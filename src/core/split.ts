/**
 * Split view — the pure part (AI-82).
 *
 * A zone used to show exactly one pane. `setVisible(z)` decided it with one line:
 *
 *     const on = pid === act;      // ← the entire limitation
 *
 * so the window's ceiling was one terminal plus one editor, and an operator running four named
 * agents met that ceiling constantly. *Watch one work while driving another* is the posture the
 * whole product assumes, which makes this a missing half of the premise rather than a feature.
 *
 * WHAT THIS FILE IS. The visible SET and its fractions, and the geometry derived from them — as
 * data, with no DOM. It exists so the arithmetic that decides where a pane sits can be tested
 * without a window, and so the renderer keeps only the parts that must touch elements. The
 * renderer cannot import it (index.html loads plain scripts), so it MIRRORS the ten lines of
 * geometry — and src/test/split.test.ts reads both sides and fails if either moves, the same
 * arrangement as the busy classifier. Forced duplication, guarded rather than pretended away.
 *
 * WHY NO REPARENTING, EVER. `.pane` is `position: absolute` inside a `position: relative` zone,
 * so tiling is a per-pane `inset` and nothing moves in the DOM. That is not a convenience: moving
 * a pane in the DOM destroys the live terminal inside it.
 */

/**
 * Sane ceiling on panes per zone — but the REAL limit is width, see fitsAnother().
 *
 * The spec deferred N>2 because each extra pane "roughly doubles the work". That was written
 * before the geometry existed and it did not hold: `boxes()` loops the visible list with
 * fractions and `setVisible` shows a set, so both were already N-general. The only things
 * enforcing two were this constant and the replace-at-capacity rule — and the operator reported
 * that rule AS the bug: with three tabs, splitting evicted a pane by a policy that looks
 * arbitrary from outside. Raising the ceiling removes a reported defect rather than adding risk.
 *
 * A count-based cap is the wrong instrument either way: it wastes a 34" monitor and ruins a
 * laptop. So this is a ceiling and `fitsAnother()` is the gate.
 */
export const MAX_VISIBLE = 3;

/** The gap between tiled panes, in px — matched to `.pane`'s own 10px inset language. */
export const SPLIT_GAP = 10;

/**
 * Narrowest a tiled pane may get, in px — **~30 columns, measured**, not the ~40 first claimed.
 *
 * Below this a TUI wraps into nonsense, which is worse than not splitting: the operator asked to
 * see two things and would get two things they cannot read.
 *
 * The number is now anchored to a measurement rather than an estimate, because the estimate was
 * wrong and a wrong stated rationale is how a constant gets "corrected" in the wrong direction
 * later. Measured in a live window (`--eval`, three tiled panes in a 747px zone): each pane came
 * out 234px wide and xterm reported **21 columns** — so a pane spends ~24px on padding and border
 * and ~10px per column. 320px is therefore ~30 columns, and 40 columns would need ~424px.
 *
 * It stays at 320 deliberately. Raising it to a true 40 columns would refuse the TWO-pane split on
 * any zone under ~858px — including windows where that split is in daily use and perfectly
 * readable. A floor exists to block the unreadable, not to enforce a comfortable ideal.
 */
export const MIN_PANE_PX = 320;

/**
 * Would one more pane still leave every pane usable in a zone this wide?
 *
 * `zoneWidth` is measured by the caller, never assumed — the answer differs between a laptop and
 * a large monitor, and hardcoding either is how a feature works for its author and nobody else.
 */
export function fitsAnother(count: number, zoneWidth: number): boolean {
  if (count >= MAX_VISIBLE) return false;
  const next = count + 1;
  const usable = zoneWidth - SPLIT_GAP * (next - 1);
  return usable / next >= MIN_PANE_PX;
}

export interface ZoneLayout {
  /** Visible pane ids, left to right. Length 1 = unsplit. Never longer than MAX_VISIBLE. */
  visible: number[];
  /** One fraction per visible pane, summing to 1. */
  frac: number[];
}

/** A pane's computed box, as CSS `inset` components. `null` = use the stylesheet's own inset. */
export interface PaneBox { left: string; right: string }

export function unsplit(id: number): ZoneLayout {
  return { visible: [id], frac: [1] };
}

/**
 * Open `next` beside `beside`, or focus it if it is already visible.
 *
 * With no room left, a pane is replaced rather than the gesture refused. Refusing would be the
 * lazier rule and it reads as a broken gesture: the operator asked for this pane to be beside the
 * one they are working in, and "nothing happened" is never the answer they wanted.
 */
