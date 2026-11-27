/**
 * The `open` verb of the spawn inbox (contract 5): may this file be shown, and how.
 *
 * A session asks a surface to show a file in the surface's own viewer, with
 * `{"action":"open","name":"<who asks>","path":"/abs","line":12}`. Any session can write that
 * request, and a session may have read someone else's text (an email, a page) that tries to get a
 * file opened. Opening only SHOWS the file to the operator; nothing goes back to the session.
 *
 * The rule is the framework's: skills/aios/orchestration-ladder/inbox-contract-5.md, thirteen checks
 * in order, the first that fails refuses. Its fixture, cases/inbox-contract-5.conformance.json, runs
 * against `decideOpen` in this package's tests, so the App and Glass make the same decision from the
 * same bytes. In proportion: this is not a boundary against a session determined to rewrite a
 * surface's configuration or a link in the home folder (it could read those files itself); it keeps
 * `open` from becoming a comfortable way to put them on screen, or something a confused session
 * triggers with one JSON file.
 *
 * THE ROOT is the framework root only (the vault included): the workspace-folder list lives in files
 * any session can write. A surface prepares it ONCE, at start (`prepareRoots`), and passes the result
 * to every decision. Checks 1 to 8 make no file system call. Links are followed one segment at a time
 * from the root (`resolveWithin`), and a link whose target is outside the root stops the walk without
 * the target being touched. Secrets are decided by NAME; nothing here reads a file's content to decide
 * one. `classify` reads at most the first 8 KB of a file that has passed every name and root check.
 *
 * SHOWING IT. The decision hands back the file's identity (device and inode). `readChecked` reads the
 * content only if the path still walks, inside the root, to that same regular file with one link and a
 * name that is not a secret.
 */
import * as nodeFs from 'node:fs';
import { sanitizeName } from './nameResolve';
import { classifyForRead } from './readClass';

export const OPEN_MAX_AGE_MS = 60_000;
export const OPEN_RATE_MAX = 5;
export const OPEN_FLOOD_MAX = 20;
export const OPEN_RATE_WINDOW_MS = 60_000;
export const OPEN_MAX_LINE = 10_000_000;
export const OPEN_MAX_NAME = 64;
const MAX_HOPS = 40;

export type OpenWhy =
  | 'too-old' | 'flood' | 'bad-name' | 'rate-limited' | 'bad-path' | 'not-absolute' | 'bad-line' | 'secret'
  | 'unavailable' | 'not-a-file' | 'hard-link' | 'unreadable' | 'executable';

export type OpenClass = 'text' | 'asset' | 'binary' | 'large';

/** What a path is, from metadata only: a link is reported as a link, never followed. */
export interface OpenStat { kind: 'file' | 'dir' | 'symlink' | 'other'; links: number; dev: number; ino: number; executable: boolean }

/** The file system as the decision sees it. `nodeOpenFs` is the real one. */
export interface OpenFs {
  lstat(p: string): OpenStat | null;
  /** A link's target as written in the link (not followed). */
  readlink(p: string): string | null;
  /** Full resolution, used ONLY by `prepareRoots` for the operator's own configured root. */
  realpath(p: string): string | null;
  /** For a regular file: what the viewer can do with it. */
  classify(p: string): OpenClass;
}

/** A root as configured and as it resolved when the surface started, in comparable form. */
export interface PreparedRoot { written: string; real: string }

/** An `open` request this surface counted. */
export interface DecidedOpen { name: string; at: number }

export interface OpenInput {
  body: Record<string, unknown>;
  /** How long ago THIS SURFACE first saw the request file (its own clock, never the file's). */
  seenAgoMs: number;
  /** The request was already in the inbox when the surface started. */
  presentAtStart?: boolean;
  nowMs: number;
  /** From `prepareRoots`, computed once at surface start. */
  roots: readonly PreparedRoot[];
  /** Requests counted in the last minute, by this surface. */
  decided: readonly DecidedOpen[];
  fs?: OpenFs;
  platform?: NodeJS.Platform;
}

export interface OpenIdentity { dev: number; ino: number }

export type OpenDecision =
  | { do: 'open'; name: string; path: string; mode: 'source' | 'auto'; line?: number; identity: OpenIdentity }
  | { do: 'refuse'; why: OpenWhy; reason: string; name?: string; counted: boolean };

