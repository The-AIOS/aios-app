/**
 * When the running card offers a one-click account swap.
 *
 * The framework owns every number: `claude-switch --availability` says, on each row, where the
 * quota watcher rotates (`rotate_at`), where a surface offers the button (`swap_offer_at`, the
 * threshold minus the framework's own margin) and the operator's pause (`rotation_paused_until`).
 * This file holds no threshold. It reads those fields beside the shared parser (core/accounts,
 * which keeps only the keys it knows) and decides from them.
 *
 * A framework that does not send them yet gets what the App did before: no button. The caller
 * says so once in the App's log, rather than inventing a number.
 */

export interface SwapRule {
  /** Usage (percent) at which the button is offered, per window. */
  offerFiveHour: number;
  offerSevenDay: number;
  /** The operator's pause of the watcher, epoch seconds, or null. */
  pausedUntil: number | null;
}

const pct = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 1 && v <= 100 ? v : null;

/**
 * The rule from the raw `--availability` answer, or null when the framework does not send it.
 * The values are global and repeated per row; a row that disagrees, or lacks them, means the
 * answer is not one this reader understands, and that reads as "not sent", never as a guess.
 */
export function readSwapRule(text: string): SwapRule | null {
  let data: unknown;
  try { data = JSON.parse(text); } catch { return null; }
  if (!Array.isArray(data) || data.length === 0) return null;
  let rule: SwapRule | null = null;
  for (const raw of data) {
    const r = raw as Record<string, unknown> | null;
    const o = (r && typeof r.swap_offer_at === 'object' ? r.swap_offer_at : null) as Record<string, unknown> | null;
    const f = pct(o?.five_hour), s = pct(o?.seven_day);
    if (f === null || s === null) return null;
    const p = r?.rotation_paused_until;
    const paused = typeof p === 'number' && Number.isFinite(p) && p > 0 ? p : null;
    const here: SwapRule = { offerFiveHour: f, offerSevenDay: s, pausedUntil: paused };
    if (rule && (rule.offerFiveHour !== f || rule.offerSevenDay !== s || rule.pausedUntil !== paused)) return null;
    rule = here;
  }
  return rule;
}

export interface SwapOffer {
  showSwap: boolean;
  /** Where the framework would send you; '' when no account can take you. */
  to: string;
  /** Epoch seconds, shown beside the button while the watcher is paused; null otherwise. */
  pausedUntil: number | null;
}

/** Offer the swap at the framework's own usage, only with 2+ accounts. */
export function swapOffer(i: { fiveHour: number; sevenDay: number; accounts: number; rule: SwapRule | null; next: string }): SwapOffer {
  const r = i.rule;
  const show = !!r && i.accounts > 1 && (i.fiveHour >= r.offerFiveHour || i.sevenDay >= r.offerSevenDay);
  return { showSwap: show, to: show ? i.next : '', pausedUntil: show && r ? r.pausedUntil : null };
}
