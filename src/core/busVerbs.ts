/**
 * THE VERB SET — the one rule both fulfillers must agree on, byte-identical in both repos.
 *
 * The App and Glass are two independent implementations of one protocol (there is no Glass
 * inside the App), and they have silently diverged before — by 248 lines. What cannot diverge is
 * the DECISION: given a request's `action` string, which verb runs. So the decision lives here,
 * in a file that is copied verbatim rather than reimplemented, and `protocolContract.test.ts`
 * hashes it on both sides — a verb added, renamed or dropped on one surface alone goes red.
 *
 * WHEN THAT TEST FAILS: you changed the protocol. That is allowed. Make the identical edit in the
 * sibling repo, update VERBS_SHA in BOTH, and update the spawn-inbox README — in one push.
 *
 * THE ABSENT/UNKNOWN SPLIT is the load-bearing part. An ABSENT action means spawn, because
 * contract-1 requests are plain `{name, task}` and there are still some in the wild. A WRITTEN
 * action must be a verb we implement: since `resume` arrived (AI-149), spawn and resume hand back
 * different things — a fresh something versus the same someone — so degrading an unrecognised
 * verb to spawn would answer `{"action":"resmue"}` with a duplicate of the very session the
 * caller asked to reopen. Absent is back-compat; unrecognised is a typo. They are not the same
 * input and must not get the same answer.
 */

/** Every verb a fulfiller implements. */
export const BUS_VERBS = ['spawn', 'kill', 'send', 'resume'] as const;
export type BusVerb = (typeof BUS_VERBS)[number];

/** A verb that was written but is not implemented. Never silently coerced to a real one. */
export type BusVerbResult = BusVerb | 'unknown';

/**
 * Read a request's `action` field. Absent, non-string or blank → 'spawn' (contract-1).
 * Case and surrounding space are not significant. Anything else unrecognised → 'unknown',
 * which every fulfiller must dead-letter naming the verb as written.
 */
export function normalizeVerb(raw: unknown): BusVerbResult {
  const written = (typeof raw === 'string' ? raw : '').trim().toLowerCase();
  if (!written) return 'spawn';
  return (BUS_VERBS as readonly string[]).includes(written) ? (written as BusVerb) : 'unknown';
}
