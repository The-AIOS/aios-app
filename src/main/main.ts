import { app, BrowserWindow, ipcMain, dialog, shell, clipboard, Menu, session, nativeTheme } from 'electron';
import { markQuitting, isQuitting, closeShouldHide } from './quitState';
import { installWebPermissionPolicy } from './webPermissions';
import { withDefaultLocale } from './termLocale';
import { createTranscriptTail, isSessionId } from './transcriptTail';
import { createPromptMonitor, type PromptMonitor, type TuiPrompt } from '../core/tuiPrompt';
import { createStreamTracker, sameMessage, normalizeForMatch, type StreamTracker } from '../core/screenStream';
import { mergeStatus, parseStatuslinePayload, scopeStatusToSession } from '../core/chatEvents';
import { builtinCommands, slashSuggestions, type SlashCommand } from '../core/slashCommands';
import { listSlashCommands } from './slashCommandsIo';
import { resolvedTheme, WINDOW_BG } from '../core/theme';
import { plainText } from '../core/plainText';
import { askSessionName, uniqueName } from '../core/sessionName';
import { runDir } from './privateRun';   // legacy snapshot sweep only; new files go through handoffDir
import { speakable, lastAnswer, guessLang } from '../core/speakable';
import { answerPlain } from '../core/answerPlain';
import { t } from '../i18n';
import { shellArgs } from './shellArgs';
import * as path from 'path';
import * as os from 'os';
import * as v8 from 'v8';
import * as vm from 'vm';
import { execFile } from 'child_process';
import { pathToFileURL } from 'url';   // main builds the file:// URL itself — see shell:openPathExternal
import { classifyForRead } from './preview';   // the fs:read gate (#39)
import { resolveLinkTargets, revealable, statWithin } from './pathLinks';
import { withToolDirs } from './toolPath';
import { writeHandoffFile, sweepHandoffDirs } from './handoffDir';   // #72: Homebrew/uv on every session's PATH   // terminal links: open vs reveal
import * as pty from 'node-pty';
import { PanelHost, setPanelLog } from './panelHost';
import { installMenu } from './menu';
import { initCommandBus, appLog } from './commandBus';
import { isBusCwdGranted } from './busCwd';
setPanelLog(appLog);   // panel notes land in the bus trail (see panelHost)
import * as caffeine from './caffeinate';
import { composeBuilderBrief, slugify, type DesignerKind, type DesignerFields } from '../core/designer';
import { taskFileInstruction, needsTaskFile } from '../core/commandBus';
import { needsSpill } from '../core/ptyLine';
import { initAutoUpdater } from './updater';
import * as aios from './aios';
import { redactSecrets } from './redact';
import { resolveOne, resolveMany, RESOLVE_PATHS_LIMIT } from './pathResolve';
import * as connectors from './connectors';
import * as fs from 'fs';
import * as crypto from 'crypto';

/**
 * Glass Shell — walking skeleton. Window + the shared Glass panel + ONE real
 * terminal over node-pty. Exists to answer the only real unknown: does the
 * panel drive terminals outside VS Code as cleanly as believed.
 *
 * `--smoke` boots headless-ish, asserts (a) renderer loaded, (b) a PTY echoes,
 * then exits 0/1 — the in-app smoke gate, here from day one.
 */
const SMOKE = process.argv.includes('--smoke');
/* A smoke run is a guest on the operator's machine, and the app they use every day is usually OPEN
   while it runs. Both share one userData folder by default, so the run would read the operator's
   localStorage (restored tabs, preferences) and write its own test tabs into it. Give it a private,
   throwaway folder instead. Settings and sessions live under ~/.aios and ~/.claude, not here. */
let smokeUserData = '';
if (SMOKE) {
  /* One fixed name, wiped at the start of every run: Chromium writes a few KB again while the process
     exits (after any cleanup the run could do), so a unique folder per run would pile up. */
  smokeUserData = path.join(os.tmpdir(), 'aios-smoke-userdata');
  fs.rmSync(smokeUserData, { recursive: true, force: true });
  fs.mkdirSync(smokeUserData, { recursive: true });
  app.setPath('userData', smokeUserData);
}
/* macOS: a smoke run is headless. The window is born hidden (`show: false`), and the process itself
   takes no Dock icon and no activation either, so the packaged binary can be run by path while the
   operator's own App is open without bouncing in the Dock or stealing focus. */
if (SMOKE && process.platform === 'darwin') { try { app.setActivationPolicy('accessory'); } catch { /* older Electron: the window is still never shown */ } }
/* app.exit() does not run 'exit' listeners, so the smoke verdict removes the folder itself. */
const dropSmokeUserData = (): void => { if (smokeUserData) { try { fs.rmSync(smokeUserData, { recursive: true, force: true }); } catch { /* best effort */ } } };
/* A gate that CAN skip will eventually skip silently, and nobody notices the day it stops running
   for a real reason. The two framework-reading gates skip when there is no framework root — right
   on a developer's laptop, wrong in CI, where a fixture is provided precisely so they run. Strict
   mode turns "did not run" into a failure, and CI sets it alongside GLASS_FRAMEWORK_PATH. */
const SMOKE_STRICT = process.env.AIOS_SMOKE_STRICT === '1';
/* Any uncaught renderer error fails a smoke run — see the verdict block. */
const rendererErrors: string[] = [];
const SHOT = process.argv.find((a) => a.startsWith('--shot')); // --shot[=/path.png] : render + screenshot + exit (dev/QA)
const EVAL = process.argv.find((a) => a.startsWith('--eval=')); // --eval=<js> : run JS in the renderer, print result, exit (dev/QA)
/* --chat-shot=<dir> : QA harness for the chat view. Renders hand-written conversations in a window
   that is NEVER shown and writes one PNG per shot into <dir> (see runChatShot below).
   Unlike --shot/--eval, which put a visible window on the operator's desktop, this mode is built
   so that a visible window is impossible — see createWindow and lockWindowHidden. */
const CHAT_SHOT_ARG = process.argv.find((a) => a === '--chat-shot' || a.startsWith('--chat-shot='));
const CHAT_SHOT = !!CHAT_SHOT_ARG;
const CHAT_SHOT_DIR = CHAT_SHOT_ARG && CHAT_SHOT_ARG.includes('=') ? CHAT_SHOT_ARG.slice(CHAT_SHOT_ARG.indexOf('=') + 1) : '';
const CHAT_SHOT_FIXTURE_ARG = process.argv.find((a) => a.startsWith('--chat-shot-fixture='));
/* --chat-bench (always together with --chat-shot): measurement mode for scripts/chat-bench.mjs. Same hidden window, same
   isolation; it only adds what a memory number needs — a renderer that can force a GC and report its heap precisely, and a
   probe line the fixture can print to ask this process for the process-level numbers (see the console-message handler). */
const CHAT_BENCH = CHAT_SHOT && process.argv.includes('--chat-bench');
const CHAT_SHOT_SIZE = { width: 1280, height: 860 };   // CSS pixels; the PNG is 2x this (see the scale switch below)
let chatShotUserData = '';   // set only when this run had to mint its own userData (the runner normally passes one)
if (CHAT_SHOT) {
  /* Must be set before `ready`: it fixes the device scale factor for every window, so the
     renderer lays out at 1280x860 CSS px and capturePage returns 2560x1720 device px — sharp
     enough to judge hairlines and type, which a 1x capture hides. */
  app.commandLine.appendSwitch('force-device-scale-factor', '2');
  if (CHAT_BENCH) { app.commandLine.appendSwitch('js-flags', '--expose-gc'); app.commandLine.appendSwitch('enable-precise-memory-info'); }
  /* macOS: no Dock icon, no menu bar, no activation. A QA run should not so much as bounce in the
     Dock while the operator is working in the same session of the desktop. */
  if (process.platform === 'darwin') { try { app.setActivationPolicy('accessory'); } catch { /* older Electron — the window is still never shown */ } }
  /* A QA run is a guest, exactly like a smoke run: it must never read or write the operator's real
     userData (restored tabs, preferences) nor a developer's `.dev-userdata`. So the userData folder
     has to live under the OS temp dir. The runner passes one; run by hand without it, mint one here
     rather than silently falling back to the real folder. */
  const given = process.argv.find((a) => a.startsWith('--user-data-dir='));
  const realTmp = (() => { try { return fs.realpathSync(os.tmpdir()); } catch { return os.tmpdir(); } })();
  const underTmp = (p: string): boolean => { try { const r = fs.realpathSync(path.resolve(p)); return r.startsWith(realTmp + path.sep); } catch { return false; } };
  if (given) {
    if (!underTmp(given.slice('--user-data-dir='.length))) {
      console.error(`chat-shot: refusing to run — --user-data-dir must be an existing folder under ${realTmp} (got ${given.slice('--user-data-dir='.length)}).`);
      process.exit(1);   // synchronous: nothing below this line may run against a real userData
    }
  } else {
    chatShotUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-chatshot-ud-'));
    app.setPath('userData', chatShotUserData);
  }
}
const ptys = new Map<number, pty.IPty>();
/* The last few KB of every pty's raw output. The chat skin's dialog detector only learns about a
   dialog from output it SEES, and a dialog is drawn once: a chat view opened (or a session that
   is still unidentified, like a folder-trust prompt before any transcript exists) after it was
   painted would otherwise never know the TUI is waiting. The monitor is seeded from this tail. */
const PTY_TAIL_CHARS = 16384;
const ptyTails = new Map<number, string>();
aios.setPtyPidSource(() => [...ptys.values()].map((p) => p.pid));   // review blocker 6: pane membership from the tree
let nextId = 1;

