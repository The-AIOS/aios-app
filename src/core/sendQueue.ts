/**
 * Spawn-inbox send queue — the pure decisions, ported from the Glass extension's
 * src/core/sendQueue.ts so the two fulfillers provably agree. Names and semantics are
 * kept IDENTICAL on purpose: if these functions ever disagree between surfaces, the
 * protocol is broken, and a diff should be the way to find out.
 *
 * The problem being solved (Glass hit it in production on 2026-07-25): the inbox has two
 * fulfillers and they RACE. A message meant for an IDE session was won by the App, which
 * consumed it (unlink on pickup), could not deliver it there, and left no trace at all.
 *
 * The fix is that the request FILE is the queue:
 *  - It is never deleted on pickup. It is CLAIMED — atomically renamed out of the
 *    watcher's `*.json` glob — and deleted only once delivery is VERIFIED.
 *  - So a race has exactly one winner (rename is atomic), a held message survives a
 *    restart (the claim is recovered), and giving up leaves a visible `.undelivered`
 *    artifact instead of silence.
 *
 * Two rules here must never soften:
 *  1. A BUSY target is never delivered into. Text sent mid-turn is dropped — it does not
 *     queue. When the hold budget runs out we report undeliverable; we do NOT "try
 *     anyway", which was Glass's 0.4.6 bug (the timeout path performed exactly the loss
 *     the gate existed to prevent).
 *  2. "The file is gone" only ever proved pickup. Delivery is proven in the TARGET'S
 *     transcript, by COUNTING occurrences — double delivery is the scariest failure mode
 *     this protocol can produce, so the expected count is exactly 1.
 *
 * Nothing here touches disk — see src/main/commandBus.ts for the IO that uses it.
 */

/** A live session as the registry reports it. */
export interface SendTarget {
  name: string;
  pid: number;
  status: string;
  sessionId: string;
}

export type SendDecision =
  | { do: 'deliver'; pid: number }
  | { do: 'hold'; reason: string }
  | { do: 'undeliverable'; reason: string };

/** Suffixes chosen so neither matches the watcher's `*.json` glob — a claimed or
 *  abandoned request must never be re-picked-up as a new one. */
export const HOLD_SUFFIX = '.holding';
export const UNDELIVERED_SUFFIX = '.undelivered';

export const holdPathFor = (requestPath: string): string => `${requestPath}${HOLD_SUFFIX}`;
export const undeliveredPathFor = (p: string): string =>
  `${p.endsWith(HOLD_SUFFIX) ? p.slice(0, -HOLD_SUFFIX.length) : p}${UNDELIVERED_SUFFIX}`;
export const isHoldPath = (p: string): boolean => p.endsWith(HOLD_SUFFIX);

export const isBusy = (status: string | undefined): boolean =>
  (status || '').trim().toLowerCase() === 'busy';

/**
 * Deliverability is an ALLOWLIST, not "anything that isn't busy".
 *
 * The registry emits more than two statuses — we measured 'shell' on a session mid-Bash —
 * so a denylist silently treats every uncharacterised state as ready, and the cost of being
 * wrong is a dropped message. An allowlist inverts that: an unknown status holds, which
 * costs seconds.
 *
 * 'shell' is on the list because it was MEASURED as safe, not assumed: a message delivered
 * to a session in that state landed as a user turn, and the target itself acknowledged
 * holding it until its background command finished. Glass 0.5.1 allowlists the same two, so
 * both surfaces now agree — add a status here only with a measurement behind it.
 */
const DELIVERABLE_STATUSES = new Set(['idle', 'shell']);
export const isDeliverable = (status: string | undefined): boolean =>
  DELIVERABLE_STATUSES.has((status || '').trim().toLowerCase());

/**
 * Deliver now, keep holding, or give up? A busy target is never delivered to; an expired
 * budget reports undeliverable rather than forcing it through.
 */
