/**
 * #179: a send to a session with background subagents landed in a subagent, repeatedly.
 * The rule (core/subagentGate) and the readers (main/transcriptSince) are run here; the send loop's
 * use of them is checked by reading the source.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { liveSubagents, landedInSubagentReason, SUBAGENT_STALE_MS, subagentHold, landedInSubagentOnly, SUBAGENT_HOLD_MAX_MS, preTypeStep } from '@the-aios/core/subagentGate';
import { countDeliveries } from '@the-aios/core/sendQueue';

const NOW = 1_800_000_000_000;

test('a subagent not finished and recently written is live', () => {
  assert.equal(liveSubagents([{ mtimeMs: NOW - 1000 }], NOW), 1);
  assert.equal(liveSubagents([{ finished: false, mtimeMs: NOW - 1000 }], NOW), 1);
});

test('a finished subagent, or one silent past the stale limit, holds nothing', () => {
  assert.equal(liveSubagents([{ finished: true, mtimeMs: NOW - 1000 }], NOW), 0);
  assert.equal(liveSubagents([{ mtimeMs: NOW - SUBAGENT_STALE_MS - 1 }], NOW), 0);
  assert.equal(liveSubagents([], NOW), 0);
});

test('the dead letter says where it went and what to do', () => {
  const r = landedInSubagentReason('lead');
  assert.match(r, /background subagent of 'lead'/);
  assert.match(r, /not typed again/);
});

function fakeHome(): { sub: (sid: string) => string; main: (sid: string) => string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subgate-'));
  fs.mkdirSync(path.join(dir, 'projects', '-x'), { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = dir;
  return {
    main: (sid) => path.join(dir, 'projects', '-x', `${sid}.jsonl`),
    sub: (sid) => { const d = path.join(dir, 'projects', '-x', sid, 'subagents'); fs.mkdirSync(d, { recursive: true }); return d; },
  };
}

test('subagent states are read from the meta files beside their transcripts', async () => {
  const h = fakeHome();
  const { subagentStates } = await import('../main/transcriptSince');
  fs.writeFileSync(h.main('s1'), '');
  const d = h.sub('s1');
  fs.writeFileSync(path.join(d, 'agent-a.jsonl'), '{}\n');
  fs.writeFileSync(path.join(d, 'agent-a.meta.json'), JSON.stringify({ finished: true }));
  fs.writeFileSync(path.join(d, 'agent-b.jsonl'), '{}\n');
  fs.writeFileSync(path.join(d, 'agent-b.meta.json'), JSON.stringify({ requestShape: 'background' }));
  const st = subagentStates('s1');
  assert.equal(st.length, 2);
  assert.equal(liveSubagents(st, Date.now()), 1, 'b is running; a finished');
});

test('a message that lands in a subagent is counted there, including a subagent started after the send', async () => {
  const h = fakeHome();
  const { SubagentsSince } = await import('../main/transcriptSince');
  fs.writeFileSync(h.main('s2'), '');
  const d = h.sub('s2');
  const old = JSON.stringify({ type: 'user', timestamp: new Date(NOW - 60_000).toISOString(), message: { role: 'user', content: 'from lead: please check X' } });
  fs.writeFileSync(path.join(d, 'agent-old.jsonl'), old + '\n');
  const since = new SubagentsSince();
  assert.equal(countDeliveries(since.read('s2'), 'from lead: please check X', 'please check X', NOW - 120_000), 0, 'what was there before the send is not counted');
  const landed = JSON.stringify({ type: 'user', timestamp: new Date(NOW).toISOString(), message: { role: 'user', content: '[queued 2 min ago] from lead: please check X' } });
  fs.writeFileSync(path.join(d, 'agent-new.jsonl'), landed + '\n');
  assert.equal(countDeliveries(since.read('s2'), 'from lead: please check X', 'please check X', NOW - 120_000), 1);
});

test('wiring: the send loop holds for live subagents and stops on a copy found in one', () => {
  const bus = fs.readFileSync('src/main/commandBus.ts', 'utf8');
  assert.match(bus, /const step = preTypeStep\(\{/, 'one pure decision per pass (table-tested below)');
  assert.match(bus, /subHoldSince = step\.holdSince;/, 'its clock is carried between passes');
  assert.match(bus, /if \(subHold === 'give-up'\) \{\s*markUndelivered/, 'a hold that runs out is a dead letter');
  assert.match(bus, /if \(!landedInSubagentOnly\(count\(sid\), baseline, subCopies\)\) return false;/, 'the session\'s own copy is looked for first');
  assert.match(bus, /countDeliveries\(subSince\.read\(sid\), deliverText, needle, firstTypedAt\)/, 'only subagent copies written after the first type');
  assert.match(bus, /if \(firstTypedAt && landedInSubagent\(sessionId\)\) return;/, 'checked before any re-type');
  assert.match(bus, /if \(now <= before && landedInSubagent\(sessionId\)\) return;/, 'checked while verifying');
  assert.match(bus, /if \(!firstTypedAt\) subSince\.read\(sessionId\);/, 'the subagent baseline is taken before the first type');
});

test('review of #179: the hold for subagents is capped, before and after the first type', () => {
  const base = { live: 1, holdSince: NOW - 1000, firstTypedAt: 0, maxHoldMs: 30 * 60_000 };
  assert.equal(subagentHold({ ...base, live: 0, now: NOW }), 'go');
  assert.equal(subagentHold({ ...base, now: NOW }), 'hold');
  assert.equal(subagentHold({ ...base, now: NOW - 1000 + SUBAGENT_HOLD_MAX_MS }), 'give-up', 'never typed: capped from when subagents first held it');
  // second review: time spent waiting on a busy session is not time spent on subagents
  assert.equal(subagentHold({ ...base, holdSince: NOW, now: NOW + 1000 }), 'hold', 'a message that queued 70 min ago for a busy session still gets its full hold');
  assert.equal(subagentHold({ ...base, firstTypedAt: NOW, now: NOW + 29 * 60_000 }), 'hold');
  assert.equal(subagentHold({ ...base, firstTypedAt: NOW, now: NOW + 30 * 60_000 }), 'give-up', 'typed: capped like every other hold');
});

test('review of #179: a copy in the session itself is a delivery, even when an agent of its own quoted it', () => {
  assert.equal(landedInSubagentOnly(1, 0, 1), false, 'the session got it and quoted it to an agent: delivered');
  assert.equal(landedInSubagentOnly(0, 0, 1), true, 'only a subagent has it: the wrong recipient');
  assert.equal(landedInSubagentOnly(null, 0, 1), false, 'session transcript unreadable: not verifiable, never a wrong-recipient letter');
  assert.equal(landedInSubagentOnly(0, 0, 0), false);
});

test('third review of #179: one pass before typing, table-tested', () => {
  const B = { firstTypedAt: 0, mainNow: 0 as number | null, baseline: 0, subLive: 0, holdSince: 0, now: NOW, maxHoldMs: 30 * 60_000 };
  // never typed, no subagents: go
  assert.deepEqual(preTypeStep(B), { do: 'go', holdSince: 0 });
  // never typed, subagents: hold, and the clock starts now
  assert.deepEqual(preTypeStep({ ...B, subLive: 2 }), { do: 'hold', holdSince: NOW });
  // the clock is kept between passes, and gives up only after the full hold ON SUBAGENTS
  assert.equal(preTypeStep({ ...B, subLive: 1, holdSince: NOW - SUBAGENT_HOLD_MAX_MS + 1, now: NOW }).do, 'hold');
  assert.equal(preTypeStep({ ...B, subLive: 1, holdSince: NOW - SUBAGENT_HOLD_MAX_MS, now: NOW }).do, 'give-up');
  // subagents finish: the clock starts over, so a later batch gets a full hold of its own
  assert.deepEqual(preTypeStep({ ...B, subLive: 0, holdSince: NOW - 10 * 60_000 }), { do: 'go', holdSince: 0 });
  // typed, and the session's own transcript gained a copy: delivered, even with subagents running
  assert.equal(preTypeStep({ ...B, firstTypedAt: NOW - 60_000, mainNow: 1, subLive: 3 }).do, 'delivered');
  // typed, transcript unreadable: unverifiable, never held into a subagents dead letter
  assert.equal(preTypeStep({ ...B, firstTypedAt: NOW - 60_000, mainNow: null, subLive: 3 }).do, 'unverifiable');
  // typed, not arrived, subagents: hold from the first type, like every other hold
  assert.equal(preTypeStep({ ...B, firstTypedAt: NOW - 29 * 60_000, mainNow: 0, subLive: 1 }).do, 'hold');
  assert.equal(preTypeStep({ ...B, firstTypedAt: NOW - 30 * 60_000, mainNow: 0, subLive: 1 }).do, 'give-up');
});
