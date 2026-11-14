/**
 * Saving a note that may have changed on disk since the editor read it (#159).
 *
 * The viewer used to write its copy back unconditionally. Agents write to notes constantly (the
 * daily-note ledger, /close-session, /close-day), so a section an agent added while the note was
 * open was silently erased by the next autosave. The rule now: the editor remembers the text it
 * started from (the BASE), and a save is decided against what is on disk NOW:
 *   - disk still equals the base   → write mine;
 *   - disk changed, mine did not   → nothing of mine to write, keep the disk;
 *   - both changed different lines → write the merge of both;
 *   - both changed the same lines  → conflict: write nothing, ask the operator.
 * Never a silent overwrite. Pure (no fs, no Electron) so a test can drive every case.
 */

export type SaveDecision = { write: string } | { conflict: true };

/** One change from base to another version: base lines [start, end) become `lines`. */
interface Hunk { start: number; end: number; lines: string[] }

/** Above this many cells, the line diff is not attempted and the save is treated as a conflict (ask, never guess). */
const DIFF_CELLS_MAX = 4_000_000;

/**
 * The changes that turn `base` into `other`, as hunks in base coordinates, in order. Null when the
 * files are too different to diff cheaply: the caller must then ask rather than merge.
 */
function hunks(base: string[], other: string[]): Hunk[] | null {
  let pre = 0;
  while (pre < base.length && pre < other.length && base[pre] === other[pre]) pre++;
  let suf = 0;
  while (suf < base.length - pre && suf < other.length - pre && base[base.length - 1 - suf] === other[other.length - 1 - suf]) suf++;
  const a = base.slice(pre, base.length - suf);
  const b = other.slice(pre, other.length - suf);
  if (!a.length && !b.length) return [];
  if (!a.length || !b.length) return [{ start: pre, end: pre + a.length, lines: b }];
  if (a.length * b.length > DIFF_CELLS_MAX) return null;
  // LCS table over the middle, then walk it into hunks.
  const n = a.length, m = b.length;
  const L: Uint32Array[] = [];
  for (let i = 0; i <= n; i++) L.push(new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out: Hunk[] = [];
  let i = 0, j = 0, cur: Hunk | null = null;
  const flush = () => { if (cur) { out.push(cur); cur = null; } };
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { flush(); i++; j++; continue; }
    if (!cur) cur = { start: pre + i, end: pre + i, lines: [] };
    if (j < m && (i >= n || L[i][j + 1] >= L[i + 1][j])) { cur.lines.push(b[j]); j++; }
    else { i++; cur.end = pre + i; }
  }
  flush();
  return out;
}

const startsWith = (a: string[], b: string[]): boolean => b.length <= a.length && b.every((l, k) => l === a[k]);
const same = (x: Hunk, y: Hunk): boolean => x.start === y.start && x.end === y.end && x.lines.length === y.lines.length && x.lines.every((l, k) => l === y.lines[k]);

/** Two hunks touch the same base lines (or insert at the same point): they cannot both be applied without a choice. */
function clash(x: Hunk, y: Hunk): boolean {
  if (x.start === x.end && y.start === y.end) return false;   // two insertions at one point: both kept, the disk's first
  if (x.start === x.end) return x.start > y.start && x.start < y.end;       // an insertion strictly inside the other's range
  if (y.start === y.end) return y.start > x.start && y.start < x.end;
  return x.start < y.end && y.start < x.end;                                 // overlapping ranges
}

/**
 * Three-way merge by lines. `ok: false` when both sides changed the same lines, unless `prefer` is 'mine': then, on those
 * lines only, mine wins and every other change from both sides is kept ("Keep my changes" in the conflict question).
 */
export function merge3(base: string, mine: string, theirs: string, prefer?: 'mine'): { ok: true; text: string } | { ok: false } {
  if (mine === theirs || theirs === base) return { ok: true, text: mine };
  if (mine === base) return { ok: true, text: theirs };
  const B = base.split('\n');
  const hm = hunks(B, mine.split('\n'));
  const ht = hunks(B, theirs.split('\n'));
  if (!hm || !ht) return { ok: false };
  const all: Hunk[] = [];
  const mineHunks = hm.map((h) => ({ ...h, lines: [...h.lines] }));
  for (const h of ht) {
    if (mineHunks.some((x) => same(x, h))) continue;   // both sides made the identical change: apply it once (mine, below)
    /* Both inserted at one point, one insertion beginning with the other (the agent wrote "foo", the operator then typed
       "foo" + "bar" in the reloaded text): the longer one holds both, so the shared lines are not written twice. */
    const twin = mineHunks.find((x) => x.start === x.end && h.start === h.end && x.start === h.start);
    if (twin && startsWith(twin.lines, h.lines)) continue;
    if (twin && startsWith(h.lines, twin.lines)) { twin.lines = [...h.lines]; continue; }
    if (mineHunks.some((x) => clash(x, h))) { if (prefer === 'mine') continue; return { ok: false }; }
    all.push(h);
  }
  all.push(...mineHunks);
  /* Apply in base order. At one point, an insertion goes before a range that starts there, and when both sides inserted
     there, the disk's lines come first (an agent appended, then the operator's own new line follows): the sort is stable
     and the disk's hunks were pushed first. */
  all.sort((x, y) => x.start - y.start || (x.end - x.start) - (y.end - y.start));
  const out: string[] = [];
  let at = 0;
  for (const h of all) {
    out.push(...B.slice(at, h.start), ...h.lines);
    at = Math.max(at, h.end);
  }
  out.push(...B.slice(at));
  return { ok: true, text: out.join('\n') };
}

/**
 * What to write, given the text the editor started from, the editor's text now, and the disk now.
 * `disk` null means the file is gone or unreadable: the editor's text is written, as before. `prefer: 'mine'` is the
 * operator's answer to a conflict: their lines win where both changed, and the rest of the disk's changes are kept.
 */
export function decideSave(base: string, mine: string, disk: string | null, prefer?: 'mine'): SaveDecision {
  if (disk === null || disk === base) return { write: mine };
  const m = merge3(base, mine, disk, prefer);
  return m.ok ? { write: m.text } : { conflict: true };
}