function createWindow(): BrowserWindow {
  /* Resolved BEFORE the window exists, so neither the pre-paint background nor the first frame
     is dark on a light machine (the body class used to land only after an IPC round-trip). */
  const firstTheme = resolvedTheme(aios.shellSettings().theme, nativeTheme.shouldUseDarkColors);
  const win = new BrowserWindow({
    /* chat-shot: the viewport is exactly CHAT_SHOT_SIZE (useContentSize), and the minimum is lifted
       so a shot can ask for a narrow dock. */
    width: CHAT_SHOT ? CHAT_SHOT_SIZE.width : 1360,
    height: CHAT_SHOT ? CHAT_SHOT_SIZE.height : 860,
    useContentSize: CHAT_SHOT,
    minWidth: CHAT_SHOT ? 320 : 880,
    minHeight: CHAT_SHOT ? 320 : 560,
    /* WHY A QA RUN CAN NEVER SHOW A WINDOW. `show` is false here, and lockWindowHidden() (called by
       the whenReady handler) additionally turns every later show()/focus() on this window into a
       no-op and re-hides it if anything gets past that. Together they make "a QA run popped a
       window over the operator's work" impossible rather than merely unlikely. */
    show: !(SMOKE || CHAT_SHOT),
    backgroundColor: WINDOW_BG[firstTheme],
    title: 'AIOS',
    // Frameless-with-inset-controls is a macOS affordance: 'hiddenInset' insets the traffic
    // lights into the content, and trafficLightPosition moves them. Neither concept exists
    // off macOS — Windows/Linux draw their own caption buttons, so 'hiddenInset' degrades to
    // a window with NO controls at all (unclosable without the menu) and trafficLightPosition
    // is dead config. Keep the native frame there; the design only ever assumed mac chrome.
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 16, y: 14 } }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true, // in-app browser panes (the Manual + operator-opened URLs) — #14
      /* chat-shot: a hidden window is throttled (timers, rAF, even painting) unless told otherwise,
         and a throttled page captures stale or blank. Only this QA mode opts out. */
      ...(CHAT_SHOT ? { backgroundThrottling: false } : {}),
    },
  });
  void win.loadFile(path.join(__dirname, '..', '..', 'renderer', 'index.html'), { query: { theme: firstTheme } });
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
  const env: Record<string, string> = withDefaultLocale({ ...(process.env as Record<string, string>) }, process.platform);
  delete env.CLAUDE_CODE_CHILD_SESSION;
  env.CLAUDE_CODE_FORCE_SESSION_PERSIST = '1';
  env.AIOS_GLASS_TERM = '1';
  /* #72 — the folders a login shell adds (Homebrew, ~/.local/bin), so `uv` and friends resolve. */
  if (process.platform !== 'win32') env.PATH = withToolDirs(env.PATH, os.homedir(), process.platform, (d) => fs.existsSync(d));
  /* WINDOWS ONLY — give a session's output a scrollback the operator can actually reach.
     REPORTED: a Windows operator could not scroll a Claude session at all — she saw one
     screenful and a long answer was unreadable past it. It fails in Windows Terminal too, so it
     is not ours; but the reason it cannot be fixed at our terminal layer is worth writing down,
     because three plausible fixes were built and thrown away before this one.
     MEASURED, on macOS, before changing anything: a session runs in the ALTERNATE screen with
     mouse tracking `any`, so it has ZERO scrollback — buffer length equals rows, baseY 0. The
     terminal holds no history at all. The wheel is encoded as an SGR mouse report (`ESC[<64;1;1M`
     up, `ESC[<65;1;1M` down, captured live off the terminal's own data stream) and handed to the
     pty, and CLAUDE scrolls its own view. That is why no keybinding, `scrollSensitivity` or
     Shift+wheel could ever have fixed it: there is nothing to scroll to, and the scrolling was
     never ours to do. On macOS the report arrives and Claude scrolls; on Windows it does not.
     So the fix is to stop needing the report. With the alternate screen off, Claude renders into
     the NORMAL buffer, output accumulates as ordinary terminal history, and the operator scrolls
     with the terminal's own 8000-line scrollback — the path that already works on her machine,
     since her plain terminals scroll fine.
     MEASURED with the flag on: normal buffer, 104 lines of scrollback, `mouse: "none"`, and the
     rich TUI intact (152 box-drawing characters — the prompt, the rules, the statusline). Three
     turns produced 98% unique lines with nothing repeated three times, so Claude's non-altscreen
     path emits incremental output rather than repainting; the scrollback stays readable.
     A DEFAULT, NOT A HARDCODE. Only set when the operator has not: this is CLAUDE's env var, not
     ours, so an operator who wants the alternate screen keeps it by exporting their own value.
     The neighbouring lines force OUR variables and are right to; this one belongs to someone else.
     WINDOWS ONLY, and deliberately not Linux — the mechanism is ConPTY, Linux has a real pty like
     macOS, and there is no evidence of the defect there. Changing a platform we have not measured
     would be trading a known-good behaviour for a guess. */
  if (process.platform === 'win32' && !env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN) {
    env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN = '1';
  }
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
    if (os.platform() === 'win32') {
      // The pane's shell is PowerShell (defaultShell), so the spilled command IS PowerShell.
      // Write a .ps1 and invoke it with the call operator `& '<path>'` in the SAME pane, so it
      // inherits that session's environment. No exec bit / shebang on Windows; escape an embedded
      // quote by doubling it (PowerShell single-quote rule).
      const file = path.join(dir, `step-${Date.now()}-${nextId}.ps1`);
      // UTF-8 BOM: Windows PowerShell 5.1 decodes a BOM-less file as the ANSI codepage, so a
      // command with accents/em-dashes (a Spanish/Portuguese operator's, pervasively) mis-parses.
      // The BOM makes PS read it as UTF-8. Same guard bannerScript uses for its generated .ps1.
      fs.writeFileSync(file, '﻿' + `${cmd}\r\n`);
      return `& '${file.replace(/'/g, "''")}'`;
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

/* $SHELL is normally set, so this is the fallback path — but the fallback has to be a shell
   that actually EXISTS, or node-pty exits code 1 and the terminal is born "[session ended]"
   (the same failure the cwd comment below describes, one argument over). A hardcoded
   /bin/zsh is right on macOS, where zsh is the system default and always present, and wrong
   on Linux, where zsh is an optional package most machines never install. Probe, don't
   assume: first candidate that exists wins, /bin/sh is POSIX-guaranteed and ends the chain. */
function defaultShell(): string {
  /* Windows FIRST, before trusting $SHELL. On Windows $SHELL is normally unset — but when the
     app is launched from Git Bash / MSYS / Cygwin it is a POSIX path like /usr/bin/bash that
     node-pty's ConPTY backend CANNOT spawn as a Windows executable, so the terminal would be
     born "[session ended]". powershell.exe is guaranteed present and is the shell the app's own
     command quoting (renderer shq/xQuote, core commandBus.shq) targets, so keep it authoritative
     here — do not honour a POSIX $SHELL on win32. */
  if (os.platform() === 'win32') return 'powershell.exe';
  if (process.env.SHELL) return process.env.SHELL;
  const candidates = os.platform() === 'darwin'
    ? ['/bin/zsh', '/bin/bash', '/bin/sh']
    : ['/bin/bash', '/usr/bin/bash', '/bin/zsh', '/bin/sh'];
  for (const c of candidates) {
    try { if (fs.statSync(c).isFile()) return c; } catch { /* try next */ }
  }
  return '/bin/sh';
}
/* The interactive-shell argv, per platform. POSIX shells take `-l` (login shell, so the pane
   inherits ~/.zprofile|.bash_profile PATH). Windows PowerShell has NO -l/-login parameter and
   node-pty exits code 1 on an unknown arg — the exact "[session ended]" failure the shell fix
   above prevents, one argument over — so pass -NoLogo (drop the banner) there; cmd.exe (COMSPEC)
   takes no such flag. */
function loginArgs(shell: string, noProfile = false): string[] {
  return shellArgs(shell, os.platform(), noProfile);   // shellArgs.ts: per platform, and #44's setup-only -NoProfile
}

ipcMain.handle('pty:spawn', (e, opts: { cols: number; rows: number; cmd?: string; cwd?: string; name?: string; noProfile?: boolean }) => {
  const shell = defaultShell();
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
  /* A bus request's `cwd` is validated where it arrives (main/busCwd: absolute, a directory, inside
     home) and granted there; it may be outside the explorer's roots, which is the point of it. */
  const requested = opts.cwd && (inAllowed(opts.cwd) || isBusCwdGranted(opts.cwd)) ? opts.cwd : undefined;
  const cwd = [requested, aios.frameworkRoot(), os.homedir()].find(usable) as string;
  const p = pty.spawn(shell, loginArgs(shell, !!opts.noProfile), {
    name: 'xterm-256color',
    cols: opts.cols, rows: opts.rows,
    cwd,
    env: termEnv(opts.cmd, opts.name),
  });
  const id = nextId++;
  ptys.set(id, p);
  p.onData((data) => {
    if (!e.sender.isDestroyed()) e.sender.send('pty:data', { id, data });
    ptyTails.set(id, ((ptyTails.get(id) ?? '') + data).slice(-PTY_TAIL_CHARS));   // so a chat view opened mid-dialog can still see the dialog
    const sk = skins.get(id);
    if (sk && !sk.screenFed) sk.monitor.push(data);   // chat skin only: is the TUI waiting on a dialog? Until the renderer sends real screens, the raw stream is the best guess
  });
  p.onExit(({ exitCode }) => { ptys.delete(id); ptyTails.delete(id); void endSkin(id, true); if (!e.sender.isDestroyed()) e.sender.send('pty:exit', { id, exitCode }); });
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
ipcMain.on('pty:kill', (_e, { id }: { id: number }) => { ptys.get(id)?.kill(); ptys.delete(id); ptyTails.delete(id); void endSkin(id, false); });

/* ── CHAT SKIN ───────────────────────────────────────────────────────────────────────────────────
   The chat view is a SKIN over a terminal pane, not a second session. The pty and the `claude`
   process inside it stay the only source of truth; the chat reads along in two ways:
     · the session's transcript file, followed live (transcriptTail → core/transcriptChat), which
       gives the conversation, tool lines, the turn state and the context size;
     · the tail of the pty's own output, only to notice that the TUI is waiting on a dialog the
       transcript cannot show (permission, folder trust, a picker, a question — core/tuiPrompt).
   The chat never types for the operator and never answers a dialog; it points at the terminal.
   `paneId` IS the pty id: pty:spawn returns it, the renderer keys its `panes` Map and ptyWrite by
   it, and `ptys` is keyed by it here — one number all the way through. */
interface Skin {
  sender: Electron.WebContents; monitor: PromptMonitor; onGone: () => void; screenFed: boolean;
  /** Reads the reply being written off the screen snapshots (core/screenStream). Only fed while a transcript is followed. */
  stream: StreamTracker; following: boolean; send: (ev: Record<string, unknown>) => void;
}
const skins = new Map<number, Skin>();
const tail = createTranscriptTail();
/* A window onto everything main sends to a chat view, for the smoke gate only: it measures the streaming
   (how many previews arrived before the transcript line, how early) without the gate re-implementing any
   of the pipeline. Null in a normal run, and it only ever READS. `screen` entries are internal timings. */
let skinTap = null as ((paneId: number, ev: Record<string, unknown>) => void) | null;

/* What a dialog's rows look like on the wire: bounded, and only the fields the card needs. The parser
   (core/tuiPrompt) decided what each key is; nothing here adds or edits a key. */
function promptWire(prompt: TuiPrompt | undefined): Record<string, unknown> {
  if (!prompt) return {};
  const options = (prompt.options ?? []).slice(0, 12).map((o) => ({
    n: o.n, label: String(o.label).slice(0, 200), selected: !!o.selected, key: o.key, ...(o.freeText ? { freeText: true } : {}),
  }));
  return { ...(prompt.question ? { question: prompt.question.slice(0, 300) } : {}), ...(options.length ? { options } : {}) };
}

async function endSkin(paneId: number, flush: boolean): Promise<void> {
  const k = skins.get(paneId);
  if (!k) return;
  skins.delete(paneId);
  k.monitor.dispose();
  try { k.sender.removeListener('destroyed', k.onGone); } catch { /* sender already gone */ }
  if (flush) await tail.finish(paneId).catch(() => tail.unwatch(paneId));   // a session's last lines land just before it exits
  else tail.unwatch(paneId);
}

/* `sessionId` may be null: "watch this pane's dialogs, there is no transcript yet". A brand-new
   session in a folder Claude has not seen blocks on the trust dialog BEFORE it registers a session
   id, so a chat view that waited for the id would sit on "connecting" with the only thing that
   matters hidden behind it. A later watch with the real id keeps the same monitor, so a dialog that
   is still open is not forgotten (and not announced twice) when the id arrives. */
ipcMain.handle('chatSkin:watch', async (e, paneId: number, sessionId: string | null): Promise<{ ok: true; file: string } | { ok: false; error: 'not-found' | 'bad-id' }> => {
  const id = Number(paneId);
  const transcript = sessionId !== null && sessionId !== undefined;
  if (!Number.isInteger(id) || id < 0 || (transcript && !isSessionId(sessionId))) return { ok: false, error: 'bad-id' };
  const sender = e.sender;
  let k = skins.get(id);
  if (k && k.sender !== sender) { await endSkin(id, false); k = undefined; }
  tail.unwatch(id);                               // one transcript per pane: a new session id replaces the old one
  if (!k) {
    const send = (body: Record<string, unknown>): void => {
      const ev = { paneId: id, ...body };
      skinTap?.(id, ev);
      if (!sender.isDestroyed()) sender.send('chatSkin:event', ev);
    };
    const monitor = createPromptMonitor({
      onChange: (kind, hint, prompt) => send({ type: 'prompt', kind, ...(hint ? { hint } : {}), ...promptWire(prompt) }),
      /* the SAME dialog with its cursor moved: the keys of an unnumbered menu are relative to the cursor, so the card
         must adopt these. `refresh` tells the renderer this is not a new dialog (it must not re-enable a used card). */
      onRefresh: (prompt) => send({ type: 'prompt', kind: prompt.kind, ...(prompt.hint ? { hint: prompt.hint } : {}), ...promptWire(prompt), refresh: true }),
    });
    const onGone = (): void => { void endSkin(id, false); };
    sender.once('destroyed', onGone);             // a closed or reloaded window must not leave a watcher behind
    k = { sender, monitor, onGone, screenFed: false, stream: createStreamTracker(), following: false, send };
    skins.set(id, k);
    const seen = ptyTails.get(id);
    if (seen) monitor.push(seen);
  }
  k.following = transcript;
  k.stream.reset();                               // a new watch is a new transcript: a preview of the old one has nothing to be replaced by
  if (!transcript) return { ok: true, file: '' };
  const skin = k;
  return tail.watch(id, sessionId as string, (ev) => {
    // a finished tool or a new operator message proves the dialog that was open has been answered
    if (ev.type === 'items' && ev.items.some((it) => it.role === 'user' || (it.tool && it.tool.status !== 'running'))) skin.monitor.clear();
    /* The finished message replaces the preview: tell the renderer which transcript line IS the previewed text BEFORE
       the items event, so it hands the preview's node to that item (same place, no second bubble, no jump). */
    if (ev.type === 'items') { const a = skin.stream.items(ev.items); if (a) skin.send({ ...a }); }
    else if (ev.type === 'turn') { if (ev.open) skin.stream.begin(); else skin.stream.end(); }
    else if (ev.type === 'reset') skin.stream.reset();
    const { paneId: _pid, ...rest } = ev as { paneId: number } & Record<string, unknown>;
    skin.send({ ...rest, sid: sessionId });       // which transcript this was read from: the view drops what was in flight when the pane moved on
  });
});
/* The renderer's terminal emulator is the only thing that knows what the screen looks like NOW, so
   it sends snapshots while the chat view is up; once one arrives the raw stream is no longer fed to
   the monitor (a mix of the two would let a differential repaint talk the monitor out of a dialog
   that is still open). Only the sender that owns the watch may feed it. The same snapshot also feeds the
   streaming preview. That extractor runs HERE, not in the renderer: it is a pure TypeScript core with unit
   tests (the renderer is plain JS with no imports, so it would need a second copy), it needs the transcript
   items to decide when the preview becomes the real message (main sees both streams), and the renderer
   then receives only the text that changed instead of a screenful every 150 ms. */
ipcMain.on('chatSkin:screen', (e, paneId: number, text: string) => {
  const k = skins.get(Number(paneId));
  if (!k || k.sender !== e.sender || typeof text !== 'string') return;
  k.screenFed = true;
  k.monitor.screen(text.slice(-8192));
  if (!k.following) return;                       // no transcript to take the preview's place: a bubble that is never replaced must never be drawn
  const t0 = performance.now();
  const ev = k.stream.screen(text);
  skinTap?.(Number(paneId), { type: 'screen', bytes: text.length, ms: performance.now() - t0 });
  if (ev) k.send({ ...ev });
});
ipcMain.handle('chatSkin:unwatch', (_e, paneId: number) => endSkin(Number(paneId), false));
/* The operator scrolled to the top of what the chat view holds: read the next window of the transcript above it (see
   transcriptTail.loadEarlier). Only the window that owns the pane may ask; the answer comes back as an `earlier` event. */
ipcMain.handle('chatSkin:earlier', async (e, paneId: number): Promise<{ ok: boolean }> => {
  const id = Number(paneId);
  const k = Number.isInteger(id) ? skins.get(id) : undefined;
  if (!k || k.sender !== e.sender) return { ok: false };
  return { ok: await tail.loadEarlier(id) };
});
/* The usage bar. ~/.claude/statusline-payload.json is the LAST payload ANY Claude Code session on this
   machine wrote, so its model, effort and context may belong to another conversation. The tab sends its own
   session id and `scopeStatusToSession` keeps those per-session fields only when the payload's session_id is
   the same; otherwise they are omitted and `sessionMatch` is false (a tab with no id yet, or a bad id, is
   simply "no match"). The account-wide numbers (5-hour, weekly and their resets) are always returned. An absent
   field stays absent — nothing here defaults a percentage to 0. */
ipcMain.handle('chat:status', async (_e, sessionId: unknown) => {
  const tabId = isSessionId(sessionId) ? sessionId : null;
  try { return mergeStatus(undefined, scopeStatusToSession(parseStatuslinePayload(await fs.promises.readFile(path.join(aios.claudeConfigDir(), 'statusline-payload.json'), 'utf8')), tabId)); }
  catch { return mergeStatus(undefined, { sessionMatch: false }); }   // no file yet, or unreadable: the bar just has fewer fields
});

/* The slash-command popup in the chat composer. The renderer sends what is in the box and the pane's working
   folder; main answers with the ranked rows, or [] when nothing should be offered (not a lone slash word, no
   match, or the word is already a complete command). Ranking is done HERE, in the pure core module, so the
   renderer (plain JS, no imports) never carries a second copy of the rules. The disk listing is cached for a
   few seconds per folder: a keystroke must not walk the commands folders, but a command file the operator
   just saved appears almost at once. Read-only; the text is capped and must start with a slash. */
const slashCache = new Map<string, { at: number; list: Promise<SlashCommand[]> }>();
ipcMain.handle('slashCommands:list', async (_e, cwd: unknown, text: unknown): Promise<SlashCommand[]> => {
  if (typeof text !== 'string' || text.length > 200 || text.charCodeAt(0) !== 47) return [];
  const dir = typeof cwd === 'string' && path.isAbsolute(cwd) ? cwd : null;
  const key = dir ?? '';
  let hit = slashCache.get(key);
  if (!hit || Date.now() - hit.at > 5000) {
    if (slashCache.size >= 24) slashCache.delete(slashCache.keys().next().value as string);
    hit = { at: Date.now(), list: listSlashCommands({ configDir: aios.claudeConfigDir(), cwd: dir, aiosCommands: aios.discoverCommands() }).catch(() => builtinCommands()) };
    slashCache.set(key, hit);
  }
  return slashSuggestions(await hit.list, text);
});

/* An image pasted (or dragged from a browser) into the chat composer has no file on disk, and Claude Code reads a
   picture from a PATH in the message. So main writes the bytes to a file of its own naming and hands back the path.
   Where it lands: <system temp>/aios-chat-paste/paste-<time>-<random>.<ext>. The system temp folder is the right home
   for a thing that only has to outlive the message that mentions it: the OS sweeps it, and a pasted screenshot never
   becomes a stray file in the operator's project. Bounded on every side: only the four image types a model can read,
   a size ceiling, a name the renderer never chooses (so it cannot aim a write anywhere), and files older than a day
   are removed on the next paste. Nothing is read back and nothing outside that one folder is touched. */
const PASTE_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const PASTE_MAX_BYTES = 25 * 1024 * 1024;
ipcMain.handle('chatFiles:savePastedImage', async (_e, bytes: unknown, mime: unknown): Promise<string | null> => {
  const ext = typeof mime === 'string' ? PASTE_EXT[mime.toLowerCase()] : undefined;
  if (!ext || !(bytes instanceof ArrayBuffer || ArrayBuffer.isView(bytes))) return null;
  const buf = bytes instanceof ArrayBuffer ? Buffer.from(bytes) : Buffer.from((bytes as ArrayBufferView).buffer, (bytes as ArrayBufferView).byteOffset, (bytes as ArrayBufferView).byteLength);
  if (!buf.length || buf.length > PASTE_MAX_BYTES) return null;
  try {
    const dir = path.join(fs.realpathSync(os.tmpdir()), 'aios-chat-paste');
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
    const cutoff = Date.now() - 24 * 3600 * 1000;
    for (const f of await fs.promises.readdir(dir).catch(() => [] as string[])) {
      if (!/^paste-[\w-]+\.(png|jpg|gif|webp)$/.test(f)) continue;   // only our own files are ever swept
      const full = path.join(dir, f);
      const st = await fs.promises.stat(full).catch(() => null);
      if (st && st.mtimeMs < cutoff) await fs.promises.unlink(full).catch(() => undefined);
    }
    const file = path.join(dir, `paste-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.${ext}`);
    await fs.promises.writeFile(file, buf, { mode: 0o600 });
    return file;
  } catch { return null; }
});

/* ── SMOKE: the chat view's ASSETS, wherever the app was loaded from ────────────────────────────
   The real-session gate below needs a model and a login, so it can skip; this one needs neither and
   never skips. It answers the packaging question the unit tests cannot: when the app runs from
   app.asar, does the chat view still find its markdown parser, its highlighter, its stylesheet and
   its preload bridge, and does a bubble that carries markdown (plus a hostile payload) come out
   formatted AND sanitised? Those are the four things the package can lose without any test noticing:
   index.html reaches marked/highlight through ../node_modules, which exists in the asar only because
   they are `dependencies`, not `devDependencies`. It runs the app's own chatRender on a detached node,
   so nothing is opened, painted or sent. */
type SmokeAssetsVerdict = { ok: boolean; detail: string };
async function chatAssetsSmoke(win: BrowserWindow): Promise<SmokeAssetsVerdict> {
  const say = (m: string): void => console.log(`shell-smoke: chat assets — ${m}`);
  try {
    const where = app.getAppPath();
    const inAsar = /\.asar$/.test(where);
    const url = win.webContents.getURL();
    say(`isPackaged=${app.isPackaged}; app path ends in ${path.basename(where)}${inAsar ? ' (inside the asar)' : ' (a plain folder)'}; renderer url ${url.includes('app.asar') ? 'is inside app.asar' : 'is outside an asar'}`);
    if (app.isPackaged && !(inAsar && url.includes('app.asar'))) return { ok: false, detail: 'a packaged build is not running from its asar' };
    const r = await win.webContents.executeJavaScript(`(() => {
      const o = {};
      o.marked = typeof marked !== 'undefined' && typeof marked.Marked === 'function';
      o.hljs = !!(window.hljs && window.hljs.getLanguage && window.hljs.getLanguage('javascript'));
      const sh = window.glassShell;
      o.bridge = !!sh && ['chatSkinWatch', 'chatSkinUnwatch', 'chatSkinEarlier', 'onChatSkinEvent'].every((k) => typeof sh[k] === 'function');
      let rules = 0;
      for (const sheet of document.styleSheets) { try { for (const rule of sheet.cssRules) if (rule.selectorText && rule.selectorText.includes('.cs-')) rules++; } catch (e) { /* cross-origin sheet */ } }
      o.cssRules = rules;
      const t = document.createElement('div');
      chatRender(t, '**bold** and \`code\`\\n\\n| a | b |\\n|---|---|\\n| 1 | 2 |\\n\\n\`\`\`js\\nconst x = 1;\\n\`\`\`\\n\\n<img src=x onerror="window.__pwn=1"><script>window.__pwn=2</script>\\n\\n[bad](javascript:window.__pwn=3) [ok](https://example.com)');
      o.strong = !!t.querySelector('strong');
      o.table = !!t.querySelector('table');
      o.highlighted = !!t.querySelector('pre code.hljs span');
      o.noActive = !t.querySelector('img, script, iframe, [onerror], [onclick], [style]');
      o.links = [...t.querySelectorAll('a')].map((a) => a.getAttribute('href'));
      o.badLink = o.links.some((h) => !/^(https?:|mailto:)/i.test(h || ''));
      o.escapedText = t.textContent.includes('onerror');   // the raw html shows up as TEXT, not as markup
      o.pwn = window.__pwn === undefined;
      return o;
    })()`) as Record<string, unknown>;
    say(`marked=${r.marked} highlight.js=${r.hljs} preload bridge=${r.bridge} chat css rules=${r.cssRules}; bubble: strong=${r.strong} table=${r.table} highlighted code=${r.highlighted}; sanitizer: no active elements/attributes=${r.noActive} hostile html shown as text=${r.escapedText} nothing executed=${r.pwn} links=${JSON.stringify(r.links)}`);
    const bad: string[] = [];
    if (!r.marked) bad.push('marked did not load');
    if (!r.hljs) bad.push('highlight.js did not load');
    if (!r.bridge) bad.push('the preload bridge has no chat methods');
    if (!(Number(r.cssRules) > 20)) bad.push(`the chat stylesheet is missing (${r.cssRules} .cs- rules)`);
    if (!r.strong || !r.table) bad.push('markdown did not render to bold/table');
    if (!r.highlighted) bad.push('code was not highlighted');
    if (!r.noActive || !r.pwn) bad.push('the sanitizer let active markup through');
    if (r.badLink) bad.push('a non-http link survived the sanitizer');
    if (!r.escapedText) bad.push('the hostile html did not appear as escaped text');
    return bad.length ? { ok: false, detail: bad.join('; ') } : { ok: true, detail: 'ok' };
  } catch (e) { return { ok: false, detail: String((e as Error)?.message ?? e) }; }
}

/* ── SMOKE: the chat view over a REAL Claude Code session, end to end ───────────────────────────
   Everything else in this file proves the chat view with fixtures; this proves it against the real
   `claude`, in the hidden smoke window, by driving the same functions the operator's hands drive:
   createPane (the launch path every session uses), the Chat/Terminal view mode (the function the Settings selector calls), the composer
   (Enter → submitToPty) and the bubbles it paints from the transcript.

   WHAT IT TOUCHES, AND WHY THAT IS SAFE. A fresh temp folder is the session's cwd, so the session
   is new, cheap (--model haiku) and nothing of the operator's is read or written by it:
     · `--setting-sources project` keeps the operator's user-level hooks, status line, remote
       control and voice out of a throwaway session (none of them belong in a test);
     · the run's own cleanup removes the pane, the claude process, the temp folder and the transcript
       folder Claude Code made for that cwd — verified by name before anything is deleted.
   Without `claude` or a login the gate is SKIPPED (a developer laptop, CI). With AIOS_SMOKE_CHAT=1 a
   gate that cannot run is a FAILURE, because "did not run" must never read as "passed"; with
   AIOS_SMOKE_CHAT=0 it is skipped on purpose. */
type SmokeChatVerdict = { status: 'ok' | 'skipped' | 'failed'; detail: string };

async function chatViewSmoke(win: BrowserWindow): Promise<SmokeChatVerdict> {
  const mode = process.env.AIOS_SMOKE_CHAT;
  const strict = mode === '1';
  const say = (m: string): void => console.log(`shell-smoke: chat view — ${m}`);
  if (mode === '0') return { status: 'skipped', detail: 'disabled by AIOS_SMOKE_CHAT=0' };
  const rd = aios.readiness();
  if (!rd.claude || !rd.signedIn) {
    const why = `no usable claude on this machine (on PATH=${rd.claude}, signed in=${rd.signedIn})`;
    return strict ? { status: 'failed', detail: `strict mode, but ${why}` } : { status: 'skipped', detail: why };
  }

  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  const js = <T>(code: string): Promise<T> => win.webContents.executeJavaScript(code) as Promise<T>;
  const psTable = (): Promise<Map<number, number>> => new Promise((resolve) => {
    execFile('ps', ['-axo', 'pid=,ppid='], (err, out) => {
      const m = new Map<number, number>();
      if (!err) for (const line of String(out).split('\n')) { const [a, b] = line.trim().split(/\s+/).map(Number); if (a && b >= 0) m.set(a, b); }
      resolve(m);
    });
  });
  const descendants = async (root: number): Promise<number[]> => {
    const t = await psTable();
    const out: number[] = [];
    const walk = (pid: number): void => { for (const [c, par] of t) if (par === pid && !out.includes(c)) { out.push(c); walk(c); } };
    walk(root);
    return out;
  };
  const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

  const tmpRoot = fs.realpathSync(os.tmpdir());
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'aios-smoke-chat-'));
  const tag = path.basename(dir).slice('aios-smoke-chat-'.length);
  const name = `smoke-chat-${tag.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
  const word = `PONG-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
  const ask = `Reply with exactly the word ${word} and nothing else`;
  const t0 = Date.now();
  const since = (): string => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

  let paneId = -1;
  let priorMode = '';
  let sessionId = '';
  const kids = new Set<number>();
  const problems: string[] = [];
  let result: SmokeChatVerdict = { status: 'failed', detail: 'did not finish' };

  const probe = (): Promise<{ view: string; exited: boolean; sessionId: string | null; watched: string | null; prompt: string | null;
    state: string | null; ptyAge: number; hidden: boolean; turnOpen: boolean; screen: string[]; rows: Array<{ who: string; text: string; hidden: boolean }> } | null> => js(`(() => {
      const p = panes.get(${paneId}); if (!p) return null;
      const cs = p.chatSkin;
      const buf = p.term.buffer.active; const screen = [];
      for (let i = Math.max(0, buf.length - 16); i < buf.length; i++) { const l = buf.getLine(i); if (l) { const s = l.translateToString(true); if (s.trim()) screen.push(s); } }
      const rows = cs ? [...cs.log.querySelectorAll('.chat-row')].map((r) => ({
        who: r.classList.contains('who-user') ? 'user' : 'claude',
        text: (r.querySelector('.chat-bubble') || r).textContent || '', hidden: r.hidden })) : [];
      return { view: p.view || 'term', exited: !!p.exited, sessionId: p.sessionId || null, watched: cs ? cs.watched : null,
        prompt: cs ? cs.promptKind : null, state: cs ? cs.state : null, ptyAge: Date.now() - (p.lastPtyAt || 0),
        hidden: document.hidden, turnOpen: cs ? !!cs.turnOpen : false, screen: screen.slice(-8), rows };
    })()`);
  const fail = (why: string, p?: { screen: string[] } | null): never => {
    throw new Error(why + (p && p.screen.length ? ` | screen: ${p.screen.slice(-4).map((l) => l.trim()).join(' / ').slice(0, 300)}` : ''));
  };

  try {
    // 1. open a real session through the renderer's own launch path (the folder is entered by the
    //    shell: pty:spawn confines `cwd` to the allowed roots, and a temp folder is none of them)
    /* The session must not inherit the identity of whatever launched this run: a smoke started from
       inside a Claude session carries that session's bridge, messaging socket and id in its
       environment, and the new one would attach to them. `env -u` drops them for this one command.
       The flags keep a throwaway session from reaching the operator's world: hooks off (their
       Stop hook can speak aloud), the status line neutralised (it rewrites the global usage
       payload the chat view reads), no remote control, no MCP servers. User settings are otherwise
       left alone, because permission defaults live there and a first-run nag appears without them. */
    const inherited = Object.keys(process.env)
      .filter((k) => (/^CLAUDE_CODE_/.test(k) && k !== 'CLAUDE_CODE_FORCE_SESSION_PERSIST') || k === 'CLAUDECODE' || k === 'CLAUDE_PID' || k === 'CLAUDE_EFFORT')
      .map((k) => `-u ${k}`).join(' ');
    const flags = JSON.stringify({ disableAllHooks: true, remoteControlAtStartup: false, statusLine: { type: 'command', command: 'true' } });
    const opened = await js<number | null>(`(async () => {
      const cmd = 'cd ' + shq(${JSON.stringify(dir)}) + ' && env ${inherited} ' + CLAUDE + ' --model haiku --name ' + shq(${JSON.stringify(name)})
        + ' --permission-mode default --strict-mcp-config --settings ' + shq(${JSON.stringify(flags)});
      return await createPane({ name: ${JSON.stringify(name)}, cmd, bypassReady: true });
    })()`);
    if (typeof opened !== 'number') return fail('createPane returned no pane');
    paneId = opened;
    const shellPid = ptys.get(paneId)?.pid;
    say(`pane ${paneId} opened in ${path.basename(dir)} (claude --model haiku --name ${name})`);

    // 2. the operator's choice in Settings, made at once: a new session is still blocked on the folder-trust
    //    dialog and has no id, which is exactly when the chat view must not hide the terminal
    /* The same function the Settings selector and the shortcut call (chatSkinSetMode), so the pane that is ALREADY open follows the
       mode. `persist: false` on purpose: the setting lives in the framework's `.glass/shell.json` (the operator's ~/aios unless
       GLASS_FRAMEWORK_PATH points elsewhere), NOT in the throwaway userData this run was given, so a persisted write would flip the
       operator's real preference from a QA run. The mode it found is put back in the cleanup. */
    priorMode = await js<string>('chatMode');
    const view = await js<string>(`(async () => { await chatSkinSetMode('chat', { persist: false }); const p = panes.get(${paneId}); return p ? (p.view || 'term') : 'no pane'; })()`);
    if (view !== 'chat') return fail(`the chat mode did not put the open Claude pane in chat view (view=${view})`);
    say('chat view on (via the same mode setting as Settings, applied to the open pane)');
    /* The pane has no header and the tab has no switch: the view is one setting. A header or a tab icon that crept back would be a second
       switch and a strip of dead space above the log, and nothing else in this run would notice it. */
    const shape = await js<string>(`(() => { const p = panes.get(${paneId}); const cs = p && p.chatSkin; if (!cs) return 'no chat view';
      if (cs.root.querySelector('.cs-head, .cs-switch, .cs-gear, .cs-menu')) return 'the chat view has a header again';
      if (p.tab.querySelector('.tview') || p.viewBtn) return 'the tab has a view switch again';
      if (cs.root.firstElementChild !== cs.log) return 'the log is not the first thing in the chat view';
      return 'ok'; })()`);
    if (shape !== 'ok') return fail(shape);
    say('no pane header and no tab switch; the log starts the view');

    // 3. answer the trust dialog if there is one, and wait for the pane to adopt its session id
    let trustSeen = false; let trustAnswered = false; let nagAnswered = false; let lastTry = 0; let byCard = 0; let direct = 0;
    /* The dialog card is the operator's own door to these questions, so the gate presses ITS button (the same click handler
       a hand reaches) and only falls back to writing the keys itself when no card is there or it did not answer. */
    const pressCard = (re: string): Promise<string | null> => js(`(() => { const cs = panes.get(${paneId}).chatSkin; if (!cs || !cs.dlg) return null;
      const b = [...cs.dlg.querySelectorAll('.csd-opt')].find((x) => new RegExp(${JSON.stringify(re)}, 'i').test(x.querySelector('.csd-l').textContent));
      if (!b || b.disabled) return null; b.click(); return b.querySelector('.csd-l').textContent; })()`);
    const adoptDeadline = Date.now() + 75000;
    let st = await probe();
    for (; Date.now() < adoptDeadline; await sleep(400), st = await probe()) {
      if (!st) return fail('the pane disappeared');
      if (st.exited) return fail('the pty exited before the session came up', st);
      if (st.prompt === 'trust' && !trustSeen) { trustSeen = true; say(`detector emitted prompt kind 'trust' after ${since()}`); }
      /* Dialogs this gate answers itself. The folder-trust one is the point (the detector must have
         seen it); the "make auto mode your default" offer is a first-run nag of this CLI that must be
         answered "No": the "Yes" would rewrite the operator's permission default. Both start with the
         cursor on the WRONG row. The card's own buttons are tried first (they carry the keys that
         account for that); only when there is no card does this write the keys itself, reading the
         screen and moving the cursor before confirming. */
      const screenText = st.screen.join('\n');
      const nag = /Make auto mode your default/i.test(screenText);
      if ((st.prompt === 'trust' || nag) && Date.now() - lastTry > 1500) {
        lastTry = Date.now();
        const want = nag ? /No, keep/i : /Yes, I trust/i;
        const pressed = await pressCard(nag ? '^No, keep' : '^Yes, I trust');
        if (pressed) { byCard++; if (nag) nagAnswered = true; else trustAnswered = true; say(`the dialog card's "${pressed.slice(0, 40)}" button pressed (${nag ? 'auto-mode offer' : 'folder trust'}), ${since()} in`); }
        else {
          direct++;
          const cur = [...st.screen].reverse().find((l) => l.includes('❯')) ?? '';   // the LAST cursor on screen: the composer's own ❯ sits above a dialog
          if (want.test(cur)) { ptys.get(paneId)?.write('\r'); if (nag) nagAnswered = true; else trustAnswered = true; }
          else ptys.get(paneId)?.write('\x1b[B');
        }
      }
      if (st.sessionId && st.watched === st.sessionId) break;
    }
    if (!st || !st.sessionId) return fail(`no session id after ${since()}${trustSeen ? '' : " (and the detector never reported the trust dialog)"}`, st);
    if (st.watched !== st.sessionId) return fail(`the chat view is not following the session (watched=${st.watched}, hidden window: document.hidden=${st.hidden})`, st);
    sessionId = st.sessionId;
    say(`session ${sessionId.slice(0, 8)}… adopted after ${since()}; trust dialog ${trustSeen ? (trustAnswered ? 'detected and answered' : 'detected') : 'not shown'}${nagAnswered ? '; auto-mode offer declined' : ''}; ${byCard} answer(s) by the card's buttons, ${direct} by writing keys directly; document.hidden=${st.hidden}`);
    if (shellPid) for (const k of await descendants(shellPid)) kids.add(k);

    // 4. wait for the TUI to settle at its prompt, then type into the composer and press Enter there
    /* "Settled" means the composer is on screen (its own ❯ line) and the output has gone quiet. Text typed
       before the TUI reads its input is dropped by the tty without a trace, and that is a test of
       timing, not of the chat view. */
    const composerUp = (x: { screen: string[] } | null): boolean => !!x && x.screen.some((l) => l.trim().startsWith('❯'));
    for (let i = 0; i < 60 && st && (st.ptyAge < 1800 || st.prompt || !composerUp(st)); i++) { await sleep(300); st = await probe(); }
    if (st && st.prompt) return fail(`a dialog (${st.prompt}) is still open`, st);
    const sent = await js<boolean>(`(() => {
      const cs = panes.get(${paneId}).chatSkin;
      cs.input.value = ${JSON.stringify(ask)};
      cs.input.dispatchEvent(new Event('input', { bubbles: true }));
      cs.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      return cs.input.value === '';
    })()`);
    if (!sent) return fail('Enter in the composer did not send the message');
    const sentAt = Date.now();
    say(`message sent from the composer: "${ask}"`);

    // 5. the operator's bubble and Claude's answer must both be painted from the transcript
    let userBubble = false; let answer = false;
    const replyDeadline = Date.now() + 90000;
    for (; Date.now() < replyDeadline && !(userBubble && answer); await sleep(500)) {
      st = await probe();
      if (!st) return fail('the pane disappeared while waiting for the answer');
      if (process.env.AIOS_SMOKE_CHAT_DEBUG && (Date.now() - sentAt) % 3000 < 500) say(`debug +${Math.round((Date.now() - sentAt) / 1000)}s rows=${st.rows.length} state=${st.state} ptyAge=${st.ptyAge} screen=${JSON.stringify(st.screen.slice(-5))}`);
      if (st.prompt) { say(`a dialog (${st.prompt}) interrupted the turn`); return fail(`dialog '${st.prompt}' while waiting for the answer`, st); }
      userBubble = st.rows.some((r) => r.who === 'user' && !r.hidden && r.text.includes(word));
      answer = st.rows.some((r) => r.who === 'claude' && !r.hidden && r.text.includes(word));
    }
    if (!userBubble) return fail(`no operator bubble with ${word} after ${((Date.now() - sentAt) / 1000).toFixed(0)}s`, st);
    if (!answer) return fail(`no assistant bubble with ${word} after ${((Date.now() - sentAt) / 1000).toFixed(0)}s (rows: ${st?.rows.map((r) => r.who).join(',')})`, st);
    say(`operator bubble and assistant bubble both carry ${word} (${((Date.now() - sentAt) / 1000).toFixed(1)}s after Enter)`);

    // 6. STREAMING, measured: a long answer, with a tap on everything main sends to the view
    const tapped: Array<{ t: number; ev: Record<string, unknown> }> = [];
    skinTap = (pid, ev) => { if (pid === paneId) tapped.push({ t: Date.now(), ev }); };
    const metrics0 = app.getAppMetrics();
    const cpu: Array<{ main: number; renderer: number }> = [];
    const askLong = 'write 25 numbered short lines about rivers';
    const sentLong = await js<boolean>(`(() => {
      const cs = panes.get(${paneId}).chatSkin;
      cs.input.value = ${JSON.stringify(askLong)};
      cs.input.dispatchEvent(new Event('input', { bubbles: true }));
      cs.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      return cs.input.value === '';
    })()`);
    if (!sentLong) return fail('Enter in the composer did not send the long-answer request');
    const sentLongAt = Date.now();
    void metrics0;
    const finalItem = (): { t: number; uuid: string; text: string } | null => {
      for (const x of tapped) {
        if (x.ev.type !== 'items') continue;
        for (const it of x.ev.items as Array<{ uuid: string; role: string; text?: string }>) {
          if (it.role === 'assistant' && typeof it.text === 'string' && /(^|\n)\s*25[.)]/.test(it.text)) return { t: x.t, uuid: it.uuid, text: it.text };
        }
      }
      return null;
    };
    let fin = finalItem();
    for (let i = 0; Date.now() < sentLongAt + 90000 && !fin; i++) {
      await sleep(500);
      const m = app.getAppMetrics();
      cpu.push({ main: m.filter((x) => x.type === 'Browser').reduce((a, x) => a + x.cpu.percentCPUUsage, 0), renderer: m.filter((x) => x.type === 'Tab').reduce((a, x) => a + x.cpu.percentCPUUsage, 0) });
      st = await probe();
      if (st && st.prompt) return fail(`dialog '${st.prompt}' while waiting for the long answer`, st);
      // mark the provisional bubble's node, so that after the finished message lands we can tell whether it took that SAME node over
      await js(`(() => { const n = panes.get(${paneId}).chatSkin.log.querySelector('.cs-prov'); if (n && !n.dataset.smk) n.dataset.smk = String(Date.now()); return true; })()`);
      fin = finalItem();
    }
    if (!fin) return fail('the long answer never reached the transcript', st);
    await sleep(1200);   // let the turn close and the last events land
    skinTap = null;
    const streams = tapped.filter((x) => x.ev.type === 'stream');
    const before = streams.filter((x) => typeof x.ev.text === 'string' && x.t < fin!.t);
    const screens = tapped.filter((x) => x.ev.type === 'screen' && x.t >= sentLongAt);
    const prefixOk = before.filter((x) => sameMessage(String(x.ev.text), fin!.text, { headCut: x.ev.headCut === true })).length;
    const adopts = streams.filter((x) => x.ev.adopt === fin!.uuid).length;
    const lens = before.map((x) => String(x.ev.text).length);
    const avg = (a: number[]): number => a.length ? a.reduce((p, c) => p + c, 0) / a.length : 0;
    const extractMs = screens.map((x) => Number(x.ev.ms));
    const snapMs = await js<number>(`(() => { const p = panes.get(${paneId}); const t0 = performance.now(); for (let i = 0; i < 40; i++) chatSkinScreenText(p); return (performance.now() - t0) / 40; })()`);
    say(`streaming — final message ${fin.text.length} chars, ${before.length} stream events before the transcript line`
      + (before.length ? `, first text ${((fin.t - before[0].t) / 1000).toFixed(1)}s before it, previews ${lens[0]} → ${lens[lens.length - 1]} chars (${(100 * lens[lens.length - 1] / fin.text.length).toFixed(0)}% of the final)` : '')
      + `; prefix of the final: ${prefixOk}/${before.length}; adopt events for the final item: ${adopts}`);
    say(`streaming cost — ${screens.length} screen snapshots in ${((fin.t - sentLongAt) / 1000).toFixed(1)}s; extractor ${avg(extractMs).toFixed(2)} ms avg / ${Math.max(0, ...extractMs).toFixed(2)} ms max in main; snapshot build ${snapMs.toFixed(2)} ms in the renderer; cpu avg main ${avg(cpu.map((c) => c.main)).toFixed(1)}% renderer ${avg(cpu.map((c) => c.renderer)).toFixed(1)}%`);
    // what the operator SAW: one bubble for the answer, in the node the preview used, and nothing left hanging
    const seen = await js<{ rows: number; marked: boolean; leftover: number; text: number }>(`(() => {
      const cs = panes.get(${paneId}).chatSkin;
      const norm = (x) => String(x || '').toLowerCase().replace(/[^\\p{L}\\p{N}]+/gu, '');
      const rows = [...cs.log.querySelectorAll('.chat-row.who-claude')].filter((r) => !r.hidden && norm(r.textContent).includes(${JSON.stringify(normalizeForMatch(fin.text.replace(/^\s*(?:\d+[.)]|[-*•])\s+/gm, '')).slice(0, 40))}));
      return { rows: rows.length, marked: rows.length === 1 && !!rows[0].dataset.smk, leftover: cs.log.querySelectorAll('.cs-prov').length, text: rows.length ? (rows[0].textContent || '').length : 0 };
    })()`);
    say(`streaming, as painted — answer bubbles: ${seen.rows}; the final bubble is the node the preview used: ${seen.marked}; previews left hanging: ${seen.leftover}`);
    if (seen.rows !== 1) return fail(`the long answer is on screen ${seen.rows} times (a preview was duplicated or the message never painted)`);
    if (seen.leftover) return fail('a provisional bubble was left hanging after the message landed');
    if (before.length > 0 && !seen.marked) return fail('the finished message did not take the preview\'s node over (no same-position replacement)');
    if (process.env.AIOS_SMOKE_CHAT_DEBUG) { for (const x of before.slice(0, 3).concat(before.slice(-2))) say(`debug stream ${JSON.stringify(String(x.ev.text).slice(0, 160))}`); say(`debug final ${JSON.stringify(fin.text.slice(0, 160))}`); }

    // 7. A REAL PERMISSION DIALOG, drawn as a card and answered by pressing its "No" button. The session runs with
    //    --permission-mode default, so a shell command that writes a file stops on "Do you want to proceed?". The gate
    //    only ever presses the button that REFUSES (and falls back to Esc, which also refuses): nothing is accepted, so
    //    nothing can run, in the temp folder or anywhere else.
    for (let i = 0; i < 80 && st && (st.ptyAge < 1500 || st.prompt || st.turnOpen); i++) { await sleep(300); st = await probe(); }   // the long answer's turn is over and the TUI is quiet
    const permFile = `smoke-perm-${crypto.randomBytes(3).toString('hex')}.txt`;
    const askPerm = `Use the Bash tool to run exactly this command and nothing else: touch ${permFile}`;
    const sentPerm = await js<boolean>(`(() => {
      const cs = panes.get(${paneId}).chatSkin;
      cs.input.value = ${JSON.stringify(askPerm)};
      cs.input.dispatchEvent(new Event('input', { bubbles: true }));
      cs.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      return cs.input.value === '';
    })()`);
    if (!sentPerm) return fail('Enter in the composer did not send the permission request');
    const dlgProbe = (): Promise<{ kind: string | null; q: string; opts: Array<{ n: number | null; label: string; selected: boolean; key: string; freeText: boolean }> | null;
      card: boolean; strip: boolean; buttons: string[]; disabled: boolean[]; used: boolean; label: string | null; link: string | null } | null> => js(`(() => {
        const p = panes.get(${paneId}); if (!p) return null; const cs = p.chatSkin;
        const d = cs.dlg;
        return { kind: cs.promptKind, q: cs.promptQ, opts: cs.promptOpts, card: !!(d && d.isConnected), strip: p.el.classList.contains('cs-strip'),
          buttons: d ? [...d.querySelectorAll('.csd-opt')].map((b) => b.textContent) : [], disabled: d ? [...d.querySelectorAll('.csd-opt')].map((b) => b.disabled) : [],
          used: !!cs.promptUsed, label: d ? d.getAttribute('aria-label') : null, link: d && d.querySelector('.csd-link') ? d.querySelector('.csd-link').textContent : null };
      })()`);
    let dlg = await dlgProbe();
    for (const deadline = Date.now() + 60000; Date.now() < deadline && dlg && !dlg.kind; await sleep(300)) dlg = await dlgProbe();
    if (!dlg || !dlg.kind) return fail('the permission request never raised a dialog (the command may have run unasked)', await probe());
    await sleep(600);   // let the card settle on its final options (the screen is read twice)
    dlg = await dlgProbe();
    if (!dlg) return fail('the pane disappeared');
    say(`dialog — kind '${dlg.kind}', question ${JSON.stringify(dlg.q)}, ${dlg.opts ? dlg.opts.length : 0} options: ${(dlg.opts ?? []).map((o) => `${o.n ?? '·'}${o.selected ? '*' : ''} ${JSON.stringify(o.label.slice(0, 48))} key=${JSON.stringify(o.key)}${o.freeText ? ' freeText' : ''}`).join(' | ')}`);
    say(`dialog — card drawn: ${dlg.card}, terminal strip: ${dlg.strip}, buttons: ${dlg.buttons.length}, aria-label ${JSON.stringify(dlg.label)}, link ${JSON.stringify(dlg.link)}`);
    if (!dlg.opts || !dlg.opts.length || !dlg.card || dlg.strip) return fail(`the real dialog did not become a card (options=${dlg.opts ? dlg.opts.length : 'none'}, card=${dlg.card}, strip=${dlg.strip})`);
    const noIdx = dlg.opts.findIndex((o) => /^No\b/i.test(o.label));
    if (noIdx < 0) return fail(`no option that refuses among: ${dlg.opts.map((o) => o.label).join(' / ')}`);
    const clicked = await js<boolean>(`(() => { const b = panes.get(${paneId}).chatSkin.dlg.querySelectorAll('.csd-opt')[${noIdx}]; if (!b || b.disabled) return false; b.click(); return true; })()`);
    if (!clicked) return fail('the "No" button could not be pressed');
    const afterClick = await dlgProbe();
    say(`dialog — pressed "${dlg.opts[noIdx].label.slice(0, 40)}" (key ${JSON.stringify(dlg.opts[noIdx].key)}); right after: used=${afterClick?.used}, buttons disabled=${afterClick?.disabled.every(Boolean)}`);
    if (!afterClick || !afterClick.used || !afterClick.disabled.every(Boolean)) return fail('the card did not disable itself after the click');
    let closed = false;
    for (const deadline = Date.now() + 15000; Date.now() < deadline && !closed; await sleep(300)) { const d = await dlgProbe(); closed = !!d && !d.kind && !d.card; }
    let viaEsc = false;
    if (!closed) {   // the button's key did not refuse by itself: say so, and refuse the way the TUI documents (Esc) so the run still ends clean
      viaEsc = true;
      ptys.get(paneId)?.write('\x1b');
      for (const deadline = Date.now() + 10000; Date.now() < deadline && !closed; await sleep(300)) { const d = await dlgProbe(); closed = !!d && !d.kind && !d.card; }
    }
    const ran = fs.existsSync(path.join(dir, permFile));
    say(`dialog — after the click the dialog ${closed ? 'closed' : 'is STILL open'}${viaEsc ? ' (only after Esc: the button key alone did not refuse)' : ' by itself'}; the command ${ran ? 'RAN' : 'did not run'}`);
    if (ran) return fail('the refused command ran anyway');
    if (!closed) return fail('the dialog did not close after pressing No');
    if (viaEsc) return fail('pressing the "No" button did not close the dialog by itself');

    // 8. /clear AND RESUME, in the same session: the id the pane follows changes twice, and the view must follow it
    //    with nothing of the other session left on screen. Costs two tiny turns (one word each).
    const wordB = `PONG-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    const typeIn = (text: string): Promise<boolean> => js<boolean>(`(() => {
      const cs = panes.get(${paneId}).chatSkin;
      cs.input.value = ${JSON.stringify(text)};
      cs.input.dispatchEvent(new Event('input', { bubbles: true }));
      cs.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      return cs.input.value === '';
    })()`);
    const quiet = async (): Promise<void> => { for (let i = 0; i < 80 && st && (st.ptyAge < 1800 || st.prompt || st.turnOpen || !composerUp(st)); i++) { await sleep(300); st = await probe(); } };
    const tailNow = (): string => { const c = tail.current(paneId); return c ? `${c.sessionId.slice(0, 8)}→${c.file ? path.basename(c.file).slice(0, 8) : 'no file'}` : 'none'; };
    const brief = (x: NonNullable<typeof st>): string => `view=${x.view} id=${(x.sessionId ?? 'null').slice(0, 8)} watched=${(x.watched ?? 'null').slice(0, 8)} tail=${tailNow()} rows=${x.rows.filter((r) => !r.hidden).length} A=${x.rows.filter((r) => r.text.includes(word)).length} B=${x.rows.filter((r) => r.text.includes(wordB)).length}`;
    /* sends `text`, then watches the pane until `done` holds, printing every CHANGE of what the pane follows and shows */
    const watchChange = async (what: string, text: string, done: (x: NonNullable<typeof st>) => boolean, ms: number): Promise<NonNullable<typeof st>> => {
      await quiet();
      if (!st) return fail('the pane disappeared');
      if (st.prompt) return fail(`a dialog (${st.prompt}) is open before ${what}`, st);
      if (!(await typeIn(text))) return fail(`Enter in the composer did not send ${what}`);
      const t1 = Date.now(); let last = '';
      for (; Date.now() - t1 < ms; await sleep(250)) {
        const x = await probe();
        if (!x) return fail(`the pane disappeared during ${what}`);
        st = x;
        const b = brief(x);
        if (b !== last) { last = b; say(`${what} +${((Date.now() - t1) / 1000).toFixed(1)}s ${b}`); }
        if (x.prompt) return fail(`dialog '${x.prompt}' during ${what}`, x);
        if (done(x)) { await sleep(1200); const y = await probe(); if (y) { st = y; const c = brief(y); if (c !== last) say(`${what} settled ${c}`); } return st as NonNullable<typeof st>; }
      }
      return fail(`${what}: not finished after ${ms / 1000}s (${last})`, st);
    };
    st = await probe();
    if (!st || !st.sessionId) return fail('no session before /clear');
    const idA = st.sessionId;
    const rowsBefore = st.rows.filter((r) => !r.hidden).map((r) => `${r.who}:${r.text}`);
    say(`before /clear — ${brief(st)}`);
    const obsClear = await watchChange('/clear', '/clear', (x) => !!x.sessionId && x.sessionId !== idA && x.watched === x.sessionId, 45000);
    const idB = obsClear.sessionId as string;
    say(`after /clear — session ${idA.slice(0, 8)} → ${idB.slice(0, 8)}; rows visible with the OLD word: ${obsClear.rows.filter((r) => !r.hidden && r.text.includes(word)).length} (before any new message)`);
    await watchChange('word B', `Reply with exactly the word ${wordB} and nothing else`, (x) => x.rows.some((r) => r.who === 'claude' && !r.hidden && r.text.includes(wordB)), 90000);
    const afterB = st as NonNullable<typeof st>;
    const shownB = afterB.rows.filter((r) => !r.hidden);
    const filesB = tail.current(paneId);
    say(`after word B — id=${(afterB.sessionId ?? '').slice(0, 8)} watched=${(afterB.watched ?? '').slice(0, 8)} tail file=${filesB?.file ? path.basename(filesB.file, '.jsonl').slice(0, 8) : 'none'}; visible rows: ${shownB.map((r) => `${r.who}:${r.text.length > 30 ? r.text.slice(0, 30) + '…' : r.text}`).join(' | ')}`);
    const clearProblems: string[] = [];
    if (afterB.sessionId === idA) clearProblems.push('the pane kept the old session id after /clear');
    if (afterB.watched !== afterB.sessionId) clearProblems.push(`watched (${afterB.watched}) does not follow the pane's id (${afterB.sessionId})`);
    if (shownB.some((r) => r.text.includes(word))) clearProblems.push(`rows of the OLD session (${word}) are still visible after /clear`);
    if (!shownB.some((r) => r.who === 'user' && r.text.includes(wordB)) || !shownB.some((r) => r.who === 'claude' && r.text.includes(wordB))) clearProblems.push('the new session\'s bubbles are not both visible');
    if (!filesB?.file || path.basename(filesB.file) !== `${afterB.sessionId}.jsonl`) clearProblems.push(`the tail follows ${filesB?.file ? path.basename(filesB.file) : 'no file'}, not the new session's file`);
    /* the new transcript legitimately opens with the `/clear` command itself (Claude Code records it as the session's first line), so three rows
       are the whole new session: that command, the word B asked, the word B answered. Anything more is something that came from the old one. */
    if (shownB.some((r) => r.who === 'user' && !r.text.includes(wordB) && !/^\s*\/clear/.test(r.text)) || shownB.length > 3) clearProblems.push(`${shownB.length} rows visible after /clear + one message (wanted the /clear line, B asked, B answered): ${shownB.map((r) => r.text.slice(0, 20)).join(' | ')}`);
    // resume back to the ORIGINAL transcript: the view must backfill it once, with nothing of B left and nothing doubled
    await watchChange('/resume', `/resume ${idA}`, (x) => x.sessionId === idA && x.watched === idA && x.rows.some((r) => r.who === 'claude' && !r.hidden && r.text.includes(word)), 60000);
    const afterR = st as NonNullable<typeof st>;
    const shownR = afterR.rows.filter((r) => !r.hidden);
    const filesR = tail.current(paneId);
    say(`after resume — id=${(afterR.sessionId ?? '').slice(0, 8)} watched=${(afterR.watched ?? '').slice(0, 8)} tail file=${filesR?.file ? path.basename(filesR.file, '.jsonl').slice(0, 8) : 'none'}; visible rows: ${shownR.length}; old word rows: ${shownR.filter((r) => r.text.includes(word)).length}; B rows: ${shownR.filter((r) => r.text.includes(wordB)).length}`);
    if (afterR.sessionId !== idA) clearProblems.push(`resume: the pane id is ${afterR.sessionId}, not the original ${idA}`);
    if (afterR.watched !== idA) clearProblems.push(`resume: watched is ${afterR.watched}, not the original ${idA}`);
    if (shownR.some((r) => r.text.includes(wordB))) clearProblems.push('resume: rows of the session left behind (B) are still visible');
    const userA = shownR.filter((r) => r.who === 'user' && r.text.includes(word)).length;
    const claudeA = shownR.filter((r) => r.who === 'claude' && r.text.includes(word)).length;
    if (userA !== 1 || claudeA !== 1) clearProblems.push(`resume: the original exchange shows ${userA} operator and ${claudeA} assistant bubble(s) (wanted 1 and 1: backfilled once, not doubled)`);
    const texts = shownR.map((r) => `${r.who}:${r.text}`);
    if (new Set(texts).size !== texts.length) clearProblems.push('resume: duplicated rows after the backfill');
    if (JSON.stringify(texts) !== JSON.stringify(rowsBefore)) clearProblems.push(`resume: the backfilled rows differ from the ${rowsBefore.length} the original session showed before /clear (${texts.length} now)`);
    if (!filesR?.file || path.basename(filesR.file) !== `${idA}.jsonl`) clearProblems.push(`resume: the tail follows ${filesR?.file ? path.basename(filesR.file) : 'no file'}, not the original file`);
    if (clearProblems.length) return fail(`/clear + resume: ${clearProblems.join('; ')}`);
    say('/clear and resume — the id changed, watched followed it, the tail moved with it, no row of the other session stayed, the resume did not double anything');
    result = { status: 'ok', detail: 'real session, chat view, composer, bubbles, streaming, permission dialog card, /clear and resume' };
  } catch (e) {
    result = { status: 'failed', detail: String((e as Error)?.message ?? e) };
  } finally {
    // CLEANUP — runs on success and on failure, and never touches anything this run did not create
    try {
      const shellPid = ptys.get(paneId)?.pid;
      if (shellPid) for (const k of await descendants(shellPid)) kids.add(k);
      if (paneId >= 0) await js(`(() => { if (panes.has(${paneId})) closePane(${paneId}); return true; })()`).catch(() => undefined);
      if (priorMode === 'chat' || priorMode === 'terminal') await js(`chatSkinSetMode(${JSON.stringify(priorMode)}, { persist: false })`).catch(() => undefined);   // the live mode goes back to what the run found
      for (let i = 0; i < 40 && [...kids].some(alive); i++) await sleep(250);
      const left = [...kids].filter(alive);
      if (left.length) {
        problems.push(`closing the pane left process(es) ${left.join(',')} running; killed by pid`);
        for (const k of left) { try { process.kill(k, 'SIGKILL'); } catch { /* gone */ } }
      }
      if (ptys.has(paneId)) problems.push('the pty is still registered after closePane');
      if (skins.has(paneId) || tail.active().includes(paneId)) problems.push('a transcript watcher is still registered after closePane');
      if (sessionId && aios.listRunningAgents().some((a) => a.sessionId === sessionId)) problems.push('the session is still in the registry');
    } catch (e) { problems.push(`cleanup of the pane failed: ${String((e as Error)?.message ?? e)}`); }
    let removed = '';
    try {
      // the temp folder: only if it is still exactly what this run made
      if (path.dirname(dir) === tmpRoot && path.basename(dir) === `aios-smoke-chat-${tag}`) { fs.rmSync(dir, { recursive: true, force: true }); removed = 'temp folder'; }
      // Claude Code's per-cwd transcript folder: named after the real path, verified before deleting
      const projects = path.join(aios.claudeConfigDir(), 'projects');
      const slug = dir.replace(/[^A-Za-z0-9]/g, '-');
      const tdir = path.join(projects, slug);
      if (fs.existsSync(tdir)) {
        const st = fs.lstatSync(tdir);
        if (st.isDirectory() && !st.isSymbolicLink() && path.dirname(tdir) === projects
            && slug.endsWith(`aios-smoke-chat-${tag.replace(/[^A-Za-z0-9]/g, '-')}`)) {
          fs.rmSync(tdir, { recursive: true, force: true }); removed += ' + transcript folder';
        } else problems.push('transcript folder failed the name check; left in place');
      }
      if (fs.existsSync(dir)) problems.push('temp folder still exists');
      if (fs.existsSync(tdir)) problems.push('transcript folder still exists');
    } catch (e) { problems.push(`cleanup of the files failed: ${String((e as Error)?.message ?? e)}`); }
    say(`cleanup — ${problems.length ? 'PROBLEMS: ' + problems.join('; ') : `pane closed, ${kids.size} process(es) gone, no watcher left, ${removed || 'nothing to remove'} removed`}`);
    if (problems.length && result.status === 'ok') result = { status: 'failed', detail: problems.join('; ') };
  }
  return result;
}

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
/* Files the operator dropped onto the App: readable for this session, one by one, without adding
   their folder to the workspace (see grantDroppedFiles in preload). Bounded; regular files only. */
