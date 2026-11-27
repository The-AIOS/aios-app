import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideSend, safeNeedle, isBusy, holdPathFor, undeliveredPathFor, isHoldPath,
  HOLD_SUFFIX, UNDELIVERED_SUFFIX, type SendTarget,
  claimVerdict, canAdoptHold, parseClaim, shouldReleaseForSibling, shouldWriteDoc,
  countUserTurnsContaining, verifyVerdict, isDeliverable, TIMINGS,
} from '../src/sendQueue';

const target = (status: string): SendTarget => ({ name: 'designer', pid: 42, status, sessionId: 'abc' });
const MAX = 30 * 60 * 1000;

test('an idle target is delivered to', () => {
  assert.deepEqual(decideSend(target('idle'), 0, MAX), { do: 'deliver', pid: 42 });
});

test('a busy target is HELD, never delivered to', () => {
  const d = decideSend(target('busy'), 0, MAX);
  assert.equal(d.do, 'hold');
});

test('a busy target is STILL not delivered to when the hold budget runs out', () => {
  // The regression this whole module exists for: 0.4.6 "delivered anyway" on timeout,
  // which is the guaranteed-drop path the status gate was built to prevent.
  const d = decideSend(target('busy'), MAX + 1, MAX);
  assert.equal(d.do, 'undeliverable');
  assert.match(d.reason, /busy/);
  assert.notEqual(d.do, 'deliver');
});

test('an unknown name is undeliverable immediately, not held forever', () => {
  const d = decideSend(undefined, 0, MAX);
  assert.equal(d.do, 'undeliverable');
  assert.match(d.reason, /registry/);
});

test('status matching is case- and whitespace-insensitive', () => {
  // isBusy stays exported so the two fulfillers' modules remain diffable, but it is no
  // longer the gate — see the deliverability allowlist below.
  assert.equal(isBusy('BUSY'), true);
  assert.equal(isBusy(' busy '), true);
  assert.equal(isBusy(''), false);
  assert.equal(isBusy(undefined), false);
  assert.equal(isDeliverable(' IDLE '), true);
  assert.equal(isDeliverable('BUSY'), false);
});

test('an EMPTY/unknown status now HOLDS rather than delivering (deliberate change)', () => {
  // This inverts the original behaviour, and the inversion is the point: "not busy" is
  // not the same as "deliverable". The registry emits statuses we haven't characterised
  // (the App measured `shell`), and the failure is asymmetric — a wrong "deliverable"
  // guess costs a real message, a wrong "hold" guess costs latency.
  assert.equal(decideSend(target(''), 0, MAX).do, 'hold');
  assert.equal(decideSend(target('idle'), 0, MAX).do, 'deliver');
  assert.equal(decideSend(target('shell'), 0, MAX).do, 'deliver');
});

test('claim + abandon paths never match the watcher glob (no re-pickup loop)', () => {
  const req = '/i/spawn-inbox/msg.json';
  const hold = holdPathFor(req);
  const dead = undeliveredPathFor(hold);
  for (const p of [hold, dead]) {
    assert.equal(p.endsWith('.json'), false, `${p} would be re-picked-up as a new request`);
  }
  assert.equal(hold, `${req}${HOLD_SUFFIX}`);
  assert.equal(isHoldPath(hold), true);
  assert.equal(isHoldPath(req), false);
  // abandoning a claimed file must not stack suffixes
  assert.equal(dead, `${req}${UNDELIVERED_SUFFIX}`);
  assert.equal(undeliveredPathFor(req), `${req}${UNDELIVERED_SUFFIX}`);
});

test('the verification needle survives JSON escaping', () => {
  const withQuotes = 'fleet-heron here — I ran your "shouldWrite" against the real doc';
  const needle = safeNeedle(withQuotes);
  assert.equal(needle.includes('"'), false);
  assert.equal(needle.includes('\\'), false);
  assert.ok(needle.length >= 24);
  // and it must actually be findable in a JSON-encoded transcript line
  assert.ok(JSON.stringify({ text: withQuotes }).includes(needle));
});

test('the needle degrades gracefully on short or hostile text', () => {
  assert.equal(safeNeedle('hi').length > 0, true);
  assert.ok(safeNeedle('"""\\\\"""').length > 0);
});

/* ── contract 2: the multi-fulfiller protocol ───────────────────────────────── */

const TTL = 10 * 60 * 1000;

test('an unaddressed request is claimable by anyone (contract-1 behaviour preserved)', () => {
  assert.equal(claimVerdict(undefined, 'glass', 0, TTL), 'claim');
  assert.equal(claimVerdict(undefined, 'app', 0, TTL), 'claim');
  assert.equal(claimVerdict('nonsense', 'glass', 0, TTL), 'claim'); // unknown value → not a target
});

