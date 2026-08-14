/**
 * Spawn-inbox contract 2 — the pure decisions, ported from Glass's src/core/sendQueue.ts.
 *
 * These tests exist so the two fulfillers can be shown to agree. Every case here is one
 * the protocol was written to prevent, and each was a real loss on one surface or the other:
 * a consumed-but-undeliverable message, a delivery into a busy session, a timeout that
 * "tried anyway", a stolen live hold, and a request left to rot.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { TIMINGS } from '../core/sendQueue';
import {
  INBOX_CONTRACT, MY_SURFACE, HOLD_SUFFIX, UNDELIVERED_SUFFIX, holdPathFor, undeliveredPathFor,
  isHoldPath, isBusy, isDeliverable, decideSend, safeNeedle, isSurface, claimVerdict,
  canAdoptHold, parseClaim, shouldReleaseForSibling, shouldWriteDoc,
  countUserTurnsContaining, verifyVerdict, type SendTarget,
} from '../core/sendQueue';

const target = (over: Partial<SendTarget> = {}): SendTarget =>
  ({ name: 'designer', pid: 4242, status: 'idle', sessionId: 'sess-1', ...over });

test('this build declares contract 2 and the app surface', () => {
  assert.equal(INBOX_CONTRACT, 2);
  assert.equal(MY_SURFACE, 'app');
});

test('claim suffixes sit OUTSIDE the *.json watch glob', () => {
  // if a claimed file still matched the watcher it would be picked up again as new
  assert.ok(!HOLD_SUFFIX.endsWith('.json'));
  assert.ok(!UNDELIVERED_SUFFIX.endsWith('.json'));
  assert.equal(holdPathFor('/i/r.json'), '/i/r.json.holding');
  assert.equal(undeliveredPathFor('/i/r.json'), '/i/r.json.undelivered');
  // from a HELD path the hold suffix is replaced, not stacked
  assert.equal(undeliveredPathFor('/i/r.json.holding'), '/i/r.json.undelivered');
  assert.ok(isHoldPath('/i/r.json.holding'));
  assert.ok(!isHoldPath('/i/r.json'));
});

test('ONLY an idle target is delivered into — "not busy" is not "ready"', () => {
  // Observed live: a session mid-Bash reports 'shell'. Glass gates on isBusy, so 'shell'
  // reads as safe there; we hold on anything that is not explicitly idle, because holding
  // costs seconds and a wrong guess costs the message. Deliberate divergence, reported.
  // an ALLOWLIST: 'shell' is here because it was measured safe (the text landed as a user
  // turn and the target acknowledged holding it), not assumed. Glass 0.5.1 allowlists the
  // same two, so the surfaces agree.
  assert.equal(isDeliverable('idle'), true);
  assert.equal(isDeliverable('shell'), true);
  for (const s of ['busy', 'waiting', 'error', '', undefined, 'something-new']) {
    assert.equal(isDeliverable(s), false, `an uncharacterised status must hold: '${String(s)}'`);
    assert.equal(decideSend(target({ status: String(s ?? '') }), 0, 1000).do, 'hold', String(s));
  }
  // isBusy is kept so the two implementations stay diffable — note it disagrees with the
  // allowlist on 'shell', which is exactly why the allowlist exists as its own function
  assert.equal(isBusy('busy'), true);
  assert.equal(isBusy('shell'), false);
  assert.equal(decideSend(target({ status: 'idle' }), 0, 1000).do, 'deliver');
  // the rule that must never soften: expiry reports undeliverable, it does not force it
  const expired = decideSend(target({ status: 'busy' }), 5000, 1000);
  assert.equal(expired.do, 'undeliverable');
  assert.match((expired as { reason: string }).reason, /never went idle/);
  // "delivered anyway on timeout" was a guaranteed silent loss
  assert.notEqual(expired.do, 'deliver');
});

test('no live session by that name is undeliverable, not a hold', () => {
  const d = decideSend(undefined, 0, 60_000);
  assert.equal(d.do, 'undeliverable');
  assert.match((d as { reason: string }).reason, /registry/);
});

test('busy detection is case- and whitespace-tolerant', () => {
  for (const s of ['busy', 'BUSY', ' busy ']) assert.equal(isBusy(s), true, s);
  for (const s of ['idle', '', undefined]) assert.equal(isBusy(s), false, String(s));
});

test('the verification needle survives jsonl escaping', () => {
  const n = safeNeedle('Hi there — this is an automated wiring check with "quotes" inside');
  assert.ok(n.length >= 24 && n.length <= 48);
  assert.ok(!n.includes('"'), 'a quote would be escaped in the transcript and could miss');
  assert.ok(!n.includes('\\'));
  // short text still yields something usable
  assert.ok(safeNeedle('ship it').length > 0);
});

test('addressing: only the addressee may fulfil; others leave it ALONE while fresh', () => {
  assert.ok(isSurface('glass') && isSurface('app') && !isSurface('ide'));
  // unaddressed → any surface (contract-1 behaviour preserved, the field is additive)
  assert.equal(claimVerdict(undefined, 'app', 0, 1000), 'claim');
  assert.equal(claimVerdict('nonsense', 'app', 0, 1000), 'claim');
  assert.equal(claimVerdict('app', 'app', 0, 1000), 'claim');
  // addressed elsewhere and fresh → do not touch: the addressee may be starting up
  assert.equal(claimVerdict('glass', 'app', 0, 1000), 'skip');
  // …but nothing rots: fulfilment is targeted, retirement is shared
  assert.equal(claimVerdict('glass', 'app', 5000, 1000), 'retire');
});

test('a live sibling\'s fresh hold is never adopted — that is the double-delivery bug', () => {
  const claim = { surface: 'glass' as const, pid: 999, at: 1_000_000 };
  assert.equal(canAdoptHold(claim, 1_000_500, 60_000, true), false, 'live holder, fresh hold');
  assert.equal(canAdoptHold(claim, 1_000_500, 60_000, false), true, 'holder died mid-wait');
  assert.equal(canAdoptHold(claim, 2_000_000, 60_000, true), true, 'live holder, stale hold');
  assert.equal(canAdoptHold(undefined, 0, 60_000, true), true, 'unstamped contract-1 hold');
});

test('a claim stamp is only trusted when fully formed', () => {
  assert.deepEqual(parseClaim({ surface: 'app', pid: 1, at: 2 }), { surface: 'app', pid: 1, at: 2 });
  for (const bad of [undefined, null, 'app', {}, { surface: 'app' }, { surface: 'x', pid: 1, at: 2 },
    { surface: 'app', pid: '1', at: 2 }]) {
    assert.equal(parseClaim(bad), undefined, JSON.stringify(bad));
  }
});

test('sibling handoff is bounded, so two surfaces cannot ping-pong a request', () => {
  assert.equal(shouldReleaseForSibling(0, 2), true);
  assert.equal(shouldReleaseForSibling(1, 2), true);
  assert.equal(shouldReleaseForSibling(2, 2), false);
});

test('a doc declaring a HIGHER contract is never downgraded', () => {
  const ours = 'body\n<!-- aios-spawn-inbox: contract 2 · written by AIOS App -->';
  assert.equal(shouldWriteDoc(undefined, 2, ours), true, 'absent → write');
  assert.equal(shouldWriteDoc('<!-- aios-spawn-inbox: contract 3 -->', 2, ours), false, 'newer doc is the accurate one');
  assert.equal(shouldWriteDoc('<!-- aios-spawn-inbox: contract 1 -->', 2, ours), true);
  assert.equal(shouldWriteDoc(ours, 2, ours), false, 'identical → no churn');
});

/* ── the main-side lifecycle that uses those decisions ───────────────────────── */

