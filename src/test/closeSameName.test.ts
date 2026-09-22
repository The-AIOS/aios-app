/**
 * Ending ONE session must never take down another that shares its name.
 *
 * The bug: with two `update` sessions open, killing one from the RUNNING card sent SIGKILL to
 * the right pid and then closed `byName('update')` — the FIRST pane with that name, which was
 * the other session. The operator asked to end one session and lost two. The capture branch
 * (and Close all) had the same defect one level down: `watchThenKill` took names, looked them up
 * in a Map keyed by name, and closed `byName`'s first match once the wait was over.
 *
 * Names are not unique — the registry is one file per pid, so `spawn update` twice gives two
 * live `update` sessions — and the file already says what a destructive caller must do about
 * it: refuse rather than guess. These callers did not.
 *
 * These tests EXECUTE the real `endSession`, `watchThenKill` and pane lookups against two panes
 * sharing a name, because the guarantee is about which pane closes, and a regex can only say
 * the code still looks a certain way. Run against the code before the fix, the first two fail
 * with pane 1 closed where pane 2 was asked for.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';

const app = fs.readFileSync('renderer/app.js', 'utf8');

function grab(re: RegExp, what: string, optional = false): string {
  const m = re.exec(app);
  if (!m && !optional) assert.fail(`${what} must be findable in renderer/app.js`);
  return m ? m[0] : '';
}

type Pane = { kind: string; name: string; sessionId: string | null; exited?: boolean };
type Entry = { name: string; id: string; pid: number; status: string };

/** Two panes named `update`, two live sessions behind them — the case the operator hit. */
function harness(opts: { killBehavior: string; running: Entry[]; panes: Array<[number, Pane]>; ticks?: Array<(r: Entry[]) => Entry[]> }) {
  const panes = new Map<number, Pane>(opts.panes);
  const pulse = { lastRunning: { running: opts.running.slice() } };
  const closed: number[] = [];
  const signals: Array<[number, string]> = [];
  const typed: Array<[number, string]> = [];
  const toasts: string[] = [];
  const ticks = (opts.ticks || []).slice();
  let clock = 0;

  /* Timers resolve at once, and each one advances the registry by one scripted step — that is
     how the capture's seen-busy → gone cycle is played out without waiting three minutes. */
  const fakeSetTimeout = (fn: () => void) => {
    const step = ticks.shift();
    if (step) pulse.lastRunning.running = step(pulse.lastRunning.running);
    fn();
    return 0;
  };
  const fakeDate = { now: () => (clock += 1000) };

  const src = [
    grab(/const byName = \(name, id\) => \{[\s\S]*?\n\};/, 'byName'),
    grab(/const ambiguous = \(name\) =>\n[^\n]*;/, 'ambiguous'),
    grab(/const paneOf = \(name, id\) => \{[\s\S]*?\n\};/, 'paneOf', true),
    grab(/async function watchThenKill\([\s\S]*?\n\}/, 'watchThenKill'),
    grab(/async function endSession\([\s\S]*?\n\}/, 'endSession'),
  ].join('\n');

  const window = { glassShell: { sessionSignal: async (pid: number, sig: string) => { signals.push([pid, sig]); return true; } } };
  const fns = new Function(
    'panes', 'pulse', 'window', 'statusInfo', 'closePane', 'toast', 't', 'submitToPty', 'setActive',
    'KILLBEHAVIOR', 'listModal', 'setTimeout', 'Date',
    `${src}\nreturn { endSession, watchThenKill };`,
  )(
    panes, pulse, window,
    (s: string) => ({ cls: s === 'busy' ? 'busy' : 'idle' }),
    (id: number) => { closed.push(id); panes.delete(id); },
    (m: string) => { toasts.push(m); },
    (k: string, v?: Record<string, string>) => `${k}${v ? '|' + JSON.stringify(v) : ''}`,
    (id: number, text: string) => { typed.push([id, text]); },
    () => {},
    opts.killBehavior,
    async () => null,
    fakeSetTimeout,
    fakeDate,
  ) as { endSession: (a: Record<string, unknown>) => Promise<unknown>; watchThenKill: (t: unknown[]) => Promise<void> };

  return { ...fns, closed, signals, typed, toasts };
}

