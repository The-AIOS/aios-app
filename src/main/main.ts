import { app, BrowserWindow, ipcMain, dialog, shell, clipboard } from 'electron';
import * as path from 'path';
import * as os from 'os';
import * as pty from 'node-pty';
import { PanelHost } from './panelHost';
import { installMenu } from './menu';
import { initCommandBus } from './commandBus';
import { composeBuilderBrief, slugify, type DesignerKind, type DesignerFields } from '../core/designer';
import { taskFileInstruction, needsTaskFile } from '../core/commandBus';
import { needsSpill } from '../core/ptyLine';
import { initAutoUpdater } from './updater';
import * as aios from './aios';
import * as fs from 'fs';

/**
 * Glass Shell — walking skeleton. Window + the shared Glass panel + ONE real
 * terminal over node-pty. Exists to answer the only real unknown: does the
 * panel drive terminals outside VS Code as cleanly as believed.
 *
 * `--smoke` boots headless-ish, asserts (a) renderer loaded, (b) a PTY echoes,
 * then exits 0/1 — the in-app smoke gate, here from day one.
 */
const SMOKE = process.argv.includes('--smoke');
/* Any uncaught renderer error fails a smoke run — see the verdict block. */
const rendererErrors: string[] = [];
const SHOT = process.argv.find((a) => a.startsWith('--shot')); // --shot[=/path.png] : render + screenshot + exit (dev/QA)
const EVAL = process.argv.find((a) => a.startsWith('--eval=')); // --eval=<js> : run JS in the renderer, print result, exit (dev/QA)
const ptys = new Map<number, pty.IPty>();
let nextId = 1;

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 880,
    minHeight: 560,
    show: !SMOKE,
    backgroundColor: '#0b0b0d',
    title: 'AIOS',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 14 },
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true, // in-app browser panes (the Manual + operator-opened URLs) — #14
    },
  });
  void win.loadFile(path.join(__dirname, '..', '..', 'renderer', 'index.html'));
  return win;
}

// Env for EVERY app-launched terminal — pty:spawn is the single chokepoint all panes
// route through (command bus, quick cards, spawn, resume, agents, skills, commands, via
// createPane→ptySpawn). Mirrors Glass (runner.ts) so a session the app launches is a
// first-class, transcript-saving, resumable, Running-card-visible one:
//  • CLEAR CLAUDE_CODE_CHILD_SESSION — the app, launched from a Claude session (or an IDE
//    that was), INHERITS this marker; left set it turns OFF transcript saving AND the
//    session registry, so launched sessions come up invisible + non-resumable ("Transcript
//    saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker"). This was the observed bug.
//  • FORCE CLAUDE_CODE_FORCE_SESSION_PERSIST — a persisted, resumable session.
//  • AIOS_GLASS_TERM — mark the terminal so the shell `spawn` wrapper boots a worker IN-PLACE
//    here (not osascript a detached window) if `spawn` is ever run from inside a pane.
function termEnv(cmd?: string, name?: string): Record<string, string> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  delete env.CLAUDE_CODE_CHILD_SESSION;
  env.CLAUDE_CODE_FORCE_SESSION_PERSIST = '1';
  env.AIOS_GLASS_TERM = '1';
  // THE SESSION RITUAL. The `spawn` wrapper exports CLAUDE_AGENT_NAME, which is what
  // makes CLAUDE.md's Mandatory First Action fire in the worker: read the name →
  // identity → agent match (glob agents/**, else fuzzy via _index) → Session Start
  // Ritual (declared + observed context). Launching a bare `claude --name X` WITHOUT
  // that var gives an identity-less session that skips the whole ritual — the gap
  // between an app-launched session and an IDE/Glass one. Deriving it from the
  // command's own `--name` covers EVERY launch path at this one chokepoint
  // (spawn button, agents, skills, commands, rituals, resume, the command bus).
  //
  // The name arrives EXPLICITLY from the caller. It used to be recovered by regex from the
  // command string, and that is how resume shipped unnamed for months: the comment above
  // claimed resume was covered, but `claude --resume` spells no `--name`, so the regex found
  // nothing and said nothing. A parameter makes an unnamed launch visible at the call site
  // instead of silently absent here.
  const explicit = (name || '').trim();
  // Fallback for callers that embed `--name` in the command itself (rituals, agents, the
  // command bus). Kept so nothing regresses — but it is the fallback now, not the mechanism.
  const m = /--name\s+("[^"]+"|'[^']+'|\S+)/.exec(cmd || '');
  const derived = m ? m[1].replace(/^["']|["']$/g, '') : '';
  const chosen = explicit || derived;
  if (chosen && /^[a-z0-9][a-z0-9-]*$/i.test(chosen)) env.CLAUDE_AGENT_NAME = chosen;
  return env;
}

/* A tty in canonical mode has a FIXED input line buffer — MAX_CANON, 1024 bytes on macOS.
   Write more than that on one line and the line discipline silently drops the remainder: no
   error, no signal, nothing in any log. Observed exactly once and it looked like the app had
   hung. The wiring step's chain (four repairs, absolute paths, plus the completion banner)
   came to 1,100-odd bytes; the operator got the first 1024, which ended mid-string, so the
   shell sat waiting for a quote to close and no command ever ran.

   Shortening the banner would only postpone this — four repairs with long home paths can
   exceed 1024 unaided, and the command bus can carry arbitrary text. So anything near the
   limit is written to a script and invoked by path. Handled HERE, at pty:spawn, because every
   surface (setup repairs, quick cards, agents, skills, the bus, resume) funnels through it —
   fixing it per-caller would leave the next caller to rediscover it. */
function spillLongCommand(cmd: string): string {
  if (!needsSpill(cmd)) return cmd;
  try {
    const dir = path.join(app.getPath('userData'), 'steps');
    fs.mkdirSync(dir, { recursive: true });
    // drop scripts from previous days; they are transient by nature
    const DAY = 86_400_000;
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      try { if (Date.now() - fs.statSync(p).mtimeMs > DAY) fs.unlinkSync(p); } catch { /* ignore */ }
    }
    const file = path.join(dir, `step-${Date.now()}-${nextId}.sh`);
    // bash, not sh: the generated chains use `{ … }` grouping and are written for it. A child
    // bash inherits the login shell's already-exported PATH, so `claude` still resolves.
    fs.writeFileSync(file, `#!/bin/bash\n${cmd}\n`, { mode: 0o700 });
    return `bash ${file.includes(' ') ? JSON.stringify(file) : file}`;
  } catch {
    // if the spill fails, send it anyway — truncated is bad, silently doing nothing is worse
    return cmd;
  }
}