test('a request addressed to me is mine; addressed elsewhere I leave it ALONE', () => {
  assert.equal(claimVerdict('glass', 'glass', 0, TTL), 'claim');
  assert.equal(claimVerdict('app', 'glass', 0, TTL), 'skip');   // the App may still be starting
  assert.equal(claimVerdict('glass', 'app', 0, TTL), 'skip');
});

test('a request whose addressee never showed up is RETIRED, never silently rotted', () => {
  assert.equal(claimVerdict('app', 'glass', TTL + 1, TTL), 'retire');
  // …but retiring is not fulfilling: the addressee's own requests stay claimable by it
  assert.equal(claimVerdict('app', 'app', TTL + 1, TTL), 'claim');
});

test('a hold belonging to a LIVE other process is never stolen', () => {
  const fresh = { surface: 'app' as const, pid: 999, at: 1_000_000 };
  assert.equal(canAdoptHold(fresh, 1_000_100, 60_000, true), false); // live + fresh → hands off
  assert.equal(canAdoptHold(fresh, 1_000_100, 60_000, false), true); // holder died → resume
  assert.equal(canAdoptHold(fresh, 9_000_000, 60_000, true), true);  // live but stale → resume
  assert.equal(canAdoptHold(undefined, 1, 60_000, true), true);      // unstamped legacy → adoptable
});

test('claim stamps round-trip and reject malformed input', () => {
  const c = { surface: 'glass', pid: 42, at: 123 };
  assert.deepEqual(parseClaim(c), { surface: 'glass', pid: 42, at: 123 });
  for (const bad of [undefined, null, 'x', {}, { surface: 'nope', pid: 1, at: 1 }, { surface: 'glass', pid: '1', at: 1 }]) {
    assert.equal(parseClaim(bad), undefined);
  }
});

test('a claim is released for a sibling window, but not forever', () => {
  assert.equal(shouldReleaseForSibling(0, 2), true);
  assert.equal(shouldReleaseForSibling(1, 2), true);
  assert.equal(shouldReleaseForSibling(2, 2), false);   // stop; declare it undeliverable
});

/* ── verification: counting user turns, not substring presence ───────────────── */

const userTurn = (text: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
const assistantEcho = (text: string) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const userBlocks = (text: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });

test('one delivery counts as ONE even when assistants quote the marker back', () => {
  // Measured by the App: a single delivery produced 5 substring hits (1 user turn +
  // assistant messages echoing it). A presence check cannot tell 1 delivery from 2.
  const tx = [
    userTurn('hello TEST-MARK-8412 please act'),
    assistantEcho('acknowledging TEST-MARK-8412'),
    assistantEcho('summary mentions TEST-MARK-8412 again'),
  ].join('\n');
  assert.equal(tx.split('TEST-MARK-8412').length - 1, 3, 'raw substring hits');
  assert.equal(countUserTurnsContaining(tx, 'TEST-MARK-8412'), 1, 'but exactly one USER turn');
});

test('a genuine double delivery counts as TWO and is flagged, not smoothed', () => {
  const tx = [userTurn('x TEST-DUP-1 y'), assistantEcho('TEST-DUP-1'), userTurn('x TEST-DUP-1 y')].join('\n');
  assert.equal(countUserTurnsContaining(tx, 'TEST-DUP-1'), 2);
  assert.equal(verifyVerdict(0, 2), 'duplicate');
});

test('verification is BASELINE-relative — the killer case on contract 2 paths', () => {
  // After a sibling handoff or an adopted hold, the needle is ALREADY present from the
  // first attempt. Presence would "verify" instantly; a baseline cannot be fooled.
  const before = countUserTurnsContaining(userTurn('TEST-RETRY-9'), 'TEST-RETRY-9');
  assert.equal(before, 1);
  assert.equal(verifyVerdict(before, before), 'pending', 'no new turn yet → still pending');
  assert.equal(verifyVerdict(before, before + 1), 'verified');
});

test('user turns are counted whether content is a string or a block array', () => {
  assert.equal(countUserTurnsContaining(userBlocks('block TEST-B-1 form'), 'TEST-B-1'), 1);
  assert.equal(countUserTurnsContaining(userTurn('string TEST-B-1 form'), 'TEST-B-1'), 1);
});

test('malformed lines and an empty needle never throw or false-positive', () => {
  assert.equal(countUserTurnsContaining('not json\n{"broken":\n', 'x'), 0);
  assert.equal(countUserTurnsContaining(userTurn('anything'), ''), 0);
});