const twoUpdates = (): Array<[number, Pane]> => [
  [1, { kind: 'term', name: 'update', sessionId: 'sA' }],
  [2, { kind: 'term', name: 'update', sessionId: 'sB' }],
];
const bothLive = (): Entry[] => [
  { name: 'update', id: 'sA', pid: 101, status: 'idle' },
  { name: 'update', id: 'sB', pid: 202, status: 'idle' },
];
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };

test('killing one of two same-named sessions from the RUNNING card closes only that one', async () => {
  const h = harness({ killBehavior: 'kill', running: bothLive(), panes: twoUpdates() });
  /* exactly what the trash button passes for the SECOND session */
  const row = /actBtn\('trash', t\('session\.kill'\), 'kill', \(\) => void endSession\((\{[^)]*\})\)\)/.exec(app);
  assert.ok(row, 'the trash button must still route through endSession');
  const a = { name: 'update', pid: 202, id: 'sB' };
  const args = new Function('a', `return ${row![1]};`)(a) as Record<string, unknown>;
  await h.endSession(args);
  assert.deepEqual(h.signals, [[202, 'SIGKILL']], 'the signal goes to the session that was asked for');
  assert.deepEqual(h.closed, [2], 'and the pane closed is ITS pane — pane 1 belongs to a session nobody asked to end');
});

test('Capture & close on one of two same-named tabs closes that tab once the capture lands', async () => {
  const h = harness({
    killBehavior: 'capture', running: bothLive(), panes: twoUpdates(),
    ticks: [
      (r) => r,                                                                  // grace
      (r) => r.map((e) => (e.id === 'sB' ? { ...e, status: 'busy' } : e)),        // capture starts
      (r) => r.filter((e) => e.id !== 'sB'),                                      // and ends
    ],
  });
  await h.endSession({ name: 'update', paneId: 2 });   // exactly what the tab × passes
  await settle();
  assert.deepEqual(h.typed, [[2, '/aios:close-session --auto']], 'the capture is typed into the pane that was asked for');
  assert.deepEqual(h.closed, [2], 'and the pane closed afterwards is that same pane');
  assert.deepEqual(h.signals, [], 'the other session receives nothing');
});

test('Close all with kill closes the picked session even when its name is shared', async () => {
  const h = harness({
    killBehavior: 'kill', running: bothLive(), panes: twoUpdates(),
    ticks: [(r) => r, (r) => r.map((e) => (e.id === 'sA' ? { ...e, status: 'busy' } : e)), (r) => r.filter((e) => e.id !== 'sA')],
  });
  const call = /void watchThenKill\((picked\.filter[^;]*)\);/.exec(app);
  assert.ok(call, 'closeAllSessions must hand watchThenKill the picked sessions');
  const targets = new Function('picked', 'primary', `return ${call![1]};`)([{ name: 'update', id: 'sA', pid: 101 }], 'aios') as unknown[];
  await h.watchThenKill(targets);
  assert.deepEqual(h.closed, [1]);
  assert.deepEqual(h.signals, []);
});

test('a shared name with no id to tell them apart closes NOTHING — refuse, never guess', async () => {
  const h = harness({ killBehavior: 'kill', running: bothLive(), panes: twoUpdates() });
  await h.endSession({ name: 'update', pid: 202 });
  assert.deepEqual(h.signals, [[202, 'SIGKILL']], 'the pid is unambiguous, so the kill itself still happens');
  assert.deepEqual(h.closed, [], 'but no pane is closed on a coin flip');

  const w = harness({ killBehavior: 'kill', running: bothLive(), panes: twoUpdates() });
  await w.watchThenKill(['update']);
  assert.deepEqual(w.closed, [], 'the waiter cannot tell which registry entry is ours');
  assert.equal(w.toasts.length, 1, 'so it reports at the deadline instead of closing something');
});

test('CONTROL: a unique name with no id still closes its pane', async () => {
  const h = harness({
    killBehavior: 'kill',
    running: [{ name: 'solo', id: 'sC', pid: 303, status: 'idle' }],
    panes: [[7, { kind: 'term', name: 'solo', sessionId: null }]],
  });
  await h.endSession({ name: 'solo', pid: 303 });
  assert.deepEqual(h.closed, [7], 'the fallback by name is kept for the case where it cannot be wrong');
});
