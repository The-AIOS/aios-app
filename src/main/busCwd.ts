import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * The optional `cwd` of a bus `spawn` / `resume` — the directory the session's terminal opens in.
 *
 * WHY: the App opens every bus session in the framework root. A worker whose rules live in its own
 * directory (a `CLAUDE.md` that scopes it, a repo it owns) then starts with the framework's
 * `CLAUDE.md` and the whole vault instead — the opposite of the scoping its author built. The
 * shell wrapper can be told where to start; the bus could not.
 *
 * WHY THESE RULES: the path is written by an agent, so it is validated like any other field that
 * reaches a launch, and a value we cannot honour is dead-lettered NAMING it, never silently
 * dropped (a worker started in the wrong directory looks exactly like one started in the right
 * one). Absolute, existing, a directory, and under the operator's home once symlinks are
 * resolved — so `~/../other-user` or a link out of home cannot widen where a session may start.
 */
export type BusCwd = { cwd: string } | { error: string };

const MAX_LEN = 4096;

/**
 * WHERE A BUS SESSION MAY START (#87). 0.13.0 accepted any directory under home, home itself and `~/.claude` included,
 * so anything that could write the inbox (a sandboxed agent, or one prompt-injected by what it read) could choose a folder
 * whose `.claude/settings.json` (hooks, allow rules), `CLAUDE.md` and `.mcp.json` it had planted, and open an
 * unsandboxed worker there; or `$HOME`, to widen the worker's project scope to the whole home folder. Now:
 *   · the framework root ITSELF (the default, as before 0.13.0), never a folder inside it: a sandboxed agent can write
 *     under the vault, so "inside the framework" is exactly where a planted config would sit;
 *   · or inside a folder the OPERATOR allowed (Settings → Bus folders). That list is kept in the App's own data folder,
 *     outside the framework, where an agent sandboxed to the vault cannot add to it;
 *   · never home itself, never through a hidden folder (`.claude`, `.ssh`, `.aios`, …), whatever the list says.
 * `addDirs` follow the SAME rules (security review: Claude Code can load skills and CLAUDE.md from an added folder, so a
 * planted vault subfolder is the same channel). Nothing strictly inside the framework is ever accepted, even under an
 * allowed folder that contains the framework: an allow entry is a folder the operator trusts, not a key to the vault.
 * A refusal names the folder and the fix.
 */
export interface BusRoots { framework?: string; allowed: string[] }
let rootsOf: () => BusRoots = () => ({ allowed: [] });
/** Main wires where the framework is and what the operator allowed; tests pass their own. */
export function setBusRoots(fn: () => BusRoots): void { rootsOf = fn; }

/** Validate a raw `cwd` field. `home` and `roots` are injectable for tests. */
export function resolveBusCwd(raw: unknown, home: string = os.homedir(), roots: BusRoots = rootsOf()): BusCwd {
  const r = resolveBusDir(raw, 'cwd', home);
  if ('error' in r) return r;
  /* The operator's rule (0.14.0 round): a bus session ALWAYS starts in the AIOS folder, or it skips the framework's own
     CLAUDE.md and everything the AIOS is. So cwd is the AIOS folder itself or nothing; the allow list is for addDirs. */
  const why = placeProblem(r.dir, home, { framework: roots.framework, allowed: [] });
  return why ? { error: `cwd '${shownOf(raw)}' is not allowed — a bus session always starts in the AIOS folder (it would skip the AIOS's own CLAUDE.md otherwise). To let it work in another folder, send that folder in "addDirs" and allow it in AIOS Settings → Bus folders` } : { cwd: r.dir };
}

/* Why a resolved directory may not be used, or '' when it may. */
function placeProblem(dir: string, home: string, roots: BusRoots): string {
  /* Compared on the ON-DISK spelling (security review): macOS and Windows volumes ignore case, so `/Users/x/AIOS/vault`
     is the framework's vault even though it does not start with `/Users/x/aios`. realpathSync.native returns the
     disk's own case; lower-casing on top covers a volume that does not report it. */
  const fold = process.platform === 'darwin' || process.platform === 'win32';
  const norm = (p: string): string => { const q = (process.platform === 'win32' ? p.replace(/\\/g, '/') : p).replace(/\/+$/, ''); return fold ? q.toLowerCase() : q; };
  const real = (p: string): string | null => { try { return norm(fs.realpathSync.native(p)); } catch { return null; } };
  const d = real(dir) ?? norm(dir);
  const h = real(home);
  if (!h) return 'the home directory could not be resolved';
  if (d === h) return 'a session may not start in the home folder itself';
  if (d.slice(h.length + 1).split('/').some((c) => c.startsWith('.'))) return 'it is inside a hidden folder (a name starting with a dot), where settings and keys live';
  const fw = roots.framework ? real(roots.framework) : null;
  if (fw && d === fw) return '';
  if (fw && d.startsWith(fw + '/')) return 'it is inside the AIOS folder, where an agent can write; only the AIOS folder itself may be used';
  for (const a of roots.allowed) {
    const ar = real(a);
    if (!ar || ar === h || (fw && (ar === fw || ar.startsWith(fw + '/') || fw.startsWith(ar + '/')))) continue;   // never an entry around the AIOS folder, however it was saved
    if (d === ar || d.startsWith(ar + '/')) return '';
  }
  return `it is not the framework folder or inside a folder allowed for the bus. If you trust it, add '${dir}' in AIOS Settings → Bus folders`;
}