/* ── deliverability: an allowlist, because unknown statuses must HOLD ─────────── */

test("'shell' is deliverable (measured), and unknown statuses are NOT", () => {
  assert.equal(isDeliverable('idle'), true);
  assert.equal(isDeliverable('shell'), true);       // App measured a successful delivery here
  assert.equal(isDeliverable('busy'), false);
  assert.equal(isDeliverable('compacting'), false); // uncharacterised → hold, don't guess
  assert.equal(isDeliverable(''), false);           // unknown → hold (was previously DELIVERED)
  assert.equal(isDeliverable(undefined), false);
});

test('decideSend holds on an uncharacterised status and names it in the reason', () => {
  const d = decideSend({ name: 'w', pid: 1, status: 'compacting', sessionId: 's' }, 0, MAX);
  assert.equal(d.do, 'hold');
  assert.match(d.reason, /compacting/);
  assert.match(d.reason, /not yet characterised/);
});

test('the four protocol timings are pinned — they are contract, not tuning', () => {
  // The App measured the failure: Glass at 45 min vs App at 15 gave a 30-minute window
  // where each side's ownership belief was correct and BOTH delivered. Changing any of
  // these requires changing every fulfiller in lockstep + the inbox README.
  assert.equal(TIMINGS.HOLD_STALE_MS, 24 * 60 * 60 * 1000 + 45 * 60 * 1000);   // > QUEUE_CEILING_MS + MAX_HOLD_MS
  assert.equal(TIMINGS.MAX_HOLD_MS, 30 * 60 * 1000);
  assert.ok(TIMINGS.HOLD_STALE_MS > TIMINGS.QUEUE_CEILING_MS, 'a live holder waiting for an idle target must never be adoptable');
  assert.equal(TIMINGS.RETIRE_TTL_MS, 10 * 60 * 1000);
  assert.equal(TIMINGS.MAX_RELEASES, 2);
  assert.ok(TIMINGS.HOLD_STALE_MS > TIMINGS.MAX_HOLD_MS,
    'a hold must not be adoptable before its own holder would have given up');
});

test('the doc is never DOWNGRADED by an older fulfiller', () => {
  const ours = 'ours\n<!-- aios-spawn-inbox: contract 2 · written by AIOS Glass v0.5.0 -->';
  assert.equal(shouldWriteDoc(undefined, 2, ours), true);
  assert.equal(shouldWriteDoc('', 2, ours), true);
  assert.equal(shouldWriteDoc(ours, 2, ours), false);                       // identical → no churn
  assert.equal(shouldWriteDoc('old\n<!-- aios-spawn-inbox: contract 1 -->', 2, ours), true);
  assert.equal(shouldWriteDoc('new\n<!-- aios-spawn-inbox: contract 3 -->', 2, ours), false); // never stomp newer
  assert.equal(shouldWriteDoc('hand-written, unstamped', 2, ours), true);
});

/* ── The slash-command needle, and the false VERIFIED it produced ────────────
   Shape verified against real transcripts on 2026-08-14 (twelve files, 11,152 user records):
   a slash command is recorded as a user turn whose text is the `<command-name>` wrapper, and
   every record carries a parseable ISO `timestamp`. Content below is synthetic — real transcript
   text is the operator's private session data and does not belong in a repo — but the SHAPE is
   what was measured, which is the part the assertions depend on. */
const cmdTurn = (cmd: string, iso: string): string => JSON.stringify({
  type: 'user',
  timestamp: iso,
  message: { role: 'user', content: `<command-name>${cmd}</command-name>\n<command-message>${cmd.slice(1)}</command-message>` },
});

