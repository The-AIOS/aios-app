/**
 * Who owns `~/.aios/surfaces/<surface>.json` — the one decision both fulfillers must agree on.
 *
 * The record answers a single question for an agent: *is a surface alive, and which pid is it?*
 * CLAUDE.md makes it load-bearing — "a surface is available iff some such file names a pid that
 * is still running" — so an agent that finds no such file does not spawn. It hands the work back
 * to the operator instead, which is the correct behaviour given a wrong answer, and is why a
 * missing record is not a cosmetic problem.
 *
 * WHY THIS IS SHARED AND PURE. Both surfaces had the same defect, written independently and
 * defended by the same mistaken comment: ownership was enforced on RETRACT ("a departing Glass
 * must not delete the App's file... also covers a second window that re-announced over ours")
 * while ANNOUNCE overwrote unconditionally. That cannot hold, because announce is what ASSIGNS
 * ownership — and it assigned it to whoever wrote last rather than to whoever is alive. Checking
 * one side of a two-sided protocol only moves the losing ordering; it never removes it.
 *
 * Measured on the App, 2026-09-15 (log timestamps, one machine):
 *   12:54:05  instance A announces      → record names A
 *   12:55:40  instance B announces      → record names B (A is still running)
 *   12:55:50  B quits, retract sees its OWN pid, unlinks → RECORD GONE
 *   12:58:05  A is still fulfilling spawns, and no record names it
 * The retract was correct by its own rule at every step. Nothing logged an error. Glass reaches
 * the same state faster and more often, because there "a second instance" is just a second IDE
 * window — routine, where the App needed two installed bundles.
 *
 * So the decision is stated once, as a function of (what the record says, who I am, who is
 * alive), and both surfaces call it on announce AND on a periodic heal. Liveness — not write
 * order, and not our own bookkeeping — is what decides.
 */

/** What a presence file holds. Every field optional: it is parsed from disk, not constructed. */
export interface PresenceRecord {
  surface?: string;
  pid?: number;
  at?: number;
  version?: string;
}

/** `claim` = write our own record here. `leave` = someone alive owns it; do not touch it. */
export type PresenceVerdict = 'claim' | 'leave';

/** Parse a presence file's contents. Unreadable, absent and malformed all mean "no record". */
export function parsePresenceRecord(raw: string | undefined): PresenceRecord | undefined {
  if (!raw) return undefined;
  try {
    const o = JSON.parse(raw) as PresenceRecord;
    return o && typeof o === 'object' ? o : undefined;
  } catch { return undefined; }
}

/**
 * Should we write our pid into this record?
 *
 * `claim` when the record names nobody alive — absent, malformed, or a pid that has gone. Also
 * when it already names us, so a heal refreshes `at`/`version` rather than treating our own
 * record as a stranger's.
 *
 * `leave` in exactly one case: it names a DIFFERENT pid that is still running. Deferring to a
 * live incumbent is what stops two surfaces trading the record back and forth, and it costs
 * nothing — the incumbent is alive and fulfilling, so the record is already true. When it exits,
 * its retract removes the record and the next heal here claims it.
 */
export function presenceVerdict(
  rec: PresenceRecord | undefined,
  mine: number,
  isAlive: (pid: number) => boolean,
): PresenceVerdict {
  const held = rec?.pid;
  if (!Number.isInteger(held) || (held as number) <= 1) return 'claim';   // no usable record
  if (held === mine) return 'claim';                                      // ours — refresh it
  return isAlive(held as number) ? 'leave' : 'claim';
}

/**
 * May we DELETE this record on our way out?
 *
 * Only if it still names us. A record naming anyone else — a live peer that announced over us,
 * or the other surface entirely — is not ours to remove. Unlike the claim decision this needs no
 * liveness check: we are the one exiting, so the only question is whether the record is ours.
 */
export function mayRetract(rec: PresenceRecord | undefined, mine: number): boolean {
  return Number.isInteger(rec?.pid) && rec?.pid === mine;
}