/**
 * The optional `addDirs` of a bus `spawn` / `resume` — directories the session may work in besides
 * the one it opens in, each passed as its own `--add-dir`.
 *
 * WHY: a session can start in the framework root and still own a repo elsewhere, but under
 * `blockReadsOutsideWorkingDirectories` (or any read outside the folder) it stalls asking for a
 * permission nobody is there to grant. The shell wrapper takes `--add-dir`; the bus could not.
 *
 * Same rules as `cwd`, per entry, and the same refusal: one directory we cannot honour dead-letters
 * the request naming it (`addDirs[1] '…'`), never a launch with the rest — a session missing a
 * directory it was promised looks exactly like one that has it until it stalls. An empty list is
 * no directories. Duplicates (after resolving symlinks) collapse to one.
 */
export type BusAddDirs = { dirs: string[] } | { error: string };

const MAX_ADD_DIRS = 16;

/** Validate a raw `addDirs` field. `home` and `platform` are injectable for tests. */
export function resolveBusAddDirs(raw: unknown, home: string = os.homedir(), platform: string = process.platform, roots: BusRoots = rootsOf()): BusAddDirs {
  if (!Array.isArray(raw)) {
    return { error: `addDirs '${shownOf(raw)}' is not valid — it must be a list of directories, e.g. ["/Users/<you>/dev/repo"]` };
  }
  if (raw.length > MAX_ADD_DIRS) return { error: `addDirs is not valid — at most ${MAX_ADD_DIRS} directories, got ${raw.length}` };
  const dirs: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const field = `addDirs[${i}]`;
    /* Unlike `cwd` (handed to the pty as an option), these are TYPED into the pane's shell as part
       of the command line. POSIX quoting (shq) holds any character there, but a control character
       (a newline is an Enter) is refused everywhere, and on Windows — where the shell is
       PowerShell, which reads a POSIX-escaped apostrophe differently, and also treats the curly
       quotes as quotes — so is the single-quote family. Refused by name, like everything else. */
    if (typeof raw[i] === 'string') {
      const bad = typedProblem(raw[i] as string, platform);
      if (bad) return { error: `${field} '${shownOf(raw[i])}' is not valid — ${bad}` };
    }
    const r = resolveBusDir(raw[i], field, home);
    if ('error' in r) return r;
    const why = placeProblem(r.dir, home, roots);
    if (why) return { error: `${field} '${shownOf(raw[i])}' is not allowed — ${why}` };
    /* What is typed is the RESOLVED path, so check it too: a clean name can be a symlink to one
       that is not. */
    const badReal = typedProblem(r.dir, platform);
    if (badReal) return { error: `${field} '${shownOf(raw[i])}' is not valid — it resolves to '${shownOf(r.dir)}', and ${badReal}` };
    if (!dirs.includes(r.dir)) dirs.push(r.dir);
  }
  return { dirs };
}

/* Why a path cannot be typed into the pane's shell, or '' when it can. */
function typedProblem(p: string, platform: string): string {
  if (/[\u0000-\u001f\u007f]/.test(p)) return 'it contains a control character';
  if (platform === 'win32' && /['\u2018\u2019\u201a\u201b]/.test(p)) return 'it contains a quote, which cannot be passed safely to PowerShell';
  return '';
}

/* A value as written, for a dead letter — never throws. `String()` does on a parsed `{"toString":0}`,
   which would skip the dead letter entirely; JSON.stringify cannot on anything JSON.parse returned. */
function shownOf(raw: unknown): string {
  return (typeof raw === 'string' ? raw : String(JSON.stringify(raw))).slice(0, 200);
}

/* One directory written by an agent: absolute, existing, a directory, inside home once symlinks are
   resolved. `field` names it in the refusal. Returns the resolved path. */
function resolveBusDir(raw: unknown, field: string, home: string): { dir: string } | { error: string } {
  const shown = shownOf(raw);
  const bad = (why: string) => ({ error: `${field} '${shown}' is not valid — ${why}` });
  if (typeof raw !== 'string' || !raw.trim()) return bad('it must be a non-empty string');
  if (raw.length > MAX_LEN || raw.includes('\0')) return bad('it is too long or contains a NUL byte');
  if (!path.isAbsolute(raw)) return bad('it must be an absolute path (no ~, no relative paths)');
  let real: string;
  let realHome: string;
  try { real = fs.realpathSync(raw); } catch { return bad('it does not exist'); }
  try { realHome = fs.realpathSync(home); } catch { return bad('the home directory could not be resolved'); }
  try { if (!fs.statSync(real).isDirectory()) return bad('it is not a directory'); } catch { return bad('it does not exist'); }
  const norm = (p: string): string => (process.platform === 'win32' ? p.replace(/\\/g, '/').toLowerCase() : p);
  const r = norm(real);
  const h = norm(realHome).replace(/\/+$/, '');
  if (r !== h && !r.startsWith(h + '/')) return bad('it must be inside the home directory');
  return { dir: real };
}

/* Directories the bus has validated, so `pty:spawn` may open a terminal there even though they are
   outside the explorer's allowed roots. Only resolveBusCwd's output is ever added, and the check
   re-resolves the path, so a renderer cannot widen this set by asking. Bounded. */
const granted = new Set<string>();

export function grantBusCwd(real: string): void {
  if (granted.size > 200) granted.clear();
  granted.add(real);
}

export function isBusCwdGranted(p: string): boolean {
  if (!granted.size) return false;
  try { return granted.has(fs.realpathSync(p)); } catch { return false; }
}