test('a ZERO baseline must not turn transcript HISTORY into a verified delivery', () => {
  /* THE BUG, reproduced. Both surfaces fail SOFT when the transcript cannot be read: Glass does
     `catch { baseline = 0 }` and the App's readTranscript returns '' (which counts 0). So a
     transient read miss at baseline time sets the baseline to zero — and then a PRE-EXISTING
     invocation of the same slash command reads as a fresh arrival.

     The consequence is the worst one in the protocol: the bus concludes its send landed, DELETES
     the request, and nobody is told. A silently lost message, not a duplicated one.

     It needs the needle to be non-unique, which for a slash command it always is:
     safeNeedle('/config') === '/config', because the command is shorter than the 24-character
     run the matcher looks for. Measured: 7 of 10 slash-command sends had a needle also present in
     other user records, invocations forty minutes and five hours apart. */
  const claimedAt = Date.parse('2026-08-14T18:00:00.000Z');
  const history = cmdTurn('/config', '2026-08-14T17:00:00.000Z');   // an hour BEFORE we claimed
  const needle = safeNeedle('/config');
  assert.equal(needle, '/config', 'a slash command IS its own needle — this is why the bound matters');

  const baselineFailed = 0;                                          // the fail-soft path
  const unbounded = countUserTurnsContaining(history, needle);
  assert.equal(unbounded, 1);
  assert.equal(verifyVerdict(baselineFailed, unbounded), 'verified',
    'this is the bug: history read as a delivery that never happened');

  const bounded = countUserTurnsContaining(history, needle, claimedAt);
  assert.equal(bounded, 0, 'a record older than our claim can never be our delivery');
  assert.equal(verifyVerdict(baselineFailed, bounded), 'pending',
    'fixed: the send stays unverified, so it retries or dead-letters LOUDLY instead of vanishing');
});

test('a real delivery still verifies, and a real double still shouts', () => {
  const claimedAt = Date.parse('2026-08-14T18:00:00.000Z');
  const needle = safeNeedle('/config');
  const one = cmdTurn('/config', '2026-08-14T18:00:05.000Z');
  assert.equal(countUserTurnsContaining(one, needle, claimedAt), 1);
  assert.equal(verifyVerdict(0, countUserTurnsContaining(one, needle, claimedAt)), 'verified');
  const two = `${one}\n${cmdTurn('/config', '2026-08-14T18:00:07.000Z')}`;
  assert.equal(verifyVerdict(0, countUserTurnsContaining(two, needle, claimedAt)), 'duplicate',
    'the bound must not silence a genuine double delivery');
  // exactly at the claim instant counts — the claim is inclusive
  assert.equal(countUserTurnsContaining(cmdTurn('/config', '2026-08-14T18:00:00.000Z'), needle, claimedAt), 1);
});

test('FAIL CLOSED: a record we cannot place in time is not counted as ours', () => {
  /* The asymmetry is deliberate and matches DELIVERABLE_STATUSES: counting an unplaceable record
     risks a silent loss, while not counting it risks a retry and at worst a LOUD .undelivered.
     Measured 11,152/11,152 records with a parseable timestamp, so this is a guard against a
     future format change, not a common path. */
  const claimedAt = Date.parse('2026-08-14T18:00:00.000Z');
  const noTs = JSON.stringify({ type: 'user', message: { role: 'user', content: '<command-name>/config</command-name>' } });
  const badTs = JSON.stringify({ type: 'user', timestamp: 'not-a-date', message: { role: 'user', content: '<command-name>/config</command-name>' } });
  assert.equal(countUserTurnsContaining(noTs, '/config', claimedAt), 0, 'missing timestamp → not ours');
  assert.equal(countUserTurnsContaining(badTs, '/config', claimedAt), 0, 'unparseable timestamp → not ours');
  // and with no bound requested, behaviour is unchanged — the parameter is additive
  assert.equal(countUserTurnsContaining(noTs, '/config'), 1, 'unbounded counting is untouched');
});

test('KNOWN LIMIT: an invocation inside our own hold window is still indistinguishable', () => {
  /* Asserted so it is a TESTED limitation rather than a surprise during the next incident. The
     needle cannot be made unique without altering the text we type, and a slash command with a
     marker appended is no longer that slash command. What the bound buys is the size of the
     window: from the transcript's entire history down to our own hold. */
  const claimedAt = Date.parse('2026-08-14T18:00:00.000Z');
  const someoneElse = cmdTurn('/config', '2026-08-14T18:00:03.000Z');
  assert.equal(countUserTurnsContaining(someoneElse, '/config', claimedAt), 1,
    'still counted — documented, bounded to the hold window, and the reason release was removed');
});

/* A built-in slash command verifies by its local_command record (real format, 2.1.288). */
import { slashCommandOf, countLocalCommands, countDeliveries } from '../src/sendQueue';

