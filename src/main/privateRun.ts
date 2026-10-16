/**
 * Private run files — where a surface writes a file another process will READ AS INSTRUCTIONS
 * (a worker's task, a resume prompt, a handoff) or RUN (a setup script). Byte-identical in the App
 * (src/main) and Glass (src/bus); a hash pin in each repo's protocolContract test keeps them so.
 *
 * WHY NOT os.tmpdir(). Those files had fixed names (`aios-spawn-task-<name>.md`) in the temp dir.
 * On macOS and Windows that dir is per-user, but on Linux it is the shared /tmp: another local
 * user can create the file — or a symlink at its path — before we do, and the worker then follows
 * THEIR instructions, or the setup step runs THEIR script. Canonical closed the same class in the
 * shell wrapper (v0.8.12) by moving to ~/.aios/run; this is the surfaces' half.
 *
 * THE RULES (POSIX). The run dir is ~/.aios/run, created 0700; it is refused if it is a symlink,
 * not a directory, or not owned by this user — and there is NO fallback to /tmp, because a
 * fallback is the vulnerability with extra steps. A file is written fresh: an old one this user
 * owns is removed first, anything else at the path (a symlink, a directory, another user's file)
 * is refused, and the write uses 'wx' (fails if something appeared in between) with mode 0600.
 * Windows keeps os.tmpdir(), which is per-user there, with the same fresh-write rule.
 *
 * Every function throws on refusal. The caller decides what a refusal means — for a task, the
 * request is dead-lettered with the reason, never delivered some other way.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const uid = (): number | undefined => (typeof process.getuid === 'function' ? process.getuid() : undefined);

function ensurePrivateDir(dir: string): void {
  try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
  const st = fs.lstatSync(dir);
  if (st.isSymbolicLink()) throw new Error(`${dir} is a symlink — refusing to write run files through it`);
  if (!st.isDirectory()) throw new Error(`${dir} is not a directory`);
  const me = uid();
  if (me !== undefined && st.uid !== me) throw new Error(`${dir} is not owned by this user`);
  if ((st.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);   // ours, but readable by others: tighten
}

/** The directory for run files, created and checked. `sub` names a private subfolder (e.g. 'setup'). */
export function runDir(sub?: string, opts: { home?: string; platform?: NodeJS.Platform } = {}): string {
  const platform = opts.platform ?? process.platform;
  if (platform === 'win32') {
    const d = sub ? path.join(os.tmpdir(), `aios-${sub}`) : os.tmpdir();
    fs.mkdirSync(d, { recursive: true });
    return d;
  }
  const aios = path.join(opts.home ?? os.homedir(), '.aios');
  fs.mkdirSync(aios, { recursive: true, mode: 0o700 });
  const base = path.join(aios, 'run');
  ensurePrivateDir(base);
  if (!sub) return base;
  const d = path.join(base, sub);
  ensurePrivateDir(d);
  return d;
}

/** Write `content` to `dir/name` as a FRESH private file and return its path. Throws on refusal. */
export function writePrivateFile(dir: string, name: string, content: string | Buffer, mode = 0o600): string {
  if (!name || name !== path.basename(name) || name === '.' || name === '..') throw new Error(`unsafe run-file name: ${name}`);
  const f = path.join(dir, name);
  let st: fs.Stats | undefined;
  try { st = fs.lstatSync(f); } catch { st = undefined; }
  if (st) {
    const me = uid();
    if (st.isSymbolicLink() || !st.isFile() || (me !== undefined && st.uid !== me)) {
      throw new Error(`${f} already exists and is not this user's plain file — refusing to write through it`);
    }
    fs.unlinkSync(f);
  }
  fs.writeFileSync(f, content, { flag: 'wx', mode });
  return f;
}