test('the bus CLAIMS by rename and deletes only after verification', () => {
  const src = fs.readFileSync('src/main/commandBus.ts', 'utf8');
  // the whole point: unlink-on-pickup is what lost a message that could not be delivered
  assert.match(src, /fs\.renameSync\(fsPath, heldPath\)/);
  assert.doesNotMatch(src, /consume[\s\S]{0,400}unlinkSync\(fsPath\)/, 'no unlink on pickup');
  // deletion happens only once a verdict is reached — never while still pending
  assert.match(src, /if \(verdict === 'pending'\) continue;\n\s*try \{ fs\.unlinkSync\(heldPath\)/);
  assert.match(src, /body\._claim = \{ surface: MY_SURFACE, pid: process\.pid, at \}/);
});

test('delivery is verified by counting USER TURNS, not substring hits', () => {
  const src = fs.readFileSync('src/main/commandBus.ts', 'utf8');
  // the RULE now lives in core (pure, unit-tested above); main only does the IO
  assert.match(src, /function readTranscript/);
  /* Pin the INVARIANT, not the call text. This assertion has now broken twice by pinning a line
     that legitimately moved (the baseline hoist on 08-12, the `sinceMs` bound on 08-14), which is
     how a guard trains people to update it without reading it. What must hold: main hands the
     transcript to the core counter, and every such call BOUNDS it by the claim. */
  const counterCalls = src.match(/countUserTurnsContaining\(readTranscript\(sessionId\)[^)]*\)/g) ?? [];
  assert.ok(counterCalls.length >= 3, `main must delegate counting to core (found ${counterCalls.length} calls)`);
  for (const call of counterCalls) {
    assert.match(call, /, needle, claimedAt\)$/,
      `every count must be bounded by the CLAIM, not unbounded and not by a per-attempt clock — got: ${call}`);
  }
  assert.doesNotMatch(src, /countUserTurnsContaining\(readTranscript\(sessionId\), needle, emittedAt\)/,
    'emittedAt moves on every retry; a moving bound resets the count mid-flight — the moving-baseline bug again');
  assert.doesNotMatch(src, /countInTranscript/, 'the substring counter is retired');
  assert.match(src, /\.claude', 'projects'/);
});