ipcMain.handle('pty:spawn', (e, opts: { cols: number; rows: number; cmd?: string; cwd?: string; name?: string }) => {
  const shell = process.env.SHELL || (os.platform() === 'win32' ? 'powershell.exe' : '/bin/zsh');
  /* The working directory must EXIST, or node-pty exits immediately with code 1 and every
     terminal is born "[session ended]". The old fallback was ~/aios unconditionally, so on
     any machine without the framework — every newcomer — no terminal could ever open,
     including the one that installs Claude. First candidate that exists wins; the home
     directory always does.
     Candidates are still confined to the allowed roots for the requested cwd ("open
     terminal here"); the fallbacks are the framework root and finally $HOME. */
  const usable = (d: string | undefined): boolean => {
    if (!d) return false;
    try { return fs.statSync(d).isDirectory(); } catch { return false; }
  };
  const requested = opts.cwd && inAllowed(opts.cwd) ? opts.cwd : undefined;
  const cwd = [requested, aios.frameworkRoot(), os.homedir()].find(usable) as string;
  const p = pty.spawn(shell, ['-l'], {
    name: 'xterm-256color',
    cols: opts.cols, rows: opts.rows,
    cwd,
    env: termEnv(opts.cmd, opts.name),
  });
  const id = nextId++;
  ptys.set(id, p);
  p.onData((data) => { if (!e.sender.isDestroyed()) e.sender.send('pty:data', { id, data }); });
  p.onExit(({ exitCode }) => { ptys.delete(id); if (!e.sender.isDestroyed()) e.sender.send('pty:exit', { id, exitCode }); });
  /* THE COMMAND IS NOT WRITTEN HERE ANY MORE — see `pty:run`.
     It used to run right at spawn, while the pty was still at the hardcoded 80×24 the renderer
     passes before it has measured anything. A shell prompt survives that (it reflows), but a
     FULL-SCREEN TUI does not: `claude --resume` painted its picker at 80 columns and then the
     pty was resized to the real grid, so xterm reflowed a half-drawn full-screen interface.
     That is the resume glitch — visible only on resume because only resume opens a TUI. */
  return id;
});
/* Run a pane's opening command AFTER the renderer has fitted the terminal and pushed the real
   geometry. Stays in main because spillLongCommand needs userData + fs (the 1024-byte MAX_CANON
   spill), and that protection must not be bypassable from the renderer. */
ipcMain.handle('pty:run', (_e, { id, cmd }: { id: number; cmd: string }) => {
  const p = ptys.get(id);
  if (!p || !cmd) return false;
  p.write(spillLongCommand(String(cmd)) + '\r');
  return true;
});
ipcMain.on('pty:write', (_e, { id, data }: { id: number; data: string }) => ptys.get(id)?.write(data));
ipcMain.on('pty:resize', (_e, { id, cols, rows }: { id: number; cols: number; rows: number }) => ptys.get(id)?.resize(cols, rows));
ipcMain.on('pty:kill', (_e, { id }: { id: number }) => { ptys.get(id)?.kill(); ptys.delete(id); });

let host: PanelHost | undefined;

ipcMain.on('panel:msg', (_e, msg) => host?.onMessage(msg));

// ── allowed-roots fs: the vault + any workspace folders the operator added ──
function allowedRoots(): string[] {
  const out: string[] = [];
  const r = aios.frameworkRoot(); // the whole framework (INTENT.md, USER.md, agents/ — vault/ included)
  if (r) out.push(r);
  out.push(...aios.workspaceFolders());
  return out;
}
function inAllowed(abs: string): boolean {
  return allowedRoots().some((r) => abs === r || abs.startsWith(r + path.sep));
}

