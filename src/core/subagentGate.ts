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

/** The dead letter for a message that arrived in a subagent instead of the session. */
export function landedInSubagentReason(name: string): string {
  return `the message reached a background subagent of '${name}', not '${name}' itself, so it was not typed again. `
    + `Send it again once '${name}' has no background subagents running.`;
}
