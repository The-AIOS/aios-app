/**
 * The `open` verb of the spawn inbox (contract 5): may this file be shown, and how.
 *
 * A session asks a surface to show a file in the surface's own viewer, with
 * `{"action":"open","name":"<who asks>","path":"/abs","line":12}`. Any session can write that
 * request, and a session may have read someone else's text (an email, a page) that tries to get a
 * file opened. Opening only SHOWS the file to the operator; nothing goes back to the session. What
 * is at stake is putting something on the screen that should not be there, putting something
 * runnable one click away, and taking the operator's attention.
 *
 * The rule is the framework's: skills/aios/orchestration-ladder/inbox-contract-5.md, thirteen checks
 * in order, the first that fails refuses. Its fixture, cases/inbox-contract-5.conformance.json, runs
 * against `decideOpen` in this package's tests, so the App and Glass make the same decision from the
 * same bytes. Each surface supplies only what is its own: its roots, the requests it has already
 * decided, when it first saw this one, and the file system.
 *
 * Checks 1 to 7 make no file system call. Secrets are decided by NAME, of the path as written and of
 * the resolved path; nothing here reads a file's content to decide whether it is a secret.
 * `classify` reads at most the first 8 KB of a file that has already passed every name and root
 * check, to tell text from binary.
 *
 * SHOWING IT. The decision hands back the file's identity (device and inode). `readChecked` reads the
 * content again only if the same path still resolves, inside the roots, to that same regular file
 * with one link and a name that is not a secret, so a surface can read once, or re-read on every
 * change, and in both cases show only what was checked.
 */
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import { sanitizeName } from './nameResolve';
import { classifyForRead } from './readClass';

export const OPEN_MAX_AGE_MS = 60_000;
export const OPEN_RATE_MAX = 5;
export const OPEN_FLOOD_MAX = 20;
export const OPEN_RATE_WINDOW_MS = 60_000;
export const OPEN_MAX_LINE = 10_000_000;
export const OPEN_MAX_NAME = 64;

export type OpenWhy =
  | 'bad-name' | 'flood' | 'rate-limited' | 'bad-path' | 'not-absolute' | 'too-old' | 'bad-line' | 'secret'
  | 'unavailable' | 'not-a-file' | 'hard-link' | 'unreadable' | 'executable';

export type OpenClass = 'text' | 'asset' | 'binary' | 'large';

/** What a resolved path is, from metadata only (lstat: a link is not followed). */
export interface OpenStat { kind: 'file' | 'dir' | 'other'; links: number; dev: number; ino: number; executable: boolean }

/** The file system as the decision sees it. `nodeOpenFs` is the real one. */
export interface OpenFs {
  /** The path with every link resolved, in every segment, to the stored name; null when it does
   *  not exist or loops. */
  realpath(p: string): string | null;
  stat(real: string): OpenStat | null;
  /** For a regular file: what the viewer can do with it. */
  classify(real: string): OpenClass;
}

/** An `open` request this surface already decided, refused or not. */
export interface DecidedOpen { name: string; at: number }

export interface OpenInput {
  body: Record<string, unknown>;
  /** How long ago THIS SURFACE first saw the request file (its own clock, never the file's). */
  seenAgoMs: number;
  /** The request was already in the inbox when the surface started. */
  presentAtStart?: boolean;
  nowMs: number;
  /** The surface's roots: the framework root and the operator's workspace folders. */
  roots: readonly string[];
  home: string;
  /** Requests decided in the last minute, by this surface. */
  decided: readonly DecidedOpen[];
  fs?: OpenFs;
  platform?: NodeJS.Platform;
}

export interface OpenIdentity { dev: number; ino: number }

export type OpenDecision =
  | { do: 'open'; name: string; path: string; mode: 'source' | 'auto'; line?: number; identity: OpenIdentity }
  | { do: 'refuse'; why: OpenWhy; reason: string; name?: string };

