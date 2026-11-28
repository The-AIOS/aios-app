/**
 * The guards a surface checks right before it types a bus message into a session.
 *
 * `sendQueue` decides whether a target is deliverable (idle, or running a shell command) and what
 * a verification miss means. Around that, the App asks three more things at the moment of typing,
 * and Glass asked none of them: it looked at the status and typed. A message could land in the
 * middle of a draft the operator was writing, inside one of the session's background subagents,
 * or a second time after the first copy had arrived late.
 *
 *   1. landedBeforeRetype   has the earlier type already arrived? (before every re-type)
 *   2. operatorComposing    is the operator writing in that session right now?
 *   3. the subagent guard   is a background subagent still running? (module `subagentGate`)
 *
 * The second needs keystrokes, which a surface whose sessions run in an editor's terminals does
 * not see. `operatorAtTerminal` is what such a surface asks in its place; it protects less, and
 * says where.
 * Pure: each surface supplies what it can observe.
 */
import { verifyVerdict } from './sendQueue';

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
 * It changes no decision table, only WHEN a surface re-reads before it types again.
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

/**
 * The nearest guard for a surface that cannot see keystrokes.
 *
 * `operatorComposing` needs to know that keys were pressed, and when. A terminal hosted by an
 * editor does not say: the editor's extension API tells which terminal is the active one and
 * whether the window has focus, never what is being typed into it, nor that a draft sits in the
 * box. So this asks the nearest thing: is the operator AT that terminal (it is the active
 * terminal of a focused window)?
 *
 *   · While the operator is there, the message waits, up to `staleMs`, counted from when this
 *     guard first found the operator there (`holdSince`: pass back what is returned, on every
 *     look, including looks where something else is holding the message). If a look finds the
 *     operator gone, the count starts again at the next visit.
 *   · When the operator is not there, the message goes.
 *
 * WHICH CAP. `COMPOSE_STALE_MS` (three minutes). The App's shorter cap goes with its pane pressing
 * Ctrl+S before it types, when its flag says a draft is open and the session's Claude Code has the
 * prompt stash: the draft is set aside and comes back after the send. The App's renderer states
 * that Ctrl+S on an empty box does nothing. A surface that cannot see drafts would press it on a
 * box it knows nothing about, every time, including a box whose draft the operator has already
 * stashed by hand; what Ctrl+S does then has not been measured (the App can reach that state
 * too, far less often). Until it is, such a surface does not stash, and passes the three-minute
 * cap.
 *
 * WHAT IT DOES NOT PROTECT:
 *   · a draft the operator LEFT in the box. The App's flag stays set, wherever the focus goes,
 *     until Enter or Ctrl-C, and holds the message for its cap. Here, the operator writes half a
 *     prompt, switches to another tab to copy something, and the message is typed onto the draft
 *     at once.
 *   · a draft being written when the cap runs out. This cap counts from when the operator was
 *     first found there, not from the last key, so it can end in the middle of a sentence. The
 *     App's counts from the last key.
 * And it holds when it need not: the operator is at the terminal, reading. That is why the hold
 * is capped at all; a cap that is not a finite number is treated as no hold.
 *
 * A caller that looks only every so often may miss an absence shorter than its interval: the
 * count then carries on from the first look.
 */
export function operatorAtTerminal(s: { present: boolean; holdSince: number | undefined; now: number; staleMs: number }): { do: 'go' | 'hold'; holdSince: number | undefined } {
  if (!s.present) return { do: 'go', holdSince: undefined };
  // A start in the future (the clock stepped back) would hold past the cap: count from now instead.
  const since = typeof s.holdSince === 'number' && s.holdSince <= s.now ? s.holdSince : s.now;
  const capped = Number.isFinite(s.staleMs) && s.now - since < s.staleMs;
  return capped ? { do: 'hold', holdSince: since } : { do: 'go', holdSince: since };
}
