import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { TIMINGS } from '../core/sendQueue';

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
