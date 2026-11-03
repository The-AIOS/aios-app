/* Files opening by themselves.
 *
 * The 03 - export watcher opened the newest file in a tab on ANY event in the folder, and the
 * setting defaulted to on. A `git pull` writes every file it brings with a fresh mtime, so work
 * from another machine (or another operator's sync) opened tabs and took focus while the operator
 * was typing somewhere else. Two changes, both decided here so they are tested without a watcher:
 *
 *   1. THREE MODES, and the default does not take focus: `badge` marks the new export quietly
 *      (a count on the explorer button), `open` is the old behaviour for those who want it,
 *      `off` does nothing. A saved `autoOpenExports: false` stays off; everything else, the old
 *      implicit default included, becomes `badge`, because the old default is the defect.
 *   2. A FILE THAT CAME FROM GIT IS NEVER ANNOUNCED. Tracked and unmodified means a checkout or a
 *      pull put it there — a session writing it would leave it untracked or modified. Git is the
 *      one witness that can tell those apart; an mtime cannot.
 */
export type ExportOpenMode = 'open' | 'badge' | 'off';
const MODES: readonly ExportOpenMode[] = ['open', 'badge', 'off'];

export function exportOpenMode(raw: { openExports?: unknown; autoOpenExports?: unknown }): ExportOpenMode {
  if (MODES.includes(raw.openExports as ExportOpenMode)) return raw.openExports as ExportOpenMode;
  return raw.autoOpenExports === false ? 'off' : 'badge';
}

/** Run git and answer its stdout, or null when git could not answer (no repo, no git, timeout). */
export type GitRun = (args: string[]) => Promise<string | null>;

/** Did this file arrive from git (tracked, and identical to what git has)? Unknown → false. */
export async function cameFromGit(file: string, git: GitRun): Promise<boolean> {
  const tracked = await git(['ls-files', '--', file]);
  if (!tracked || !tracked.trim()) return false;            // untracked, ignored, or no answer
  const status = await git(['status', '--porcelain', '--', file]);
  return status !== null && status.trim() === '';           // tracked AND clean → a pull/checkout
}
