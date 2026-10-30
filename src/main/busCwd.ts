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

/** Validate a raw `cwd` field. `home` is injectable for tests. */
export function resolveBusCwd(raw: unknown, home: string = os.homedir()): BusCwd {
  const r = resolveBusDir(raw, 'cwd', home);
  return 'error' in r ? r : { cwd: r.dir };
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

/** Validate a raw `addDirs` field. `home` is injectable for tests. */
export function resolveBusAddDirs(raw: unknown, home: string = os.homedir()): BusAddDirs {
  if (!Array.isArray(raw)) {
    return { error: `addDirs '${String(JSON.stringify(raw)).slice(0, 200)}' is not valid — it must be a list of directories, e.g. ["/Users/<you>/dev/repo"]` };
  }
  if (raw.length > MAX_ADD_DIRS) return { error: `addDirs is not valid — at most ${MAX_ADD_DIRS} directories, got ${raw.length}` };
  const dirs: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const r = resolveBusDir(raw[i], `addDirs[${i}]`, home);
    if ('error' in r) return r;
    if (!dirs.includes(r.dir)) dirs.push(r.dir);
  }
  return { dirs };
}

/* One directory written by an agent: absolute, existing, a directory, inside home once symlinks are
   resolved. `field` names it in the refusal. Returns the resolved path. */
function resolveBusDir(raw: unknown, field: string, home: string): { dir: string } | { error: string } {
  const shown = String(raw).slice(0, 200);
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