const MAX_PATH = 4096;
const SECRET_SEGMENTS = new Set(['.ssh', '.gnupg', '.aws', '.docker', '.kube', '.git', '.obsidian', '.claude', 'agent-secrets']);
const SECRET_NAMES = new Set(['.netrc', '.pgpass', '.npmrc', '.pypirc', '.git-credentials', '.dockercfg', '.mcp.json',
  'storage_state.json', 'spotify-cache.json', '.dev.vars', 'credentials', 'kubeconfig',
  'auth.json', '.htpasswd', '.vault-token', '.yarnrc.yml', '.s3cfg', '.my.cnf']);
const SECRET_EXT = /\.(pem|key|p12|pfx|p8|kdbx|ovpn|ppk|jks|keystore|tfstate|tfvars)$/;
const WORD_EXT = /\.(json|ya?ml|toml|txt)$/;
const WORDS = new Set(['token', 'tokens', 'credential', 'credentials', 'oauth', 'secret', 'secrets', 'cookie', 'cookies', 'password', 'passwords', 'apikey']);
const EXEC_EXT = new RegExp('\\.(' + ['exe', 'com', 'bat', 'cmd', 'ps1', 'msi', 'scr', 'app', 'command', 'lnk', 'url', 'webloc', 'desktop',
  'terminal', 'jar', 'vbs', 'hta', 'reg', 'scpt', 'workflow', 'pkg', 'dmg', 'appimage', 'jse', 'vbe', 'wsf', 'wsh', 'cpl', 'msc', 'pif',
  'scf', 'appref-ms', 'application', 'appinstaller', 'msix', 'appx', 'msp', 'settingcontent-ms', 'library-ms', 'searchconnector-ms',
  'fileloc', 'inetloc', 'afploc', 'mobileconfig', 'jnlp'].join('|') + ')$');
const BAD_CHARS = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
/** Full Unicode case folding, as a case-insensitive file system compares names (ſ is s, ß is ss). */
export const fold = (s: string): string => s.toUpperCase().toLowerCase();
const DOC_EXT = /\.(md|markdown|txt|json|ya?ml|toml|csv|log|html?|png|jpe?g|gif|webp|svg|pdf)$/i;
const SOURCE_EXT = /\.(html?|xhtml?|xht|shtml|mht|mhtml)$/i;
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)$/i;

/** A secret by NAME (inbox-contract-5.md § Secrets). Both separators are read. */
export function isSecretPath(p: string): boolean {
  const raw = p.split(/[\\/]+/).filter(Boolean);
  const segs = raw.map(fold);
  if (!segs.length) return false;
  if (segs.some((s) => SECRET_SEGMENTS.has(s))) return true;
  const b = segs[segs.length - 1];
  if (b.startsWith('.env') || b.endsWith('.env') || SECRET_NAMES.has(b)) return true;
  if (SECRET_EXT.test(b)) return true;
  if (b.endsWith('.json') && (b.startsWith('service-account') || b.includes('firebase-adminsdk'))) return true;
  if (segs.length > 1 && segs[segs.length - 2] === 'auth' && b.endsWith('.json')) return true;
  const hasExt = b.replace(/^\.+/, '').includes('.');
  if (WORD_EXT.test(b) || !hasExt) {
    const rb = raw[raw.length - 1];
    const stem = hasExt ? rb.slice(0, rb.lastIndexOf('.')) : rb;
    const w = fold(stem.replace(/([a-z])([A-Z])/g, '$1 $2')).match(/[a-z]+|[0-9]+/g) ?? [];
    if (w.some((x) => WORDS.has(x)) || w.some((x, i) => x === 'api' && w[i + 1] === 'key')) return true;
  }
  return /^id_(rsa|dsa|ecdsa|ed25519)/.test(b) && !b.endsWith('.pub');
}

/** The Windows path-shape checks of check 5; null when they pass. */
export function windowsShape(p: string): 'bad-path' | 'not-absolute' | null {
  if (/^[\\/]{2}/.test(p)) return 'bad-path';
  if (!/^[A-Za-z]:[\\/]/.test(p)) return 'not-absolute';
  const rest = p.slice(2);
  if (rest.includes(':')) return 'bad-path';
  for (const seg of rest.split(/[\\/]+/).filter(Boolean)) {
    if (seg === '.' || seg === '..' || /[. ]$/.test(seg) || /~\d/.test(seg) || RESERVED.test(fold(seg.split('.')[0].replace(/ +$/, '')))) return 'bad-path';
  }
  return null;
}

/* A path in the form compared and walked here: forward slashes, separators collapsed, no trailing
   slash; on Windows, without case. Node's fs accepts forward slashes on Windows. */