export function decideSend(
  target: SendTarget | undefined,
  heldForMs: number,
  maxHoldMs: number,
): SendDecision {
  if (!target) {
    return { do: 'undeliverable', reason: 'no live session by that name in the session registry' };
  }
  if (isDeliverable(target.status)) {
    return { do: 'deliver', pid: target.pid };
  }
  if (heldForMs < maxHoldMs) {
    return { do: 'hold', reason: `'${target.name}' is ${target.status || 'not idle'}` };
  }
  return {
    do: 'undeliverable',
    reason: `'${target.name}' never went idle in ${Math.round(maxHoldMs / 60000)} min (last status '${target.status}') — not delivering into a session that is not ready, it would be dropped silently`,
  };
}

/**
 * A verification needle that survives `.jsonl` encoding: the longest leading run of
 * characters that are NOT escaped inside JSON, so a transcript match can't fail on
 * escaping alone.
 */
export function safeNeedle(text: string): string {
  const m = text.match(/[A-Za-z0-9 ,.\-—:;()!?']{24,}/);
  return (m ? m[0] : text.slice(0, 24)).slice(0, 48);
}

/**
 * Delivery verification, as pure functions — ported from Glass's module of the same names
 * so both sides can be diffed, and so the counting rule is UNIT-TESTED rather than trusted.
 *
 * Why a baseline: the marker appears in the transcript more than once per delivery (measured:
 * 1 user turn + 2 assistant messages quoting it back = 5 raw substring hits). And on a
 * re-attempt — sibling handoff, adopted hold — it is already there from the first try. So
 * presence proves nothing; only an INCREASE in user-turn count proves that THIS attempt landed.
 */
const isUserRecord = (rec: unknown): boolean => {
  if (!rec || typeof rec !== 'object') return false;
  const r = rec as { type?: unknown; message?: { role?: unknown } };
  return r.type === 'user' || r.message?.role === 'user';
};

const recordText = (rec: unknown): string => {
  const c = (rec as { message?: { content?: unknown } }).message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c.map((blk) => (blk && typeof blk === 'object' ? String((blk as { text?: unknown }).text ?? '') : '')).join(' ');
  }
  return '';
};

/**
 * The record's own wall-clock, used to bound counting to OUR attempt.
 *
 * Measured 2026-08-14: 11,152 of 11,152 user records across twelve transcripts carried a
 * parseable ISO `timestamp`. Undefined means the field was absent or unparseable, which the
 * caller treats as NOT-OURS — see the fail-closed note below.
 */
const recordTimeMs = (rec: unknown): number | undefined => {
  const ts = (rec as { timestamp?: unknown }).timestamp;
  if (typeof ts !== 'string') return undefined;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : undefined;
};

/**
 * Count user turns containing `needle` — optionally only those at or after `sinceMs`.
 *
 * WHY `sinceMs` EXISTS, and why its absence was a correctness bug rather than noise.
 *
 * `safeNeedle` returns the first run of >=24 safe characters, or the first 24 characters when
 * there is no such run. A slash command is shorter than that, so for a slash-command send the
 * needle IS THE WHOLE COMMAND — `safeNeedle('/config')` === `'/config'`. That needle identifies
 * the COMMAND, never THIS DELIVERY: measured on real transcripts, 7 of 10 slash-command sends had
 * a needle also present in other user records, one pair of `/config` invocations forty minutes
 * apart and another five hours apart.
 *
 * Both directions were live, and the noisy one was the harmless one:
 *   · FALSE VERIFIED — the dangerous direction. Any other invocation of the same command inside
 *     the verification window raises the count, the bus concludes ITS send landed, and it deletes
 *     the request. Nothing was delivered and nobody is told: a silently lost message, strictly
 *     worse than delivering twice.
 *   · FALSE DUPLICATE — two invocations inside the window read as `now - before > 1`, logging
 *     `DUPLICATE DELIVERY … INVESTIGATE` for a delivery that was perfectly fine. Since the bus
 *     trail became durable this misinformation persists and will mislead the next investigation.
 *
 * Bounding the count to records at or after the claim shrinks the window from the transcript's
 * ENTIRE history to our own hold — seconds or minutes instead of hours or days.
 *
 * FAIL CLOSED on a missing timestamp: a record we cannot place in time is not counted as ours.
 * The asymmetry is deliberate and matches `DELIVERABLE_STATUSES` — counting it could mean a
 * silent loss, while not counting it means a retry and, at worst, a LOUD `.undelivered` the
 * operator can see. Prefer the noisy failure to the quiet one.
 *
 * WHAT THIS DOES NOT FIX: someone invoking the same slash command inside our own hold window is
 * still indistinguishable, because the needle cannot be made unique without altering the text we
 * type, and a slash command with a marker appended is no longer that slash command.
 */
export function countUserTurnsContaining(jsonl: string, needle: string, sinceMs?: number): number {
  if (!needle) return 0;
  let n = 0;
  for (const line of jsonl.split('\n')) {
    if (!line.includes(needle)) continue;   // cheap prefilter before JSON.parse
    let rec: unknown;
    try { rec = JSON.parse(line); } catch { continue; }
    if (!isUserRecord(rec)) continue;       // assistant echoes must not count
    if (sinceMs !== undefined) {
      const t = recordTimeMs(rec);
      if (t === undefined || t < sinceMs) continue;   // not ours, or unplaceable in time
    }
    if (recordText(rec).includes(needle)) n++;
  }
  return n;
}

/** Verdict for a verification poll, given the baseline taken BEFORE delivering. */
export type VerifyVerdict = 'pending' | 'verified' | 'duplicate';

export function verifyVerdict(before: number, now: number): VerifyVerdict {
  if (now <= before) return 'pending';
  return now - before > 1 ? 'duplicate' : 'verified';
}

/* ══════════════════════════════════════════════════════════════════════════════
   CONTRACT 2 — the multi-fulfiller protocol
   Claim-by-rename makes a race SAFE but not ADDRESSABLE, and it opens three new ways to
   be wrong: stealing another surface's live hold, failing a request a sibling could have
   delivered, and letting a request for an absent surface rot forever. Contract 2 closes
   all four. It is ADDITIVE — a request with no `surface` behaves exactly as contract 1.
   ══════════════════════════════════════════════════════════════════════════════ */

export const INBOX_CONTRACT = 2;

/* ── Protocol TIMINGS — these are CONTRACT, not local tuning ──────────────────
   Every fulfiller must use the same four numbers, because they decide *cross-process
   ownership*. Measured by the AIOS App on 2026-07-25: with Glass holding at 45 min and
   the App at 15, there is a 30-minute window where Glass believes it owns a hold the App
   considers stale and adopts — and BOTH deliver. That is the double delivery contract 2
   exists to prevent, reachable with neither implementation wrong on its own terms.
   Change these only in lockstep across every fulfiller, and update the inbox README so
   the next one inherits them. */
export const TIMINGS = {
  /** A `.holding` older than this may be adopted even if its claimer still lives. */
  HOLD_STALE_MS: 45 * 60 * 1000,
  /** How long a fulfiller waits for a target to become deliverable before giving up. */
  MAX_HOLD_MS: 30 * 60 * 1000,
  /** A request addressed to a surface that never took it is retired after this. */
  RETIRE_TTL_MS: 10 * 60 * 1000,
  /** Sibling-window handoffs before a request is declared undeliverable. */
  MAX_RELEASES: 2,
  /** How many times a fulfiller may actually TYPE a message before it stops re-sending and
   *  only watches for a late arrival. Bounded because double delivery is the worst outcome
   *  this protocol can produce — explicitly worse than latency. Exhausting it is NOT a
   *  failure: the fulfiller keeps waiting out MAX_HOLD_MS in silence. */
  MAX_DELIVERY_ATTEMPTS: 3,
} as const;

/** Which fulfiller a request is addressed to. Absent → any (contract-1 behaviour). */
export type Surface = 'glass' | 'app';

export const isSurface = (v: unknown): v is Surface => v === 'glass' || v === 'app';

/** This build's identity as a fulfiller. */
export const MY_SURFACE: Surface = 'app';

/** Who holds a claimed request — embedded in the held file, so the claim is
 *  self-describing and any `.undelivered` artifact carries forensics. */
export interface ClaimStamp {
  surface: Surface;
  pid: number;
  at: number;
}

export function parseClaim(raw: unknown): ClaimStamp | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const c = raw as Record<string, unknown>;
  if (!isSurface(c.surface) || typeof c.pid !== 'number' || typeof c.at !== 'number') return undefined;
  return { surface: c.surface, pid: c.pid, at: c.at };
}

