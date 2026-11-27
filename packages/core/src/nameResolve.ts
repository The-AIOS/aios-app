/**
 * Which live session a name means, with the answer a bus request needs: ONE, NONE, or AMBIGUOUS.
 *
 * `nameMatch` already decides how a written name maps onto a registered one (exact first, else
 * the one session whose name cleans to the same handle). What it cannot say is WHY it found
 * nothing: "nobody answers to that name" and "two sessions do" both came back as `undefined`, and
 * each surface then handled the second case its own way. One delivered to whichever session the
 * registry listed first. One refused a send in its window and, for a kill, found no target and
 * retired the request as done. For a spawn of a name that two sessions answered to in different
 * capitals, "no target" meant "not running yet", so a third session was started.
 *
 * So the verdict is explicit, and a surface that uses it refuses `ambiguous` for every verb,
 * naming the sessions that answer: a message typed into the wrong session, or the wrong session killed, is
 * worse than a request that comes back saying which names collided.
 *
 * The list passed in is the live registry AS IT IS, one entry per session, duplicates included:
 * two sessions registered under the very same name are ambiguous too, and a list of distinct
 * names would hide exactly that case. Pure.
 */
import { sessionKey } from './nameMatch';

/** A request's `name`, cleaned to the handle the bus uses: lowercase kebab, no edge hyphens. */
export function sanitizeName(raw: unknown): string {
  return sessionKey(raw);
}

export type NameVerdict =
  | { kind: 'one'; name: string }
  | { kind: 'none' }
  | { kind: 'ambiguous'; names: string[] };

/* The resolved name flows into terminal commands and pane lookups, so only a name made of safe
   characters is ever returned (the same rule as nameMatch). */
const SAFE = /^[A-Za-z0-9._-]+$/;

export function resolveName(want: string, live: readonly string[]): NameVerdict {
  const safe = live.filter((n) => SAFE.test(n));
  const exact = safe.filter((n) => n === want);
  if (exact.length === 1) return { kind: 'one', name: want };
  if (exact.length > 1) return { kind: 'ambiguous', names: exact };
  const k = sessionKey(want);
  if (!k) return { kind: 'none' };
  const hits = safe.filter((n) => sessionKey(n) === k);
  if (hits.length === 0) return { kind: 'none' };
  if (hits.length === 1) return { kind: 'one', name: hits[0] };
  return { kind: 'ambiguous', names: hits };
}

function collided(want: string, names: readonly string[]): string {
  const shown = [...new Set(names)];
  return shown.length === 1
    ? `${names.length} live sessions are named '${shown[0]}'`
    : `${names.length} live sessions answer to '${want}' (${shown.map((n) => `'${n}'`).join(', ')})`;
}

/** The sentence a dead letter carries when a name is ambiguous. One wording, both surfaces. */
export function ambiguousReason(want: string, names: readonly string[]): string {
  return `${collided(want, names)}, so this request was not delivered to any of them — rename one, or address it by a name only one session has`;
}

/**
 * The same, for a send whose text was ALREADY typed once when the name became ambiguous. It may
 * have arrived: saying "not delivered" would be false, and a dead letter is work still owed, so
 * the sender would send it again on top of a copy that landed.
 */
export function ambiguousAfterTypedReason(want: string, names: readonly string[]): string {
  return `typed once into '${want}', and before it could be verified ${collided(want, names)}, so it cannot be told which one has it. It MAY have been delivered: check before sending it again`;
}