test('slash command: /remote-control verifies by the local_command record it really writes', () => {
  const rc = (ts: string, args = '') => JSON.stringify({ parentUuid: 'p', isSidechain: false, type: 'system', subtype: 'local_command',
    content: `<command-name>/remote-control</command-name>\n            <command-message>remote-control</command-message>\n            <command-args>${args}</command-args>`,
    level: 'info', timestamp: ts, uuid: 'u', sessionId: 's' });
  const claimed = Date.parse('2026-10-03T01:38:30.000Z');
  const before = [rc('2026-10-02T09:00:00.000Z')].join('\n');                       // an older re-attach: not ours
  const after = [before, rc('2026-10-03T01:38:34.559Z', 'aios-canonical')].join('\n');
  assert.equal(slashCommandOf('/remote-control'), '/remote-control');
  assert.equal(slashCommandOf('/rename new-name'), '/rename');
  assert.equal(slashCommandOf('hello /remote-control'), null);
  assert.equal(countLocalCommands(after, '/remote-control', claimed), 1);
  const b = countDeliveries(before, '/remote-control', '/remote-control', claimed);
  const a = countDeliveries(after, '/remote-control', '/remote-control', claimed);
  assert.equal(verifyVerdict(b, a), 'verified', 'a re-attach that happened is a delivery, not a dead letter');
  assert.equal(countLocalCommands(rc('2026-10-03T01:38:34Z').replace('"system"', '"user"'), '/remote-control'), 0, 'only system/local_command records count');
});

test('slash command: a plain message still verifies by user turns only, and a command is never counted twice', () => {
  const user = (text: string, ts: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: text }, timestamp: ts });
  const t0 = Date.parse('2026-10-11T00:00:00Z');
  const tx = user('hello from the bus, a long enough marker', '2026-10-11T00:00:05Z');
  assert.equal(countDeliveries(tx, 'hello from the bus, a long enough marker', 'hello from the bus, a long', t0), 1);
  const custom = [user('<command-name>/aios:today</command-name>', '2026-10-11T00:00:05Z')].join('\n');
  assert.equal(countDeliveries(custom, '/aios:today', '/aios:today', t0), 1, 'a custom command lands as a user turn: max(), not sum');
});

import { isQueuedDelivery, queueTurn as queueTurn11 } from '../src/sendQueue';
test('should-fix 11: a resume to a LIVE session is a queued delivery — it waits its turn and is waited on', () => {
  assert.equal(isQueuedDelivery('send', { name: 'w' }), true);
  assert.equal(isQueuedDelivery('resume', { name: 'w', prompt: 'carry on' }), true, 'a resume with a prompt delivers like a send');
  assert.equal(isQueuedDelivery('resume', { name: 'w' }), false, 'a resume with nothing to say types nothing');
  assert.equal(isQueuedDelivery('resume', { name: 'w', prompt: '   ' }), false);
  assert.equal(isQueuedDelivery('spawn', { name: 'w', task: 'x' }), false);
  assert.equal(isQueuedDelivery('send', {}), false, 'no target, no line');
  // An older resume-with-prompt to w is ahead of a newer send to w from someone else.
  const held = [{ key: 'r.json.holding', target: 'w', from: 'buddai', queuedAt: 1000 }, { key: 's.json.holding', target: 'w', from: 'canonical', queuedAt: 2000 }];
  assert.equal(queueTurn11(held[1], held).do, 'wait', 'the send waits behind the resume');
  assert.equal(queueTurn11(held[0], held).do, 'go', 'the resume goes first');
});

import { supersedes as supersedes64, queueTurn as queueTurn64 } from '../src/sendQueue';
test('operator test 6.4: a correction retires the older message itself, whatever order the checks run in', () => {
  // The run that failed: an older RESUME (prompt) and a newer SEND, same sender, same busy target.
  const older = { key: 'q-resume.json.holding', target: 'stamp-target', from: 'bus-tester', queuedAt: 1000 };
  const newer = { key: 'q-send.json.holding', target: 'stamp-target', from: 'bus-tester', queuedAt: 21000 };
  const inbox = new Set([older.key, newer.key]);
  const held = () => [older, newer].filter((h) => inbox.has(h.key));
  // The target goes idle and the NEWER checks first (the order that broke it).
  assert.equal(queueTurn64(newer, held()).do, 'go', 'the correction goes');
  for (const o of supersedes64(newer, held())) inbox.delete(o.key);   // retired before it types
  assert.equal(inbox.has(older.key), false, 'the older message is gone before the correction is typed');
  inbox.delete(newer.key);                                            // delivered, verified, removed
  // The older one's own check now runs: its file is gone, so it is never delivered (both surfaces
  // test existence before their first type). Before the fix it saw no newer message and went out.
  assert.equal(inbox.has(older.key), false);
  assert.deepEqual(supersedes64({ ...newer, from: undefined }, [older, newer]), [], 'without a sender nothing is superseded');
  assert.deepEqual(supersedes64(newer, [{ ...older, from: 'someone-else' }]), [], 'another sender\'s message is never retired');
  assert.deepEqual(supersedes64(older, [older, newer]), [], 'an older message never retires a newer one');
});