const SECRET_SEGMENTS = new Set(['.ssh', '.gnupg', '.aws', '.docker', '.kube', '.git', '.obsidian', 'agent-secrets']);
const SECRET_NAMES = new Set(['.envrc', '.netrc', '.pgpass', '.npmrc', '.pypirc', '.git-credentials', '.dockercfg', '.mcp.json', 'storage_state.json']);
const SECRET_EXT = /\.(pem|key|p12|pfx|kdbx|ovpn|ppk|jks|keystore)$/;
const DATA_SECRET = /\.(json|ya?ml|toml)$/;
const DATA_WORD = /token|credential|oauth|secret|cookie/;
const SECRET_KEY = /^id_(rsa|dsa|ecdsa|ed25519)(_sk)?$/;
const EXEC_EXT = /\.(exe|com|bat|cmd|ps1|msi|scr|app|command|lnk|url|webloc|desktop|terminal|jar|vbs|hta|reg|scpt|workflow|pkg|dmg|appimage)$/i;
const SOURCE_EXT = /\.(html?|xhtml?|xht|shtml|mht|mhtml)$/i;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** A secret by NAME (inbox-contract-5.md § Secrets). Both separators are read. */
export function isSecretPath(p: string): boolean {
  const segs = p.split(/[\\/]+/).filter(Boolean).map((s) => s.toLowerCase());
  if (!segs.length) return false;
  if (segs.some((s) => SECRET_SEGMENTS.has(s))) return true;
  const b = segs[segs.length - 1];
  if (b === '.env' || b.startsWith('.env.') || b.endsWith('.env') || SECRET_NAMES.has(b)) return true;
  if (SECRET_EXT.test(b)) return true;
  if (b.startsWith('service-account') && b.endsWith('.json')) return true;
  if (DATA_SECRET.test(b) && DATA_WORD.test(b)) return true;
  return SECRET_KEY.test(b);
}

/** The Windows path-shape checks of check 3; null when they pass. */
export function windowsShape(p: string): 'bad-path' | 'not-absolute' | null {
  if (/^[\\/]{2}/.test(p)) return 'bad-path';
  if (!/^[A-Za-z]:[\\/]/.test(p)) return 'not-absolute';
  const rest = p.slice(2);
  if (rest.includes(':')) return 'bad-path';
  for (const seg of rest.split(/[\\/]+/).filter(Boolean)) {
    if (/[. ]$/.test(seg) || RESERVED.test(seg.split('.')[0])) return 'bad-path';
  }
  return null;
}

/* A path in one comparable form: forward slashes; on Windows, without case. */
function cmp(p: string, platform: NodeJS.Platform): string {
  const s = platform === 'win32' ? p.replace(/\\/g, '/').toLowerCase() : p;
  return s.length > 1 ? s.replace(/\/+$/, '') : s;
}
function under(p: string, root: string): boolean {
  return p === root || p.startsWith(root === '/' ? '/' : root + '/');
}
/** `.` and `..` applied as text, separators collapsed. */
function lexical(p: string, platform: NodeJS.Platform): string {
  const s = cmp(p, platform);
  const drive = platform === 'win32' ? (s.match(/^[a-z]:/) ?? [''])[0] : '';
  const out: string[] = [];
  for (const c of s.slice(drive.length).split('/')) {
    if (!c || c === '.') continue;
    if (c === '..') { out.pop(); continue; }
    out.push(c);
  }
  return drive + '/' + out.join('/');
}

/** The roots that may be used, both forms of each, compared form. A root that is the file-system
 *  root, the home folder or one of its ancestors is never used, whatever a configuration says. */
export function usableRoots(roots: readonly string[], home: string, fs: OpenFs, platform: NodeJS.Platform): { written: string; real: string }[] {
  const h = cmp(fs.realpath(home) ?? home, platform);
  const out: { written: string; real: string }[] = [];
  for (const r of roots) {
    const rr = fs.realpath(r);
    if (!rr) continue;
    const real = cmp(rr, platform);
    if (real === '/' || /^[a-z]:$/.test(real) || under(h, real)) continue;
    out.push({ written: lexical(r, platform), real });
  }
  return out;
}

