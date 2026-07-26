/**
 * The "Needs you" inbox — pure keying model for STATEFUL dismissal.
 *
 * One idea: dismissing an inbox item hides it UNTIL the item changes again.
 * Each item carries a stable `key` (its identity) and a change signature
 * (`updatedAt` — any string/number that changes when the item meaningfully
 * changes: a status, a raw task line, a commit hash). Dismissal stores the
 * signature seen at dismiss time; the item stays hidden exactly while the
 * live signature still matches. The moment it changes, the dismissal
 * auto-expires and the item resurfaces.
 *
 * Pure by design (no fs, no electron): aios.ts persists the map in
 * `.glass/state.json`; tests feed fabricated maps.
 */

/** key → the change signature the item had when the operator dismissed it. */
export type InboxDismissals = Record<string, string | number>;

/** True while the item is dismissed: a dismissal exists for `key` AND the
 *  item hasn't changed since (`updatedAt` still matches the stored signature).
 *  A changed signature means "it changed again" — no longer dismissed. */
export function isInboxEntityDismissed(
  dismissed: InboxDismissals | undefined | null,
  key: string,
  updatedAt: string | number,
): boolean {
  if (!dismissed || typeof dismissed !== 'object') return false;
  if (!Object.prototype.hasOwnProperty.call(dismissed, key)) return false;
  return String(dismissed[key]) === String(updatedAt);
}

/** Record a dismissal (immutably) — stores the CURRENT signature under the key. */
export function dismissInboxEntity(
  dismissed: InboxDismissals | undefined | null,
  key: string,
  updatedAt: string | number,
): InboxDismissals {
  const base = dismissed && typeof dismissed === 'object' ? dismissed : {};
  return { ...base, [key]: updatedAt };
}

/** Drop dismissals whose item no longer exists — keeps the persisted map from
 *  accreting dead keys forever. Call with the keys of the CURRENT live items. */
export function pruneInboxDismissals(
  dismissed: InboxDismissals | undefined | null,
  liveKeys: Iterable<string>,
): InboxDismissals {
  const out: InboxDismissals = {};
  if (!dismissed || typeof dismissed !== 'object') return out;
  const live = new Set(liveKeys);
  for (const [k, v] of Object.entries(dismissed)) if (live.has(k)) out[k] = v;
  return out;
}
