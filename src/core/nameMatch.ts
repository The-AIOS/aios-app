/**
 * Which LIVE session a request means, by name. Requests are cleaned to lowercase kebab, but a session
 * can be registered with capitals (`claude --name Market-desk`), so an exact match missed it and the
 * request dead-lettered as "no such session" (reported in app#58). Shared core (App + Glass).
 *
 * The rule: an exact match wins; otherwise the ONE live session whose name cleans to the same handle.
 * Two live sessions that clean to the same handle are ambiguous, so neither is picked — a message
 * typed into the wrong session is worse than one that is refused and says why. Pure.
 */
export function sessionKey(name: unknown): string {
  return String(name ?? '').trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/^-+|-+$/g, '');
}

/* The resolved name flows into terminal commands and pane lookups, so only a name made of safe
   characters can be returned. A registry name is written by whoever started the session; one with
   shell metacharacters (`x; rm -rf ~`) must never be handed on — the cleaned name is used instead. */
const SAFE = /^[A-Za-z0-9._-]+$/;

export function resolveSessionName(want: string, live: readonly string[]): string | undefined {
  const safe = live.filter((n) => SAFE.test(n));
  if (safe.includes(want)) return want;
  const k = sessionKey(want);
  if (!k) return undefined;
  const hits = [...new Set(safe.filter((n) => sessionKey(n) === k))];
  return hits.length === 1 ? hits[0] : undefined;
}

/**
 * app#65 — a session renamed after it started keeps its earlier names in the registry
 * (`formerNames`). A kill addressed to the old name found no live session and reported
 * "no live pid; pane close only" while the process lived on. The current name always wins; this
 * is only the fallback, and only when exactly ONE live session ever carried that name.
 */
export function resolveFormerName(want: string, live: readonly { name: string; formerNames?: readonly string[] }[]): string | undefined {
  const k = sessionKey(want);
  if (!k) return undefined;
  const hits = [...new Set(live.filter((a) => SAFE.test(a.name) && (a.formerNames ?? []).some((f) => sessionKey(f) === k)).map((a) => a.name))];
  return hits.length === 1 ? hits[0] : undefined;
}