/**
 * May THIS fulfiller take this request at all?
 *
 * - `skip`   → addressed elsewhere and still fresh: leave it COMPLETELY alone (the
 *              addressee may be starting up).
 * - `retire` → addressed elsewhere, older than the TTL, nobody took it. Any surface may
 *              retire it, so fulfilment is targeted while retirement is shared and
 *              nothing rots silently.
 * - `claim`  → ours, or unaddressed.
 */
export function claimVerdict(
  requestedSurface: unknown,
  mySurface: Surface,
  ageMs: number,
  ttlMs: number,
): 'claim' | 'skip' | 'retire' {
  if (!isSurface(requestedSurface) || requestedSurface === mySurface) return 'claim';
  return ageMs >= ttlMs ? 'retire' : 'skip';
}

/**
 * We found a `.holding` file on startup. Orphan to resume, or a hold another live
 * process is actively waiting on? Adopting a fresh claim held by a live process IS the
 * cross-surface double-delivery bug, so only adopt when the holder is demonstrably gone
 * or the hold outlived any legitimate wait.
 */
export function canAdoptHold(
  claim: ClaimStamp | undefined,
  nowMs: number,
  staleMs: number,
  claimerAlive: boolean,
): boolean {
  if (!claim) return true;              // unstamped (contract-1 era) → adoptable
  if (!claimerAlive) return true;       // holder died mid-wait → resume it
  return nowMs - claim.at >= staleMs;   // live holder, but the hold is stale
}