// ── explorer live watch: recursive watchers on each root → debounced fsEvent ──
// (lets the renderer surface new files in place + refresh git markers, no repaint)
const explorerWatchers: fs.FSWatcher[] = [];
let fsEventTimer: ReturnType<typeof setTimeout> | undefined;
const fsEventDirs = new Set<string>();
function setupExplorerWatch(win: BrowserWindow): void {
  for (const w of explorerWatchers.splice(0)) { try { w.close(); } catch { /* ignore */ } }
  const SKIP = /(^|\/)(\.git|node_modules|out|dist|\.venv|__pycache__)(\/|$)/;
  for (const root of allowedRoots()) {
    try {
      explorerWatchers.push(fs.watch(root, { recursive: true }, (_evt, filename) => {
        if (!filename) return;
        const rel = String(filename);
        if (SKIP.test(rel)) return;
        fsEventDirs.add(path.dirname(path.join(root, rel)));
        if (fsEventTimer) clearTimeout(fsEventTimer);
        fsEventTimer = setTimeout(() => {
          const dirs = [...fsEventDirs]; fsEventDirs.clear();
          if (!win.webContents.isDestroyed()) win.webContents.send('shell:fsEvent', { dirs });
        }, 300);
      }));
    } catch { /* root may be absent */ }
  }
}
function resolveIn(relOrAbs: string): string | null {
  const v = aios.vaultRoot();
  const abs = path.isAbsolute(relOrAbs) ? relOrAbs : (v ? path.resolve(v, relOrAbs) : null);
  return abs && inAllowed(abs) ? abs : null;
}
ipcMain.handle('fs:roots', () => {
  const v = aios.vaultRoot();
  return {
    framework: aios.frameworkRoot() ?? null,
    vault: v ?? null,
    workspace: aios.workspaceFolders().map((p) => ({ path: p, name: path.basename(p) })),
  };
});
ipcMain.handle('fs:addFolder', async () => {
  const r = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths[0]) return null;
  aios.addWorkspaceFolder(r.filePaths[0]);
  if (mainWin) setupExplorerWatch(mainWin); // wire live watch + git for the new folder
  return r.filePaths[0];
});
/* Add a folder we were HANDED (an OS drop), as opposed to one chosen in the dialog. Same
   validation the dialog path gets implicitly: it must be a real directory. */
ipcMain.handle('fs:addFolderPath', (_e, p: string) => {
  const abs = String(p || '');
  try { if (!fs.statSync(abs).isDirectory()) return null; } catch { return null; }
  aios.addWorkspaceFolder(abs);
  if (mainWin) setupExplorerWatch(mainWin);
  return abs;
});
ipcMain.handle('fs:removeFolder', (_e, p: string) => { aios.removeWorkspaceFolder(p); if (mainWin) setupExplorerWatch(mainWin); return true; });
const FS_ALWAYS_HIDE = new Set(['node_modules', 'out', 'dist', '.git', '.DS_Store', '.venv', '__pycache__']);
// AI-58: entries carry mtime and arrive UNSORTED — the renderer owns the order
// (per-folder sort via resolveSort over the roaming .glass/state.json prefs).
ipcMain.handle('fs:list', (_e, dirPath: string) => {
  const abs = resolveIn(dirPath || '.');
  if (!abs) return [];
  const showHidden = aios.shellSettings().showHidden;
  try {
    return fs.readdirSync(abs, { withFileTypes: true })
      .filter((d) => !FS_ALWAYS_HIDE.has(d.name) && !aios.isIgnoredName(d.name) && (showHidden || !d.name.startsWith('.')))
      .map((d) => {
        const p = path.join(abs, d.name);
        // one stat gets BOTH is-dir (through symlinks) and the mtime `mtime` sorts on
        let mtime = 0, dir = d.isDirectory();
        try { const st = fs.statSync(p); mtime = st.mtimeMs; dir = st.isDirectory(); } catch { /* keep dirent */ }
        return { name: d.name, dir, path: p, mtime };
      });
  } catch { return []; }
});
// AI-58: sort prefs (shared shape with Glass — src/core/sort.ts keys in .glass/state.json)
/* Resolve a path-shaped token from terminal output into a real, openable file.
   Existence inside the allowed roots is BOTH the safety property and the precision filter:
   terminal output is full of things that look like paths, and only underlining the ones that
   actually resolve is what stops the whole screen from lighting up. Returns the absolute path
   or null — deliberately not the content, because this runs on hover. */
ipcMain.handle('fs:resolveFile', (_e, cand: string, base?: string) => {
  try {
    let c = String(cand || '').trim().replace(/[)\]},.;:'"]+$/, '');   // trailing punctuation from prose
    if (!c) return null;
    c = c.replace(/:\d+(?::\d+)?$/, '');                              // file.ts:42[:7] → file.ts
    if (c.startsWith('~')) c = path.join(os.homedir(), c.slice(1));
    const bases = [base, aios.frameworkRoot(), os.homedir()].filter(Boolean) as string[];
    const cands = path.isAbsolute(c) ? [c] : bases.map((b) => path.resolve(b, c));
    for (const abs of cands) {
      if (!inAllowed(abs)) continue;
      try { if (fs.statSync(abs).isFile()) return abs; } catch { /* next */ }
    }
    return null;
  } catch { return null; }
});
/* Plural form: a hovered terminal line can hold a dozen path-shaped tokens, and resolving
   them one IPC at a time is what made the first hover feel slow. */
