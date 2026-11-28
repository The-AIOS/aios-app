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

/* ── The stored rotation setting (#430) ───────────────────────────────────────────────────────────
   Where the watcher rotates and whether it rotates on its own are one setting, owned by the framework
   (`claude-identity.sh rotation`), which the Settings tab shows and edits. The App writes no file and
   keeps no number: it reads the setting from `--availability` (`rotation_setting`, global, repeated per
   row) and changes it through the framework's command. A framework that does not send it has no such
   command either, so the editor is offered only when it is sent. */

export type RotationSource = 'default' | 'file' | 'environment';
export interface RotationValue<T> { value: T; source: RotationSource }
export interface RotationSetting {
  fiveHour: RotationValue<number>;
  sevenDay: RotationValue<number>;
  enabled: RotationValue<boolean>;
  /** The range the framework accepts for a stored value. */
  min: number;
  max: number;
  /** Values the framework found and refused, in its words. */
  ignored: string[];
}

const SOURCES: readonly string[] = ['default', 'file', 'environment'];
const intIn = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;

function readRotationRow(raw: unknown): RotationSetting | null {
  const r = raw as Record<string, unknown> | null;
  const s = (r && typeof r.rotation_setting === 'object' ? r.rotation_setting : null) as Record<string, unknown> | null;
  if (!s) return null;
  const val = (k: string, ok: (v: unknown) => boolean): RotationValue<never> | null => {
    const o = s[k] as Record<string, unknown> | null;
    return o && typeof o === 'object' && ok(o.value) && typeof o.source === 'string' && SOURCES.includes(o.source)
      ? { value: o.value as never, source: o.source as RotationSource } : null;
  };
  const min = s.min, max = s.max;
  if (!intIn(min, 1, 100) || !intIn(max, min, 100)) return null;
  /* The environment keeps its own range (1-100), so a value in force may sit outside min-max. */
  const f = val('five_hour', (v) => intIn(v, 1, 100)), w = val('seven_day', (v) => intIn(v, 1, 100));
  const e = val('enabled', (v) => typeof v === 'boolean');
  if (!f || !w || !e) return null;
  const ignored = Array.isArray(s.ignored) ? s.ignored.filter((x): x is string => typeof x === 'string').map((x) => x.slice(0, 300)) : [];
  return { fiveHour: f, sevenDay: w, enabled: e, min, max, ignored };
}

/** The setting from the raw `--availability` answer, or null when the framework does not send it (or rows disagree). */
export function readRotationSetting(text: string): RotationSetting | null {
  let data: unknown;
  try { data = JSON.parse(text); } catch { return null; }
  if (!Array.isArray(data) || data.length === 0) return null;
  let first: RotationSetting | null = null;
  for (const raw of data) {
    const here = readRotationRow(raw);
    if (!here) return null;
    if (first && JSON.stringify(first) !== JSON.stringify(here)) return null;
    first = here;
  }
  return first;
}

/** The answer of `claude-identity.sh rotation [--set]`: the setting itself, not a list. */
export function readRotationAnswer(text: string): RotationSetting | null {
  let data: unknown;
  try { data = JSON.parse(text); } catch { return null; }
  return readRotationRow({ rotation_setting: data });
}

export interface RotationChange { fiveHour?: number; sevenDay?: number; enabled?: boolean }

/**
 * The arguments for `claude-identity.sh rotation --set`, or an error. Checked against the range the
 * framework itself reported, so nothing it would refuse is sent; it still validates on its side.
 */
export function rotationSetArgs(change: RotationChange, setting: RotationSetting | null): { args: string[] } | { error: string } {
  if (!setting) return { error: 'the framework does not offer this setting; update it' };
  const args: string[] = [];
  for (const [k, flag] of [['fiveHour', '5h'], ['sevenDay', '7d']] as const) {
    const v = change[k];
    if (v === undefined) continue;
    if (!intIn(v, setting.min, setting.max)) return { error: `${flag}: a whole number from ${setting.min} to ${setting.max}` };
    args.push(`${flag}=${v}`);
  }
  if (change.enabled !== undefined) {
    if (typeof change.enabled !== 'boolean') return { error: 'on or off' };
    args.push(change.enabled ? 'on' : 'off');
  }
  return args.length ? { args } : { error: 'nothing to change' };
}
