/** AI-196 — OSC 7501, against the exact payloads measured from Claude Code 2.1.296 in the App's PTY. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseProgramStatus, overlayProgramStatus, registryStatusOf, PROGRAM_STATUS_REPLY, type ProgramStatus } from '../core/programStatus';

const b = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const ROOT = path.join(__dirname, '..', '..');

test('the probe is recognised and the reply is an OSC 7501 that starts with "?"', () => {
  assert.equal(parseProgramStatus('?', 1), 'query');
  assert.equal(PROGRAM_STATUS_REPLY, '\x1b]7501;?\x1b\\', 'what Claude matches: an OSC 7501 whose data starts with "?"');
});

test('the measured payloads parse — msg and title are base64', () => {
  assert.deepEqual(parseProgramStatus('state=working:app=claude-code', 5), { state: 'working', at: 5 });
  const blocked = parseProgramStatus(`state=blocked:app=claude-code:kind=permission:msg=${b('approve Write: /Users/x/code/a.txt')}`, 6) as ProgramStatus;
  assert.equal(blocked.state, 'blocked');
  assert.equal(blocked.kind, 'permission');
  assert.equal(blocked.msg, 'approve Write: /Users/x/code/a.txt');
  const done = parseProgramStatus(`state=done:app=claude-code:msg=${b('greeted user in Spanish, one line, no tools')}`, 7) as ProgramStatus;
  assert.equal(done.msg, 'greeted user in Spanish, one line, no tools');
  assert.equal(parseProgramStatus('state=clear:id=3', 8), 'clear');
  assert.equal(parseProgramStatus('garbage', 9), null);
});

test('blocked means waiting on you; working and done clear it', () => {
  assert.deepEqual(registryStatusOf({ state: 'blocked', kind: 'permission', msg: 'approve Write: a', at: 1 }), { status: 'waiting', waitingFor: 'approve Write: a' });
  assert.deepEqual(registryStatusOf({ state: 'working', at: 1 }), { status: 'busy' });
  assert.deepEqual(registryStatusOf({ state: 'done', at: 1 }), { status: 'idle' });
  assert.equal(registryStatusOf({ state: 'failed', at: 1 }), undefined, 'no opinion: the registry keeps its own');
});

test('the newer of the two sources wins, so neither pins a stale state on the other', () => {
  const reg = [{ sessionId: 's1', status: 'busy', statusUpdatedAt: 1000 }, { sessionId: 's2', status: 'waiting', waitingFor: 'input needed', statusUpdatedAt: 1000 }];
  const sig = new Map<string, ProgramStatus>([
    ['s1', { state: 'blocked', kind: 'permission', msg: 'approve Write: a', at: 2000 }],   // newer → wins
    ['s2', { state: 'working', at: 500 }],                                                  // older → ignored
  ]);
  const out = overlayProgramStatus(reg, sig);
  assert.deepEqual(out[0], { sessionId: 's1', status: 'waiting', waitingFor: 'approve Write: a', statusUpdatedAt: 2000 });
  assert.deepEqual(out[1], reg[1]);
  const answered = overlayProgramStatus([out[0]], new Map([['s1', { state: 'working', at: 3000 }]]));
  assert.equal(answered[0].status, 'busy');
  assert.equal(answered[0].waitingFor, undefined, 'answering the prompt clears what it was waiting for');
});

test('a waiting registry with no clock is never masked by a signal that says otherwise', () => {
  /* Hardening (0.12.0): with no statusUpdatedAt there is nothing to compare, so any signal won and
     a stale "working" could hide "waiting on you" — the only status that notifies. */
  const reg = [{ sessionId: 's1', status: 'waiting', waitingFor: 'approve Bash' }];
  assert.deepEqual(overlayProgramStatus(reg, new Map([['s1', { state: 'working', at: 9e12 }]])), reg, 'working does not hide waiting');
  assert.deepEqual(overlayProgramStatus(reg, new Map([['s1', { state: 'done', at: 9e12 }]])), reg, 'neither does done');
  const blocked = overlayProgramStatus(reg, new Map([['s1', { state: 'blocked', msg: 'approve Write: a', at: 9e12 }]]));
  assert.equal(blocked[0].waitingFor, 'approve Write: a', 'a blocked signal may still sharpen WHAT it waits for');
  const busy = [{ sessionId: 's2', status: 'busy' }];
  assert.equal(overlayProgramStatus(busy, new Map([['s2', { state: 'blocked', at: 1 }]]))[0].status, 'waiting', 'a signal can still RAISE a block on a clockless registry');
});

test('the App answers the probe in every terminal, and relays statuses by session id', () => {
  const app = fs.readFileSync(path.join(ROOT, 'renderer', 'app.js'), 'utf8');
  assert.match(app, /term\.parser\.registerOscHandler\(7501, \(data\) => programStatusOsc\(oscPane, data\)\);\s*const id = await window\.glassShell\.ptySpawn/, 'registered before the pty can emit');
  assert.match(app, /if \(s\.startsWith\('\?'\)\) \{ window\.glassShell\.ptyWrite\(paneId, '\\x1b\]7501;\?\\x1b\\\\'\); return true; \}/);
  const host = fs.readFileSync(path.join(ROOT, 'src', 'main', 'panelHost.ts'), 'utf8');
  assert.match(host, /const running = overlayProgramStatus\(registry, this\.programStatus\);\s*this\.attention\.tick\(running/, 'the badge and banners read the merged list');
});