ipcMain.handle('fs:resolveFiles', (_e, cands: string[], base?: string) => {
  const out: Record<string, string> = {};
  for (const c of (Array.isArray(cands) ? cands : []).slice(0, 24)) {
    try {
      let v = String(c || '').trim().replace(/[)\]},.;:'"]+$/, '');
      if (!v) continue;
      v = v.replace(/:\d+(?::\d+)?$/, '');
      if (v.startsWith('~')) v = path.join(os.homedir(), v.slice(1));
      const bases = [base, aios.frameworkRoot(), os.homedir()].filter(Boolean) as string[];
      const tries = path.isAbsolute(v) ? [v] : bases.map((b) => path.resolve(b, v));
      for (const abs of tries) {
        if (!inAllowed(abs)) continue;
        try { if (fs.statSync(abs).isFile()) { out[c] = abs; break; } } catch { /* next */ }
      }
    } catch { /* skip */ }
  }
  return out;
});
ipcMain.handle('fs:sortState', () => ({ master: aios.masterSort(), overrides: aios.folderSorts() }));
ipcMain.handle('fs:setSort', (_e, folder: string, mode: string) => {
  if (typeof folder !== 'string' || !inAllowed(folder)) return { master: aios.masterSort(), overrides: aios.folderSorts() };
  return aios.setFolderSortPref(folder, mode);
});
ipcMain.handle('fs:setMasterSort', (_e, mode: string) => aios.setMasterSortPref(mode));
ipcMain.handle('fs:git', () => aios.gitStatusForRoots(allowedRoots()));
ipcMain.handle('fs:dirtyLines', (_e, abs: string) => (inAllowed(String(abs)) ? aios.gitDirtyLines(String(abs)) : []));
// Render an HTML file to a high-res PNG (full page) via an offscreen window — the
// "download this deck/infographic as an image" action. Captures at the display's
// pixel ratio (2× on retina = HD). Saves <name>.png next to the source.
ipcMain.handle('html:toPng', async (_e, filePath: string) => {
  const abs = resolveIn(filePath);
  if (!abs || !/\.html?$/i.test(abs)) return null;
  const off = new BrowserWindow({ show: false, width: 1440, height: 900, webPreferences: { sandbox: true, offscreen: false } });
  try {
    await off.loadFile(abs);
    await new Promise((r) => setTimeout(r, 500)); // let fonts + entry animations settle
    const dims = await off.webContents.executeJavaScript(
      '({w: Math.ceil(Math.max(document.documentElement.scrollWidth, document.body.scrollWidth)), h: Math.ceil(Math.max(document.documentElement.scrollHeight, document.body.scrollHeight))})');
    const w = Math.min(Math.max(Number(dims.w) || 1440, 320), 4000);
    const h = Math.min(Math.max(Number(dims.h) || 900, 240), 20000);
    off.setContentSize(w, h);
    await new Promise((r) => setTimeout(r, 400)); // reflow at full size
    const img = await off.webContents.capturePage();
    const out = abs.replace(/\.html?$/i, '') + '.png';
    fs.writeFileSync(out, img.toPNG());
    return { out, w: img.getSize().width, h: img.getSize().height };
  } catch { return null; } finally { off.destroy(); }
});
ipcMain.handle('shell:reveal', (_e, p: string) => { if (resolveIn(p)) shell.showItemInFolder(p); return true; });
ipcMain.handle('shell:readText', () => clipboard.readText());
/* Interface scale via Electron's NATIVE zoom, never CSS `body { zoom }`. CSS zoom scales
   painting but not the coordinate space, so getBoundingClientRect() and a component's own
   pixel math drift apart — that produced menus landing off-target and xterm hit-testing
   "below the pointer" (a proportional offset, the tell-tale of a scale mismatch). setZoomFactor
   scales the whole page including input coordinates, so nothing has to compensate. */
ipcMain.handle('shell:zoom', (_e, factor: number) => {
  const f = Math.min(1.6, Math.max(0.7, Number(factor) || 1));
  const w = mainWin;
  if (w && !w.isDestroyed()) w.webContents.setZoomFactor(f);
  return f;
});
ipcMain.handle('shell:copyText', (_e, t: string) => { clipboard.writeText(String(t)); return true; });
ipcMain.handle('fs:read', (_e, relOrAbs: string) => {
  const abs = resolveIn(relOrAbs);
  if (!abs) return null;
  try { return { path: abs, content: fs.readFileSync(abs, 'utf8') }; } catch { return null; }
});
ipcMain.handle('aios:lists', () => ({
  agents: aios.discoverAgents(),
  commands: aios.discoverCommands(),
  skills: aios.discoverSkills(),
  frequent: aios.frequentTasks(),
  running: aios.listRunningAgents(),
  suggestions: aios.listAgentSuggestions(),
}));
ipcMain.handle('fs:index', () => aios.fileIndex());
ipcMain.handle('aios:plugins', () => ({
  catalog: aios.pluginCatalog(),
  installed: aios.installedPlugins(),
  marketplaces: aios.knownMarketplaces(),
}));
ipcMain.handle('shell:openExternal', (_e, url: string) => {
  if (/^https?:\/\//.test(url)) void shell.openExternal(url);
  return true;
});
// signal any registered session by pid (interrupt/terminate/kill) — works for
// sessions started outside this window too, where we have no TTY to type into
ipcMain.handle('session:signal', (_e, { pid, sig }: { pid: number; sig: NodeJS.Signals }) => {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, sig); return true; } catch { return false; }
});
// session post-its (#12): jot/view/delete notes on a live session (.glass/state.json)
ipcMain.handle('notes:get', (_e, name: string) => aios.sessionNotes(String(name)));
ipcMain.handle('notes:counts', () => aios.sessionNoteCounts());
// #32 account rotation: the USER.md roster + the atomic swap (shells claude-identity.sh)
// "Show logs" (Glass's cog has it): the app's logs are the DevTools console — main-process
// lines (command bus, updater, doctor) and renderer errors both land there.
ipcMain.handle('shell:devtools', () => { mainWin?.webContents.openDevTools({ mode: 'bottom' }); return true; });
ipcMain.handle('shell:setPrimary', (_e, name: string) => aios.setPrimaryName(String(name)));
ipcMain.handle('accounts:list', () => aios.anthropicAccounts());
ipcMain.handle('accounts:swap', (_e, email: string) => aios.swapAccount(String(email)));
ipcMain.handle('notes:add', (_e, name: string, note: string) => aios.addSessionNote(String(name), String(note)));
ipcMain.handle('notes:del', (_e, name: string, index: number) => aios.deleteSessionNote(String(name), Number(index)));
ipcMain.handle('fs:resolveNote', (_e, name: string) => {
  // wikilink resolution: first match by basename across the vault (Obsidian-style)
  const v = aios.vaultRoot();
  if (!v) return null;
  const want = name.toLowerCase() + '.md';
  const stack = [v];
  while (stack.length) {
    const dir = stack.pop() as string;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { stack.push(p); continue; }
      if (e.name.toLowerCase() === want) return p;
    }
  }
  return null;
});
ipcMain.handle('shell:vaultRoot', () => aios.vaultRoot() ?? null);
ipcMain.handle('fs:write', (_e, relOrAbs: string, content: string) => {
  const abs = resolveIn(relOrAbs);
  if (!abs) return false;
  try {
    fs.mkdirSync(path.dirname(abs), { recursive: true }); // e.g. the Designer's skills/custom/{name}/ folder
    const tmp = abs + '.glass-tmp';
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, abs);
    return true;
  } catch { return false; }
});
// Designer: the app no longer writes framework infra — it reads the catalog so the
// operator can borrow a bundled unit's shape or pick one of their OWN custom units to
// update, and `aios-builder` does the writing (see src/core/designer.ts).
ipcMain.handle('designer:catalog', (_e, kind: string) => aios.designerCatalog(String(kind)));
ipcMain.handle('designer:read', (_e, relPath: string) => aios.designerRead(String(relPath)));
// The brief itself is composed in the core (pure, tested) — the renderer is plain JS and
// can't import TS, so it asks for the text and then spawns the builder with it.
/**
 * Hand the brief to `aios-builder` via a TEMP FILE, never inline.
 *
 * A brief is long and multi-line, and typing it into a pty is the exact failure the
 * command bus already fixed (Glass 0.4.3): a burst of Enter-presses, shell-quote mangling
 * (`'\''` everywhere), and truncation past the terminal's line limit — all three were
 * visible in the operator's paste. So we write the brief to a file and hand over one short
 * line, mirroring the `spawn` wrapper's own long-task indirection.
 */