function form(p: string, platform: NodeJS.Platform): string {
  const s = (platform === 'win32' ? fold(p.replace(/\\/g, '/')) : p).replace(/\/+/g, '/');
  return s.length > 1 ? s.replace(/\/+$/, '') : s;
}
function under(p: string, root: string): boolean {
  return p === root || p.startsWith(root === '/' ? '/' : root + '/');
}
function joinTarget(dir: string, target: string, platform: NodeJS.Platform): string {
  const t = target.replace(/\\/g, '/');
  const abs = platform === 'win32' ? /^[A-Za-z]:\//.test(t) : t.startsWith('/');
  const full = abs ? t : dir + '/' + t;
  const drive = platform === 'win32' ? (full.match(/^[A-Za-z]:/) ?? [''])[0] : '';
  const out: string[] = [];
  for (const c of full.slice(drive.length).split('/')) {
    if (!c || c === '.') continue;
    if (c === '..') { out.pop(); continue; }
    out.push(c);
  }
  return form(drive + '/' + out.join('/'), platform);
}

/**
 * The roots a surface may use, prepared ONCE at start: each configured root resolved, and dropped if
 * it is the file-system root, the home folder, a folder that contains the home folder, or a folder
 * inside a hidden folder of the home (a segment below home starting with a dot).
 */
export function prepareRoots(roots: readonly string[], home: string, o: { fs?: OpenFs; platform?: NodeJS.Platform } = {}): PreparedRoot[] {
  const fs = o.fs ?? nodeOpenFs;
  const platform = o.platform ?? process.platform;
  const h = form(fs.realpath(home) ?? home, platform);
  const out: PreparedRoot[] = [];
  for (const r of roots) {
    const rr = fs.realpath(r);
    if (!rr) continue;
    const real = form(rr, platform);
    if (real === '/' || /^[a-z]:$/.test(real) || under(h, real)) continue;
    if (under(real, h) && real.slice(h.length).split('/').some((s) => s.startsWith('.'))) continue;
    if (!looksLikeFramework(real, fs)) continue;   // a root that does not look like a framework turns open off
    out.push({ written: form(r, platform), real });
  }
  return out;
}

/** Does this resolved root look like a framework root? A surface turns `open` off when it does not. */
export function looksLikeFramework(root: string, fs: OpenFs = nodeOpenFs): boolean {
  const d = (p: string) => fs.lstat(p)?.kind === 'dir';
  return d(root + '/vault') && d(root + '/plugins/aios');
}

/**
 * Check 9: walk `p` (already inside a root as text) one segment at a time from the resolved root. A
 * link is read, not followed; if its target, as text, is outside every resolved root the walk stops
 * there and the target is never touched. Null for a missing segment, a loop, or a way out.
 */
export function resolveWithin(p: string, roots: readonly PreparedRoot[], fs: OpenFs, platform: NodeJS.Platform): string | null {
  const f = form(p, platform);
  let base = ''; let cur = '';
  for (const r of roots) {
    for (const b of [r.written, r.real]) {
      if (under(f, b) && b.length > base.length) { base = b; cur = r.real; }
    }
  }
  if (!cur) return null;
  const queue = f.slice(base.length).split('/').filter(Boolean);
  let hops = 0;
  while (queue.length) {
    const c = queue.shift() as string;
    const cand = cur === '/' ? '/' + c : cur + '/' + c;
    const st = fs.lstat(cand);
    if (!st) return null;
    if (st.kind === 'symlink') {
      if (++hops > MAX_HOPS) return null;
      const target = fs.readlink(cand);
      if (target === null) return null;
      const t = joinTarget(cur, target, platform);
      const holders = roots.filter((r) => under(t, r.real));
      if (!holders.length) return null;
      const r0 = holders.reduce((a, b) => (b.real.length > a.real.length ? b : a)).real;
      queue.unshift(...t.slice(r0.length).split('/').filter(Boolean));
      cur = r0;
      continue;
    }
    cur = cand;
  }
  return cur;
}

const no = (why: OpenWhy, reason: string, name?: string): OpenDecision => ({ do: 'refuse', why, reason, name, counted: why !== 'too-old' });

