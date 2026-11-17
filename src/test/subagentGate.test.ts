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
import { liveSubagents, landedInSubagentReason, SUBAGENT_STALE_MS, subagentHold, landedInSubagentOnly, SUBAGENT_HOLD_MAX_MS } from '../core/subagentGate';
import { countDeliveries } from '../core/sendQueue';

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
  assert.match(bus, /const subLive = liveSubagents\(subagentStates\(sessionId\), Date\.now\(\)\);\s*if \(subLive > 0 && !subHoldSince\) subHoldSince = Date\.now\(\);\s*const subHold = subagentHold\(\{ live: subLive, now: Date\.now\(\), holdSince: subHoldSince/, 'busy while subagents run, capped from the first time they held it');
  const late = bus.indexOf("log(`delivered → '${req.name}' (verified late)`);\n        return;\n      }\n    }\n    const subLive");
  assert.ok(late > 0, 'a late arrival is checked BEFORE the subagent hold (second review)');
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
