/**
 * One effective status for every list the operator reads. With a permission prompt just opened the
 * panel said "waiting on you" (it overlaid the terminal's own signal) while Ask, the quick bar and
 * the palette read the raw registry and still said busy.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { noteProgramStatus, effectiveSessions, forgetEndedSessions, clearProgramStatusForTests } from '../main/sessionStatus';
import { isBlockedStatus } from '../core/attention';
import { sessionsHoldAwake } from '../core/caffeinate';

const b = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const ROOT = path.join(__dirname, '..', '..');
const src = (...p: string[]) => fs.readFileSync(path.join(ROOT, 'src', ...p), 'utf8');

test('a permission prompt the terminal just reported reads as waiting, over a registry that still says busy', () => {
  clearProgramStatusForTests();
  const registry: Array<{ sessionId: string; name: string; status: string; waitingFor?: string; statusUpdatedAt: number }> = [
    { sessionId: 's1', name: 'a', status: 'busy', statusUpdatedAt: 1000 }, { sessionId: 's2', name: 'b', status: 'busy', statusUpdatedAt: 1000 }];
  assert.equal(noteProgramStatus('s1', `state=blocked:app=claude-code:kind=permission:msg=${b('approve Write: a.txt')}`, 2000), true);
  const out = effectiveSessions(registry);
  assert.equal(out[0].status, 'waiting');
  assert.equal(out[0].waitingFor, 'approve Write: a.txt');
  assert.ok(isBlockedStatus(out[0].status), 'what Ask and the quick bar mark as waiting');
  assert.equal(out[1].status, 'busy', 'a session with no signal keeps its registry status');
  assert.equal(registry[0].status, 'busy', 'the registry list itself is not mutated');
});

test('the probe and unreadable data change nothing; clear withdraws; ended sessions are forgotten', () => {
  clearProgramStatusForTests();
  const reg = [{ sessionId: 's1', status: 'busy', statusUpdatedAt: 1000 }];
  assert.equal(noteProgramStatus('s1', '?', 2000), false);
  assert.equal(noteProgramStatus('s1', 'garbage', 2000), false);
  assert.equal(noteProgramStatus('', 'state=done', 2000), false);
  assert.equal(noteProgramStatus('s1', 'state=done:app=claude-code', 2000), true);
  assert.equal(effectiveSessions(reg)[0].status, 'idle');
  assert.equal(noteProgramStatus('s1', 'state=clear', 3000), true);
  assert.equal(effectiveSessions(reg)[0].status, 'busy');
  noteProgramStatus('s1', 'state=done:app=claude-code', 4000);
  forgetEndedSessions([]);
  assert.equal(effectiveSessions(reg)[0].status, 'busy', 'a signal outlives no session');
});

test('the panel, Ask, the quick bar and the palette all read through effectiveSessions', () => {
  const host = src('main', 'panelHost.ts');
  assert.match(host, /noteProgramStatus\(sessionId, data, at\)/, 'the panel records into the one store');
  assert.match(host, /const running = effectiveSessions\(registry\);\s*lastShownStatuses = running\.map\(\(a\) => a\.status\);\s*this\.attention\.tick\(running/);
  assert.doesNotMatch(host, /new Map<string, ProgramStatus>/, 'no second store in the panel');
  const main = src('main', 'main.ts');
  assert.match(main, /sessions: effectiveSessions\(aios\.listOperatorSessions\(\)\)\.map\(\(s\) => \(\{ name: s\.name, waiting: isBlockedStatus\(s\.status\) \}\)\)/, 'Ask destinations');
  assert.match(main, /sessions: \(\) => effectiveSessions\(aios\.listOperatorSessions\(\)\),/, 'the quick bar');
  assert.match(main, /running: effectiveSessions\(aios\.listOperatorSessions\(\)\),/, 'the palette and the running-sessions picker');
});

const MIN = 60 * 1000;

test('keep-awake: a stale registry that still says busy, with a newer "done" from the terminal, does not hold the machine', () => {
  clearProgramStatusForTests();
  const now = 10 * 60 * MIN;
  const registry = [{ sessionId: 's1', pid: 101, status: 'busy', statusUpdatedAt: now - 30 * MIN }, { sessionId: 's2', pid: 102, status: 'idle', statusUpdatedAt: now - 30 * MIN }];
  assert.equal(sessionsHoldAwake(registry, new Set(), now), true, 'the registry alone holds');
  noteProgramStatus('s1', 'state=done:app=claude-code', now - MIN);
  assert.equal(sessionsHoldAwake(effectiveSessions(registry), new Set(), now), false, 'the session said its turn ended');
});

test('keep-awake: a fresh "working" holds at once, over a registry that still says idle', () => {
  clearProgramStatusForTests();
  const now = 10 * 60 * MIN;
  const registry = [{ sessionId: 's1', pid: 101, status: 'idle', statusUpdatedAt: now - 30 * MIN }];
  assert.equal(sessionsHoldAwake(registry, new Set(), now), false);
  noteProgramStatus('s1', 'state=working:app=claude-code', now - 1000);
  assert.equal(sessionsHoldAwake(effectiveSessions(registry), new Set(), now), true);
});

test('keep-awake: an unapproved permission prompt does not hold the machine, as today; the shell grace counts from the signal', () => {
  clearProgramStatusForTests();
  const now = 10 * 60 * MIN;
  const registry = [{ sessionId: 's1', pid: 101, status: 'busy', statusUpdatedAt: now - 3 * 60 * MIN }];
  noteProgramStatus('s1', 'state=blocked:app=claude-code:kind=permission', now - 5 * MIN);
  assert.equal(sessionsHoldAwake(effectiveSessions(registry), new Set(), now), false, 'waiting is not busy');
  assert.equal(sessionsHoldAwake([{ pid: 101, status: 'waiting', statusUpdatedAt: now - 5 * MIN }], new Set(), now), false, 'nor was it from the registry');
  /* With a shell of its own still running, the hour of grace starts when the terminal said so (5 min ago),
     not at the registry's 3 h old write, which would already have let the machine sleep. */
  assert.equal(sessionsHoldAwake(effectiveSessions(registry), new Set([101]), now), true);
  assert.equal(sessionsHoldAwake(registry.map((a) => ({ ...a, status: 'idle' })), new Set([101]), now), false, 'the registry clock alone: past the grace');
});