/** The thirteen checks of inbox-contract-5.md, in order. */
export function decideOpen(i: OpenInput): OpenDecision {
  const fs = i.fs ?? nodeOpenFs;
  const platform = i.platform ?? process.platform;
  const b = i.body ?? {};

  // 1. age, by this surface's own clock; not counted
  if (i.presentAtStart || i.seenAgoMs > OPEN_MAX_AGE_MS) {
    return no('too-old', i.presentAtStart ? 'the request was already waiting when this surface started; an open is never shown late' : `this surface saw the request ${Math.round(i.seenAgoMs / 1000)} s ago; an open is shown within ${OPEN_MAX_AGE_MS / 1000} s or not at all`);
  }
  // 2. flood: needs no field
  const recent = i.decided.filter((d) => d.at >= i.nowMs - OPEN_RATE_WINDOW_MS);
  if (recent.length >= OPEN_FLOOD_MAX) return no('flood', `${OPEN_FLOOD_MAX} open requests in the last minute; this one is dropped`);
  // 3. name
  const name = typeof b.name === 'string' ? sanitizeName(b.name) : '';
  if (!name || name.length > OPEN_MAX_NAME) return no('bad-name', `an open request needs a 'name' (the session asking), at most ${OPEN_MAX_NAME} characters`);
  // 4. rate for this name
  if (recent.filter((d) => sanitizeName(d.name) === name).length >= OPEN_RATE_MAX) {
    return no('rate-limited', `'${name}' already asked to open ${OPEN_RATE_MAX} files in the last minute`, name);
  }
  // 5. path shape
  const raw = b.path;
  if (typeof raw !== 'string') return no('bad-path', "'path' must be one absolute path", name);
  const p = raw.replace(/^[ \t]+|[ \t]+$/g, '');
  if (!p || BAD_CHARS.test(p)) return no('bad-path', "'path' must be one absolute path, without control characters", name);
  if (platform === 'win32') {
    const w = windowsShape(p);
    if (w) return no(w, w === 'bad-path' ? `that path form is never opened: ${p}` : `'path' must be absolute: ${p}`, name);
  } else {
    if (p.startsWith('~') || !p.startsWith('/')) return no('not-absolute', `'path' must be absolute: ${p}`, name);
    if (p.split('/').some((s) => s === '.' || s === '..')) return no('bad-path', `'path' must not contain . or .. segments: ${p}`, name);
  }
  if (p.length > MAX_PATH || /[\\/]$/.test(p)) return no('bad-path', `'path' must name a file, in at most ${MAX_PATH} characters`, name);
  // 6. line
  const hasLine = Object.prototype.hasOwnProperty.call(b, 'line');
  const line = b.line;
  if (hasLine && !(typeof line === 'number' && Number.isFinite(line) && Number.isInteger(line) && line >= 1 && line <= OPEN_MAX_LINE)) {
    return no('bad-line', `'line' must be a whole number from 1 to ${OPEN_MAX_LINE}`, name);
  }
  // 7. secret, as written
  const SECRET = 'that file is a secret by its name, and is never shown on request';
  if (isSecretPath(p)) return no('secret', SECRET, name);
  // 8. root, as text: no file system call for a path outside it
  const UNAVAILABLE = `not available to open: ${p}`;
  const f = form(p, platform);
  if (!i.roots.some((r) => under(f, r.written) || under(f, r.real))) return no('unavailable', UNAVAILABLE, name);
  // 9. resolve, one segment at a time, never out of the root
  const real = resolveWithin(p, i.roots, fs, platform);
  if (!real) return no('unavailable', UNAVAILABLE, name);
  // 10. a regular file, with one link
  const st = fs.lstat(real);
  if (!st || st.kind !== 'file') return no('not-a-file', 'that is not a regular file', name);
  /* A parent folder swapped for a link between the walk and the lstat would make the lstat describe
     a file elsewhere: walk again and require the same end. This narrows the window; it cannot close
     it, which is why what is SHOWN is read by readChecked, walking a third time. */
  if (resolveWithin(p, i.roots, fs, platform) !== real) return no('unavailable', UNAVAILABLE, name);
  if (st.links > 1) return no('hard-link', 'that file has another hard link elsewhere on the disk, so its name does not say what it is; a session cannot ask for it. You can still open it yourself', name);
  // 11. secret, resolved, and by the name the file system stores (a case-insensitive file system
  //     matches more spellings than folding does; on Windows this also expands a short name)
  const stored = fs.realpath(real);
  if (isSecretPath(real) || !stored || isSecretPath(stored)) return no('secret', SECRET, name);
  // 12. kind
  const cls = fs.classify(real);
  if (cls === 'binary' || cls === 'large') return no('unreadable', `the viewer cannot show it (${cls})`, name);
  // 13. executable
  const low = fold(real);
  if (EXEC_EXT.test(low) || (st.executable && !DOC_EXT.test(low))) return no('executable', 'that file is executable, and is never opened on request', name);

  const out: OpenDecision = { do: 'open', name, path: real, mode: SOURCE_EXT.test(low) ? 'source' : 'auto', identity: { dev: st.dev, ino: st.ino } };
  if (hasLine) out.line = line as number;
  return out;
}

