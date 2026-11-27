/**
 * Two counters for "what is waiting on you", because they clear differently (#22).
 *
 *   ACTIVE BLOCKS  enter when the registry status becomes 'waiting'; clear when it LEAVES
 *                  'waiting' — i.e. when the operator actually answered. Looking at a
 *                  permission prompt does not resolve it, so viewing must not clear it.
 *                  Surfaces as the Dock badge AND (at the top level) one banner, on entry.
 *
 * ONE COUNTER, NOT TWO — and the second one was removed after an operator ran it. The original
 * design also counted "finished while you were away", which sounds useful and is not: a Dock
 * number reading 4 beside two waiting sessions cannot be read, because the two halves clear by
 * different acts and neither is visible in the total. "I have a badge showing 4 but then I only
 * have 2 sessions waiting for input" — and the deeper question underneath it, *how do you clear
 * a finished one*, has no good answer: a result you have not read is not a thing you can DO
 * something about, so it does not belong in a number that means "act on me".
 *
 * So the badge counts exactly one thing: sessions blocked on the operator. It clears when they
 * answer, which is the only act that clears it, and the number is legible without a legend.
 *
 * THREE STATES, NOT TWO. The issue that asked for this was explicit: keep *detected*,
 * *notification pending* and *notification accepted* apart, because a notifier that fails may
 * not mark the event as notified. So `blocks` is derived fresh from the registry every tick
 * (it can never drift), while `notified` is bookkeeping the CALLER advances only after the OS
 * actually accepted the banner. A throwing Notification therefore retries next tick instead of
 * being silently swallowed — the failure mode where the one banner that mattered never shows
 * and nothing anywhere says so.
 *
 * Pure and Electron-free on purpose: every rule below is a decision about when to interrupt a
 * human, which is exactly the kind of thing that must be testable without a display.
 */

/** off = nothing · badge = Dock badge only · banner = badge + one notification per block. */
export type NotifyLevel = 'off' | 'badge' | 'banner';

export const NOTIFY_LEVELS: readonly NotifyLevel[] = ['off', 'badge', 'banner'] as const;

/** Default: the operator is told. Silence is a choice they can make, not one made for them. */
export const NOTIFY_DEFAULT: NotifyLevel = 'banner';

export function normalizeNotifyLevel(raw: unknown): NotifyLevel {
  const v = (typeof raw === 'string' ? raw : '').trim().toLowerCase();
  return (NOTIFY_LEVELS as readonly string[]).includes(v) ? (v as NotifyLevel) : NOTIFY_DEFAULT;
}

/** The slice of a session record this module reasons about. */
export interface AttentionSession {
  /**
   * The session's IDENTITY — its `sessionId`, or `pid:<n>` for a record without one.
   *
   * NOT the name. Names are not unique and nothing enforces that they are: the registry is one
   * file per PID, so `spawn ingest` twice gives two live sessions both called `ingest`. Keyed by
   * name, one of them silently overwrites the other — measured on a live machine, two `ingest`
   * sessions (one working, one idle) made BOTH tabs animate, because a Map keyed on name keeps
   * only the last entry and both panes then resolved to it.
   *
   * The App's renderer already learned this once and says so in a comment a hundred lines from
   * where this was reintroduced: *"The name was never the identity. `sessionId` is."*
   */
  id: string;
  name: string;
  /** Claude Code's registry status: busy | shell | idle | waiting. */
  status: string;
  /** Present only while blocked — e.g. 'input needed', or the dialog's own label. */
  waitingFor?: string;
}

/** The identity of a registry record. Stable across a rename; unique across duplicates. */
export function sessionKey(r: { sessionId?: string; pid?: number }): string {
  const sid = (r.sessionId ?? '').trim();
  return sid || `pid:${r.pid ?? 0}`;
}

export interface AttentionState {
  /** Blocks already announced, BY ID. Not the badge — bookkeeping, advanced only on delivery. */
  notified: string[];
}

export const EMPTY_ATTENTION: AttentionState = { notified: [] };

export interface AttentionTick {
  /** Carry this into the next tick. */
  state: AttentionState;
  /** Sessions blocked right now — derived, never remembered. */
  blocks: AttentionSession[];
  /** Blocks entered and not yet announced. Notify these, then markNotified() what succeeded. */
  pending: AttentionSession[];
  /** What the Dock should show. 0 means clear the badge. */
  badge: number;
}

/**
 * "Is this session waiting on the operator" — ONE definition, shared.
 *
 * This was `status === 'waiting'` while the surfaces decided the same question with a regex, and
 * the two disagreed in the field: the operator's session showed the BLUE needs-you dot (regex)
 * and produced no badge and no banner (exact match). Two predicates for one question is the
 * whole bug — the dot and the counter have to be the same sentence or one of them is lying.
 *
 * The regex is the older and broader spelling and it wins, because it is what every surface
 * already renders from. Kept here so the counter cannot drift from the colour again;
 * `BLOCKED_STATUS_RE` is pinned character-for-character against the renderer's copy by
 * `attention.test.ts`, since a plain `.js` renderer cannot import this module.
 */
export const BLOCKED_STATUS_RE = /wait|input|prompt|\bask\b|attention|approv|permission|block/;

export function isBlockedStatus(status: string): boolean {
  return BLOCKED_STATUS_RE.test((status || '').toLowerCase());
}

const isBlocked = (s: AttentionSession): boolean => isBlockedStatus(s.status);

/**
 * Advance the counter by one observation. Blocks are derived fresh every tick and never
 * remembered, so the badge cannot drift; only the announced-set is carried.
 */
export function attentionTick(
  prev: AttentionState,
  sessions: readonly AttentionSession[],
): AttentionTick {
  const blocks = sessions.filter(isBlocked);
  const blocked = new Set(blocks.map((s) => s.id));

  // forget a session once it is no longer blocked, so the NEXT block speaks
  const notified = prev.notified.filter((k) => blocked.has(k));
  const pending = blocks.filter((s) => !notified.includes(s.id));

  return { state: { notified }, blocks, pending, badge: blocks.length };
}

/** Record that these blocks were announced, BY ID. Call ONLY for banners the OS accepted. */
export function markNotified(state: AttentionState, ids: readonly string[]): AttentionState {
  if (!ids.length) return state;
  return { ...state, notified: [...new Set([...state.notified, ...ids])] };
}

/** What the Dock shows. Electron clears the badge on '' and shows the string otherwise. */
export function badgeText(count: number, level: NotifyLevel): string {
  if (level === 'off' || count <= 0) return '';
  return String(count);
}

/** Whether a banner may be raised at all. Unread results never banner, at any level. */
export function mayBanner(level: NotifyLevel): boolean {
  return level === 'banner';
}
