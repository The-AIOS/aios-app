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
 * renderer cannot import it (index.html loads plain scripts), so nothing here may be duplicated
 * there — the renderer receives geometry, it does not compute it. Main owns nothing here; this is
 * shared arithmetic, exercised by tests.
 *
 * WHY NO REPARENTING, EVER. `.pane` is `position: absolute` inside a `position: relative` zone,
 * so tiling is a per-pane `inset` and nothing moves in the DOM. That is not a convenience: moving
 * a pane in the DOM destroys the live terminal inside it.
 */

/** How many panes a zone may show at once. v1 is two; N>2 is deliberately deferred. */
export const MAX_VISIBLE = 2;

/** The gap between two tiled panes, in px — matched to `.pane`'s own 10px inset language. */
export const SPLIT_GAP = 10;

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
 * At MAX_VISIBLE the NON-focused half is replaced rather than refused. Refusing would be the
 * lazier rule and it reads as a broken gesture: the operator asked for this pane to be beside the
 * one they are working in, and "nothing happened" is never the answer they wanted.
 */
export function splitWith(zone: ZoneLayout, beside: number, next: number): ZoneLayout {
  if (next === beside) return zone;
  if (zone.visible.includes(next)) return zone;                 // already up — caller just focuses
  if (zone.visible.length < MAX_VISIBLE) {
    const at = zone.visible.indexOf(beside);
    const visible = at < 0 ? [...zone.visible, next] : [...zone.visible];
    if (at >= 0) visible.splice(at + 1, 0, next);
    return { visible, frac: even(visible.length) };
  }
  /* Full. Replace the half that is NOT focused, keeping the focused pane where it sits so the
     operator's own work does not jump across the screen. */
  const keep = zone.visible.indexOf(beside);
  const visible = keep === 0 ? [beside, next] : [next, beside];
  return { visible, frac: zone.frac.length === visible.length ? [...zone.frac] : even(visible.length) };
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