test('keep-awake reads through effectiveSessions, over every registered session; signals are pruned against all of them', () => {
  const c = src('main', 'caffeinate.ts');
  assert.match(c, /const agents = effectiveSessions\(aios\.listRunningAgents\(\)\);\s*if \(anyBusy\(agents\.map\(\(a\) => a\.status\)\)\) return true;[^\n]*\n\s*probeShells\(agents\.map\(\(a\) => a\.pid\)\);\s*return sessionsHoldAwake\(agents, awaiting, Date\.now\(\)\);/);
  assert.match(src('main', 'panelHost.ts'), /forgetEndedSessions\(aios\.listRunningAgents\(\)\.map\(\(a\) => a\.sessionId\)\)/,
    'a session the scope filter hides from the panel still has a tab, and keep-awake still reads its signal');
});

test('the unattended updater sees a permission prompt from the terminal, even in a session the panel hides', () => {
  /* busyNow() no longer counts a blocked session as busy, so the "waiting" has to reach the updater's statuses itself,
     or a session hidden by the scope filter, still "busy" in the registry, would let it install and restart under the prompt. */
  assert.match(src('main', 'updater.ts'), /statuses: \[\.\.\.listRunningAgents\(\)\.map\(\(a\) => a\.status\), \.\.\.effectiveSessions\(listRunningAgents\(\)\)\.map\(\(a\) => a\.status\), \.\.\.lastPanelStatuses\(\)\]/);
  clearProgramStatusForTests();
  noteProgramStatus('hidden', 'state=blocked:app=claude-code:kind=permission', 5000);
  const reg = [{ sessionId: 'hidden', pid: 7, status: 'busy', statusUpdatedAt: 1000 }];
  assert.ok(effectiveSessions(reg).some((a) => isBlockedStatus(a.status)));
  assert.equal(sessionsHoldAwake(effectiveSessions(reg), new Set(), 6000), false, 'and busyNow would no longer say busy');
});