const no = (why: OpenWhy, reason: string, name?: string): OpenDecision => ({ do: 'refuse', why, reason, name });

/** The thirteen checks of inbox-contract-5.md, in order. */
export function decideOpen(i: OpenInput): OpenDecision {
  const fs = i.fs ?? nodeOpenFs;
  const platform = i.platform ?? process.platform;
  const b = i.body ?? {};

  // 1. name
  const name = typeof b.name === 'string' ? sanitizeName(b.name) : '';
  if (!name || name.length > OPEN_MAX_NAME) return no('bad-name', `an open request needs a 'name' (the session asking), at most ${OPEN_MAX_NAME} characters`);

  // 2. rate: every decided request counts
  const recent = i.decided.filter((d) => d.at >= i.nowMs - OPEN_RATE_WINDOW_MS);
  if (recent.length >= OPEN_FLOOD_MAX) return no('flood', `${OPEN_FLOOD_MAX} open requests in the last minute; this one is dropped`, name);
  if (recent.filter((d) => sanitizeName(d.name) === name).length >= OPEN_RATE_MAX) {
    return no('rate-limited', `'${name}' already asked to open ${OPEN_RATE_MAX} files in the last minute`, name);
  }

  // 3. path shape
  const raw = b.path;
  if (typeof raw !== 'string' || /[\0\r\n]/.test(raw) || !raw.trim()) return no('bad-path', "'path' must be one absolute path", name);
  const p = raw.trim();
  if (platform === 'win32') {
    const w = windowsShape(p);
    if (w) return no(w, w === 'bad-path' ? `that path form is never opened: ${p}` : `'path' must be absolute: ${p}`, name);
  } else if (p.startsWith('~') || !p.startsWith('/')) {
    return no('not-absolute', `'path' must be absolute: ${p}`, name);
  }

  // 4. age, by this surface's own clock
  if (i.presentAtStart || i.seenAgoMs > OPEN_MAX_AGE_MS) {
    return no('too-old', i.presentAtStart ? 'the request was already waiting when this surface started; an open is never shown late' : `this surface saw the request ${Math.round(i.seenAgoMs / 1000)} s ago; an open is shown within ${OPEN_MAX_AGE_MS / 1000} s or not at all`, name);
  }

  // 5. line
  const hasLine = Object.prototype.hasOwnProperty.call(b, 'line');
  const line = b.line;
  if (hasLine && !(typeof line === 'number' && Number.isFinite(line) && Number.isInteger(line) && line >= 1 && line <= OPEN_MAX_LINE)) {
    return no('bad-line', `'line' must be a whole number from 1 to ${OPEN_MAX_LINE}`, name);
  }

  // 6. secret, as written
  const SECRET = 'that file is a secret by its name, and is never shown on request';
  if (isSecretPath(p)) return no('secret', SECRET, name);

  // 7. roots, as text: no file system call for a path outside them
  const UNAVAILABLE = `not available to open: ${p}`;
  const roots = usableRoots(i.roots, i.home, fs, platform);
  const lp = lexical(p, platform);
  if (!roots.some((r) => under(lp, r.written) || under(lp, r.real))) return no('unavailable', UNAVAILABLE, name);

  // 8. resolve
  const real = fs.realpath(p);
  if (!real) return no('unavailable', UNAVAILABLE, name);

  // 9. roots, resolved
  const rc = cmp(real, platform);
  if (!roots.some((r) => under(rc, r.real))) return no('unavailable', UNAVAILABLE, name);

  // 10. a regular file, with one link
  const st = fs.stat(real);
  if (!st || st.kind !== 'file') return no('not-a-file', 'that is not a regular file', name);
  if (st.links > 1) return no('hard-link', 'that file has another hard link elsewhere on the disk, so its name does not say what it is; a session cannot ask for it. You can still open it yourself', name);

  // 11. secret, resolved
  if (isSecretPath(real)) return no('secret', SECRET, name);

  // 12. kind
  const cls = fs.classify(real);
  if (cls === 'binary' || cls === 'large') return no('unreadable', `the viewer cannot show it (${cls})`, name);

  // 13. executable
  if (EXEC_EXT.test(real) || st.executable) return no('executable', 'that file is executable, and is never opened on request', name);

  const out: OpenDecision = { do: 'open', name, path: real, mode: SOURCE_EXT.test(real) ? 'source' : 'auto', identity: { dev: st.dev, ino: st.ino } };
  if (hasLine) out.line = line as number;
  return out;
}