/**
 * Generic long-prompt handoff. ANY prompt the app hands to a session should come through
 * here: short ones pass straight through, long or multi-line ones become a temp file plus
 * a one-line "read this" instruction. Three places needed this independently (the spawn
 * wrapper, the command bus, the Designer) — this is the rule, so a fourth doesn't
 * rediscover it by shipping a mangled prompt.
 */
ipcMain.handle('task:handoff', (_e, req: { prompt: string; name?: string }) => {
  const prompt = String(req?.prompt ?? '');
  if (!prompt) return '';
  if (!needsTaskFile(prompt)) return prompt;
  const slug = (String(req?.name ?? 'task').toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'task').slice(0, 40);
  const file = path.join(os.tmpdir(), `aios-task-${slug}.md`);
  try { fs.writeFileSync(file, prompt); } catch { return prompt; }  // fall back to inline
  return taskFileInstruction(file);
});
ipcMain.handle('designer:handoff', (_e, req: { kind: DesignerKind; fields: DesignerFields; mode: 'create' | 'update'; targetPath?: string }) => {
  if (!req || !['agent', 'skill', 'command'].includes(req.kind)) return null;
  const brief = composeBuilderBrief(req.kind, req.fields, {
    mode: req.mode === 'update' ? 'update' : 'create',
    targetPath: req.targetPath,
    plugins: aios.customPluginHandles(),
    suggestedHandle: slugify(aios.operatorName()) || undefined,
  });
  if (!brief) return null;
  const slug = slugify(req.fields?.name || '') || 'unit';
  const file = path.join(os.tmpdir(), `aios-designer-${req.kind}-${slug}.md`);
  try { fs.writeFileSync(file, brief); } catch { return null; }
  return { file, prompt: taskFileInstruction(file) };
});
ipcMain.handle('designer:brief', (_e, req: { kind: DesignerKind; fields: DesignerFields; mode: 'create' | 'update'; templatePath?: string; targetPath?: string }) => {
  if (!req || !['agent', 'skill', 'command'].includes(req.kind)) return '';
  // the operator's own plugin handles travel with the brief so a new command joins an
  // existing plugin instead of the builder minting a second one
  // …and if they have none, propose a handle from their own name rather than asking a
  // blank "what should the plugin be called?" on their very first command.
  return composeBuilderBrief(req.kind, req.fields, {
    mode: req.mode === 'update' ? 'update' : 'create',
    templatePath: req.templatePath,
    targetPath: req.targetPath,
    plugins: aios.customPluginHandles(),
    suggestedHandle: slugify(aios.operatorName()) || undefined,
  });
});
ipcMain.handle('setup:check', () => aios.setupChecks());
// starter packs: persona → preseeded Home (frequent tasks + suggested agents)
ipcMain.handle('starter:packs', () => aios.starterPacks());
ipcMain.handle('starter:apply', (_e, id: string) => {
  const r = aios.applyStarterPack(String(id ?? ''));
  host?.postState(); // Home's frequent count changes immediately
  return r;
});
// the Onboarding flow: one doctor battery → the gated stepper (done/active/locked)
ipcMain.handle('onboarding:state', () => aios.onboardingState());
// PAT lane: store a GitHub token via `git credential approve` (never echoed)
ipcMain.handle('onboarding:storePat', (_e, pat: string) => aios.storeGitHubPat(String(pat ?? '')));
// doctor: headless repair + re-run-the-same-check proof (see aios.repairCheck)
ipcMain.handle('doctor:repair', (_e, id: string) => aios.repairCheck(String(id)));
ipcMain.handle('doctor:health', () => aios.computeHealth());
ipcMain.handle('shell:config', () => ({ ...aios.shellSettings(), localeResolved: aios.resolvedLocale(), hasIdentity: aios.hasIdentity(), operator: aios.operatorName(), primary: aios.primaryName() }));
ipcMain.handle('claude:config', () => aios.claudeConfig());
ipcMain.handle('claude:outputStyles', () => aios.outputStyleOptions());
ipcMain.handle('claude:modelOptions', () => aios.modelOptions());
/* THE MACHINE CHANGES UNDER US. Everything that resolves the framework or the vault is wired
   when the window opens — the explorer tree, the panel's file watchers, the update tracker. On a
   newcomer's machine none of those paths exist at that moment, so every watcher silently no-ops
   and the tree renders empty. Minutes later the setup session creates all of it, and nothing
   tells the app. The operator saw an empty explorer beside a fully-populated vault, a calendar
   with no dot for the note /aios:today had just written, and an update pill stuck on "not tracked
   yet" — three symptoms of one cause. Adding a workspace folder appeared to "fix" it only because
   that path happened to re-run the watcher.
   So: watch for the roots appearing, then re-wire everything that assumed they were not there.
   A poll, not a watcher, because you cannot watch a directory that does not exist, and its parent
   is $HOME — far too noisy to watch for this. */