const droppedGrants = new Set<string>();
ipcMain.handle('fs:grantDropped', (_e, paths: unknown) => {
  if (!Array.isArray(paths)) return false;
  for (const p of paths.slice(0, 50)) {
    try {
      const abs = fs.realpathSync(String(p));
      if (fs.statSync(abs).isFile()) droppedGrants.add(abs);
    } catch { /* gone or unreadable: nothing to grant */ }
  }
  if (droppedGrants.size > 500) droppedGrants.clear();
  return true;
});
function inAllowed(abs: string): boolean {
  try { if (droppedGrants.size && droppedGrants.has(fs.realpathSync(abs))) return true; } catch { /* not a file */ }
  /* Windows needs TWO normalizations the POSIX path never did, or a legitimately-allowed file is
     rejected and fs:read/write/list/openViewer/"open terminal here" fail with "not allowed":
     (1) SEPARATOR — callers pass both `C:\a` (native) and `C:/a` (e.g. the renderer, which works
     in forward slashes), while the roots are backslash; compare with a single separator.
     (2) CASE — the FS is case-insensitive and realpathSync can canonicalize drive-letter/segment
     casing differently than the typed path. Both only on win32; POSIX comparison is unchanged. */
  const norm = (p: string): string => (process.platform === 'win32' ? p.replace(/\\/g, '/').toLowerCase() : p);
  const a = norm(abs);
  return allowedRoots().some((r) => { const rr = norm(r); return a === rr || a.startsWith(rr + '/'); });
}

