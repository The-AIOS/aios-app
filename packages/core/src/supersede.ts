/**
 * Review nit — a superseded message must leave something the SENDER can see. It used to be
 * deleted, which from outside is indistinguishable from a delivery: the file vanished either way.
 * Now it is moved to the inbox's `_archive/` as `<name>.json.superseded`, stamped with what replaced
 * it — beside the archived dead letters, out of the live inbox, so nothing re-reads it as a request.
 * Pure: names and stamps only; each surface does the move and the pruning.
 */
export const SUPERSEDED_SUFFIX = '.superseded';
export const SUPERSEDED_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

/** `buddai-fix.json.holding` → `buddai-fix.json.superseded` (the archive's file name). */
export function supersededName(heldBasename: string): string {
  return heldBasename.replace(/\.holding$/, '') + SUPERSEDED_SUFFIX;
}

/** The archived body: the request as written, plus why it was not delivered. */
export function supersededBody(body: Record<string, unknown>, by: string, surface: string, nowMs: number): Record<string, unknown> {
  return { ...body, _superseded: { by, at: nowMs, surface, reason: 'a newer message from the same sender replaced it before delivery' } };
}
