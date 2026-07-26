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
  assert.match(src, /countUserTurnsContaining\(readTranscript\(sessionId\), needle\)/);
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

test('protocol timings match Glass exactly — they are contract, not tuning', () => {
  const src = fs.readFileSync('src/main/commandBus.ts', 'utf8');
  // Both surfaces reason about the same files, so a mismatch is a protocol bug, not a
  // preference. HOLD_STALE was ours 15 min vs Glass's 45: in that 30-minute window Glass
  // still owned a hold we would have adopted, and both would have delivered.
  assert.match(src, /const RETIRE_TTL_MS = 10 \* 60_000;/);
  assert.match(src, /const HOLD_STALE_MS = 45 \* 60_000;/);
  assert.match(src, /const MAX_HOLD_MS = 30 \* 60_000;/);
  assert.match(src, /const MAX_RELEASES = 2;/);
  assert.match(src, /CONTRACT, not tuning/, 'say why, so nobody re-tunes one side');
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
  const src = fs.readFileSync('src/main/commandBus.ts', 'utf8');
  assert.match(src, /const before = countUserTurnsContaining\(readTranscript\(sessionId\), needle\);/);
  assert.match(src, /const verdict = verifyVerdict\(before, now\);/);
  assert.match(src, /if \(verdict === 'pending'\) continue;/);
  assert.match(src, /DUPLICATE DELIVERY/, 'a duplicate must be shouted, not smoothed');
});

test('HOLD_STALE_MS > MAX_HOLD_MS — a hold must not become adoptable before its holder gives up', () => {
  // fleet-heron's invariant: if adoption could happen while the original holder is still
  // legitimately waiting, the protocol invites the double delivery it exists to prevent
  const src = fs.readFileSync('src/main/commandBus.ts', 'utf8');
  const num = (name: string): number => {
    const m = new RegExp(`const ${name} = (\\d+) \\* 60_000`).exec(src);
    assert.ok(m, `${name} must be declared in minutes`);
    return Number(m[1]);
  };
  const stale = num('HOLD_STALE_MS'), maxHold = num('MAX_HOLD_MS'), retire = num('RETIRE_TTL_MS');
  assert.ok(stale > maxHold, `HOLD_STALE (${stale}m) must exceed MAX_HOLD (${maxHold}m)`);
  assert.equal(stale, 45); assert.equal(maxHold, 30); assert.equal(retire, 10);
});
