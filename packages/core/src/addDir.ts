/**
 * aios#231 — A WORKER THAT CANNOT READ OUTSIDE ITS WORKING FOLDER MUST STILL READ ITS TASK FILE.
 *
 * Under Claude Code's `permissions.blockReadsOutsideWorkingDirectories`, a session can read only its
 * working directory and the directories it was given. A surface that launches `claude` with the
 * prompt "Read <file> and follow…" writes that file to the private run dir (~/.aios/run), which is
 * outside the worker's folder — so the worker was told to read a file it was not allowed to open.
 * The fix is to grant that one directory on the same command line: `--add-dir <dir of the file>`.
 *
 * Pure (no node:path), shared by both surfaces. Two rules for the caller:
 *  · `--add-dir` is VARIADIC in Claude Code: every following token that is not a flag is read as
 *    another directory. So place it straight after the binary, where the next token is always a
 *    flag — never just before the positional prompt, which would be swallowed as a directory.
 *  · the returned dir is unquoted; quote it for the shell like every other argument.
 */

/** The directory part of `file`, for either separator. '' when there is none. */
export function dirOfFile(file: string): string {
  const i = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'));
  if (i < 0) return '';
  if (i === 0) return file[0];                       // '/x' → '/'
  if (/^[A-Za-z]:$/.test(file.slice(0, i))) return file.slice(0, i + 1);   // 'C:\x' → 'C:\'
  return file.slice(0, i);
}

/** `['--add-dir', <dir>]` for a launch whose prompt points at `taskFile`; [] without one. */
export function addDirArgs(taskFile?: string): string[] {
  const dir = taskFile ? dirOfFile(taskFile) : '';
  return dir ? ['--add-dir', dir] : [];
}