let lastRootSig = '';
function rootSignature(): string {
  return `${aios.frameworkRoot() ?? ''}|${aios.vaultRoot() ?? ''}`;
}
function rewireForRoots(win: BrowserWindow): void {
  const sig = rootSignature();
  if (sig === lastRootSig) return;
  lastRootSig = sig;
  setupExplorerWatch(win);
  host?.wireWatchers();
  host?.refreshUpdateStatus(true);
  if (!win.webContents.isDestroyed()) win.webContents.send('shell:rootsChanged', { framework: aios.frameworkRoot() ?? '', vault: aios.vaultRoot() ?? '' });
}

ipcMain.handle('aios:phase1', () => aios.phase1Script());
ipcMain.handle('aios:trustDir', (_e, d: string) => { aios.trustDirForClaude(String(d || '')); return true; });
// the renderer owns the wording (it has the locale); main owns writing the file
ipcMain.handle('aios:banner', (_e, m: { ok: string; okSub: string; fail: string; failSub: string }) =>
  aios.bannerScript(m.ok, m.okSub, m.fail, m.failSub));
ipcMain.handle('aios:readiness', () => aios.readiness());
ipcMain.handle('aios:addFrequent', (_e, task: Parameters<typeof aios.addFrequentTask>[0]) => aios.addFrequentTask(task));
ipcMain.handle('aios:removeFrequent', (_e, id: string) => aios.removeFrequentTask(String(id)));
// AIOS's own auto-update preference (USER.md), deliberately NOT on the claude:* channel
ipcMain.handle('shell:setAutoUpdates', (_e, on: boolean) => { aios.setAutoUpdates(!!on); return aios.claudeConfig().autoUpdates; });
ipcMain.handle('claude:permissionModes', () => aios.permissionModes());
ipcMain.handle('shell:frameworkPath', () => aios.frameworkPathSetting());
ipcMain.handle('shell:setFrameworkPath', (_e, v: string) => { aios.setFrameworkPath(String(v ?? '')); return aios.frameworkPathSetting(); });
ipcMain.handle('claude:set', (_e, key: 'model' | 'mode' | 'remoteControl' | 'autoUpdates', value: unknown) => {
  aios.setClaudeConfig(key, value);
  return aios.claudeConfig();
});
ipcMain.handle('shell:setSetting', (_e, key: 'claudeCmd' | 'showHints' | 'showNudges' | 'showMemory' | 'theme' | 'termFontSize' | 'showHidden' | 'fileIcons' | 'autoReveal' | 'showWeekNumbers' | 'killBehavior' | 'terminalMode' | 'openNotesIn' | 'appFontSize' | 'hiddenCards' | 'ignorePaths' | 'locale', value: unknown) => {
  aios.setShellSetting(key, value);
  if (key === 'locale') {
    aios.applyLocale();          // reload i18n for main-process strings (nudges, setup, calendar)
    installMenu(() => mainWin);  // the native menu can't re-render itself — rebuild it
  }
  host?.postState();             // re-emit localized pulse state (nudge, calendar)
  return aios.shellSettings();
});

let mainWin: BrowserWindow | undefined;

