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

test('the keep-awake driver still reads the registry (its timing is a separate decision)', () => {
  const c = src('main', 'caffeinate.ts');
  assert.match(c, /const agents = aios\.listRunningAgents\(\);/);
  assert.doesNotMatch(c, /effectiveSessions/);
});
