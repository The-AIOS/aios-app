import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { TIMINGS, decideAfterVerifyMiss } from '../core/sendQueue';

/* THE CROSS-REPO DIFF-GUARD.
 *
 * `aios-app` and `aios-glass` both fulfil requests on the same bus, and contract 2 has them
 * RACE — so a request must behave identically whichever one wins. The two `sendQueue.ts` copies
 * had silently diverged by 248 lines, and `TIMINGS` — the block literally commented "these are
 * CONTRACT, not local tuning" — existed in only ONE of them. The only thing linking the surfaces
 * was a code comment reading `// Glass: MAX_HOLD_MS`.
 *
 * They agreed anyway, because someone hand-copied them. Nothing enforced it.
 *
 * A true diff cannot run here: these are separate repositories, so neither CI can see the other's
 * tree. What CAN travel is a HASH. Both repos record the same digest of the TIMINGS block, so
 * editing the contract in one repo fails that repo's test until the digest is updated — and the
 * digest is a 16-character string a human compares across the two PRs in one glance. It converts
 * silent drift into a visible, deliberate act.
 *
 * WHEN THIS FAILS: you changed TIMINGS. That is allowed — but it is a PROTOCOL change. Make the
 * identical edit in the other repo, recompute, update PROTOCOL_TIMINGS_SHA in BOTH, and update
 * the inbox README's invariants section. All in the same push, or a live fleet runs split-brain.
 */
const PROTOCOL_TIMINGS_SHA = 'ee54bd44cff806e1';

function timingsBlock(): string {
  const src = fs.readFileSync('src/core/sendQueue.ts', 'utf8');
  const m = /export const TIMINGS = \{[\s\S]*?\n\} as const;/.exec(src);
  assert.ok(m, 'the TIMINGS block must exist in this surface — it is the contract');
  return m![0];
}

test('PROTOCOL: the TIMINGS block is byte-identical across both fulfillers', () => {
  const sha = crypto.createHash('sha256').update(timingsBlock()).digest('hex').slice(0, 16);
  assert.equal(sha, PROTOCOL_TIMINGS_SHA,
    'TIMINGS changed. This is a PROTOCOL change: make the same edit in the sibling repo, update this SHA in BOTH, and update the inbox README — in one push.');
});

test('PROTOCOL: the values themselves are the agreed ones', () => {
  // Belt and braces: the hash catches edits, these catch a hash updated without thought.
  assert.equal(TIMINGS.HOLD_STALE_MS, 45 * 60 * 1000);
  assert.equal(TIMINGS.MAX_HOLD_MS, 30 * 60 * 1000);
  assert.equal(TIMINGS.RETIRE_TTL_MS, 10 * 60 * 1000);
  assert.equal(TIMINGS.MAX_RELEASES, 2);
  assert.equal(TIMINGS.MAX_DELIVERY_ATTEMPTS, 3);
  // MAX_HOLD_MS must stay below HOLD_STALE_MS or a claimer gives up after its hold is adoptable.
  assert.ok(TIMINGS.MAX_HOLD_MS < TIMINGS.HOLD_STALE_MS, 'a fulfiller must give up before its claim goes stale');
});

/* AI-66 pt4 — the four-way decision after a delivery that did not verify.
   Pure, so it can be exhaustively tested WITHOUT an extension host or an Electron window —
   which is the whole reason it lives in this module rather than inside each surface's async
   delivery loop, where the bug originally hid in two places at once. */

test('a verify miss on a LIVE target inside the hold budget never retires', () => {
  // The bug: "no sibling left" was read as "undeliverable" and a brief died in 20 seconds
  // with 29m40s of MAX_HOLD_MS unspent. Nothing below may return 'retire' while the target
  // is alive and the clock has not run out.
  for (const releases of [0, 1, 2, 3]) {
    for (const attempts of [0, 1, 2, 3, 9]) {
      const d = decideAfterVerifyMiss({ targetAlive: true, heldMs: 20_000, releases, attempts });
      assert.notEqual(d.do, 'retire', `alive + 20s in must never retire (releases=${releases} attempts=${attempts})`);
    }
  }
});

test('sibling handoffs come first, and are bounded', () => {
  assert.equal(decideAfterVerifyMiss({ targetAlive: true, heldMs: 0, releases: 0, attempts: 0 }).do, 'release');
  assert.equal(decideAfterVerifyMiss({ targetAlive: true, heldMs: 0, releases: 1, attempts: 0 }).do, 'release');
  // spent: must fall through to retrying, NOT to retiring
  assert.equal(decideAfterVerifyMiss({ targetAlive: true, heldMs: 0, releases: TIMINGS.MAX_RELEASES, attempts: 0 }).do, 'retry');
});

test('sends are capped, patience is not', () => {
  const spent = { targetAlive: true, heldMs: 60_000, releases: TIMINGS.MAX_RELEASES };
  assert.equal(decideAfterVerifyMiss({ ...spent, attempts: TIMINGS.MAX_DELIVERY_ATTEMPTS - 1 }).do, 'retry');
  // out of sends but still inside the hold: WAIT. Retrying forever would re-type the message
  // every verify window for 30 minutes — double delivery, which is worse than the delay.
  assert.equal(decideAfterVerifyMiss({ ...spent, attempts: TIMINGS.MAX_DELIVERY_ATTEMPTS }).do, 'wait');
  assert.equal(decideAfterVerifyMiss({ ...spent, attempts: 99 }).do, 'wait');
});

test('only a dead target or a spent hold budget retires a request', () => {
  const dead = decideAfterVerifyMiss({ targetAlive: false, heldMs: 0, releases: 0, attempts: 0 });
  assert.equal(dead.do, 'retire');
  assert.match(dead.reason, /no longer a live session/);
  const timedOut = decideAfterVerifyMiss({ targetAlive: true, heldMs: TIMINGS.MAX_HOLD_MS, releases: 9, attempts: 9 });
  assert.equal(timedOut.do, 'retire');
  assert.match(timedOut.reason, /held for \d+ min/);
  // one millisecond short of the budget is still not a failure
  assert.notEqual(decideAfterVerifyMiss({ targetAlive: true, heldMs: TIMINGS.MAX_HOLD_MS - 1, releases: 9, attempts: 9 }).do, 'retire');
});

test('a dead target beats every other consideration', () => {
  // Ordering matters: no amount of remaining budget makes a vanished session deliverable.
  assert.equal(decideAfterVerifyMiss({ targetAlive: false, heldMs: 0, releases: 0, attempts: 0 }).do, 'retire');
});

test('the delivery cap gates the SEND, not just the log line', () => {
  /* Traced, not assumed: a 'wait' verdict does `continue`, which re-enters the delivery
     branch. A cap enforced only in the after-a-miss decision therefore capped NOTHING — the
     loop would keep re-typing the message for the whole hold budget. The guard must sit
     before the send itself. */
  const src = fs.readFileSync('src/main/commandBus.ts', 'utf8');
  assert.match(src, /attempts >= TIMINGS\.MAX_DELIVERY_ATTEMPTS/, 'the cap must be checked BEFORE delivering');
  const gate = src.indexOf('attempts >= TIMINGS.MAX_DELIVERY_ATTEMPTS');
  const bump = src.indexOf('attempts++', gate);
  assert.ok(gate > 0 && bump > gate, 'the guard must precede the attempt counter, or it runs too late');
});
