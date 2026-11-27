import { verifyVerdict } from '@the-aios/core/sendQueue';

/**
 * Re-type, or has the earlier type already landed? Asked right before EVERY re-type.
 *
 * 26 Oct 2026, measured: a send went to a session that turned busy during verification. The
 * verdict was 'wait', the loop held until the target was idle again, and then typed the message a
 * second time, because the late-arrival check ran only once the attempts were spent. By then the
 * first copy was in the transcript: the operator got the same message twice, 33 s apart, and the
 * App's own counter logged DUPLICATE DELIVERY. A busy target finishes its turn and writes the text
 * it was given; the only safe moment to decide on a re-type is after re-reading.
 *
 * App-only on purpose: core/sendQueue.ts is pinned byte-for-byte to the Glass fulfiller
 * (protocolContract SENDQUEUE_SHA). This changes no decision table, only when the App re-reads.
 */
export function landedBeforeRetype(typedOnce: boolean, before: number, now: number): boolean {
  return typedOnce && verifyVerdict(before, now) !== 'pending';
}

/**
 * #81 (an operator saw sessions "jump in" while typing). Is the operator writing in the target's
 * pane? The renderer reports its own keystrokes: composing = keys since the last Enter / Ctrl-C; `at` = the last key. A bus message is never typed into a draft (it lands inside it), so
 * the bus treats a composing target like a busy one: it holds, through its own budgets and
 * readiness checks, and never types from anywhere else.
 */
export const COMPOSE_QUIET_MS = 8000;
/** A draft with no key for this long is abandoned, not being written: a lone Esc, Shift-Tab or a digit
 *  answering a prompt leaves "composing" set with no Enter to clear it, and at 30 min (or never, in the
 *  pane) that held a session's messages for up to the queue's 24 h ceiling, silently. 3 min covers a
 *  real pause mid-sentence. The pane's own check uses the same limit (renderer BUS_COMPOSE_STALE_MS). */
export const COMPOSE_STALE_MS = 3 * 60 * 1000;
/** With Claude Code's prompt stash (Ctrl+S) the pane sets a draft aside before typing and Claude puts
 *  it back after the send, so a draft is never glued to a message. The only reason left to wait is
 *  not pulling the box away mid-sentence: 10 s without a key. Measured in the 0.13.0 round on 2.1.312.
 *  The stash predates 2.1.19 in Claude Code's changelog; 2.1.69 fixed it being cleared by a submit
 *  while Claude works, which is this exact path, so that is the floor. Below it, or with no version
 *  in the registry: no Ctrl+S and the 3 min limit, as before. */
export const COMPOSE_STALE_STASH_MS = 10_000;
export const STASH_MIN_VERSION = '2.1.69';
export function hasPromptStash(version: string | undefined): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version || '').trim());
  if (!m) return false;
  const v = [Number(m[1]), Number(m[2]), Number(m[3])];
  const min = STASH_MIN_VERSION.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (v[i] !== min[i]) return v[i] > min[i];
  return true;
}
export const composeStaleMs = (stash: boolean): number => (stash ? COMPOSE_STALE_STASH_MS : COMPOSE_STALE_MS);
export function operatorComposing(rec: { composing: boolean; at: number } | undefined, now: number, staleMs: number = COMPOSE_STALE_MS): boolean {
  return !!rec && ((rec.composing && now - rec.at < staleMs) || now - rec.at < COMPOSE_QUIET_MS);
}