/**
 * Read a file the decision let through, showing it only if it is still what was checked: the path
 * still walks, inside the root, to the SAME regular file (device and inode) with one link, whose name
 * is not a secret. Text is read from a descriptor opened without following a final link and checked
 * with fstat; an asset (`asBytes`) is read the same way, up to 32 MB.
 */
export function readChecked(
  path: string,
  identity: OpenIdentity,
  o: { roots: readonly PreparedRoot[]; platform?: NodeJS.Platform; fs?: OpenFs; asBytes?: boolean },
): { ok: true; path: string; content: string | Buffer } | { ok: false; reason: string } {
  const fs = o.fs ?? nodeOpenFs;
  const platform = o.platform ?? process.platform;
  /* One reason for every refusal: a dead letter that said "gone", "outside" or "a secret" after a
     swap would tell a session what exists outside the root, which the single code exists to hide. */
  const NO = { ok: false as const, reason: 'the file changed since it was checked, and is not shown' };
  const real = resolveWithin(path, o.roots, fs, platform);
  if (!real || isSecretPath(real)) return NO;
  const st = fs.lstat(real);
  if (!st || st.kind !== 'file' || st.links > 1 || st.dev !== identity.dev || st.ino !== identity.ino) return NO;
  const cls = fs.classify(real);
  if (o.asBytes ? cls !== 'asset' : cls !== 'text') return NO;
  let fd: number | undefined;
  try {
    const flags = nodeFs.constants.O_RDONLY | (nodeFs.constants.O_NOFOLLOW ?? 0) | (nodeFs.constants.O_NONBLOCK ?? 0);
    fd = nodeFs.openSync(real, flags);
    const f = nodeFs.fstatSync(fd);
    if (!f.isFile() || f.nlink > 1 || f.dev !== identity.dev || f.ino !== identity.ino) return NO;
    /* The parent-folder swap again, now on the descriptor: the path must still walk to this file. */
    if (resolveWithin(path, o.roots, fs, platform) !== real) return NO;
    const limit = o.asBytes ? 32 * 1024 * 1024 : 4 * 1024 * 1024;
    /* At most limit + 1 bytes into a fixed buffer, whatever the size says now: a file that grows
       between the fstat and the read is never read past the bound. */
    const buf = Buffer.alloc(Math.min(f.size, limit) + 1);
    let n = 0;
    while (n < buf.length) { const k = nodeFs.readSync(fd, buf, n, buf.length - n, n); if (k <= 0) break; n += k; }
    if (n > limit) return NO;
    const data = buf.subarray(0, n);
    return { ok: true, path: real, content: o.asBytes ? data : data.toString('utf8') };
  } catch {
    return NO;
  } finally {
    if (fd !== undefined) { try { nodeFs.closeSync(fd); } catch { /* closed */ } }
  }
}

/** The real file system. */
export const nodeOpenFs: OpenFs = {
  lstat(p) {
    try {
      const st = nodeFs.lstatSync(p);
      return {
        kind: st.isSymbolicLink() ? 'symlink' : st.isFile() ? 'file' : st.isDirectory() ? 'dir' : 'other',
        links: st.nlink, dev: st.dev, ino: st.ino,
        executable: process.platform !== 'win32' && (st.mode & 0o111) !== 0,
      };
    } catch { return null; }
  },
  readlink(p) {
    try { return nodeFs.readlinkSync(p); } catch { return null; }
  },
  realpath(p) {
    try { return nodeFs.realpathSync.native(p); } catch { return null; }
  },
  classify(p) {
    try { return classifyForRead(p).kind; } catch { return 'binary'; }
  },
};

/** The requests a surface remembers: one minute of them, at most 200. */
export function rememberDecided(decided: DecidedOpen[], d: DecidedOpen, nowMs: number): DecidedOpen[] {
  const keep = decided.filter((x) => x.at >= nowMs - OPEN_RATE_WINDOW_MS);
  keep.push(d);
  return keep.slice(-200);
}
