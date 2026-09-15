/**
 * Who owns the presence record — the decision both surfaces share (`core/presence`).
 *
 * The bug these tests exist for shipped in BOTH repos, written independently, each defended by a
 * comment claiming the case was handled. Ownership was enforced where a process LEAVES and not
 * where it ARRIVES, so the record belonged to whoever wrote last rather than to whoever was
 * alive — and a second instance that started late and quit early took the record with it while
 * the first was still running and still fulfilling spawns.
 *
 * These are pure: a verdict from (record, me, who is alive). No filesystem, no clock, no pids
 * that have to exist. The orderings that produced the outage are just three of the rows.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePresenceRecord, presenceVerdict, mayRetract } from '../core/presence';

const ALIVE = (...pids: number[]) => (p: number): boolean => pids.includes(p);
const NOBODY = (): boolean => false;

/** What a surface actually does with a verdict: claim by writing itself in, or leave it be. */
type Rec = { pid?: number } | undefined;
const apply = (rec: Rec, me: number, alive: (p: number) => boolean): Rec =>
  presenceVerdict(rec, me, alive) === 'claim' ? { pid: me } : rec;

test('parsePresenceRecord: absent, malformed and non-object all mean "no record"', () => {
  assert.equal(parsePresenceRecord(undefined), undefined, 'no file');
  assert.equal(parsePresenceRecord(''), undefined, 'empty file — a truncated write');
  assert.equal(parsePresenceRecord('{"surface":"app",'), undefined, 'half-written JSON');
  assert.equal(parsePresenceRecord('null'), undefined, 'valid JSON, not a record');
  assert.deepEqual(parsePresenceRecord('{"surface":"app","pid":42}'), { surface: 'app', pid: 42 });
});

test('a record naming nobody alive is CLAIMED — absent, stale, or garbage', () => {
  assert.equal(presenceVerdict(undefined, 100, NOBODY), 'claim', 'no record at all');
  assert.equal(presenceVerdict({}, 100, NOBODY), 'claim', 'a record with no pid');
  assert.equal(presenceVerdict({ pid: 0 }, 100, NOBODY), 'claim', 'pid 0 is not a process');
  assert.equal(presenceVerdict({ pid: 1 }, 100, ALIVE(1)), 'claim',
    'pid 1 is launchd, never a surface — a record naming it is corrupt, alive or not');
  /* The three-week-dead `glass.json` that sat beside a live `app.json`. Nothing could displace
     it before, because only its own process was allowed to remove it and that process was gone. */
  assert.equal(presenceVerdict({ pid: 87052 }, 100, NOBODY), 'claim', 'the holder has died');
});

test('a LIVE incumbent is left alone — the record is already true, and churning it is the bug', () => {
  assert.equal(presenceVerdict({ pid: 5048 }, 6057, ALIVE(5048, 6057)), 'leave');
  /* Two live instances must SETTLE rather than trade the record every heal tick: whoever holds
     it keeps holding it, because each sees a live holder that is not itself. */
  assert.equal(presenceVerdict({ pid: 6057 }, 5048, ALIVE(5048, 6057)), 'leave');
});

test('our own record is claimable — a heal refreshes it, it is not a stranger', () => {
  assert.equal(presenceVerdict({ pid: 5048 }, 5048, ALIVE(5048)), 'claim');
});

test('THE OUTAGE, as a sequence — and it no longer ends with nobody named', () => {
  /* Measured on the App 2026-09-15; Glass reaches the same state with two IDE windows.
     A starts, B starts over it, B quits ten seconds later, A runs on. */
  const A = 5048, B = 6057;
  let record: Rec;

  record = apply(record, A, ALIVE(A));
  assert.deepEqual(record, { pid: A }, '12:54 — A announces into an empty directory');

  // 12:55:40 — B announces while A is alive. THIS is where the old code overwrote.
  record = apply(record, B, ALIVE(A, B));
  assert.deepEqual(record, { pid: A }, 'B must not displace a live A');

  // 12:55:50 — B quits. Its retract asks whether the record is its own.
  assert.equal(mayRetract(record, B), false, 'B deletes nothing: the record is A\'s');
  if (mayRetract(record, B)) record = undefined;

  // 12:58 — A is still fulfilling spawns. An agent asks: is a surface alive?
  assert.deepEqual(record, { pid: A }, 'the record still names the surface that is actually running');
  assert.equal(presenceVerdict(record, A, ALIVE(A)), 'claim', 'and A would simply refresh its own');
});

test('the other ordering too: the incumbent exits and the deferrer takes over', () => {
  /* B deferred to A on startup, so B never owned the record. When A exits it correctly removes
     it — and without a heal that is where it ended: a live B and no record. The heal is what
     closes this, and it needs no coordination between the two processes. */
  const A = 5048, B = 6057;
  let record: Rec = { pid: A };
  record = apply(record, B, ALIVE(A, B));
  assert.deepEqual(record, { pid: A }, 'B defers on startup');

  assert.equal(mayRetract(record, A), true, 'A owns it, so A may remove it on a clean exit');
  record = undefined;

  record = apply(record, B, ALIVE(B));
  assert.deepEqual(record, { pid: B },
    'B\'s next heal claims the empty record — no handoff, no message, just liveness');
});

test('mayRetract: only ever our own record', () => {
  assert.equal(mayRetract({ pid: 42 }, 42), true);
  assert.equal(mayRetract({ pid: 42 }, 99), false, 'a peer\'s record');
  assert.equal(mayRetract(undefined, 42), false, 'nothing to remove');
  assert.equal(mayRetract({}, 42), false, 'a record with no pid names nobody, so it is not ours');
  /* Deliberately NOT liveness-gated: we are the one exiting, so "is it mine" is the whole
     question. Asking whether we are alive would always answer yes and add a failure mode. */
});