export function splitWith(zone: ZoneLayout, beside: number, next: number, room: boolean): ZoneLayout {
  if (next === beside) return zone;
  if (zone.visible.includes(next)) return zone;                 // already up — caller just focuses
  /* `room` is the caller's MEASURED answer from fitsAnother(). Passed in rather than decided here,
     so this file carries no assumption about how wide the operator's window is. */
  if (room) {
    const at = zone.visible.indexOf(beside);
    const visible = at < 0 ? [...zone.visible, next] : [...zone.visible];
    if (at >= 0) visible.splice(at + 1, 0, next);
    return { visible, frac: even(visible.length) };
  }
  /* No room. Replace the pane FURTHEST from the focused one and keep the focused pane where it
     sits: the operator's own work must not jump, and evicting its immediate neighbour would
     shuffle the arrangement more than the request needs. */
  const keep = zone.visible.indexOf(beside);
  const drop = keep === 0 ? zone.visible.length - 1 : 0;
  const visible = zone.visible.map((v, i) => (i === drop ? next : v));
  return { visible, frac: even(visible.length) };
}

/**
 * A pane closed or died. Returns the zone without it, re-evening what remains.
 *
 * An empty result is legitimate — the caller decides what an empty zone shows — so this does not
 * invent a replacement. Inventing one here is how a closed pane silently resurrects something.
 */
export function withoutPane(zone: ZoneLayout, id: number): ZoneLayout {
  const visible = zone.visible.filter((v) => v !== id);
  if (visible.length === zone.visible.length) return zone;
  return { visible, frac: even(visible.length) };
}

/** Drop ids that no longer exist — restoring a persisted split after a restart. */
export function reconcile(zone: ZoneLayout, alive: (id: number) => boolean): ZoneLayout {
  const visible = zone.visible.filter(alive);
  if (visible.length === zone.visible.length) return zone;
  return { visible, frac: even(visible.length) };
}

function even(n: number): number[] {
  return n <= 0 ? [] : Array.from({ length: n }, () => 1 / n);
}

/**
 * Where each visible pane sits, as `left`/`right` CSS values.
 *
 * Only the horizontal axis is computed: `top` and `bottom` stay with the stylesheet, so a pane in
 * an unsplit zone needs no inline geometry at all and the split cannot drift from `.pane`'s own
 * vertical inset. `edge` is that stylesheet's horizontal inset (10px), passed in rather than
 * hardcoded so the two cannot disagree silently.
 *
 * Returns `null` for an unsplit zone — the signal to CLEAR inline geometry rather than to write a
 * full-width box, which would pin a value the stylesheet should own.
 */
export function boxes(zone: ZoneLayout, edge = SPLIT_GAP): PaneBox[] | null {
  if (zone.visible.length <= 1) return null;
  const gap = SPLIT_GAP;
  const out: PaneBox[] = [];
  let acc = 0;
  for (let i = 0; i < zone.visible.length; i++) {
    const f = zone.frac[i] ?? 1 / zone.visible.length;
    const startPct = acc * 100;
    const endPct = (acc + f) * 100;
    /* Half a gap is taken from each side of an interior edge, so the two panes are `gap` apart and
       the pair still spans exactly the zone minus its outer `edge` inset. Written as calc() so it
       survives a zone resize without recomputation — the split has no width of its own to stale. */
    const left = i === 0 ? `${edge}px` : `calc(${startPct}% + ${gap / 2}px)`;
    const right = i === zone.visible.length - 1 ? `${edge}px` : `calc(${100 - endPct}% + ${gap / 2}px)`;
    out.push({ left, right });
    acc += f;
  }
  return out;
}

/** Is this zone showing more than one pane? */
export function isSplit(zone: ZoneLayout): boolean {
  return zone.visible.length > 1;
}

/**
 * Sanitise a persisted zone. Anything unusable becomes a single-pane zone rather than throwing —
 * a corrupt layout must not stop the window opening, and `localStorage` is operator-writable.
 */
export function parseZone(raw: unknown, fallback: number | null): ZoneLayout {
  const j = (raw ?? {}) as { visible?: unknown; frac?: unknown };
  const visible = Array.isArray(j.visible)
    ? j.visible.filter((v): v is number => typeof v === 'number' && Number.isFinite(v)).slice(0, MAX_VISIBLE)
    : [];
  if (!visible.length) return fallback === null ? { visible: [], frac: [] } : unsplit(fallback);
  const frac = Array.isArray(j.frac)
    ? j.frac.filter((v): v is number => typeof v === 'number' && v > 0 && v < 1)
    : [];
  /* Fractions are trusted only if there is one per pane AND they sum to ~1. A half-written array
     would otherwise tile two panes into 30% of the zone with the rest blank. */
  const sum = frac.reduce((a, b) => a + b, 0);
  const usable = frac.length === visible.length && Math.abs(sum - 1) < 0.01;
  return { visible, frac: usable ? frac : even(visible.length) };
}
