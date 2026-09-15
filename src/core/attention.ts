/**
 * Two counters for "what is waiting on you", because they clear differently (#22).
 *
 *   ACTIVE BLOCKS  enter when the registry status becomes 'waiting'; clear when it LEAVES
 *                  'waiting' — i.e. when the operator actually answered. Looking at a
 *                  permission prompt does not resolve it, so viewing must not clear it.
 *                  Surfaces as the Dock badge AND (at the top level) one banner, on entry.
 *
 *   UNREAD RESULTS enter on busy → idle while the session was NOT visible; clear the moment
 *                  it becomes visible. Nobody needs a banner for work that finished — you
 *                  find out when you look. Badge only, no sound, at every level.
 *
 * Merging them into one number was the tempting simplification and it is wrong: one clears by
 * answering and the other by looking, so a single counter would either nag after you answered
 * or go quiet before you read the result.
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

/** off = nothing · badge = Dock badge only · banner = badge + one macOS notification per block. */
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
  /** Finished while nobody was looking, BY ID. */
  unread: string[];
  /** Last status seen per session id — how a TRANSITION is told from a repeated observation. */
  seen: Record<string, string>;
}

export const EMPTY_ATTENTION: AttentionState = { notified: [], unread: [], seen: {} };

export interface AttentionTick {
  /** Carry this into the next tick. */
  state: AttentionState;
  /** Sessions blocked right now — derived, never remembered. */
  blocks: AttentionSession[];
  /** Finished-unseen session IDS. Resolve to names for display at the call site. */
  unread: string[];
  /** Blocks entered and not yet announced. Notify these, then markNotified() what succeeded. */
  pending: AttentionSession[];
  /** What the Dock should show. 0 means clear the badge. */
  badge: number;
}

const isBlocked = (s: AttentionSession): boolean => s.status === 'waiting';

/**
 * Advance the counters by one observation.
 *
 * `visible` is every session the operator can actually SEE — the App focused AND that pane on
 * screen — given as IDS, not names. A focused pane behind another window is not visible, which
 * is why this is passed in rather than inferred from a tab id. It is a SET rather than one id
 * because this app splits: with two panes tiled, both are on screen, and treating only the
 * focused one as seen would leave a result the operator is looking at counted as unread.
 */
export function attentionTick(
  prev: AttentionState,
  sessions: readonly AttentionSession[],
  visible: readonly string[],
): AttentionTick {
  const vis = new Set(visible);
  const live = new Set(sessions.map((s) => s.id));
  const blocks = sessions.filter(isBlocked);
  const blocked = new Set(blocks.map((s) => s.id));

  // ── unread: busy → idle while unseen ──────────────────────────────────────
  const unread = new Set(prev.unread.filter((k) => live.has(k)));
  for (const s of sessions) {
    const was = prev.seen[s.id];
    /* 'shell' is a plain terminal, not an agent finishing work — a shell going idle is not a
       result anyone is waiting to read. Only an agent that was actually working can produce one. */
    if (was === 'busy' && s.status === 'idle' && !vis.has(s.id)) unread.add(s.id);
  }
  for (const v of vis) unread.delete(v);        // looking at it IS reading it

  // ── notified: forget a session once it is no longer blocked, so the NEXT block speaks ──
  const notified = prev.notified.filter((k) => blocked.has(k));
  const pending = blocks.filter((s) => !notified.includes(s.id));

  const seen: Record<string, string> = {};
  for (const s of sessions) seen[s.id] = s.status;

  return {
    state: { notified, unread: [...unread], seen },
    blocks,
    unread: [...unread],
    pending,
    badge: blocks.length + unread.size,
  };
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