test('a mid-write request is re-checked, not condemned', () => {
  const src = fs.readFileSync('src/main/commandBus.ts', 'utf8');
  // fs.watch fires on CREATE, which can beat the writer's bytes to disk. Retiring that as
  // unparseable turned a transient read into a permanent failure — observed on the first run.
  assert.match(src, /const PARSE_GRACE_MS/);
  assert.match(src, /if \(ageMs < PARSE_GRACE_MS\) \{ setTimeout\(\(\) => recheck\(fsPath\), PARSE_GRACE_MS\); return undefined; \}/);
});

test('the watcher ignores claimed and abandoned files', () => {
  const src = fs.readFileSync('src/main/commandBus.ts', 'utf8');
  assert.match(src, /if \(!f\.endsWith\('\.json'\)\) return;/);
  // and the drain loop uses the same rule
  assert.match(src, /if \(f\.endsWith\('\.json'\)\) consume\(getWin, path\.join\(dir, f\)\);/);
});

test('giving up always leaves a readable artifact', () => {
  const src = fs.readFileSync('src/main/commandBus.ts', 'utf8');
  assert.match(src, /body\._undelivered = \{ reason, at: Date\.now\(\), surface: MY_SURFACE \}/);
  // malformed requests are retired rather than retried on every fs event
  assert.match(src, /unparseable request/);
});

test('protocol timings are READ from the contract, never re-declared locally', () => {
  /* This test used to assert that commandBus.ts contained its own literal `const MAX_HOLD_MS =
     30 * 60_000;` and friends, "matching Glass exactly" — a claim it had no way to check, since
     it cannot see the other repo. It was a hand-maintained mirror, and mirrors drift: TIMINGS
     turned out to exist ONLY in Glass, with the App carrying loose consts linked by a comment.
     So the assertion is inverted. The App must NOT own these numbers; it must read them from
     the shared module, where the cross-repo hash guard (protocolContract.test.ts) enforces that
     both copies are byte-identical. */
  const src = fs.readFileSync('src/main/commandBus.ts', 'utf8');
  for (const k of ['MAX_HOLD_MS', 'MAX_RELEASES', 'RETIRE_TTL_MS', 'HOLD_STALE_MS']) {
    assert.match(src, new RegExp(`const ${k} = TIMINGS\\.`), `${k} must come from TIMINGS`);
  }
  assert.doesNotMatch(src, /const (MAX_HOLD_MS|HOLD_STALE_MS|RETIRE_TTL_MS) = \d+ \* 60_000/,
    'no local literal may shadow a contract value — that is how the two surfaces drifted');
  assert.match(fs.readFileSync('src/core/sendQueue.ts', 'utf8'), /CONTRACT, not local tuning/,
    'say why, so nobody re-tunes one side');
});
/* ── delivery verification: the rule that makes "exactly 1" measurable ───────── */

