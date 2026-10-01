/**
 * Capture & close must close once the capture is DONE — and never before.
 *
 * Reported on 0.10.0: × on a live session → Capture & close. The capture landed in ~10s, the
 * tab never closed, and the operator clicked again at 3m54s. `watchThenKill` only recognised a
 * finished capture by SAMPLING `busy` on a 2s pulse; a turn that falls between samples leaves
 * the session idle and the wait running out its three minutes. The registry's `statusUpdatedAt`
 * says when the current status began, so an idle that began after the capture was typed is
 * proof the turn ran and ended.
 *
 * The same test had the opposite defect one branch over: after one seen busy it accepted any
 * non-busy status as done, so a capture parked on a permission prompt (`waiting`) had its pane
 * closed mid-capture.
 *
 * These EXECUTE the real `watchThenKill` and `statusInfo`. Against the code before the fix the
 * first two fail: nothing closes in the first, and pane 1 closes while `waiting` in the second.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';

const app = fs.readFileSync('renderer/app.js', 'utf8');

function grab(re: RegExp, what: string): string {
  const m = re.exec(app);
  if (!m) assert.fail(`${what} must be findable in renderer/app.js`);
  return m[0];
}

type Entry = { name: string; id: string; pid: number; status: string; statusUpdatedAt?: number };

function harness(running: Entry[], ticks: Array<(r: Entry[]) => Entry[]>) {
  const panes = new Map<number, { kind: string; name: string; sessionId: string }>([[1, { kind: 'term', name: 'worker', sessionId: 'sA' }]]);
  const pulse = { lastRunning: { running: running.slice() } };
  const closed: number[] = [];
  const closedWhile: string[] = [];
  const toasts: string[] = [];
  const steps = ticks.slice();
  let clock = 0;
  /* Timers resolve at once; each advances the registry one scripted step. The clock moves 1s
     per read, so `typedAt` is 1000 and any statusUpdatedAt above it is "after we typed". */
  const fakeSetTimeout = (fn: () => void) => {
    const step = steps.shift();
    if (step) pulse.lastRunning.running = step(pulse.lastRunning.running);
    fn();
    return 0;
  };
  const src = [
    grab(/function statusInfo\(raw\) \{[\s\S]*?\n\}/, 'statusInfo'),
    grab(/const byName = \(name, id\) => \{[\s\S]*?\n\};/, 'byName'),
    grab(/const ambiguous = \(name\) =>\n[^\n]*;/, 'ambiguous'),
    grab(/const paneOf = \(name, id\) => \{[\s\S]*?\n\};/, 'paneOf'),
    grab(/async function watchThenKill\([\s\S]*?\n\}/, 'watchThenKill'),
  ].join('\n');
  const window = { glassShell: { sessionSignal: async () => true } };
  const quiet = { warn: () => {} };
  const fns = new Function(
    'panes', 'pulse', 'window', 'closePane', 'toast', 't', 'setTimeout', 'Date', 'console',
    `${src}\nreturn { watchThenKill };`,
  )(
    panes, pulse, window,
    (id: number) => { closed.push(id); closedWhile.push(pulse.lastRunning.running.find((e) => e.id === 'sA')?.status ?? 'gone'); panes.delete(id); },
    (m: string) => { toasts.push(m); },
    (k: string) => k,
    fakeSetTimeout,
    { now: () => (clock += 1000) },
    quiet,
  ) as { watchThenKill: (t: unknown[]) => Promise<void> };
  return { ...fns, closed, closedWhile, toasts };
}

const target = [{ name: 'worker', id: 'sA', paneId: 1 }];
const idleBefore = (): Entry[] => [{ name: 'worker', id: 'sA', pid: 101, status: 'idle', statusUpdatedAt: 500 }];

test('a capture that turns over between two samples still closes its tab', async () => {
  const h = harness(idleBefore(), [
    (r) => r,                                                              // grace: not started yet
    (r) => r.map((e) => ({ ...e, status: 'idle', statusUpdatedAt: 4000 })), // busy came and went unseen
  ]);
  await h.watchThenKill(target);
  assert.deepEqual(h.closed, [1], 'an idle entered after the capture was typed means the capture ran and ended');
  assert.deepEqual(h.toasts, [], 'and nothing is reported as left open');
});

test('a capture parked on a permission prompt is never closed mid-capture', async () => {
  const h = harness(idleBefore(), [
    (r) => r,
    (r) => r.map((e) => ({ ...e, status: 'busy', statusUpdatedAt: 3000 })),
    (r) => r.map((e) => ({ ...e, status: 'waiting', statusUpdatedAt: 4000 })),
    (r) => r,
    (r) => r.map((e) => ({ ...e, status: 'busy', statusUpdatedAt: 7000 })),
    (r) => r.map((e) => ({ ...e, status: 'idle', statusUpdatedAt: 8000 })),
  ]);
  await h.watchThenKill(target);
  assert.deepEqual(h.closed, [1], 'it closes once the capture finishes');
  assert.deepEqual(h.closedWhile, ['idle'], 'and not while the session was waiting on the prompt');
});

test('a background shell after the capture counts as done', async () => {
  const h = harness(idleBefore(), [
    (r) => r,
    (r) => r.map((e) => ({ ...e, status: 'busy', statusUpdatedAt: 3000 })),
    (r) => r.map((e) => ({ ...e, status: 'shell', statusUpdatedAt: 4000 })),
  ]);
  await h.watchThenKill(target);
  assert.deepEqual(h.closed, [1]);
});

test('CONTROL: a session whose status never changed after typing is left open and reported', async () => {
  const h = harness(idleBefore(), []);
  await h.watchThenKill(target);
  assert.deepEqual(h.closed, [], 'no evidence the capture ran — an open tab is recoverable, a killed capture is not');
  assert.equal(h.toasts.length, 1, 'so it reports at the deadline');
});