/**
 * We claimed it but cannot reach the target's terminal — a SIBLING (the other surface, or
 * another window) might. Releasing the claim back to `*.json` is very different from
 * declaring the message undeliverable. Bounded, so two fulfillers can't ping-pong it.
 */
export function shouldReleaseForSibling(releases: number, maxReleases: number = TIMINGS.MAX_RELEASES): boolean {
  /* The bound now DEFAULTS to the contract value instead of relying on every caller to pass
     the right one. It was a required parameter, which meant this pure, fully unit-tested
     function did not own the number that decides cross-process behaviour — so both surfaces
     could pass different values and both test suites would still be green. That is the exact
     shape of every failure in this ticket: a check that is correct about something nobody
     verified. Callers may still override for tests; production passes nothing. */
  return releases < maxReleases;
}

/* ── After a delivery that did not verify: FOUR states, not two ───────────────
   This was imperative and duplicated, and both copies got it wrong the same way: they
   collapsed "no sibling left to try" into "undeliverable" and retired the request. A brief
   died twenty seconds after being claimed, with 29m40s of MAX_HOLD_MS unspent, because the
   target was merely busy — the exact case the hold budget exists for.

   It lives here, pure, for the reason every other value in this file does: a decision that
   governs cross-process behaviour cannot be re-derived correctly in two codebases by hand.
   Both surfaces call this and therefore agree by construction rather than by discipline.

     retire   the target is gone, or the hold budget really is spent — a true failure
     release  another window may own that terminal; hand the claim back (bounded)
     retry    we still have sends left; deliver again
     wait     out of sends but NOT out of time — keep watching for a late arrival,
              and never type again. Bounded sends, unbounded patience: double delivery
              is worse than latency, so exhausting the retries must not end the wait. */
