/**
 * The `@` file mention in the chat composer: what Claude Code's own prompt offers when `@` is typed — the files and
 * folders of the session's folder, ranked for what follows the `@`. PURE: main lists the folder (git ls-files, or a
 * bounded walk) and hands the paths here, so the ranking is testable without a disk.
 */

export interface FileMention { path: string; dir: boolean }

/** At most this many rows reach the popup; it shows seven and scrolls. */
export const MENTION_LIMIT = 30;

/** The `@word` the caret is in, or null: an `@` at the start or after a space, and no space or quote since. */
export function mentionAt(before: string): { start: number; query: string } | null {
  const m = /(?:^|\s)@([^\s@"']*)$/.exec(before);
  if (!m) return null;
  return { start: before.length - m[1].length - 1, query: m[1] };
}

/**
 * Rank `files` (relative, `/`-separated) and the folders above them for `query`. A folder is offered with its trailing
 * slash, like the terminal's. Order: the name starts with the query, then the name contains it, then the path does;
 * shorter paths first inside each band, so `src/` beats `src/core/deep/src.ts`. An empty query lists the top level.
 */
export function rankMentions(files: string[], query: string, limit = MENTION_LIMIT): FileMention[] {
  const q = query.toLowerCase().replace(/^\.\//, '');
  const dirs = new Set<string>();
  for (const f of files) {
    const parts = f.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/') + '/');
  }
  const all: FileMention[] = [...[...dirs].map((path) => ({ path, dir: true })), ...files.map((path) => ({ path, dir: false }))];
  if (!q) return all.filter((x) => !x.path.replace(/\/$/, '').includes('/')).sort((a, b) => Number(b.dir) - Number(a.dir) || a.path.localeCompare(b.path)).slice(0, limit);
  const scored: { x: FileMention; band: number }[] = [];
  for (const x of all) {
    const p = x.path.toLowerCase();
    const name = p.replace(/\/$/, '').split('/').pop() ?? p;
    const band = name.startsWith(q) ? 0 : name.includes(q) ? 1 : p.includes(q) ? 2 : -1;
    if (band >= 0) scored.push({ x, band });
  }
  scored.sort((a, b) => a.band - b.band || a.x.path.length - b.x.path.length || a.x.path.localeCompare(b.x.path));
  return scored.slice(0, limit).map((s) => s.x);
}
