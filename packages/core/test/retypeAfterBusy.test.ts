import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countDeliveries } from '../src/sendQueue';
import { landedBeforeRetype } from '../src/sendGuards';

/* 26 Oct 2026: one send, a target that went busy during verification, then a second copy typed
   once it was idle again although the first had landed. Built from the shape of that transcript. */
const turn = (text: string, ts: string) =>
  JSON.stringify({ type: 'user', timestamp: ts, message: { role: 'user', content: text } });
const MSG = '[queued 2 min ago] fortress 09:16: no rerun needed. The run ledger is UP';

test('a copy that landed while the target was busy stops the re-type', () => {
  const claimed = Date.parse('2026-10-26T08:16:00Z');
  const before = countDeliveries('', MSG, MSG.slice(0, 40), claimed);           // empty at the first type
  const later = turn(MSG, '2026-10-26T08:16:54Z');                               // written once its turn ended
  const now = countDeliveries(later, MSG, MSG.slice(0, 40), claimed);
  assert.equal(before, 0);
  assert.equal(now, 1);
  assert.equal(landedBeforeRetype(true, before, now), true);
});

test('nothing landed: the re-type goes ahead', () => {
  assert.equal(landedBeforeRetype(true, 0, 0), false);
});

test('the first type is never skipped, whatever the transcript holds', () => {
  assert.equal(landedBeforeRetype(false, 0, 1), false);
});