/* No 'release'. It was removed on 2026-08-12 rather than left unreachable: a type that says a
   decision CAN hand an already-typed message to a sibling invites a caller to handle that case,
   and handling it is the double-delivery bug. Release still exists in the protocol — it just
   belongs to the "could not type it here" path, which never reaches this decision. */
export type MissAction = 'retire' | 'retry' | 'wait';

export function decideAfterVerifyMiss(s: {
  targetAlive: boolean;
  /**
   * The target is mid-turn. It has not had the OPPORTUNITY to write the turn yet, so a missing
   * transcript entry says nothing about whether the text arrived.
   */
  targetBusy: boolean;
  heldMs: number;
  attempts: number;
}): { do: MissAction; reason: string } {
  if (!s.targetAlive) return { do: 'retire', reason: 'the target is no longer a live session' };
  if (s.heldMs >= TIMINGS.MAX_HOLD_MS) {
    return { do: 'retire', reason: `held for ${Math.round(s.heldMs / 60000)} min without the message ever appearing in the target transcript` };
  }
  /* THE 2026-08-12 BUG, half one — a busy target at VERIFY time proves nothing.
     `decideSend` refuses to type into a non-deliverable session, so a send only happens while the
     status is deliverable. The target can then go busy during the verification window, and a
     session that is mid-turn has not written the incoming turn to its transcript yet. So an empty
     transcript here distinguishes nothing, and acting on it re-types a message that may already
     have arrived.
     MEASURED, not inferred: one `/aios:close-session --auto` reached a busy session FOUR times
     (~2 min apart, no operator typing), while two IDLE targets in the same minutes verified and
     consumed on the first try. That contrast is the evidence; the precise fate of mid-turn text is
     NOT something this was able to establish — note rule 1 in this file's header, which says such
     text is dropped rather than queued. Waiting is the correct action under either reading: if it
     queued, the turn appears and we consume; if it was dropped, the target goes idle and the
     bounded retry below re-sends it once. What is never correct is concluding failure — or handing
     it to a sibling — while the target has had no chance to answer. */
  if (s.targetBusy) {
    return { do: 'wait', reason: 'target went busy during verification — an empty transcript proves nothing yet' };
  }
  /* THE 2026-08-12 BUG, half two — `release` used to be FIRST here, and it is now gone entirely.
     Reaching this function means we already TYPED the message successfully (a surface that could
     not type it returns !ok and releases on that path, which is the case release was built for —
     see the AI-67 comment in commandBus.runSend). Handing an already-typed request to a sibling
     asks a second surface to type it AGAIN: double delivery, the one outcome this protocol calls
     explicitly worse than latency. And with a single fulfiller running there is no sibling at all,
     so the request came straight back to the same App, which re-typed it and burned a release —
     twice, to MAX_RELEASES, one step from retiring work that had already been done as a FALSE dead
     letter. `releases` is therefore no longer read here: after a successful type, the sibling
     budget is irrelevant to what we do next. */
  if (s.attempts < TIMINGS.MAX_DELIVERY_ATTEMPTS) {
    return { do: 'retry', reason: `not verified and the target is idle; re-delivering (attempt ${s.attempts + 1}/${TIMINGS.MAX_DELIVERY_ATTEMPTS})` };
  }
  return { do: 'wait', reason: 'out of send attempts but still inside the hold budget — watching for a late arrival' };
}


/**
 * Never DOWNGRADE a README that declares a HIGHER contract than we implement — a newer
 * fulfiller's doc is the accurate one, and stomping it would replace correct instructions
 * with stale ones. (The App additionally defers to Glass at equal contract; see
 * inboxReadme.shouldWrite.)
 */
export function shouldWriteDoc(existing: string | undefined, ourContract: number, ours: string): boolean {
  if (!existing || !existing.trim()) return true;
  const m = /aios-spawn-inbox: contract\s+(\d+)/i.exec(existing);
  if (m && Number(m[1]) > ourContract) return false;
  return existing.trim() !== ours.trim();
}