/** A transcript shaped like the real one that produced 5 substring hits for ONE delivery. */
const transcript = (userTurns: number, needle: string): string => {
  const lines: string[] = [{ type: 'summary', summary: 'unrelated' } as never].map((o) => JSON.stringify(o));
  for (let i = 0; i < userTurns; i++) {
    lines.push(JSON.stringify({ type: 'user', message: { role: 'user', content: `${needle} please` } }));
    // the target quoting the marker back — twice, exactly as measured
    lines.push(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `Understood — I'll hold ${needle}` }] } }));
    lines.push(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `${needle}\n\nDONE` }] } }));
    lines.push(JSON.stringify({ type: 'last-prompt', prompt: needle }));   // not a turn
  }
  return lines.join('\n');
};

test('only USER turns count — assistant echoes and metadata do not', () => {
  const N = 'TEST-MARK-1234';
  // one delivery produces several raw hits; the count must still be 1
  const one = transcript(1, N);
  assert.ok(one.split(N).length - 1 >= 4, 'fixture must reproduce the multi-hit shape');
  assert.equal(countUserTurnsContaining(one, N), 1);
  assert.equal(countUserTurnsContaining(transcript(2, N), N), 2, 'a real double delivery must read as 2');
  assert.equal(countUserTurnsContaining(transcript(0, N), N), 0);
  // string content and block content both count
  assert.equal(countUserTurnsContaining(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: N }] } }), N), 1);
  // unparseable lines and an empty needle are survivable
  assert.equal(countUserTurnsContaining(`{not json ${N}
` + transcript(1, N), N), 1);
  assert.equal(countUserTurnsContaining(transcript(1, N), ''), 0);
});

test('a verdict needs an INCREASE over the baseline, and shouts at 2', () => {
  // presence alone proves nothing: on a re-attempt the marker is already there from the
  // first try, which is exactly what made the old presence check report a false success
  assert.equal(verifyVerdict(1, 1), 'pending', 'already present, nothing new landed');
  assert.equal(verifyVerdict(0, 0), 'pending');
  assert.equal(verifyVerdict(0, 1), 'verified');
  assert.equal(verifyVerdict(1, 2), 'verified', 'a second attempt that lands once is still correct');
  assert.equal(verifyVerdict(0, 2), 'duplicate', 'this is the failure mode the count exists for');
  assert.equal(verifyVerdict(2, 1), 'pending', 'a shrinking count is never a success');
});

test('the main side reads the transcript but delegates the RULE to core', () => {
  /* The assertion used to pin `const before = countUserTurnsContaining(...)` verbatim. That line
     moved on 2026-08-12: the baseline is now captured ONCE outside the delivery loop, because
     re-reading it per attempt absorbed the previous attempt's own turn and made a landed message
     undetectable forever. The intent here is unchanged and is what is asserted — main does the IO,
     core owns the counting rule and the verdict. Where the baseline is captured is asserted in
     busPayload.test.ts, next to the reason. */
  const src = fs.readFileSync('src/main/commandBus.ts', 'utf8');
  assert.match(src, /countUserTurnsContaining\(readTranscript\(sessionId\), needle, claimedAt\)/,
    'main reads the transcript and hands it to the core counter, bounded by the claim');
  assert.match(src, /const verdict = verifyVerdict\(before, now\);/,
    'the verdict rule stays in core — main must not re-derive it');
  assert.match(src, /if \(verdict === 'pending'\) continue;/);
  assert.match(src, /DUPLICATE DELIVERY/, 'a duplicate must be shouted, not smoothed');
});

test('HOLD_STALE_MS > MAX_HOLD_MS — a hold must not become adoptable before its holder gives up', () => {
  // If adoption could happen while the original holder is still legitimately waiting, the
  // protocol invites the double delivery it exists to prevent. Asserted on the VALUES now,
  // not scraped from source text.
  assert.ok(TIMINGS.HOLD_STALE_MS > TIMINGS.MAX_HOLD_MS,
    'a fulfiller must give up before its own claim becomes adoptable');
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
