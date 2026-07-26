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

export function countUserTurnsContaining(jsonl: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  for (const line of jsonl.split('\n')) {
    if (!line.includes(needle)) continue;   // cheap prefilter before JSON.parse
    let rec: unknown;
    try { rec = JSON.parse(line); } catch { continue; }
    if (!isUserRecord(rec)) continue;       // assistant echoes must not count
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
export function shouldReleaseForSibling(releases: number, maxReleases: number): boolean {
  return releases < maxReleases;
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
