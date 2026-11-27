/**
 * #179: a bus `send` to a session that runs background subagents landed inside one of the subagents,
 * again and again, while the session itself never saw it.
 *
 * Two failures, two rules:
 *  1. WRONG RECIPIENT. A session with a background subagent still running is treated as busy: the
 *     send waits until its subagents finish, the same way it waits out a session mid-turn. Claude Code
 *     writes each subagent's state beside its transcript (`<session>/subagents/agent-*.meta.json`,
 *     `finished: true` once done); a subagent whose transcript has not moved for SUBAGENT_STALE_MS
 *     counts as finished, so a crashed one can never hold a message forever.
 *  2. REPEATED DELIVERY. The send was verified only in the session's own transcript, so a copy that
 *     landed in a subagent never counted and the message was typed again. Now a copy found in a
 *     subagent's transcript ends the send: it is never typed again, and a dead letter tells the
 *     sender where it went.
 * Pure, so both rules can be tested without Claude Code.
 */

/** A subagent whose transcript has not changed for this long is not holding anything. */
export const SUBAGENT_STALE_MS = 15 * 60 * 1000;

export interface SubagentState {
  /** `finished` from the subagent's .meta.json; anything but `true` means still running. */
  finished?: unknown;
  /** Last change of the subagent's transcript. */
  mtimeMs: number;
}

/** How many of the session's subagents are still running at `now`. */
export function liveSubagents(states: readonly SubagentState[], now: number, staleMs = SUBAGENT_STALE_MS): number {
  return states.filter((s) => s.finished !== true && now - s.mtimeMs < staleMs).length;
}

/** Longest a message waits for subagents BEFORE it is first typed (review of #179: without a cap, a session that keeps
 *  agents running back to back held every message to it forever, with no dead letter). */
export const SUBAGENT_HOLD_MAX_MS = 60 * 60 * 1000;

/**
 * What a send does while the target has subagents running: `go` (none live), `hold`, or `give-up` once it has waited
 * too long ON SUBAGENTS: before the first type, from `holdSince` (the first time this send found subagents running,
 * never the time it queued, which includes waiting for a busy session or a draft: second review of #179); after, from
 * the first type, like every other hold.
 */
export function subagentHold(s: { live: number; now: number; holdSince: number; firstTypedAt: number; maxHoldMs: number; maxPreTypeMs?: number }): 'go' | 'hold' | 'give-up' {
  if (s.live <= 0) return 'go';
  const waited = s.firstTypedAt ? s.now - s.firstTypedAt : s.now - s.holdSince;
  const cap = s.firstTypedAt ? s.maxHoldMs : (s.maxPreTypeMs ?? SUBAGENT_HOLD_MAX_MS);
  return waited >= cap ? 'give-up' : 'hold';
}

/**
 * Did the message land in a subagent INSTEAD of the session? Only when the session's own transcript has no copy since
 * the send began, and a subagent has one written after the first type. A session that received the message and quoted
 * it to an agent of its own has a copy in both: that is a delivery, never a dead letter (review of #179).
 */
export function landedInSubagentOnly(mainNow: number | null, mainBefore: number, subCopiesSinceTyped: number): boolean {
  if (mainNow === null) return false;   // the session's transcript cannot be read: not verifiable, never "wrong recipient"
  if (mainNow > mainBefore) return false;
  return subCopiesSinceTyped > 0;
}

/** The dead letter for a message that arrived in a subagent instead of the session. */
export function landedInSubagentReason(name: string): string {
  return `the message reached a background subagent of '${name}', not '${name}' itself, so it was not typed again. `
    + `Send it again once '${name}' has no background subagents running.`;
}

/**
 * One pass of the send loop before it types (third review of #179), as a pure decision so it is tested by running it:
 *  - typed before and the session's transcript is unreadable → `unverifiable` (typed once, never typed again);
 *  - typed before and the session's own transcript gained a copy → `delivered` (it arrived late);
 *  - subagents running → `hold` or `give-up`, the clock counting only time spent on subagents and starting over once
 *    none are running;
 *  - otherwise → `go`.
 * Returns the hold clock to keep for the next pass.
 */
export function preTypeStep(s: {
  firstTypedAt: number; mainNow: number | null; baseline: number; subLive: number; holdSince: number; now: number; maxHoldMs: number; maxPreTypeMs?: number;
}): { do: 'unverifiable' | 'delivered' | 'hold' | 'give-up' | 'go'; holdSince: number } {
  if (s.firstTypedAt) {
    if (s.mainNow === null) return { do: 'unverifiable', holdSince: s.holdSince };
    if (s.mainNow > s.baseline) return { do: 'delivered', holdSince: s.holdSince };
  }
  if (s.subLive <= 0) return { do: 'go', holdSince: 0 };
  const since = s.holdSince || s.now;
  return { do: subagentHold({ live: s.subLive, now: s.now, holdSince: since, firstTypedAt: s.firstTypedAt, maxHoldMs: s.maxHoldMs, maxPreTypeMs: s.maxPreTypeMs }), holdSince: since };
}