/* ── Claude config live watch ──────────────────────────────────────────────────
   Settings MIRRORS Claude's own config, so it has to notice when Claude's config changes without
   us. Run `/config` inline in a session with the Settings tab open and the panel was showing
   whatever was true when it was built — a mirror that only refreshes when you rebuild it is a
   photograph. Watching both stores closes that: the renderer repaints an open Settings tab from
   the file that just changed.
   READ-ONLY, deliberately. ~/.claude.json is large and live sessions write it, so a
   read-modify-write races them (see writeClaudeUserJson) — watching does not. */
const claudeWatchers: fs.FSWatcher[] = [];
let lastClaudeCfg = '';
let claudeCfgTimer: ReturnType<typeof setTimeout> | undefined;
function setupClaudeConfigWatch(win: BrowserWindow): void {
  for (const w of claudeWatchers.splice(0)) { try { w.close(); } catch { /* ignore */ } }
  /* ALL FOUR stores, not the two user ones. The read chain and the write routing both learned
     about the project/local stores; this watcher did not, so `/config` writing
     `<vault>/.claude/settings.local.json` fired nothing and the panel sat stale — the one setting
     that still "conflicted" after the rest were fixed. Three mechanisms had to learn the same
     fact, and the third was easy to forget precisely because the first two were already right. */
  const framework = aios.frameworkRoot();
  const watched = [
    path.join(aios.claudeConfigDir(), 'settings.json'),
    aios.claudeJsonDefault(),
    ...(framework ? [path.join(framework, '.claude', 'settings.json'), path.join(framework, '.claude', 'settings.local.json')] : []),
  ];
  lastClaudeCfg = JSON.stringify(aios.claudeConfig());   // baseline, so the first real change is the first event
  for (const f of watched) {
    try {
      /* Watch the DIRECTORY, not the file. An editor (and Claude itself) writes atomically —
         write a temp file, then rename over the target — which destroys the inode a file watch is
         bound to, so a file watcher fires once and then goes deaf. Filtering by basename on a
         directory watch survives replacement. */
      const dir = path.dirname(f);
      const base = path.basename(f);
      claudeWatchers.push(fs.watch(dir, (_evt, filename) => {
        if (String(filename || '') !== base) return;
        if (claudeCfgTimer) clearTimeout(claudeCfgTimer);
        claudeCfgTimer = setTimeout(() => {
          if (win.webContents.isDestroyed()) return;
          /* ONLY WHEN THE VALUES THIS EVENT IS ABOUT ACTUALLY CHANGED. `~/.claude.json` is
             rewritten constantly by every live Claude session — it is the file CLAUDE.md warns
             is "LARGE and live Claude sessions write it too" — so a bare file event fires
             whenever any session breathes. The renderer rebuilds the open Settings tab on this,
             which is why Settings visibly reloaded itself every minute or so while several
             sessions were running (operator-reported 2026-09-14). Nothing about those writes
             touches the handful of values Settings shows, so comparing them first turns a
             constant churn into an event that fires when something really changed. */
          const next = JSON.stringify(aios.claudeConfig());
          if (next === lastClaudeCfg) return;
          lastClaudeCfg = next;
          win.webContents.send('shell:claudeConfigChanged', aios.claudeConfig());
        }, 200);
      }));
    } catch { /* absent store — nothing to watch yet */ }
  }
}

// ── explorer live watch: recursive watchers on each root → debounced fsEvent ──
// (lets the renderer surface new files in place + refresh git markers, no repaint)
const explorerWatchers: fs.FSWatcher[] = [];
let fsEventTimer: ReturnType<typeof setTimeout> | undefined;
const fsEventDirs = new Set<string>();
function setupExplorerWatch(win: BrowserWindow): void {
  for (const w of explorerWatchers.splice(0)) { try { w.close(); } catch { /* ignore */ } }
  // Separator-agnostic: Windows recursive fs.watch delivers filenames with backslashes, so a
  // forward-slash-only class never filters .git/node_modules/dist/out churn and floods the
  // renderer with shell:fsEvent messages. `[\\/]` matches both.
  const SKIP = /(^|[\\/])(\.git|node_modules|out|dist|\.venv|__pycache__)([\\/]|$)/;
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
/* RESUMABLE SESSIONS — the whole set, so the picker's filter can actually find things.
   Paging this was worse than it looked: with ten rows loaded, typing the name of a session from
   last week matched nothing, which reads as "that session does not exist" rather than "it is on
   page four". So everything is returned and the modal filters in memory.
   MEASURED before choosing: 593 transcripts, 16KB head each, 22ms warm / ~180ms cold. Cheap.
   Only 209 of those 593 carry an `agent-name` row, so most historic sessions have no name to
   recover and are labelled by project — worth knowing rather than discovering in the UI.
   Cached by path+mtime: reopening the picker costs nothing, and a transcript that grows gets
   re-read because its mtime moved.
   The archive is still never READ on the app's own initiative — only when this picker is opened,
   and nothing resumes without being ticked (AI-67's constraint). */
const nameCache = new Map<string, { name: string; was: string[] }>();
const RESUMABLE_CAP = 2000;      // a backstop, not a page: far above any real archive

/* AI-209 — WHAT A SESSION WAS CALLED, not only what it is called now. Measured: "boston" in the
   picker found nothing, because `boston-companion` renamed itself `fortress-companion` in its last
   minutes, and the list matched current names only. A session is recognised by any name the
   operator ever knew it by, so the reader also returns the earlier ones — the name it was BORN
   with (its first agent-name row, from the head it already reads) plus any others in the tail
   window — and the picker searches and shows them. No extra reads: same tail, same head. */
const agentNameOf = (line: string): string => {
  if (!line.includes('"agent-name"')) return '';
  try { const j = JSON.parse(line); return j && typeof j.agentName === 'string' ? j.agentName : ''; } catch { return ''; /* a chunk boundary split this line */ }
};
function sessionNamesFromTranscript(file: string, mtime: number): { name: string; was: string[] } {
  const key = file + ':' + mtime;
  const hit = nameCache.get(key);
  if (hit !== undefined) return hit;
  let name = '';
  const seen: string[] = [];
  let fd = -1;
  try {
    fd = fs.openSync(file, 'r');
    /* THE LAST `agent-name` ROW WINS, not the first. Reading the head found the name a session
       was BORN with, so any session later renamed showed a stale label — measured on the
       reporting machine: 17 of 209 named sessions, e.g. `buddai` → `buddai-jul-23-2026` and
       `keen-falcon` → `falcon`. Roughly one session in five carries more than one name row.
       Reading the whole corpus is not an option (1.4GB across 592 files, the largest 617MB), so
       scan BACKWARDS in chunks and stop at the first row found — which, read from the end, is the
       most recent declaration. Measured at 377ms for the full set, cached thereafter.
       Honest limit: a rename followed by more than ~2MB of further activity falls outside the
       window, and that session keeps showing its original name. That is a real name for it, just
       an older one — strictly better than the uuid, and cheap to widen if it ever matters. */
    const size = fs.fstatSync(fd).size;
    const CHUNK = 256 * 1024;
    const MAX_BACK = 8;                       // 2MB of tail before giving up
    for (let i = 0; i < MAX_BACK && !name; i++) {
      const end = size - i * CHUNK;
      if (end <= 0) break;
      const start = Math.max(0, end - CHUNK);
      const buf = Buffer.alloc(end - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      const lines = buf.toString('utf8').split('\n');
      for (let k = lines.length - 1; k >= 0; k--) {
        const n = agentNameOf(lines[k]);
        if (!n) continue;
        if (!name) name = n;
        if (!seen.includes(n)) seen.push(n);    // the rest of this chunk is free: other names it held
      }
      if (start === 0) break;
    }
    /* The head: where a never-renamed session declares itself, and where a renamed one says what it
       was born as. */
    const b = Buffer.alloc(16 * 1024);
    const nb = fs.readSync(fd, b, 0, b.length, 0);
    for (const line of b.subarray(0, nb).toString('utf8').split('\n')) {
      const n = agentNameOf(line);
      if (!n) continue;
      if (!name) name = n;
      if (!seen.includes(n)) seen.push(n);
      break;
    }
  } catch { /* unreadable — list it unnamed rather than hide it */ } finally {
    if (fd >= 0) { try { fs.closeSync(fd); } catch { /* already closed */ } }
  }
  const out = { name, was: seen.filter((n) => n !== name) };
  nameCache.set(key, out);
  return out;
}

/* #28 — WHERE EACH SESSION WE ARE ABOUT TO OFFER STANDS NOW. Not `sessions:resumable`: that list
   hides unnamed sessions on purpose and is capped, so a restored pane that never announced a name
   would be reported "could not be found" when its transcript is sitting right there. This asks
   about exactly the ids we hold, and nothing else.
     exists — a transcript is on disk, so `claude --resume <id>` has something to resume
     live    — another surface (Glass, a terminal) already has it open; resuming it here would
               open a second pane fighting the first for one conversation
   The id becomes part of a PATH, so anything that is not id-shaped is refused before it is joined. */
ipcMain.handle('sessions:locate', (_e, ids: unknown) => {
  const want = (Array.isArray(ids) ? ids : []).map(String).filter((id) => /^[0-9a-f][0-9a-f-]{7,63}$/i.test(id));
  const dir = path.join(aios.claudeConfigDir(), 'projects');
  let projs: string[] = [];
  try { projs = fs.readdirSync(dir); } catch { /* no transcripts at all */ }
  const live = new Set(aios.listRunningAgents().map((a: { sessionId?: string }) => a.sessionId).filter(Boolean));
  const out: Record<string, { exists: boolean; live: boolean }> = {};
  for (const id of want) {
    const exists = projs.some((pr) => { try { return fs.existsSync(path.join(dir, pr, id + '.jsonl')); } catch { return false; } });
    out[id] = { exists, live: live.has(id) };
  }
  return out;
});

ipcMain.handle('sessions:resumable', () => {
  const dir = path.join(aios.claudeConfigDir(), 'projects');
  let files: Array<{ file: string; at: number; size: number }> = [];
  try {
    for (const proj of fs.readdirSync(dir)) {
      const pdir = path.join(dir, proj);
      let entries: string[] = [];
      try { entries = fs.readdirSync(pdir); } catch { continue; }
      for (const f of entries) {
        if (!f.endsWith('.jsonl')) continue;
        try { const st = fs.statSync(path.join(pdir, f)); files.push({ file: path.join(pdir, f), at: st.mtimeMs, size: st.size }); } catch { /* vanished */ }
      }
    }
  } catch { return { items: [], total: 0, named: 0 }; }
  // Already-open sessions are excluded: resuming one duplicates a pane or fights its owner.
  const liveIds = new Set(aios.listRunningAgents().map((a: { sessionId?: string }) => a.sessionId).filter(Boolean));
  files = files.filter((f) => !liveIds.has(path.basename(f.file, '.jsonl')));
  files.sort((a2, b2) => b2.at - a2.at);
  const total = files.length;
  const all = files.slice(0, RESUMABLE_CAP).map((f) => {
    const n = sessionNamesFromTranscript(f.file, f.at);
    return {
      id: path.basename(f.file, '.jsonl'),
      name: n.name,
      was: n.was,
      proj: path.basename(path.dirname(f.file)).replace(/^-Users-[^-]+-/, ''),
      at: f.at,
      size: f.size,
    };
  });
  /* NAMED SESSIONS ONLY. Of 593 transcripts here, 384 never wrote an `agent-name` row — those
     could only ever be labelled `project · a3f9c2b1`, which identifies nothing and is 65% of the
     list you have to scroll past to find what you meant. Resuming is an act of recognition, so
     the list holds what can be recognised.
     The others are NOT lost and must not be dropped in silence: the count is returned so the
     picker can say how many are hidden, and Claude's own picker (one row in that modal) still
     reaches every one of them. */
  const items = all.filter((i) => i.name);
  return { items, total, named: items.length, unnamed: all.length - items.length };
});

/* THE SHORTCUT MAP — read off the INSTALLED MENU, never a hand-written list.
   Today alone two accelerators collided silently: zoom took ⌘0 from the terminal dock, and
   Recents took ⌘⇧R from Running sessions. Neither announced itself — a menu accelerator simply
   wins and the other feature stops. A map is the fix, but a HAND-COPIED map would be the same
   class of bug one edit later: it would claim bindings the app no longer has.
   So this walks `Menu.getApplicationMenu()` — the menu actually in force — and reports what it
   finds. Only items with an EXPLICIT accelerator are included: role items (⌘C, ⌘V, ⌘Q) get their
   keys from the OS and documenting them would pad the list with things every operator already
   knows, while burying the app's own bindings. */
ipcMain.handle('menu:shortcuts', () => {
  const out: Array<{ group: string; label: string; accel: string }> = [];
  const menu = Menu.getApplicationMenu();
  if (!menu) return out;
  const walk = (items: Electron.MenuItem[], group: string, trail: string[]): void => {
    for (const it of items) {
      const label = String(it.label || '').replace(/\.\.\.$|…$/, '');
      if (it.submenu) { walk(it.submenu.items, group || label, label ? [...trail, label] : trail); continue; }
      /* Items WITHOUT an accelerator are separators and submenu parents. Role items (Quit, the
         Edit section) DO report one — as `CommandOrControl+Q` etc. — so they are included and the
         formatter must know that spelling. An earlier comment here claimed roles were excluded;
         they never were, and believing it is what let `CommandOrControlQ` reach the screen. */
      if (!it.accelerator) continue;
      out.push({ group: group || '—', label: [...trail, label].filter(Boolean).join(' › '), accel: it.accelerator });
    }
  };
  for (const top of menu.items) {
    const label = String(top.label || '');
    if (top.submenu) walk(top.submenu.items, label, []);
  }
  return out;
});

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
  const refused = aios.addWorkspaceFolder(r.filePaths[0]);
  if (refused) return { refused, path: r.filePaths[0] };   // the renderer says why
  if (mainWin) setupExplorerWatch(mainWin); // wire live watch + git for the new folder
  return r.filePaths[0];
});
/* Add a folder we were HANDED (an OS drop), as opposed to one chosen in the dialog. Same
   validation the dialog path gets implicitly: it must be a real directory. */