/**
 * Read a file the decision let through, again, showing it only if it is still what was checked:
 * the same path still resolves, inside the roots, to the SAME regular file (device and inode) with
 * one link, whose resolved name is not a secret and which the viewer can show. The content comes
 * from a descriptor opened on that resolved path without following a final link, and checked with
 * fstat, so a swap between the check and the read is caught.
 */
export function readChecked(
  path: string,
  identity: OpenIdentity,
  o: { roots: readonly string[]; home: string; platform?: NodeJS.Platform; fs?: OpenFs },
): { ok: true; path: string; content: string } | { ok: false; reason: string } {
  const fs = o.fs ?? nodeOpenFs;
  const platform = o.platform ?? process.platform;
  const real = fs.realpath(path);
  if (!real) return { ok: false, reason: 'the file is gone' };
  if (!usableRoots(o.roots, o.home, fs, platform).some((r) => under(cmp(real, platform), r.real))) return { ok: false, reason: 'the file now resolves outside the roots' };
  if (isSecretPath(real)) return { ok: false, reason: 'the file now resolves to a secret' };
  const st = fs.stat(real);
  if (!st || st.kind !== 'file' || st.links > 1 || st.dev !== identity.dev || st.ino !== identity.ino) return { ok: false, reason: 'the file was replaced since it was opened' };
  const cls = fs.classify(real);
  if (cls !== 'text') return { ok: false, reason: `the viewer cannot show it now (${cls})` };
  let fd: number | undefined;
  try {
    const flags = nodeFs.constants.O_RDONLY | (nodeFs.constants.O_NOFOLLOW ?? 0) | (nodeFs.constants.O_NONBLOCK ?? 0);
    fd = nodeFs.openSync(real, flags);
    const f = nodeFs.fstatSync(fd);
    if (!f.isFile() || f.nlink > 1 || f.dev !== identity.dev || f.ino !== identity.ino) return { ok: false, reason: 'the file was replaced since it was opened' };
    return { ok: true, path: real, content: nodeFs.readFileSync(fd, 'utf8') };
  } catch {
    return { ok: false, reason: 'the file could not be read' };
  } finally {
    if (fd !== undefined) { try { nodeFs.closeSync(fd); } catch { /* closed */ } }
  }
}

/** The real file system. */
export const nodeOpenFs: OpenFs = {
  realpath(p) {
    try { return nodeFs.realpathSync.native(p); } catch { return null; }
  },
  stat(real) {
    try {
      const st = nodeFs.lstatSync(real);
      return {
        kind: st.isFile() ? 'file' : st.isDirectory() ? 'dir' : 'other',
        links: st.nlink,
        dev: st.dev,
        ino: st.ino,
        executable: process.platform !== 'win32' && (st.mode & 0o111) !== 0,   // the extension rule covers Windows
      };
    } catch { return null; }
  },
  classify(real) {
    try { return classifyForRead(real).kind; } catch { return 'binary'; }
  },
};

/** The requests a surface remembers: one minute of them, at most 200. */
export function rememberDecided(decided: DecidedOpen[], d: DecidedOpen, nowMs: number): DecidedOpen[] {
  const keep = decided.filter((x) => x.at >= nowMs - OPEN_RATE_WINDOW_MS);
  keep.push(d);
  return keep.slice(-200);
}

export const isAbsoluteForOpen = (p: string, platform: NodeJS.Platform): boolean =>
  platform === 'win32' ? windowsShape(p) === null : nodePath.posix.isAbsolute(p);