app.whenReady().then(() => {
  aios.setSystemLocale(app.getLocale());  // capture the OS language so `auto` can resolve to it
  aios.applyLocale();            // load the resolved UI locale before building the menu
  const win = createWindow();
  mainWin = win;
  installMenu(() => mainWin);
  host = new PanelHost(win.webContents);
  host.start();
  if (!SMOKE && !SHOT) setupExplorerWatch(win);
  // Spawn-inbox command bus: watch ~/.aios/spawn-inbox/ and fulfil agent-dropped
  // spawn/kill/send requests natively (Glass 0.4.2/0.4.3 parity). Interactive
  // window only — never during smoke/shot/eval.
  if (!SMOKE && !SHOT && !EVAL) initCommandBus(() => mainWin, app.getVersion());
  // Auto-update (packaged builds only — self-guards on app.isPackaged): check on
  // boot + every 6h, native-notify when staged, install on quit. GitHub-Releases
  // channel; never fires in dev/smoke/shot/eval. Renderer surface folds into the
  // Needs-you inbox card (batch G) later; this is the mechanism only.
  if (!SMOKE && !SHOT && !EVAL) initAutoUpdater(() => mainWin);
  // Glass re-checks status whenever its panel becomes visible again; the App's
  // panel never hides, so window focus is the equivalent signal — come back from
  // a push or a pull elsewhere and the pill is current. Rate-limited in the host.
  /* DEV ONLY: renderer console → this process's stdout. Electron routes renderer logs to
     DevTools, so a `console.log` in app.js is invisible to anyone tailing the app's output —
     which once made an empty log read as "the feature never fired". Never in a packaged
     build: a shipped app should not narrate its renderer into the system log. */
  if (!app.isPackaged) {
    win.webContents.on('console-message', (...args: unknown[]) => {
      const d = args[0] as { message?: string; level?: unknown } | undefined;
      const msg = d && typeof d === 'object' && 'message' in d ? d.message : (args[1] as string);
      if (msg) console.log('[renderer]', String(msg));
    });
  }
  if (SMOKE) {
    win.webContents.on('console-message', (...args: unknown[]) => {
      const d = args[0] as { message?: string; level?: string | number } | undefined;
      const msg = String((d && typeof d === 'object' && 'message' in d ? d.message : args[1]) ?? '');
      if (/Uncaught|is not a function|is not defined|TypeError|ReferenceError/.test(msg)
          && !/Content-Security-Policy/.test(msg)) rendererErrors.push(msg.slice(0, 200));
    });
  }
  win.on('focus', () => { host?.refreshUpdateStatus(); rewireForRoots(win); });
  /* Every 4s while the window is up. Cheap (two path resolutions) and it only acts on a CHANGE,
     so the common case — roots that already exist — costs nothing after the first tick. */
  const rootPoll = setInterval(() => { if (!win.isDestroyed()) rewireForRoots(win); }, 4000);
  win.on('closed', () => clearInterval(rootPoll));
  win.on('closed', () => { host?.dispose(); host = undefined; for (const w of explorerWatchers.splice(0)) { try { w.close(); } catch { /* ignore */ } } });
  if (EVAL) {
    const expr = EVAL.slice('--eval='.length);
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        void win.webContents.executeJavaScript(`Promise.resolve((async()=>{${expr}})()).then(JSON.stringify)`)
          .then((r) => { console.log('eval: ' + r); app.exit(0); })
          .catch((e) => { console.error('eval failed', e); app.exit(1); });
      }, 3500);
    });
    return;
  }
  if (SHOT) {
    const out = SHOT.includes('=') ? SHOT.split('=')[1] : '/tmp/aios-shot.png';
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        void win.webContents.capturePage().then((img) => {
          fs.writeFileSync(out, img.toPNG());
          console.log('shot: ' + out);
          app.exit(0);
        }).catch((e) => { console.error('shot failed', e); app.exit(1); });
      }, 3500); // let the pulse populate
    });
    return;
  }
  if (SMOKE) {
    // Awaited gate chain (racing fixed-delay timers against async probes made the
    // gate FLAKY — probes that hadn't finished read as failures).
    let loaded = false;
    win.webContents.on('did-finish-load', () => { loaded = true; });
    const p = pty.spawn(process.env.SHELL || '/bin/zsh', ['-c', 'echo GLASS_SHELL_PTY_OK'], { name: 'xterm', cols: 80, rows: 24, cwd: os.homedir(), env: process.env as Record<string, string> });
    let buf = '';
    p.onData((d) => { buf += d; });

    const gates = async (): Promise<boolean> => {
      await new Promise((r) => setTimeout(r, 3000)); // window + iframe settle
      let stateOk = false;
      try {
        const agents = aios.discoverAgents().length;
        const op = aios.operatorName();
        stateOk = agents > 0;   // a name is optional (virgin vault); discovery is the real signal
        console.log(`shell-smoke: state — operator=${op}, agents=${agents}, commands=${aios.discoverCommands().length}, skills=${aios.discoverSkills().length}`);
      } catch (err) { console.error('shell-smoke: state FAIL', err); }
      const rendererOk = await win.webContents.executeJavaScript('window.__workbenchOk === true').catch(() => false);
      let panelOk = false;
      let themeOk = false;
      try {
        // gates 5/6: the NATIVE pulse must have consumed real state + the calendar
        // must render + the light theme must repaint the window
        const pulseReady = await win.webContents.executeJavaScript('window.__pulseReady === true').catch(() => false);
        const calCells = await win.webContents.executeJavaScript("document.querySelectorAll('#pCal td').length").catch(() => -1);
        const sessions = await win.webContents.executeJavaScript("document.querySelectorAll('#pRun .prow2').length").catch(() => -1);
        const actionBtns = await win.webContents.executeJavaScript("document.querySelectorAll('#pQuick .pbtn').length + document.querySelectorAll('#pDaily .pbtn').length").catch(() => -1);
        // toggle from WHATEVER the operator's saved theme is (assuming dark start
        // broke the gate the night the operator left light mode on)
        const bgBefore = await win.webContents.executeJavaScript("getComputedStyle(document.body).backgroundColor");
        await win.webContents.executeJavaScript("document.body.classList.toggle('light')");
        const bgAfter = await win.webContents.executeJavaScript("getComputedStyle(document.body).backgroundColor");
        await win.webContents.executeJavaScript("document.body.classList.toggle('light')");
        panelOk = !!pulseReady && Number(calCells) >= 7 && Number(actionBtns) >= 7; // ≥7 supports week view
        themeOk = bgBefore !== bgAfter;
        console.log(`shell-smoke: pulse — ready=${pulseReady}, calCells=${calCells}, sessions=${sessions}, actionBtns=${actionBtns}, themeRepaints=${themeOk}, bg=${bgBefore}→${bgAfter}`);
      } catch (err) { console.error('shell-smoke: pulse gate error', err); }
      /* gate 7: SETUP MUST HAVE CONTENT. This is the first screen a newcomer ever sees, and it
         shipped rendering its title and nothing else — a `const` called above its own
         declaration threw inside the pane builder, so the step list, every button and the
         repaint handle never existed. Nothing caught it: the unit tests assert that the source
         CONTAINS the right calls, which was true, and the pane is built lazily so no other
         gate ever opened it. A test that reads source cannot see a dead temporal-dead-zone
         reference. This one opens the tab and counts what a person could actually click. */
      let setupOk = false;
      try {
        await win.webContents.executeJavaScript('openSetupTab(), 1');
        /* POLL, never a fixed sleep. This was `setTimeout(2500)` and the gate failed roughly
           one run in three with steps=0 — the pane builds asynchronously, so a hardcoded wait
           is racing it. A flaky gate is worse than a failing one: this is the check that caught
           the CFBundleName packaging break and a temporal-dead-zone crash, and a gate that
           cries wolf is one people learn to re-run until it is green. Poll for the condition
           and only give up after a budget that is generously longer than the old sleep. */
        let steps: number = 0;
        for (let i = 0; i < 60; i++) {                       // up to ~6s, checked every 100ms
          steps = Number(await win.webContents.executeJavaScript("document.querySelectorAll('.onboarding .step').length").catch(() => 0));
          if (steps >= 1) break;
          await new Promise((r) => setTimeout(r, 100));
        }
        const clickable = await win.webContents.executeJavaScript("document.querySelectorAll('.onboarding .vbtn').length").catch(() => -1);
        const repaint = await win.webContents.executeJavaScript("typeof onboardingRepaint === 'function'").catch(() => false);
        setupOk = Number(steps) >= 1 && Number(clickable) >= 1 && !!repaint;
      /* OPEN A FILE. No gate did, and a crash in openViewer therefore reached the operator:
         `el` is shadowed by a local <div> in that function, so calling the el() helper threw
         and EVERY file opened blank — markdown, TypeScript, all of it. Unit tests read source,
         smoke opened only the Setup tab, and the one screen nobody exercised was the one that
         broke. This opens a real file and counts what rendered. */
      try {
        const viewerOk = await win.webContents.executeJavaScript(
          `(async () => { await openViewer('${path.join(__dirname, '..', '..', 'package.json').replace(/\\/g, '/')}');
             await new Promise(r => setTimeout(r, 800));
             return document.querySelectorAll('.pane .codeedit, .pane .mdview, .pane pre').length; })()`,
        ).catch(() => 0);
        console.log(`shell-smoke: viewer — panes rendered=${viewerOk}`);
        /* Lazy code paths need their own check. The terminal link provider only runs on HOVER,
           so a missing declaration inside it throws nothing during a smoke run and the
           uncaught-error gate stays silent — that is exactly how `linkCache is not defined`
           survived a green suite. `typeof` on an undeclared name returns "undefined" instead of
           throwing, which makes the dependency itself testable without invoking the path. */
        const deps = await win.webContents.executeJavaScript(
          `[typeof linkCache, typeof pathCandidates, typeof showPathTip, typeof hidePathTip, typeof renamePane, typeof sessionNameFromTitle].join(',')`,
        ).catch(() => 'ERR');
        console.log(`shell-smoke: lazy-path deps — ${deps}`);
        if (String(deps).includes('undefined') || deps === 'ERR') {
          setupOk = false;
          console.error('shell-smoke: LAZY PATH BROKEN — a symbol the terminal link provider needs is not declared; it would throw on first hover');
        }
        if (Number(viewerOk) < 1) { setupOk = false; console.error('shell-smoke: VIEWER FAILED — a file opened but rendered nothing'); }
      } catch (e) { console.error('shell-smoke: viewer gate error', e); setupOk = false; }
        console.log(`shell-smoke: setup — steps=${steps}, clickable=${clickable}, repaintWired=${repaint}`);
      } catch (err) { console.error('shell-smoke: setup gate error', err); }
      const ptyOk = buf.includes('GLASS_SHELL_PTY_OK');
      /* A renderer that threw is broken whether or not the thing it broke is something a gate
         happens to look at. Three uncaught errors reached a human tester tonight with every
         other check green — a shadowed helper that killed the file viewer, and a swallowed
         declaration, twice. Watch for the failure, not for the symptom. */
      if (rendererErrors.length) {
        console.error(`shell-smoke: RENDERER THREW ${rendererErrors.length} uncaught error(s):`);
        for (const e of [...new Set(rendererErrors)].slice(0, 5)) console.error('  · ' + e);
      }
      const clean = rendererErrors.length === 0;
      const ok = loaded && ptyOk && stateOk && !!rendererOk && panelOk && themeOk && setupOk && clean;
      console.log(ok
        ? 'shell-smoke: window + pty + state + workbench + panel + theme + setup + no-renderer-errors OK ✓'
        : `shell-smoke: FAIL (loaded=${loaded}, pty=${ptyOk}, state=${stateOk}, workbench=${rendererOk}, panel=${panelOk}, theme=${themeOk}, setup=${setupOk}, rendererClean=${clean})`);
      return ok;
    };
    void Promise.race([
      gates(),
      // the setup gate opens a real tab and waits for its async paint, so the old 15s
      // ceiling would have failed the run on time rather than on truth
      new Promise<boolean>((r) => setTimeout(() => r(false), 25000)),
    ]).then((ok) => app.exit(ok ? 0 : 1));
  }
});
app.on('window-all-closed', () => app.quit());