ipcMain.handle('fs:addFolderPath', (_e, p: string) => {
  const abs = String(p || '');
  try { if (!fs.statSync(abs).isDirectory()) return null; } catch { return null; }
  const refused = aios.addWorkspaceFolder(abs);
  if (refused) return { refused, path: abs };
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
/* The shell's CURRENT folder for a pane, so a relative path printed after `cd` resolves where the
   shell actually is (the pane only knows where it started). macOS/Linux only: Windows has no
   cheap equivalent, and the renderer falls back to the start folder. Cached ~1.5s because the
   link provider asks once per hovered line. */
const ptyCwdCache = new Map<number, { at: number; cwd: string | null }>();
ipcMain.handle('pty:cwd', async (_e, id: number) => {
  const p = ptys.get(Number(id));
  if (!p || process.platform === 'win32') return null;
  const hit = ptyCwdCache.get(p.pid);
  if (hit && Date.now() - hit.at < 1500) return hit.cwd;
  let cwd: string | null = null;
  try {
    if (process.platform === 'linux') cwd = fs.readlinkSync(`/proc/${p.pid}/cwd`);
    else {
      const out = await new Promise<string>((res) => execFile('lsof', ['-a', '-p', String(p.pid), '-d', 'cwd', '-Fn'], { timeout: 1500 }, (_err, o) => res(String(o || ''))));
      const line = out.split('\n').find((l) => l.startsWith('n'));
      cwd = line ? line.slice(1) : null;
    }
  } catch { cwd = null; }
  ptyCwdCache.set(p.pid, { at: Date.now(), cwd });
  return cwd;
});
/* fs:resolveFile and fs:resolvePaths share ONE implementation of the rules (pathResolve.ts): trim, `:line`,
   `~`, the base folders, the allowed roots. fs:resolveFiles (the terminal's hover) runs on pathLinks.ts,
   which adds the reveal-only level and the time-limited stat; the string cleaning is the one function
   both import (normalizeCandidate), so a terminal link and a chat link cannot disagree about a string. */
const resolveEnv = { allowed: (abs: string) => inAllowed(abs), frameworkRoot: () => aios.frameworkRoot() };
ipcMain.handle('fs:resolveFile', (_e, cand: string, base?: string) => {
  try { return resolveOne(cand, base, resolveEnv, false)?.abs ?? null; } catch { return null; }
});
/* Plural form: a hovered terminal line can hold a dozen path-shaped tokens, and resolving
   them one IPC at a time is what made the first hover feel slow. Answers TWO maps — what the
   viewer may open, and what Finder may only reveal (a folder, or a file outside the allowed
   roots) — see pathLinks.ts for why the second one has no roots gate. */
const statOrNull = statWithin();   // async + time-limited: a hung mount must not freeze the app on hover
ipcMain.handle('fs:resolveFiles', (_e, cands: string[], base?: string) =>
  resolveLinkTargets(cands, {
    allowed: inAllowed,
    bases: [base, aios.frameworkRoot(), os.homedir()].filter(Boolean) as string[],
    home: os.homedir(),
    stat: statOrNull,
  }));
/* The chat's variant. It exists because a chat message names folders as often as files ("the output is
   in ~/Projects/site/dist") and has to say which one it found: a file opens in a viewer, a folder is
   revealed in the explorer. It stays on pathResolve.ts (synchronous, inside the allowed roots, `dir`
   says which) rather than on resolveLinkTargets: the chat has no reveal-outside-the-roots gesture, and
   it resolves a whole message in one call, so its ceiling is higher. A separate channel rather than a
   flag on fs:resolveFiles so the terminal's {open, reveal} reply can never change shape. Both normalise
   a candidate with the same function (normalizeCandidate, in pathLinks.ts). */
ipcMain.handle('fs:resolvePaths', (_e, cands: string[], base?: string) =>
  resolveMany(cands, base, resolveEnv, { dirs: true, limit: RESOLVE_PATHS_LIMIT }));
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
/* Reveal reads nothing, so it is not held to the allowed roots: an absolute path that exists is
   enough (a relative one still resolves inside them, as the explorer's callers expect). */
ipcMain.handle('shell:reveal', async (_e, p: string) => {
  const abs = (await revealable(p, statOrNull)) ?? resolveIn(p);
  if (abs) shell.showItemInFolder(abs);
  return true;
});
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
/* AI-196 — a session's own OSC 7501 status, relayed by the renderer, merged in panelHost. */
/* AI-169 — a session's final answer, reduced to what is worth hearing (core/speakable). */
ipcMain.handle('session:speakable', (_e, sessionId: string) => {
  const sid = String(sessionId || '');
  if (!/^[A-Za-z0-9-]{8,}$/.test(sid)) return { text: '', lang: '' };
  try {
    const base = path.join(aios.claudeConfigDir(), 'projects');
    for (const d of fs.readdirSync(base)) {
      const f = path.join(base, d, `${sid}.jsonl`);
      if (!fs.existsSync(f)) continue;
      const size = fs.statSync(f).size;
      const len = Math.min(size, 512 * 1024);
      const fd = fs.openSync(f, 'r');
      const buf = Buffer.alloc(len);
      try { fs.readSync(fd, buf, 0, len, size - len); } finally { fs.closeSync(fd); }
      const answer = lastAnswer(buf.toString('utf8'));
      const lang = guessLang(answer);
      /* "The rest is on screen" in the ANSWER's language, so one voice says the whole thing. */
      const rest = lang === 'es' ? 'El resto está en pantalla.' : lang === 'pt' ? 'O resto está na tela.' : lang === 'en' ? 'The rest is on screen.' : t('readAloud.rest');
      return { text: speakable(answer, rest), lang: lang ?? '' };
    }
  } catch { /* unreadable — say nothing */ }
  return { text: '', lang: '' };
});
/* AI-192, revised — "Copy last answer": the session's final answer from its transcript, as plain text,
   straight to the clipboard. Returns its length (0 = no answer yet). */
ipcMain.handle('session:copyLastAnswer', (_e, sessionId: string) => {
  const sid = String(sessionId || '');
  if (!/^[A-Za-z0-9-]{8,}$/.test(sid)) return 0;
  try {
    const base = path.join(aios.claudeConfigDir(), 'projects');
    for (const d of fs.readdirSync(base)) {
      const f = path.join(base, d, `${sid}.jsonl`);
      if (!fs.existsSync(f)) continue;
      const size = fs.statSync(f).size;
      const len = Math.min(size, 2 * 1024 * 1024);
      const fd = fs.openSync(f, 'r');
      const buf = Buffer.alloc(len);
      try { fs.readSync(fd, buf, 0, len, size - len); } finally { fs.closeSync(fd); }
      const text = answerPlain(lastAnswer(buf.toString('utf8')));
      if (text) clipboard.writeText(text);
      return text.length;
    }
  } catch { /* unreadable */ }
  return 0;
});
/* app#59 — is this session id already running (any surface, any terminal)? Asked by tab restore
   before it starts `claude --resume <id>`, so one transcript never gets two live processes. */
ipcMain.handle('session:isLive', (_e, sessionId: string) => {
  const sid = String(sessionId || '');
  return !!sid && aios.listRunningAgents().some((a) => a.sessionId === sid);
});
ipcMain.on('panes:sessions', (_e, ids: unknown) => aios.setPaneSessionIds(ids));   // AI-203
ipcMain.on('pty:programStatus', (_e, m: { sessionId?: string; data?: string; at?: number }) => {
  host?.setProgramStatus(String(m?.sessionId ?? ''), String(m?.data ?? ''), Number(m?.at) || Date.now());
});
/* AI-200 — "Report this": the tab's recent lines go to a LOCAL temp file for aios-feedback to read.
   Never sent anywhere by the App; the agent scrubs and asks before anything leaves the machine. */
ipcMain.handle('feedback:snapshot', (_e, name: string, text: string) => {
  sweepReportSnapshots();
  try {
    const slug = String(name || 'terminal').replace(/[^a-z0-9-]+/gi, '-').slice(0, 40) || 'terminal';
    /* Review should-fix 12: written ALREADY REDACTED — token shapes, keys, credentials in URLs. The
       agent still scrubs; the App no longer depends on it. A private run file (privateRun), like
       every file a session is told to read. */
    return writeHandoffFile(`aios-report-${slug}-${Date.now()}.txt`, redactSecrets(String(text ?? '').slice(0, 200_000)));
  } catch { return ''; }
});
/* Snapshots are read once, by the session the report opened. Any older than a day is an orphan
   (a report abandoned, or one dropped because the feedback pane already existed) — remove it. */
function sweepReportSnapshots(maxAgeMs = 24 * 60 * 60 * 1000): void {
  try {
    const dir = runDir();
    for (const n of fs.readdirSync(dir)) {
      if (!/^aios-report-.*\.txt$/.test(n)) continue;
      const f = path.join(dir, n);
      try { if (Date.now() - fs.statSync(f).mtimeMs > maxAgeMs) fs.unlinkSync(f); } catch { /* gone */ }
    }
  } catch { /* tmp unreadable */ }
}
app.whenReady().then(() => { sweepReportSnapshots(); sweepHandoffDirs(); }).catch(() => undefined);   // older loose snapshots + handoff folders
ipcMain.handle('shell:copyText', (_e, t: string) => { clipboard.writeText(String(t)); return true; });
/* AI-192 — ⇧⌘C / right-click "Copy as plain text": the selection without Claude's TUI scaffolding
   (bullets, quote bars, indents, the footer) and with terminal wraps rejoined into paragraphs. */
ipcMain.handle('shell:copyPlainText', (_e, t: string, cols: number) => { clipboard.writeText(plainText(String(t), Number(cols) || 80)); return true; });
ipcMain.handle('fs:read', (_e, relOrAbs: string) => {
  const abs = resolveIn(relOrAbs);
  if (!abs) return null;
  try {
    /* GATE BEFORE READING. This handler once read whatever it was handed, as utf8, whole: a
       ⌘-click on a 123 MB .dmg printed in a terminal froze the window (operator-reported; force
       quit). Assets render from their path and are never read; binaries and oversize text come
       back as a FLAG the viewer acts on — reveal in the folder — rather than as a string it
       would try to lay out. `src/main/preview.ts` holds the rule and its tests. */
    const c = classifyForRead(abs);
    if (c.kind === 'asset') return { path: abs, content: '' };
    if (c.kind !== 'text') return { path: abs, content: null, unreadable: c.kind, size: c.size };
    return { path: abs, content: fs.readFileSync(abs, 'utf8') };
  } catch { return null; }
});
ipcMain.handle('aios:lists', () => ({
  agents: aios.discoverAgents(),
  commands: aios.discoverCommands(),
  skills: aios.discoverSkills(),
  frequent: aios.frequentTasks(),
  running: aios.listOperatorSessions(),
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
/* "Reveal in browser" — hand a LOCAL file to the desktop, outside the app.
   Deliberately NOT routed through shell:openExternal above, and the reason is worth stating:
   that handler accepts http(s) ONLY and silently drops everything else **while returning true**,
   so a renderer passing a file:// URL would be told it worked and nothing would happen. Widening
   that regex to admit `file:` would also hand the renderer the ability to open ANY path on the
   machine through one call — the guard is there on purpose.
   So this is a separate, narrower door: it takes a PATH rather than a URL, refuses anything
   outside `allowedRoots()` (the framework root plus the operator's own workspace folders — the
   same containment the explorer, quick-open and "open terminal here" already use), requires the
   file to exist, and builds the file:// URL HERE. Main never trusts a URL the renderer
   assembled; it assembles its own from a path it has just validated.
   Returns false rather than throwing on refusal, so the caller can say so instead of appearing
   to succeed — which is exactly the failure mode of the handler above. */
ipcMain.handle('shell:openPathExternal', (_e, p: string) => {
  try {
    /* REJECT "nothing" BEFORE RESOLVING IT. `path.resolve('')` returns the process's CWD — which
       is inside an allowed root and does exist — so an empty or missing argument sailed through
       both checks and opened the app's own working directory. Caught by testing the refusal
       cases: `''` and `null` both answered true. An input meaning "no path" must never resolve
       to a real one, and requiring an ABSOLUTE path is what makes that structural rather than a
       special case for the two spellings of empty I happened to try. */
    const raw = typeof p === 'string' ? p.trim() : '';
    if (!raw || !path.isAbsolute(raw)) return false;
    const abs = path.resolve(raw);
    if (!inAllowed(abs)) return false;
    /* A FILE, not merely something that exists. A directory would hand Finder/Explorer a folder —
       which is what the row above this one already does, under a name that promises it. */
    let st; try { st = fs.statSync(abs); } catch { return false; }
    if (!st.isFile()) return false;
    void shell.openExternal(pathToFileURL(abs).toString());
    return true;
  } catch { return false; }
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
  /* A private run file (privateRun). A failed write is REFUSED, never "fall back to inline": typing
     a long prompt is the mangling this handoff exists to prevent. The renderer says why. */
  try { return taskFileInstruction(writeHandoffFile(`aios-task-${slug}.md`, prompt)); }
  catch (e) { return { error: (e as Error).message }; }
});
/* app#66 — the suggested session name for an Ask AIOS intent: a dated USER.md identity the intent
   names, else the descriptive ask-… name; letters folded, never a name already running. The Ask
   dialog shows it in an editable field, so the operator always sees and can change it. */
/* "Live" = the registry AND this window's open tabs: a tab opened a moment ago may not have
   registered yet, and a second session under its name is one the bus cannot tell apart. */
const liveNames = (panes: unknown): string[] => [
  ...aios.listRunningAgents().map((a) => a.name),
  ...(Array.isArray(panes) ? panes.filter((x): x is string => typeof x === 'string') : []),
];
ipcMain.handle('ask:name', (_e, intent: unknown, panes?: unknown) =>
  askSessionName(String(intent ?? ''), { identities: aios.primaryNames(), live: liveNames(panes) }));
/* The FINAL name, after the operator edited it: the same never-a-running-name rule (reviewer,
   0.12.0 — typing `buddai` while buddai is live started a second one). */
ipcMain.handle('ask:unique', (_e, name: unknown, panes?: unknown) => uniqueName(String(name ?? ''), liveNames(panes)));
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
  try { const file = writeHandoffFile(`aios-designer-${req.kind}-${slug}.md`, brief); return { file, prompt: taskFileInstruction(file) }; }
  catch (e) { return { error: (e as Error).message }; }
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
ipcMain.handle('onboarding:skip', (_e, id: string) => { aios.skipOnboardingStep(String(id ?? '')); return aios.onboardingState(); });
// PAT lane: store a GitHub token via `git credential approve` (never echoed)
/* #50: stored → verified once with GitHub → the gh step can pass on macOS, where the token lives
   in Keychain and the poll may not read it. 'unverified' = stored, but GitHub refused it. */
ipcMain.handle('onboarding:storePat', async (_e, pat: string): Promise<'verified' | 'unverified' | 'failed'> => {
  const p = String(pat ?? '');
  if (!aios.storeGitHubPat(p)) return 'failed';
  return (await aios.verifyGitHubPat(p)) ? 'verified' : 'unverified';
});
// doctor: headless repair + re-run-the-same-check proof (see aios.repairCheck)
ipcMain.handle('doctor:repair', (_e, id: string) => aios.repairCheck(String(id)));
/* "Finish setup": the App runs the four wiring installers itself (skills → plugin → spawn → hooks),
   re-checking each — the lane the guided setup session cannot use in auto mode. See core/finishSetup.ts. */
ipcMain.handle('doctor:finishSetup', () => aios.finishSetup());
// what is still not wired, each with its one-line manual command — the Next steps page's fallback
ipcMain.handle('doctor:wiringLeft', () => aios.wiringLeft());
ipcMain.handle('doctor:health', () => aios.computeHealth());
ipcMain.handle('health:routines', () => aios.routineHealth());   // #27
// "Having issues?" — one battery + a plan per failing tool → the next ACTION, not a report.
ipcMain.handle('doctor:triage', () => aios.setupTriage(app.getVersion()));

// connectors: read canonical's manifests, classify against the live registration, and register
// through `claude mcp add` — never by editing ~/.claude.json, which running sessions also write.
ipcMain.handle('connectors:list', () => connectors.listConnectors(aios.frameworkRoot()));
ipcMain.handle('connectors:connect', (_e, id: string, answers?: Record<string, string>) =>
  connectors.connect(aios.frameworkRoot(), String(id), answers ?? {}));
ipcMain.handle('connectors:disconnect', (_e, id: string) =>
  connectors.disconnect(aios.frameworkRoot(), String(id)));
ipcMain.handle('connectors:fix', (_e, id: string) =>
  connectors.fixDrift(aios.frameworkRoot(), String(id)));
// delete: unregister AND remove the operator's own connector folder. Gated to mcps/custom/ in main.
ipcMain.handle('connectors:delete', (_e, id: string) =>
  connectors.deleteCustom(aios.frameworkRoot(), String(id)));
ipcMain.handle('connectors:addCustom', (_e, input: string, service?: string) =>
  connectors.addCustom(aios.frameworkRoot(), String(input ?? ''), service ? String(service) : undefined));
ipcMain.handle('shell:config', () => ({ ...aios.shellSettings(), localeResolved: aios.resolvedLocale(), hasIdentity: aios.hasIdentity(), operator: aios.operatorName(), identityNameGap: aios.identityNameGap(), primary: aios.primaryName() }));
/**
 * A NATIVE context menu for a tab (AI-82).
 *
 * The first version used the app's `listModal`, which carries a filter box because it was built
 * for long searchable lists — sessions, skills, commands. On a four-row tab menu that reads as
 * over-powered, and the operator said so: a search field implies a list worth searching.
 *
 * A native menu is the correct affordance and costs nothing new: it appears at the pointer, needs
 * no styling, is keyboard-navigable, and matches what every other app on the machine does with a
 * right-click. Labels come from the RENDERER because i18n lives there — main is told what to
 * show, never what the words mean, so there is no second copy of the strings.
 */
ipcMain.handle('tab:menu', async (e, items: { label: string; value: string }[]) => new Promise<string | null>((resolve) => {
  const win = BrowserWindow.fromWebContents(e.sender) ?? mainWin;
  let picked: string | null = null;
  const menu = Menu.buildFromTemplate((items || []).map((it) => (
    it.value === '-' ? { type: 'separator' as const }
      : { label: String(it.label), click: () => { picked = String(it.value); } }
  )));
  /* Resolved on CLOSE, not on click: a menu dismissed with Escape or a click elsewhere must
     resolve too, or the renderer's await hangs forever and the tab silently stops responding to
     right-clicks. `picked` stays null in that case, which is the honest answer. */
  menu.popup({ window: win ?? undefined, callback: () => resolve(picked) });
}));

/* The running version, for the renderer's "what's new" check. Deliberately NOT updaterCheckNow(),
   which asks the same question over the network — this one is asked at every launch and must not
   depend on connectivity or on an update server answering. */
ipcMain.handle('shell:appVersion', () => app.getVersion());
ipcMain.handle('caffeinate:state', () => caffeine.state());
ipcMain.handle('caffeinate:toggle', () => caffeine.toggle());
ipcMain.handle('caffeinate:lid', (_e, on: unknown, prompt: unknown) => caffeine.lidEnable(on === true, String(prompt ?? '')));
ipcMain.handle('caffeinate:lidRemove', (_e, prompt: unknown) => caffeine.lidRemove(String(prompt ?? '')));
ipcMain.handle('claude:config', () => aios.claudeConfig());
ipcMain.handle('claude:outputStyles', () => aios.outputStyleOptions());
ipcMain.handle('claude:modelOptions', () => aios.modelOptions());
/* The strongest of the standard ladder — NOT modelOptions()[0], which can be an account
   extra or the operator's own unrankable pin. The setup suggestion needs a ranking. */
ipcMain.handle('claude:recommendedModel', () => aios.recommendedModel());
ipcMain.handle('claude:rankPinnedModel', (_e, pinned: unknown) => aios.rankPinnedModel(String(pinned ?? '')));
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
// the setup session's cwd: the framework if there is one, else a created + trusted ~/aios
ipcMain.handle('aios:prepareSetupCwd', () => aios.prepareSetupCwd());
// the renderer owns the wording (it has the locale); main owns writing the file
ipcMain.handle('aios:banner', (_e, m: { ok: string; okSub: string; fail: string; failSub: string }) =>
  aios.bannerScript(m.ok, m.okSub, m.fail, m.failSub));
ipcMain.handle('aios:readiness', () => aios.readiness());
/* Both re-post: Home's frequent count is a value the pulse DISPLAYS, and the panel only learns
   a new one when something pushes. `starter:apply` already did this and said why; these two had
   the identical need and were never connected, so adding or deleting a task left the counter
   showing whatever the last push said until an unrelated refresh happened to correct it.
   Enforced by pulseState.test.ts — a handler that mutates a displayed value and does not push
   fails there rather than on someone's screen. */
ipcMain.handle('aios:addFrequent', (_e, task: Parameters<typeof aios.addFrequentTask>[0]) => {
  const r = aios.addFrequentTask(task);
  host?.postState();
  return r;
});
ipcMain.handle('aios:removeFrequent', (_e, id: string) => {
  const r = aios.removeFrequentTask(String(id));
  host?.postState();
  return r;
});
// AIOS's own auto-update preference (USER.md), deliberately NOT on the claude:* channel
ipcMain.handle('shell:setAutoUpdates', (_e, on: boolean) => { aios.setAutoUpdates(!!on); return aios.claudeConfig().autoUpdates; });
/* Which live session runs under a pane's pty — exact identity, where a name cannot be.
   The renderer asks when a pane confirms itself, so two same-named sessions land on the
   right tabs instead of both adopting whichever the name matched first. */
ipcMain.handle('session:under', (_e, paneIds: number[]) => {
  /* The renderer holds PANE HANDLES (a counter), never pty pids — only this process knows
     those, via `ptys`. So translate handle → pty pid here, walk, and answer by handle. */
  const ids = (Array.isArray(paneIds) ? paneIds : []).map(Number).filter((n) => Number.isInteger(n));
  const ptyPidOf = new Map<number, number>();
  for (const id of ids) {
    const pid = ptys.get(id)?.pid;
    if (Number.isInteger(pid) && (pid as number) > 0) ptyPidOf.set(id, pid as number);
  }
  const running = aios.listRunningAgents();
  const map = aios.sessionPidsUnder([...ptyPidOf.values()], running.map((a) => a.pid));
  const byPid = new Map(running.map((a) => [a.pid, a]));
  const out: Record<number, { name: string; id: string; pid: number }> = {};
  for (const [paneId, ptyPid] of ptyPidOf) {
    const a = byPid.get(map[ptyPid]);
    if (a) out[paneId] = { name: a.name, id: a.sessionId, pid: a.pid };
  }
  return out;
});
/* Settings asks whether macOS has refused a banner, so the alerts control can say why it looks
   like it is doing nothing rather than leaving the operator to find System Settings unaided. */
ipcMain.handle('claude:permissionModes', () => aios.permissionModes());
ipcMain.handle('shell:frameworkPath', () => aios.frameworkPathSetting());
ipcMain.handle('shell:setFrameworkPath', (_e, v: string) => { aios.setFrameworkPath(String(v ?? '')); return aios.frameworkPathSetting(); });
ipcMain.handle('claude:setKeys', () => aios.claudeConfigSetKeys());
ipcMain.handle('claude:stores', () => aios.claudeConfigStores());
ipcMain.handle('claude:set', (_e, key: 'model' | 'effort' | 'advisor' | 'mode' | 'remoteControl' | 'autoUpdates', value: unknown) => {
  aios.setClaudeConfig(key, value);
  return aios.claudeConfig();
});
ipcMain.handle('shell:setSetting', (_e, key: 'claudeCmd' | 'showHints' | 'showNudges' | 'showMemory' | 'theme' | 'termFontSize' | 'chatFontFamily' | 'chatFontSize' | 'showHidden' | 'fileIcons' | 'autoReveal' | 'openExports' | 'showWeekNumbers' | 'killBehavior' | 'terminalMode' | 'openNotesIn' | 'appFontSize' | 'hiddenCards' | 'ignorePaths' | 'locale' | 'caffeinate' | 'attention' | 'busFocus' | 'lidAsked' | 'claudeView', value: unknown) => {
  /* claudeView is a closed set. Anything else is refused rather than stored: normalizeClaudeView would ignore it on read and fall
     back to the old chatViewDefault, so a bad write could silently resurrect a value the operator had moved on from. */
  if (key === 'claudeView' && value !== 'chat' && value !== 'terminal') return aios.shellSettings();
  aios.setShellSetting(key, value);
  /* AI-132: changing the RULE retires any override — otherwise you switch manual→auto and watch
     auto not follow sessions, with nothing on screen explaining why. Applies immediately rather
     than waiting for the next 2s tick, so the button reflects the new mode as the select closes. */
  if (key === 'caffeinate') caffeine.modeChanged();
  if (key === 'locale') {
    aios.applyLocale();          // reload i18n for main-process strings (nudges, setup, calendar)
    installMenu(() => mainWin);  // the native menu can't re-render itself — rebuild it
  }
  host?.postState();             // re-emit localized pulse state (nudge, calendar)
  return aios.shellSettings();
});

let mainWin: BrowserWindow | undefined;

/* ONE APP, ONE INSTANCE — and the reason is not tidiness.
   Operator-reported 2026-09-15: clicking a notification banner opened a SECOND AIOS. macOS
   activates the bundle through LaunchServices, and with no lock that starts a whole new app.
   It is easy to see as cosmetic and it is not: every instance publishes the same presence file
   `~/.aios/surfaces/app.json` and watches the same spawn-inbox, so the second silently
   overwrites the first's pid and the two then RACE for every request — which is exactly the
   double-delivery the bus contract was built to prevent, reached from a direction the contract
   cannot see, because both racers believe they are the only App.
   The smoke run is exempt: it launches deliberately alongside a developer's own App, and a lock
   there would make the gate exit 0 having tested nothing. */
/* MUST EQUAL `build.appId` in package.json — asserted by a test, because it cannot be read.
   It was read at first, which was wrong in the way that matters: electron-builder REWRITES
   package.json when it packages and drops the whole `build` block, so in the shipped app the
   lookup returned undefined and silently fell through to this literal. It worked only because
   the literal was already correct. Change `build.appId` and the packaged app would have gone on
   announcing the old id while the installer wrote the new one onto the shortcut — and a
   mismatched id makes Windows DROP every toast, with nothing logged.
   A literal plus a test is the honest shape: one place a human edits, and a loud failure when
   the two disagree. A runtime read that works in dev and not in the package is worse than
   either, because it looks like it cannot drift. */
const APP_ID = 'com.the-aios.app';

/* A QA run must coexist with the operator's open App and dev window, so it never takes (or yields to) the lock. */
if (!(SMOKE || CHAT_SHOT) && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    /* Someone asked for this app — a banner click, a Dock click, `open -a`. Show the window
       they already have instead of starting another. */
    const w = BrowserWindow.getAllWindows()[0];
    if (!w || w.isDestroyed()) return;
    if (w.isMinimized()) w.restore();
    w.show();
    w.focus();
  });
}

/* WINDOWS WILL NOT ATTRIBUTE A TOAST WITHOUT THIS, and the failure is silent: notifications
   simply never appear, with nothing logged and nothing to click. Windows keys toasts to an
   Application User Model ID, which must match the one on the Start Menu shortcut the installer
   creates — electron-builder's NSIS target writes `build.appId` there, so this reads the same
   value from package.json rather than restating it. Without the call Electron derives an id from
   the executable path, which does not match the shortcut, and the toast is dropped.
   Harmless and a no-op off Windows; called before whenReady because the id must be set before
   anything is shown. */
if (process.platform === 'win32') {
  try { app.setAppUserModelId(APP_ID); } catch { /* older Electron — the default id stands */ }
}

/* ── CHAT SHOT: screenshots of the chat view, from a window that is never shown ──────────────────
   `--chat-shot=<dir>` is a QA harness for whoever iterates on the chat view's looks: it boots the
   real renderer in a hidden window, opens one terminal pane that "is" a Claude session, feeds the
   chat skin hand-written events (the same `chatSkinHandleEvent` entry the transcript tail uses),
   and writes one PNG per entry of a JSON fixture. Run it through `npm run chat:shot` — the runner
   (scripts/chat-shot.mjs) builds the synthetic HOME and the throwaway userData this mode requires.

   Why not --shot or --eval: both create a VISIBLE window (`show: !SMOKE`), which puts a window on
   the operator's desktop mid-work. This mode never does: createWindow passes show:false, and
   lockWindowHidden() makes any later show()/focus() a no-op.

   THE FIXTURE (src/test/fixtures/chat-shot.json by default, or --chat-shot-fixture=<path>):
     { "version": 1,
       "settleMs": 700,                          // fonts + transitions; per-shot "wait" adds to it
       "layout": "dock-max",                     // default for every shot; see per-shot "layout"
       "setup": "…js…" | ["…", …],               // optional, runs once before the first shot
       "streams": { "name": [ <event>, … ] },    // reusable event lists, see below
       "shots": [ { "name": "chat-dark",         // → <dir>/chat-dark.png (letters, digits, . _ -)
                    "theme": "dark" | "light",   // default dark
                    "events": ["conversation", { "type": "turn", "open": true }],
                                                 // stream names and/or inline events, in order
                    "composer": "text in the compose box",
                    "terminal": "text written to the xterm (NOT the pty) — for dialog states",
                    "js": "…" | ["…"],           // extra JS, async, after the events; see ctx below
                    "size": { "width": 900, "height": 700 },   // CSS px; default 1280x860
                    "layout": "dock-max" | "workbench",   // dock maximised (default) or the stock layout
                    "clip": "window" | "pane",   // default window
                    "wait": 0,                   // extra ms before the capture
                    "hover": ".chat-md .cs-path.file",   // selector of an element to put the REAL mouse pointer over (see below)
                    "working": true } ] }        // keep the "working" indicator lit (default true
                                                 // while the last turn event left the turn open)
   An <event> is what chatSkinHandleEvent takes minus paneId (reset · items · turn · usage · prompt ·
   missing · error) plus one extra type, "status", which feeds the usage bar like the statusline does
   ({ "type": "status", "fiveHourPct": 42, … }; a "fiveHourResetsAt" / "sevenDayResetsAt" of "+8280" means
   8280 seconds from the moment of the shot, so a reset never ends up in the past). A shot's "js" runs in the renderer with
   ctx = { id, p (the pane), cs (p.chatSkin), root (the chat overlay), $ / $$ (querySelector(All) in
   it), sleep(ms), feed(events) }; throwing fails the run, naming the shot. Adding a shot is adding an
   object to "shots" — main.ts never changes.

   HOVER. A :hover style cannot be photographed by toggling a class (that would test a copy of the rule, not the
   rule), so a shot's "hover" selector makes this process send a real mouseMove to the centre-left of that element
   after the shot's js has run, which makes the browser apply :hover and fire mouseenter exactly as for an operator.
   The shot FAILS if the element does not end up matching :hover, so a pointer that missed cannot pass for a hover
   picture. Nothing production is involved: the event goes to the hidden QA window only.

   THE FAKE SESSION, AND THE WATCH THAT COMES BACK. The pane gets a made-up (but well-formed) session
   id so the chat view is eligible and enters watch mode, which asks main to tail
   a .jsonl file under <HOME>/.claude/projects/. That file does not exist, so main answers 'not-found'
   asynchronously and keeps looking. Rather than race that reply, the driver (1) awaits an identical
   chatSkinWatch itself, which also replaces the app's own watch, so no tail is running any more, and
   (2) only then injects `reset` + the fixture's events. Nothing can emit a transcript event after
   that, and the one late path that remains (the app's own not-found reply) only repaints a state
   line that `items` has already turned to 'live'. */
interface ChatShotShot {
  name: string; theme?: 'dark' | 'light'; events?: Array<string | Record<string, unknown>>; composer?: string;
  terminal?: string | string[] | null; js?: string | string[]; size?: { width: number; height: number };
  clip?: 'window' | 'pane'; wait?: number; working?: boolean; layout?: 'dock-max' | 'workbench'; hover?: string;
}
interface ChatShotFixture { version: 1; settleMs?: number; layout?: 'dock-max' | 'workbench'; setup?: string | string[]; streams?: Record<string, Array<Record<string, unknown>>>; shots: ChatShotShot[]; }

function validateChatShotFixture(raw: unknown): ChatShotFixture {
  const fx = raw as ChatShotFixture;
  if (!fx || typeof fx !== 'object' || fx.version !== 1) throw new Error('fixture: "version" must be 1');
  if (fx.layout !== undefined && fx.layout !== 'dock-max' && fx.layout !== 'workbench') throw new Error('fixture: "layout" must be "dock-max" or "workbench"');
  if (!Array.isArray(fx.shots) || fx.shots.length === 0) throw new Error('fixture: "shots" must be a non-empty array');
  const streams = fx.streams ?? {};
  const seen = new Set<string>();
  for (const s of fx.shots) {
    if (!s || typeof s.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(s.name)) throw new Error(`fixture: bad shot name ${JSON.stringify(s && s.name)} (letters, digits, . _ - only; it becomes a file name)`);
    if (seen.has(s.name)) throw new Error(`fixture: duplicate shot name "${s.name}"`);
    seen.add(s.name);
    if (s.theme !== undefined && s.theme !== 'dark' && s.theme !== 'light') throw new Error(`fixture: shot "${s.name}": theme must be "dark" or "light"`);
    if (s.layout !== undefined && s.layout !== 'dock-max' && s.layout !== 'workbench') throw new Error(`fixture: shot "${s.name}": layout must be "dock-max" or "workbench"`);
    if (s.clip !== undefined && s.clip !== 'window' && s.clip !== 'pane') throw new Error(`fixture: shot "${s.name}": clip must be "window" or "pane"`);
    for (const e of s.events ?? []) {
      if (typeof e === 'string' ? !Array.isArray(streams[e]) : !e || typeof e !== 'object' || typeof (e as { type?: unknown }).type !== 'string') throw new Error(`fixture: shot "${s.name}": unknown stream or malformed event ${JSON.stringify(e).slice(0, 80)}`);
    }
    if (s.hover !== undefined && (typeof s.hover !== 'string' || !s.hover.trim())) throw new Error(`fixture: shot "${s.name}": hover must be a non-empty selector`);
    if (s.size && !(s.size.width >= 320 && s.size.height >= 320 && s.size.width <= 4000 && s.size.height <= 4000)) throw new Error(`fixture: shot "${s.name}": size out of range`);
  }
  return fx;
}

/* The renderer half. Plain JS in a String.raw (no backticks or dollar-brace inside) because it is
   evaluated in the page, where `panes`, `createPane`, `chatSkin*` are script-level globals — the
   same trick --eval uses. It never touches the pty: only the xterm's screen (term.write) and the
   chat skin's own event entry. */
const CHAT_SHOT_DRIVER = String.raw`(() => {
  if (window.__chatShot) return 'already';
  const FAKE_SESSION = '00000000-0000-4000-8000-00000000c0de';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, what, ms) => {
    const t0 = Date.now();
    for (;;) {
      let v = false;
      try { v = fn(); } catch (e) { v = false; }
      if (v) return v;
      if (Date.now() - t0 > (ms || 20000)) throw new Error('timed out waiting for ' + what);
      await sleep(50);
    }
  };
  const S = { pin: 0 };
  const feed = (id, events) => {
    const p = panes.get(id);
    const cs = p && p.chatSkin;
    if (!cs) throw new Error('the pane has no chat view');
    for (const ev of events) {
      if (ev.type === 'status') {
        const s = Object.assign({}, ev); delete s.type;
        // a reset written as '+8280' means "that many seconds from now": a fixture cannot hold a real instant, which would be in the past by the next run
        for (const k of Object.keys(s)) if (/ResetsAt$/.test(k) && typeof s[k] === 'string' && /^\+\d+$/.test(s[k])) s[k] = Math.floor(Date.now() / 1000) + Number(s[k].slice(1));
        chatApplyStatus(cs, s);
        continue;
      }
      chatSkinHandleEvent(Object.assign({ paneId: id }, ev));
    }
  };
  window.__chatShot = {
    async ready() {
      await waitFor(() => typeof createPane === 'function' && typeof chatSkinSetView === 'function' && typeof chatSkinSetMode === 'function' && window.glassShell && panes instanceof Map && document.readyState === 'complete', 'the renderer');
      await document.fonts.ready;
      await sleep(1500);   // first paint of the workbench (pulse, explorer) before anything is measured
      return true;
    },
    async open(o) {
      THEME = o.theme === 'light' ? 'light' : 'dark';
      applyTheme(THEME);
      // noProfile: a bare shell, so nothing from a profile prints into the xterm; 'cat' then keeps it silent
      const id = await createPane({ name: o.name, cmd: 'cat', bypassReady: true, noProfile: true });
      const p = panes.get(id);
      if (!p) throw new Error('createPane returned no pane');
      // 'dock-max' gives the chat the whole height of the window, which is what a design review wants
      // to look at; 'workbench' is the layout an operator gets by default (editor above, dock below).
      th = o.layout === 'workbench' ? TH_DEFAULT : TH_MAX;
      applySplit(); fitTerms();
      p.isSession = true;
      p.sessionId = FAKE_SESSION;   // eligibility normally comes from the session registry; set directly, never persisted
      await sleep(400);             // the shell has printed whatever it will print
      /* Through the mode, as an operator gets there (Settings → Claude sessions view → Chat), so the Settings page photographed
         later reads "Chat" and the tab strip is the one a real chat user sees. With persist:false: the shot has no stored setting
         to write, and nothing here should reach a shell.json. */
      await chatSkinSetMode('chat', { persist: false });
      if (p.view !== 'chat') throw new Error('the pane is not eligible for the chat view');
      await waitFor(() => p.chatSkin && p.chatSkin.watched === FAKE_SESSION, 'the chat watch');
      await window.glassShell.chatSkinWatch(id, FAKE_SESSION);   // see "THE FAKE SESSION" in main.ts
      await sleep(150);
      p.chatSkin.statusAt = Date.now() + 3600000;   // the global usage refresh must not overwrite the fixture's numbers
      return id;
    },
    async apply(id, spec) {
      const p = panes.get(id);
      const cs = p.chatSkin;
      feed(id, [{ type: 'reset' }].concat(spec.events || []));
      if (typeof spec.composer === 'string' && spec.composer) {
        cs.input.value = spec.composer;
        cs.input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      if (spec.terminal !== null && spec.terminal !== undefined) {
        p.term.reset();
        // a TUI draws its dialog at the BOTTOM of the screen, and the chat shows the lower part of the
        // xterm in its strip, so pad the text down instead of leaving it at the top where it is cropped
        const lines = String(spec.terminal).split(/\r?\n/);
        const pad = Math.max(0, p.term.rows - lines.length - 1);
        await new Promise((r) => p.term.write('\r\n'.repeat(pad) + lines.join('\r\n'), r));
        repaintTerm(p);
      }
      if (S.pin) { clearInterval(S.pin); S.pin = 0; }
      if (cs.turnOpen && spec.working !== false) {
        const hold = () => { p.lastPtyAt = Date.now(); chatSkinControls(p); };
        hold();
        S.pin = setInterval(hold, 250);   // "working" needs recent pty output; keep it lit for the capture
      }
      return true;
    },
    ctx(id) {
      const p = id === null || id === undefined ? null : panes.get(id);
      const cs = p ? p.chatSkin : null;
      const root = cs ? cs.root : document;
      return {
        id, p, cs, root, sleep,
        $: (sel) => root.querySelector(sel),
        $$: (sel) => Array.from(root.querySelectorAll(sel)),
        feed: (events) => feed(id, events),
      };
    },
    async settle(id, ms) {
      await document.fonts.ready;
      await sleep(ms);
      await new Promise((r) => {
        let done = false;
        const fin = () => { if (!done) { done = true; r(); } };
        requestAnimationFrame(() => requestAnimationFrame(fin));
        setTimeout(fin, 400);   // a throttled page may never deliver the frames
      });
      const p = panes.get(id);
      const b = p.el.getBoundingClientRect();
      return { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) };
    },
    close(id) {
      if (S.pin) { clearInterval(S.pin); S.pin = 0; }
      closePane(id);
      return true;
    },
  };
  return 'installed';
})()`;

/* The process-level half of a chat-bench probe. The fixture prints `chat-bench:probe <label> <json>` after forcing a GC in
   the renderer; this answers with `chat-bench: metrics <label> <json>` carrying the renderer process's working set and private
   bytes (app.getAppMetrics, KB) and this process's RSS and heap after a forced GC. The fixture waits a moment after each probe. */
async function chatBenchProbe(win: BrowserWindow, msg: string): Promise<void> {
  try {
    const label = msg.split(' ')[1] ?? '?';
    try { v8.setFlagsFromString('--expose-gc'); (vm.runInNewContext('gc') as () => void)(); } catch { /* no GC: the heap number is then not post-GC */ }
    const m = app.getAppMetrics().find((x) => x.pid === win.webContents.getOSProcessId());
    const mu = process.memoryUsage();
    console.log('chat-bench: metrics ' + label + ' ' + JSON.stringify({
      rendererWorkingSetKB: m?.memory.workingSetSize ?? null, rendererPrivateKB: m?.memory.privateBytes ?? null,
      mainRssMB: +(mu.rss / 1048576).toFixed(1), mainHeapMB: +(mu.heapUsed / 1048576).toFixed(1),
    }));
  } catch (e) { console.log('chat-bench: metrics-error ' + String(e)); }
}

/* Belt and braces for "never visible": no code path may bring this window up. */
function lockWindowHidden(win: BrowserWindow): void {
  const noop = (): void => { /* a QA window is never shown */ };
  Object.assign(win, { show: noop, showInactive: noop, focus: noop, restore: noop, maximize: noop, setFullScreen: noop });
  win.on('show', () => { if (!win.isDestroyed()) win.hide(); });
}

function dropChatShotUserData(): void {
  if (chatShotUserData && path.basename(chatShotUserData).startsWith('aios-chatshot-ud-')) {
    try { fs.rmSync(chatShotUserData, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

async function runChatShot(win: BrowserWindow): Promise<void> {
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  const finish = (code: number): void => { dropChatShotUserData(); app.exit(code); };
  const fail = (msg: string): void => { console.error('chat-shot: FAILED — ' + msg); finish(1); };
  /* A hung renderer must not hang whoever called us (the runner has its own, longer, kill timer). 300 s, because
     the full shot list takes about two minutes and grows with every scenario added. */
  setTimeout(() => fail('timed out after 300 s'), 300_000);
  try {
    if (!CHAT_SHOT_DIR) throw new Error('missing output folder: --chat-shot=<dir>');
    const outDir = path.resolve(CHAT_SHOT_DIR);
    fs.mkdirSync(outDir, { recursive: true });
    const fixturePath = CHAT_SHOT_FIXTURE_ARG
      ? path.resolve(CHAT_SHOT_FIXTURE_ARG.slice('--chat-shot-fixture='.length))
      : path.join(__dirname, '..', '..', 'src', 'test', 'fixtures', 'chat-shot.json');
    let fx: ChatShotFixture;
    try { fx = validateChatShotFixture(JSON.parse(fs.readFileSync(fixturePath, 'utf8'))); }
    catch (e) { throw new Error(`cannot use fixture ${fixturePath}: ${e instanceof Error ? e.message : String(e)}`); }

    const wc = win.webContents;
    wc.setBackgroundThrottling(false);
    if (wc.isLoading()) await new Promise<void>((r) => wc.once('did-finish-load', () => r()));
    const exec = (code: string): Promise<unknown> => wc.executeJavaScript(code, true);
    const userJs = (js: string | string[], id: number | null): Promise<unknown> =>
      exec(`(async () => { const ctx = window.__chatShot.ctx(${id === null ? 'null' : String(id)}); ${Array.isArray(js) ? js.join('\n') : js}\n})()`);

    await exec(CHAT_SHOT_DRIVER);
    await exec('window.__chatShot.ready()');
    if (fx.setup) await userJs(fx.setup, null);

    const written: string[] = [];
    for (const shot of fx.shots) {
      const step = (what: string, e: unknown): Error => new Error(`shot "${shot.name}": ${what}: ${e instanceof Error ? e.message : String(e)}`);
      const size = shot.size ?? CHAT_SHOT_SIZE;
      win.setContentSize(size.width, size.height);
      await sleep(200);   // let the layout follow the new size before a pane is created in it
      const streams = fx.streams ?? {};
      const events = (shot.events ?? []).flatMap((e) => (typeof e === 'string' ? streams[e] : [e]));
      let id: number;
      try { id = (await exec(`window.__chatShot.open(${JSON.stringify({ name: 'chat-qa', theme: shot.theme ?? 'dark', layout: shot.layout ?? fx.layout ?? 'dock-max' })})`)) as number; }
      catch (e) { throw step('opening the chat view', e); }
      try {
        await exec(`window.__chatShot.apply(${id}, ${JSON.stringify({ events, composer: shot.composer, terminal: Array.isArray(shot.terminal) ? shot.terminal.join('\n') : shot.terminal, working: shot.working })})`);
        if (shot.js) await userJs(shot.js, id);
      } catch (e) { throw step('applying events / js', e); }
      if (shot.hover) {
        try {
          const at = (await exec(`(() => { const e = window.__chatShot.ctx(${id}).$(${JSON.stringify(shot.hover)}); if (!e) return null;
            e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect();
            return { x: Math.round(r.left + Math.min(r.width / 2, 40)), y: Math.round(r.top + r.height / 2) }; })()`)) as { x: number; y: number } | null;
          if (!at) throw new Error(`nothing matches ${shot.hover}`);
          await sleep(100);   // the scroll above must have been laid out before the pointer lands
          wc.sendInputEvent({ type: 'mouseMove', x: at.x, y: at.y });
          await sleep(200);
          const hovered = await exec(`window.__chatShot.ctx(${id}).$(${JSON.stringify(shot.hover)}).matches(':hover')`);
          if (hovered !== true) throw new Error(`the pointer did not end up over ${shot.hover}`);
        } catch (e) { throw step('hovering', e); }
      }
      const rect = (await exec(`window.__chatShot.settle(${id}, ${Math.max(0, (fx.settleMs ?? 700) + (shot.wait ?? 0))})`)) as { x: number; y: number; width: number; height: number };
      const img = shot.clip === 'pane' ? await wc.capturePage(rect) : await wc.capturePage();
      const { width, height } = img.getSize();
      /* A page that never painted still captures: as one flat colour. That would read as a
         "working" harness while measuring nothing, so refuse it. */
      const bmp = img.toBitmap();
      let varied = false;
      for (let i = 4; i < bmp.length && !varied; i += 97) varied = bmp[i] !== bmp[0] || bmp[i + 1] !== bmp[1] || bmp[i + 2] !== bmp[2];
      if (!varied) throw new Error(`shot "${shot.name}": the capture is one flat colour — the hidden window did not paint`);
      const file = path.join(outDir, `${shot.name}.png`);
      fs.writeFileSync(file, img.toPNG());
      written.push(file);
      const expectW = (shot.clip === 'pane' ? rect.width : size.width) * 2;
      console.log(`chat-shot: ${file} ${width}x${height}${width === expectW ? '' : ` (expected ${expectW} wide: the 2x scale did not apply)`}`);
      try { await exec(`window.__chatShot.close(${id})`); } catch { /* the run is about to end or fail anyway */ }
    }
    console.log(`chat-shot: done — ${written.length} PNG(s) in ${outDir}`);
    finish(0);
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
}

/* Every session the App creates, including a browser pane's, gets the web permission policy
   before any page can ask for anything (webPermissions.ts explains why the default is not safe). */
app.on('session-created', (s) => installWebPermissionPolicy(s));
app.whenReady().then(() => {
  installWebPermissionPolicy(session.defaultSession);
  aios.setSystemLocale(app.getLocale());  // capture the OS language so `auto` can resolve to it
  aios.applyLocale();            // load the resolved UI locale before building the menu
  const win = createWindow();
  mainWin = win;
  /* macOS: THE RED BUTTON HIDES, IT DOES NOT QUIT. The Mac convention, and here it protects work:
     the terminals live in this window and the App answers the spawn-inbox, so a reflexive close
     used to end live sessions and leave agents' requests unclaimed. ⌘Q, the Dock's Quit, logout
     and an update install still quit (quitState.ts explains why the install needs its own mark).
     Windows and Linux keep closing = quitting, their convention. Smoke/eval runs never hide. */
  win.on('close', (e) => {
    if (!closeShouldHide(process.platform, isQuitting(), !!(SMOKE || EVAL || SHOT || CHAT_SHOT))) return;
    e.preventDefault();
    if (win.isFullScreen()) { win.once('leave-full-screen', () => win.hide()); win.setFullScreen(false); }
    else win.hide();
  });
  installMenu(() => mainWin);
  host = new PanelHost(win.webContents);
  host.start();
  if (!SMOKE && !SHOT && !CHAT_SHOT) setupExplorerWatch(win);
  /* Seed Claude's config once, so the Settings mirror has real values to reflect instead of
     assertions nobody read. Idempotent by marker, skipped in smoke/shot so a gate never writes
     into the machine it is testing on. */
  if (!SMOKE && !SHOT && !EVAL && !CHAT_SHOT) {
    try {
      const r = aios.seedClaudeDefaults();
      if (!r.already && r.seeded.length) console.log(`[claude-config] seeded on first install: ${r.seeded.join(', ')}`);
    } catch (e) { console.log('[claude-config] seeding skipped:', String(e)); }
  }
  if (!SMOKE && !SHOT && !CHAT_SHOT) setupClaudeConfigWatch(win);
  // Spawn-inbox command bus: watch ~/.aios/spawn-inbox/ and fulfil agent-dropped
  // spawn/kill/send requests natively (Glass 0.4.2/0.4.3 parity). Interactive
  // window only — never during smoke/shot/eval.
  if (!SMOKE && !SHOT && !EVAL && !CHAT_SHOT) initCommandBus(() => mainWin, app.getVersion());
  /* AI-132 keep-awake. Same guards as the bus: a smoke/shot/eval run must not hold a real
     machine awake. 2s matches the rendering cadence the RUNNING card already polls sessions on,
     so `auto` reacts as fast as the operator can see a session go busy and no new poll exists
     just for this. The teardown releases the blocker — the process dying releases it anyway, so
     this only covers a quit that lingers. */
  if (!SMOKE && !SHOT && !EVAL && !CHAT_SHOT) {
    const stopCaffeine = caffeine.init((st) => {
      const w = mainWin;
      if (w && !w.isDestroyed() && !w.webContents.isDestroyed()) w.webContents.send('shell:caffeinate', st);
    }, 2000);
    app.on('before-quit', stopCaffeine);
  }
  // Auto-update (packaged builds only — self-guards on app.isPackaged): check on
  // boot + every 6h, native-notify when staged, install on quit. GitHub-Releases
  // channel; never fires in dev/smoke/shot/eval. Renderer surface folds into the
  // Needs-you inbox card (batch G) later; this is the mechanism only.
  if (!SMOKE && !SHOT && !EVAL && !CHAT_SHOT) initAutoUpdater(() => mainWin);
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
      if (CHAT_BENCH && msg && msg.startsWith('chat-bench:probe ')) void chatBenchProbe(win, msg);
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
  win.on('focus', () => { host?.refreshUpdateStatus(); host?.refreshStateIfChanged(); rewireForRoots(win); });
  /* Every 4s while the window is up. Cheap (two path resolutions) and it only acts on a CHANGE,
     so the common case — roots that already exist — costs nothing after the first tick. */
  const rootPoll = setInterval(() => { if (!win.isDestroyed()) rewireForRoots(win); }, 4000);
  win.on('closed', () => clearInterval(rootPoll));
  win.on('closed', () => { tail.unwatchAll(); for (const id of [...skins.keys()]) void endSkin(id, false); });   // macOS hides the window instead of closing it, so this is a real teardown
  win.on('closed', () => { host?.dispose(); host = undefined; for (const w of explorerWatchers.splice(0)) { try { w.close(); } catch { /* ignore */ } } });
  if (CHAT_SHOT) { lockWindowHidden(win); void runChatShot(win); return; }
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
    const out = SHOT.includes('=') ? SHOT.split('=')[1] : path.join(os.tmpdir(), 'aios-shot.png');
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
    const probeShell = defaultShell();
    // powershell.exe accepts `-c` (abbrev. of -Command) and `echo` (alias Write-Output), but be
    // explicit per platform: -NoProfile keeps it fast, -Command is the correct token, and cmd.exe
    // (if ever COMSPEC-resolved) would need /c not -c.
    const probeArgs = os.platform() === 'win32'
      ? ['-NoProfile', '-Command', 'echo GLASS_SHELL_PTY_OK']
      : ['-c', 'echo GLASS_SHELL_PTY_OK'];
    const p = pty.spawn(probeShell, probeArgs, { name: 'xterm', cols: 80, rows: 24, cwd: os.homedir(), env: process.env as Record<string, string> });
    let buf = '';
    p.onData((d) => { buf += d; });

    const gates = async (): Promise<boolean> => {
      await new Promise((r) => setTimeout(r, 3000)); // window + iframe settle
      /* This gate measures FRAMEWORK DISCOVERY — can the app find the operator's agents,
         commands and skills. It therefore requires a framework to discover, and on a bare CI
         runner there is none: it reported `operator=, agents=0` and failed the whole smoke run
         for the absence of a fixture rather than for anything about the build.
         That is not a hypothetical. `smoke` is gated to pull_request, and every green run on
         main was a push — so this job had never actually executed in CI. Its first real run
         failed here, exactly as release.yml's comment predicted when smoke was pulled out of
         the release lane. A gate that fails for reasons unrelated to what it guards gets
         disabled within a week, which costs more than it ever protected.
         So: no framework root → the gate DID NOT RUN, and says so. Unmeasured must never read
         as measured (that direction is the whole point), but it must not read as broken either.
         The real fix is a minimal vault fixture in CI so this always runs; until then, honest
         about which of the two it is. Same treatment the viewer gate got, for the same reason. */
      let stateOk = false;
      try {
        const root = aios.frameworkRoot();
        if (!root) {
          stateOk = !SMOKE_STRICT;   // not a pass on the requirement — a pass on "nothing to measure"
          console.log(`shell-smoke: state — ${SMOKE_STRICT ? 'FAILED: strict mode, but there is no framework root to discover — the fixture did not take effect (check GLASS_FRAMEWORK_PATH)' : 'SKIPPED (no framework root on this machine; discovery gate did not run)'}`);
        } else {
          const agents = aios.discoverAgents().length;
          const op = aios.operatorName();
          stateOk = agents > 0;   // a name is optional (virgin vault); discovery is the real signal
          console.log(`shell-smoke: state — operator=${op}, agents=${agents}, commands=${aios.discoverCommands().length}, skills=${aios.discoverSkills().length}`);
        }
      } catch (err) { console.error('shell-smoke: state FAIL', err); }
      const rendererOk = await win.webContents.executeJavaScript('window.__workbenchOk === true').catch(() => false);
      let panelOk = false;
      let themeOk = false;
      let animOk = false;
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
      /* GATE: AN ANIMATION THAT IS SUPPOSED TO RUN, RUNS — and on a compositable property.
         The unit test reads @keyframes, which is necessary and not sufficient: a malformed rule
         leaves the keyframes perfectly valid while the DECLARATION never reaches the element.
         That happened — a stray `}` closed `.shimverb` one line early, the shimmer silently
         stopped, every test stayed green, and the operator noticed before any check did.
         Computed style in a live renderer is the only thing that can tell "defined" from
         "applied". */
      try {
        const anim = await win.webContents.executeJavaScript(`(() => {
          /* The ring lives on ::after, not on the dot — reading the element alone reports 'none'
             and says nothing about the animation AI-157 was actually about. */
          const probe = (cls, pseudo) => { const el = document.createElement('span'); el.className = cls;
            document.body.appendChild(el); const cs = getComputedStyle(el, pseudo || null);
            const r = { name: cs.animationName, dur: cs.animationDuration }; el.remove(); return r; };
          return {
            reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
            shim: probe('shimverb'), dot: probe('pdot busy', '::after'),
          };
        })()`).catch(() => null);
        /* BRANCHED ON THE OPERATOR'S OWN SETTING, because both answers are correct behaviour and
           only one of them is "the animation runs". The theme carries a reduced-motion block that
           kills every animation by design, and CI's macOS runner reports reduce — so a gate that
           unconditionally demanded motion failed a build whose CSS was doing exactly the right
           thing. It had never run in CI before this branch, which is how it shipped.
           Asserting both halves is strictly more than the original did: under reduce, motion is
           the DEFECT, and nothing was checking that the escape hatch actually worked. */
        const runs = (a: { name?: string; dur?: string } | undefined): boolean =>
          !!a && a.name !== 'none' && a.dur !== '0s';
        const ok = !!anim && (anim.reduced
          ? !runs(anim.shim) && !runs(anim.dot)
          : runs(anim.shim) && runs(anim.dot));
        if (!ok) {
          console.error(`shell-smoke: animation gate FAIL — reduced-motion=${anim && anim.reduced}, `
            + `shimverb=${JSON.stringify(anim && anim.shim)}, busyDot=${JSON.stringify(anim && anim.dot)}`);
        }
        animOk = ok;
        console.log(`shell-smoke: animations — reduced=${anim?.reduced} shimverb=${anim?.shim.name}/${anim?.shim.dur} busyDot=${anim?.dot.name}/${anim?.dot.dur}`);
      } catch (err) { console.error('shell-smoke: animation gate error', err); }
      /* GATE: A REBUILT TOOL TAB STILL HAS CONTENT, AND NEVER GOES BLANK TO GET THERE.
         Settings is declared `rebuild: true`, so re-opening or re-showing it re-runs an ASYNC
         builder. That builder used to empty the body first, which is what the operator saw as
         Settings flickering off and on as it saved. It now stages the new content beside the old
         and swaps — and the stage has to stay ATTACHED, because the Setup painter bails when its
         wrap is off-document. Both halves are invisible to a source-reading test and would fail
         as an empty tab, so: rebuild it for real, then count what is there. */
      let rebuildOk = false;
      try {
        await win.webContents.executeJavaScript('openSettingsTab(), 1');
        /* Poll for the FIRST build — it is async and a fixed sleep would race it. */
        let rowsFirst = 0;
        for (let i = 0; i < 60; i++) {                       // up to ~6s, checked every 100ms
          rowsFirst = Number(await win.webContents.executeJavaScript(
            "(() => { const p = [...panes.values()].find((x) => x.path === '::settings');"
            + " return p ? p.el.querySelectorAll('.trow').length : 0; })()").catch(() => 0));
          if (rowsFirst > 3) break;
          await new Promise((r) => setTimeout(r, 100));
        }
        /* AWAIT THE REBUILD ITSELF, never a poll. Polling here CANNOT FAIL, and that is the
           whole point of the change under test: the new content is staged beside the old, so a
           poll reads the still-present old rows and returns immediately, before the swap. The
           first version of this gate did exactly that and passed a mutation that threw the
           rebuilt content away — a check with an unreachable failing branch. `executeJavaScript`
           resolves promises, so awaiting the pane's own serialized rebuild is what makes the
           measurement land after the swap rather than before it. */
        const rowsAfter = Number(await win.webContents.executeJavaScript(`(async () => {
          const p = [...panes.values()].find((x) => x.path === '::settings');
          if (!p || !p.rebuild) return -1;
          await p.rebuild();
          return p.el.querySelectorAll('.trow').length;
        })()`).catch(() => -1));
        rebuildOk = Number(rowsFirst) > 3 && Number(rowsAfter) > 3;
        if (!rebuildOk) console.error(`shell-smoke: rebuild gate FAIL — rows ${rowsFirst} then ${rowsAfter}`);
        console.log(`shell-smoke: settings rebuild — ${rowsFirst} rows, ${rowsAfter} after rebuild`);
      } catch (err) { console.error('shell-smoke: rebuild gate error', err); }

      /* GATE: #28 — A RESTORED TAB IS REAL, REMEMBERED, AND COSTS NOTHING UNTIL OPENED. Driven
         through the actual functions rather than read as source: a placeholder is created, must
         appear in the strip marked as waiting, must NOT be the visible pane (nothing has started),
         must be in the persisted list, and must LEAVE the list when the operator closes it. The
         lookup behind the launch offer is probed with a path-traversal id, which it must drop —
         that id becomes part of a filesystem path. Nothing here spawns a process. */
      let restoreOk = false;
      try {
        const rs = await win.webContents.executeJavaScript(`(async () => {
          const keep = localStorage.getItem('shellSessions');
          const sid = '00000000-0000-4000-8000-00000000abcd';
          const termsBefore = [...panes.values()].filter((x) => x.kind === 'term').length;
          const id = createRestoreTab({ sessionId: sid, name: 'smoke-restore', cwd: '' });
          const p = panes.get(id);
          const tabOk = !!(p && p.tab && p.tab.classList.contains('restoring') && document.body.contains(p.tab));
          /* NOTHING STARTED — the property lazy restore exists for. Asked as "no new terminal pane",
             not "not the active pane": a placeholder may legitimately be SHOWN (it is the last thing
             in its zone), and then its body must say it is paused and offer Resume. */
          await new Promise((r) => setTimeout(r, 300));
          const idle = !!p && p.kind === 'restore'
            && [...panes.values()].filter((x) => x.kind === 'term').length === termsBefore
            && !!p.el.querySelector('button.vbtn');
          const inSnap = sessionsSnapshot().sessions.some((x) => x.sessionId === sid);
          persistSessions();
          await new Promise((r) => setTimeout(r, 400));
          const stored = JSON.parse(localStorage.getItem('shellSessions') || '{"sessions":[]}');
          const persisted = stored.sessions.some((x) => x.sessionId === sid);
          closePane(id);
          const dropped = !sessionsSnapshot().sessions.some((x) => x.sessionId === sid);
          const loc = await window.glassShell.locateSessions(['../../../../etc/passwd', sid]);
          const traversalRefused = !Object.keys(loc).some((k) => k.includes('/') || k.includes('..'));
          const answered = !!loc[sid] && loc[sid].exists === false;
          await new Promise((r) => setTimeout(r, 300));
          if (keep === null) localStorage.removeItem('shellSessions'); else localStorage.setItem('shellSessions', keep);
          return { tabOk, idle, inSnap, persisted, dropped, traversalRefused, answered };
        })()`).catch((e) => ({ err: String(e) }));
        restoreOk = !!rs && !rs.err && rs.tabOk && rs.idle && rs.inSnap && rs.persisted && rs.dropped && rs.traversalRefused && rs.answered;
        if (!restoreOk) console.error(`shell-smoke: restore gate FAIL — ${JSON.stringify(rs)}`);
        console.log(`shell-smoke: restore — ${JSON.stringify(rs)}`);
      } catch (err) { console.error('shell-smoke: restore gate error', err); }

      /* GATE: THE PANEL HEADER NEVER DRAWS ITS TWO HALVES ON TOP OF EACH OTHER. The offline label
         overlapped the wordmark at a narrow panel (operator-reported 2026-09-22) — the same defect
         class as the clipped busy-row buttons, one row over, and nothing measured this row. So:
         force the panel narrow, put the LONGEST label any locale can produce into the status, and
         require the brand to end before the status begins and the status to stay inside the row. */
      let headOk = false;
      try {
        const head = await win.webContents.executeJavaScript(`(() => {
          const ph = document.getElementById('phead');
          const brand = ph && ph.querySelector('.pbrand');
          const st = document.getElementById('railUpdate');
          const txt = st && st.querySelector('.pupdtext');
          if (!ph || !brand || !st || !txt) return { err: 'header parts missing' };
          const keepW = ph.style.width, keepT = txt.textContent;
          ph.style.width = '200px';
          txt.textContent = 'não foi possível verificar · última sincronização 2026-09-15';
          const pb = ph.getBoundingClientRect(), bb = brand.getBoundingClientRect(), sb = st.getBoundingClientRect();
          const out = { rowW: Math.round(pb.width), overlapPx: Math.round(bb.right - sb.left),
                        spillPx: Math.round(sb.right - pb.right) };
          ph.style.width = keepW; txt.textContent = keepT;
          return out;
        })()`).catch(() => null);
        headOk = !!head && !head.err && head.overlapPx <= 1 && head.spillPx <= 1;
        if (!headOk) console.error(`shell-smoke: header gate FAIL — ${JSON.stringify(head)}`);
        console.log(`shell-smoke: header — row ${head?.rowW}px, overlap ${head?.overlapPx}px, spill ${head?.spillPx}px`);
      } catch (err) { console.error('shell-smoke: header gate error', err); }
      /* GATE: THE TWO NEW RE-CHECKS COST NOTHING WHEN NOTHING CHANGED (AI-153 + the retry label).
         0.9.8 adds two things that fire on a clock: the counter re-check (every 30s) and the
         "retrying…" status (every few seconds while a check fails). Either one repainting the panel
         on each tick would be AI-157's redraw class again, arriving by a new door. Unit tests prove
         the gates in main; only a live renderer can prove the DOM stays still, so this measures
         style recalcs + layouts through the DevTools protocol over three equal windows — plain
         idle, ten counter re-checks, ten identical retrying posts — and requires the triggered
         windows to cost no more than idle does (a small allowance for a clock tick landing inside). */
      let idleOk = false;
      try {
        const dbg = win.webContents.debugger;
        if (!dbg.isAttached()) dbg.attach('1.3');
        await dbg.sendCommand('Performance.enable');
        const metric = async (): Promise<number> => {
          const r = await dbg.sendCommand('Performance.getMetrics') as { metrics: { name: string; value: number }[] };
          const v = (n: string) => r.metrics.find((m) => m.name === n)?.value ?? 0;
          return v('RecalcStyleCount') + v('LayoutCount');
        };
        const WINDOW_MS = 1500;
        const measure = async (poke: () => void): Promise<number> => {
          const a = await metric();
          for (let i = 0; i < 10; i++) { poke(); await new Promise((r) => setTimeout(r, WINDOW_MS / 10)); }
          return (await metric()) - a;
        };
        host?.postState();                                  // settle: the panel holds current state
        await new Promise((r) => setTimeout(r, 800));
        const idle = await measure(() => { /* nothing */ });
        /* Count what main actually SENDS during the counter window, beside what the renderer paid:
           recalcs alone cannot say whether a post happened or the 2s running-sessions tick landed. */
        let statePosts = 0;
        const wcs = win.webContents as unknown as { send: (c: string, m: unknown) => void };
        const realSend = wcs.send.bind(wcs);
        wcs.send = (c: string, m: unknown) => { if ((m as { type?: string })?.type === 'state') statePosts++; realSend(c, m); };
        let counters: number;
        try { counters = await measure(() => host?.refreshStateIfChanged()); } finally { wcs.send = realSend; }
        const retryMsg = { type: 'updateStatus', state: 'unknown', retrying: true,
                           framework: { repo: 'https://github.com/The-AIOS/aios.git', hash: '585f3d3', synced: '2026-09-15' } };
        win.webContents.send('panel:post', retryMsg);       // the first one legitimately repaints
        await new Promise((r) => setTimeout(r, 300));
        const retrying = await measure(() => win.webContents.send('panel:post', retryMsg));
        await dbg.sendCommand('Performance.disable');
        dbg.detach();
        const ALLOW = 4;
        idleOk = statePosts === 0 && counters <= idle + ALLOW && retrying <= idle + ALLOW;
        console.log(`shell-smoke: idle — recalc+layout per ${WINDOW_MS}ms: idle ${idle}, counter re-checks ${counters} (${statePosts} state posts), retrying posts ${retrying}`);
        if (!idleOk) console.error(`shell-smoke: idle gate FAIL — a no-change re-check is repainting (idle ${idle}, counters ${counters}, retrying ${retrying})`);
        host?.refreshUpdateStatus(true);                    // put the real status back
      } catch (err) { console.error('shell-smoke: idle gate error', err); }

      /* GATE: THE ROW ACTIONS FIT INSIDE THE ROW. `.prow2` clips its overflow, so when the hover
         actions do not fit they are silently CUT rather than pushed anywhere visible — and the
         busy row is the one that overflows, because it carries a fourth button (interrupt) that
         no other row has. Operator-reported 2026-09-15, having shipped past every test.
         Nothing that reads CSS as text can catch this: every declaration was valid, and the
         clipping is a product of three widths meeting in a box. So this builds the worst case
         with the real class names, forces the hover layout (opacity + the memory readout
         yielding, which is all `:hover` changes here), and measures. */
      let rowOk = false;
      try {
        const fit = await win.webContents.executeJavaScript(`(() => {
          const host = document.getElementById('pRun');
          if (!host) return { err: 'no #pRun' };
          const css = document.createElement('style');
          css.textContent = '.smoke-hover .runacts{opacity:1!important} .smoke-hover .rmem{display:none!important}';
          document.head.appendChild(css);
          const row = document.createElement('div');
          row.className = 'prow2 smoke-hover';
          const add = (cls, text) => { const e = document.createElement('span'); e.className = cls; if (text) e.textContent = text; row.appendChild(e); return e; };
          add('pdot busy');
          add('rname', 'a-long-running-session-name');
          const pst = add('pst tight');
          pst.appendChild(Object.assign(document.createElement('span'), { className: 'shimverb', textContent: 'Working' }));
          pst.appendChild(document.createTextNode(' for 1h 23m'));
          const tick = add('ticker');
          tick.appendChild(Object.assign(document.createElement('span'), { className: 'tickline still', textContent: 'a fairly long recent output line from the session' }));
          add('rmem', '412 MB');
          const acts = add('runacts');
          for (const c of ['note', '', '', 'kill']) {
            const b = document.createElement('button'); b.className = 'runact' + (c ? ' ' + c : '');
            b.style.width = '18px'; b.style.height = '16px';
            acts.appendChild(b);
          }
          host.appendChild(row);
          const rb = row.getBoundingClientRect(), ab = acts.getBoundingClientRect();
          const out = { buttons: acts.children.length, rowW: Math.round(rb.width),
                        actsW: Math.round(ab.width), overflowPx: Math.round(ab.right - rb.right) };
          row.remove(); css.remove();
          return out;
        })()`).catch(() => null);
        /* One pixel of slack for sub-pixel rounding; anything more is a clipped control. */
        rowOk = !!fit && !fit.err && fit.buttons === 4 && fit.rowW > 0 && fit.overflowPx <= 1;
        if (!rowOk) console.error(`shell-smoke: row-actions gate FAIL — ${JSON.stringify(fit)}`);
        console.log(`shell-smoke: row actions — ${fit?.buttons} buttons, acts ${fit?.actsW}px in row ${fit?.rowW}px, overflow ${fit?.overflowPx}px`);
      } catch (err) { console.error('shell-smoke: row-actions gate error', err); }

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
      /* The probe file has to be one the app will actually OPEN. openViewer is confined to
         allowedRoots() — the framework root plus the operator's workspace folders — and this
         gate used to hand it the app's own package.json. That path is inside the repo in dev and
         inside app.asar once packaged, and NEITHER is an allowed root for anyone whose vault is
         not this checkout. So the gate reported "a file opened but rendered nothing" on every
         machine except one whose workspace happened to include the repo: the viewer was fine and
         the gate was pointing outside the fence. Pick a file from the framework root instead —
         reachable by construction — and if there is no framework root, say the gate did not run
         rather than let an unmeasured pass look like a measured one. */
      const probe = (() => {
        const root = aios.frameworkRoot();
        if (!root) return '';
        for (const c of ['README.md', 'CLAUDE.md', 'CHEATSHEET.md', 'SETUP.md']) {
          const p = path.join(root, c);
          try { if (fs.statSync(p).isFile()) return p; } catch { /* next */ }
        }
        return '';
      })();
      try {
        let viewerOk: number | null = null;   // null = the gate did not run, which is NOT a pass
        if (!probe) {
          if (SMOKE_STRICT) { setupOk = false; console.error('shell-smoke: VIEWER FAILED — strict mode, but no probe file was reachable; the fixture did not take effect (check GLASS_FRAMEWORK_PATH)'); }
          else console.log('shell-smoke: viewer — SKIPPED (no framework root on this machine; gate did not run)');
        } else {
          viewerOk = Number(await win.webContents.executeJavaScript(
            `(async () => { await openViewer('${probe.replace(/\\/g, '/')}');
               await new Promise(r => setTimeout(r, 800));
               return document.querySelectorAll('.pane .codeedit, .pane .mdview, .pane pre').length; })()`,
          ).catch(() => 0));
          console.log(`shell-smoke: viewer — panes rendered=${viewerOk} (${path.basename(probe)})`);
        }
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
        if (viewerOk !== null && viewerOk < 1) { setupOk = false; console.error(`shell-smoke: VIEWER FAILED — ${path.basename(probe)} opened but rendered nothing`); }
      } catch (e) { console.error('shell-smoke: viewer gate error', e); setupOk = false; }
        console.log(`shell-smoke: setup — steps=${steps}, clickable=${clickable}, repaintWired=${repaint}`);
      } catch (err) { console.error('shell-smoke: setup gate error', err); }
      /* gate 9: JS-MOUNTED CHROME IS ACTUALLY ON SCREEN. The explorer refresh button was built
         at boot and then silently deleted: `applyStaticI18n()` assigns `innerHTML` to every
         [data-i18n] element, #xhead WAS that element, and it runs after the mount. The unit test
         asserted the mounting function exists in source — true, and useless, because the button
         was created and destroyed in the same second. I told the operator to click a control
         that was not there.
         Source cannot see a wipe. Ask the DOM. Everything listed here is built by JS after load,
         which is exactly the class an innerHTML pass can silently erase. */
      let chromeOk = false;
      try {
        const missing = await win.webContents.executeJavaScript(
          `['xrefresh','railExplorer','railSettings','dragacts'].filter((id) => !document.getElementById(id)).join(',')`,
        ).catch(() => 'ERR');
        /* AND THE INVARIANT BEHIND IT, which is the part that can actually regress.
           `applyStaticI18n()` assigns innerHTML to every [data-i18n] node, so ANY such node with
           element children will have them destroyed on the next locale pass. That is the general
           rule — not "the refresh button exists". Checked because the presence check alone was
           proven blind: with the original defect restored it still passed, since a defensive
           re-mount rebuilt the button afterwards. A check a known bug walks past is not a check. */
        const clobber = await win.webContents.executeJavaScript(
          `[...document.querySelectorAll('[data-i18n]')].filter((n) => {` +
          `  if (!n.children.length) return false;` +
          /* Children are only AT RISK when the translation is plain text. Several hints legitimately
                carry their own markup (<kbd>⌘J</kbd>), and for those the innerHTML assignment puts the
                children straight back — flagging them would be a false positive, and a gate that cries
                wolf gets muted, which costs more than the bug it was guarding. */
          `  try { return !/</.test(String(t(n.getAttribute('data-i18n')) || '')); } catch (e) { return true; }` +
          `}).map((n) => n.id || n.tagName.toLowerCase() + '.' + n.className).join(',')`,
        ).catch(() => 'ERR');
        chromeOk = missing === '' && clobber === '';
        if (missing !== '') console.error(`shell-smoke: CHROME MISSING — built by JS then absent from the DOM: ${missing}`);
        if (clobber !== '') console.error(`shell-smoke: I18N WILL CLOBBER CHILDREN — these carry data-i18n AND element children, so the next locale pass deletes them: ${clobber}`);
        if (chromeOk) console.log('shell-smoke: chrome — every JS-mounted control present, no i18n node can clobber children');
      } catch (e) { console.error('shell-smoke: chrome gate error', e); }
      /* THE UPDATE PILL MUST RENDER AS A PILL (0.11.0 review blocker). A rule pasted into its CSS
         comment once ended the comment early and the browser dropped the pill rule: it fell back
         to the title bar's 26×26 button box. A user whose pill is broken can never receive the
         update that fixes it, so the packaged app proves it: shown, wider than the forced box,
         rounded, filled with the button coral, and the topmost element at its own centre. */
      let pillOk = false;
      try {
        const pill = await win.webContents.executeJavaScript(`(() => {
          showUpdatePill('0.0.0-smoke', 'ready');
          const p = document.getElementById('updPill'); const r = p.getBoundingClientRect(); const cs = getComputedStyle(p);
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === p;
          const res = { w: Math.round(r.width), h: Math.round(r.height), radius: cs.borderRadius, bg: cs.backgroundColor, hit };
          hideUpdatePill();
          return res;
        })()`).catch(() => null);
        pillOk = !!pill && pill.w > 40 && pill.h >= 20 && pill.radius === '999px' && pill.bg !== 'rgba(0, 0, 0, 0)' && pill.hit;
        console.log(`shell-smoke: update pill — ${JSON.stringify(pill)} ${pillOk ? 'renders as a clickable pill' : 'BROKEN'}`);
      } catch (e) { console.error('shell-smoke: pill gate error', e); }
      /* gate 10: THE SHORTCUT MAP MUST NOT LEAK RAW TOKENS. `CommandOrControlQ` reached the
         screen because the unit sweep read accelerator strings out of menu.ts SOURCE — and role
         items (Quit, the whole Edit section) have no accelerator in source. They only exist on the
         INSTALLED menu at runtime, which is precisely where the untranslated spelling came from.
         So the check has to run against the live menu and through the real formatter. A sweep that
         cannot see half its inputs is the kind of green that hides a bug. */
      /* The LEAK SET is platform-specific, and conflating the two is its own bug. On macOS a
         formatted accelerator is pure glyphs, so ANY surviving word — Shift, Alt, Control, Plus
         — is a leak. Off macOS `Ctrl+Shift+T` is the CORRECT rendering: Windows and Linux write
         modifiers as words. Running the mac set everywhere flags all 20 correct bindings and
         reports a passing formatter as broken — a gate that fails on the platform it does not
         model teaches you to ignore it. What IS still a leak off macOS: Electron's internal
         spellings (`CmdOrCtrl`, `CommandOrControl`) and key NAMES that should have become
         symbols (`Plus`, `Minus`) — "Ctrl+Plus" names a key no keyboard has. */
      let mapOk = false;
      const leakRe = process.platform === 'darwin'
        ? String.raw`/CmdOrCtrl|CommandOrControl|Command|\bPlus\b|\bShift\b|\bAlt\b|\bControl\b/`
        : String.raw`/CmdOrCtrl|CommandOrControl|\bCommand\b|\bPlus\b|\bMinus\b|\bReturn\b|\bEscape\b/`;
      try {
        const leaks = await win.webContents.executeJavaScript(
          `window.glassShell.menuShortcuts().then((ks) => ks.map((k) => prettyAccel(k.accel))` +
          `.filter((v) => ${leakRe}.test(v)).join(','))`,
        ).catch(() => 'ERR');
        mapOk = leaks === '';
        if (!mapOk) console.error(`shell-smoke: SHORTCUT MAP LEAKED RAW TOKENS — ${leaks}`);
        else console.log('shell-smoke: shortcuts — every accelerator on the live menu formats cleanly');
      } catch (e) { console.error('shell-smoke: shortcut gate error', e); }
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
      const ok = loaded && ptyOk && stateOk && !!rendererOk && panelOk && themeOk && setupOk && chromeOk && pillOk && mapOk && animOk && rowOk && rebuildOk && headOk && restoreOk && idleOk && clean;
      console.log(ok
        ? 'shell-smoke: window + pty + state + workbench + panel + theme + setup + chrome + update-pill + shortcuts + animations + row-actions + settings-rebuild + header + restore + idle + no-renderer-errors OK ✓'
        : `shell-smoke: FAIL (loaded=${loaded}, pty=${ptyOk}, state=${stateOk}, workbench=${rendererOk}, panel=${panelOk}, theme=${themeOk}, setup=${setupOk}, chrome=${chromeOk}, pill=${pillOk}, shortcutMap=${mapOk}, animations=${animOk}, rowActions=${rowOk}, settingsRebuild=${rebuildOk}, header=${headOk}, restore=${restoreOk}, idle=${idleOk}, rendererClean=${clean})`);
      return ok;
    };
    void Promise.race([
      gates(),
      // the setup gate opens a real tab and waits for its async paint, so the old 15s
      // ceiling would have failed the run on time rather than on truth
      new Promise<boolean>((r) => setTimeout(() => r(false), 25000)),
    ]).then(async (ok) => {
      /* The real-session gate runs AFTER the fast ones and outside their 25 s ceiling: it waits on a
         model, so it has deadlines of its own (and always cleans up). Skipped when something
         already failed, so a broken build does not also spend a model call. */
      let assets: SmokeAssetsVerdict = { ok: false, detail: 'an earlier gate failed' };
      if (ok) {
        assets = await chatAssetsSmoke(win);
        if (assets.ok) console.log('shell-smoke: chat assets OK ✓ — marked, highlight.js, stylesheet, preload bridge and sanitizer all work from where this build was loaded');
        else console.error(`shell-smoke: chat assets FAILED — ${assets.detail}`);
      }
      let chat: SmokeChatVerdict = { status: 'skipped', detail: 'an earlier gate failed' };
      if (ok && assets.ok) chat = await chatViewSmoke(win).catch((e): SmokeChatVerdict => ({ status: 'failed', detail: String(e?.message ?? e) }));
      if (chat.status === 'ok') console.log('shell-smoke: chat view OK ✓ — a real claude session, the chat mode, the composer and the bubbles agree');
      else if (chat.status === 'skipped') console.log(`shell-smoke: chat view SKIPPED — ${chat.detail}`);
      else console.error(`shell-smoke: chat view FAILED — ${chat.detail}`);
      dropSmokeUserData();
      app.exit(ok && assets.ok && chat.status !== 'failed' ? 0 : 1);
    });
  }
});
/* Every real quit passes through here first, so the close handler above lets the windows go. */
app.on('before-quit', markQuitting);
/* The chat sessions are child processes of this app; closing them here keeps a quit from orphaning them. */
app.on('before-quit', () => { tail.unwatchAll(); for (const id of [...skins.keys()]) void endSkin(id, false); });
/* The Dock icon brings the hidden window back. */
app.on('activate', () => {
  if (!(SMOKE || CHAT_SHOT) && mainWin && !mainWin.isDestroyed()) { mainWin.show(); mainWin.focus(); }   // a QA run has no Dock icon to click, but never relies on that
});
/* Kept on every platform: on macOS a window only really closes while quitting (or if it died),
   and an App left in the Dock with no window and no way to rebuild one would be worse. */
app.on('window-all-closed', () => app.quit());
