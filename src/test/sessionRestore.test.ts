/**
 * #28 — the sessions that were open at quit are the ones offered back at launch.
 *
 * The first build of this shipped a smoke gate that proved the PLACEHOLDER mechanics — a restored
 * tab is marked, costs nothing, is saved, leaves when closed — and it passed. It could not have
 * caught the bug the operator hit on the first real test: open four sessions, quit, relaunch, and
 * nothing is offered. The gate built its test tab with an id already on it; a real session only
 * gets one when its terminal title matches the registry, which reaches the renderer on a 2s poll,
 * and a freshly started idle session announces its title once — usually before that poll. So no
 * real session was ever identified, and nothing was stored.
 *
 * These tests EXECUTE the real `adoptUnidentified`, `sessionsSnapshot` and `persistSessions`
 * against panes shaped exactly like fresh sessions — no id — with the process-tree lookup faked.
 * The guarantee is about what ends up stored, and only running the code can say that.
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

type Pane = { kind: string; name: string; cmd?: string; sessionId?: string | null; exited?: boolean;
              isSession?: boolean; confirmedName?: string | null; manualName?: boolean; cwd?: string };

function harness(panesIn: Array<[number, Pane]>, lookup: (ids: number[]) => Record<number, { id: string; name: string; pid: number }>) {
  const panes = new Map<number, Pane>(panesIn);
  const tabOrder = { main: [] as number[], term: panesIn.map(([id]) => id) };
  const active: Record<string, number | null> = { main: null, term: panesIn[0]?.[0] ?? null };
  const store: Record<string, string> = {};
  const calls: number[][] = [];
  const localStorage = { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; } };
  const glassShell = { sessionUnder: (ids: number[]) => { calls.push(ids.slice()); return Promise.resolve(lookup(ids)); } };
  const src = [
    'let restoreQuitting = false; let restoreTimer = 0; let restorePending = null;',
    "const RESTORE_KEY = 'shellSessions';",
    "const CLAUDE = 'claude';",
    grab(/function paneIsClaude\(cmd\) \{[\s\S]*?\n\}/, 'paneIsClaude'),
    grab(/function sessionsSnapshot\(\) \{[\s\S]*?\n\}/, 'sessionsSnapshot'),
    grab(/function persistSessions\(\) \{[\s\S]*?\n\}/, 'persistSessions'),
    grab(/let adoptInFlight = false;\nfunction adoptUnidentified\(\) \{[\s\S]*?\n\}/, 'adoptUnidentified'),
    'return { adoptUnidentified, sessionsSnapshot };',
  ].join('\n');
  // Timers fire at once: persistSessions debounces by 250ms, which a test must not wait for.
  const now = (fn: () => void) => { fn(); return 0; };
  const api: { adoptUnidentified: () => void; sessionsSnapshot: () => unknown } = new Function('panes', 'tabOrder', 'active', 'localStorage', 'window', 'setTimeout', 'clearTimeout', src)(
    panes, tabOrder, active, localStorage, { glassShell }, now, () => { /* */ });
  const stored = () => JSON.parse(store.shellSessions || '{"sessions":[]}').sessions as Array<{ sessionId: string; name: string }>;
  const settle = () => new Promise((r) => setImmediate(r));
  return { ...api, panes, calls, stored, settle };
}

const fresh = (name: string): Pane => ({ kind: 'term', name, cmd: `claude --name ${name}`, sessionId: null, isSession: true });
const ids = { 1: 'aaaaaaaa-0000-4000-8000-000000000001', 2: 'aaaaaaaa-0000-4000-8000-000000000002',
              3: 'aaaaaaaa-0000-4000-8000-000000000003', 4: 'aaaaaaaa-0000-4000-8000-000000000004' } as Record<number, string>;

test('THE REPORTED CASE: four fresh sessions, none identified by title, all four are stored', async () => {
  const h = harness([[1, fresh('a')], [2, fresh('b')], [3, fresh('c')], [4, fresh('d')]],
    (want) => Object.fromEntries(want.map((id) => [id, { id: ids[id], name: 'abcd'[id - 1], pid: 100 + id }])));
  assert.equal(h.stored().length, 0, 'before: nothing — exactly what the operator saw on relaunch');
  h.adoptUnidentified();
  await h.settle();
  assert.deepEqual(h.stored().map((s) => s.sessionId), [ids[1], ids[2], ids[3], ids[4]],
    'every session open at quit is in the list, in tab order');
  for (const id of [1, 2, 3, 4]) {
    assert.equal(h.panes.get(id)?.confirmedName, 'abcd'[id - 1],
      'an adopted pane also gets confirmedName — the liveness pass keys on it to notice an ending');
  }
});

test('a session not registered YET is retried on the next poll, not given up on', async () => {
  let registered = false;
  const h = harness([[1, fresh('a')]], (want) => (registered ? { [want[0]]: { id: ids[1], name: 'a', pid: 101 } } : {}));
  h.adoptUnidentified();
  await h.settle();
  assert.equal(h.stored().length, 0, 'claude still starting — nothing to adopt yet');
  registered = true;
  h.adoptUnidentified();
  await h.settle();
  assert.equal(h.stored()[0]?.sessionId, ids[1], 'the next poll finds it');
});

test('BOUNDED: nothing is asked once every pane has an id, and plain terminals are never asked about', async () => {
  const h = harness([[1, { ...fresh('a'), sessionId: ids[1] }], [2, { kind: 'term', name: 'zsh', cmd: '', isSession: false }]],
    () => ({}));
  h.adoptUnidentified();
  h.adoptUnidentified();
  await h.settle();
  /* No request at all: an identified pane has nothing to learn, and a plain shell will never have
     a session — asking about it every 2s forever would be periodic work on an idle window, which
     is the shape of cost AI-157 taught us to refuse. */
  assert.equal(h.calls.length, 0);
});

test('one request at a time — polls that arrive while one is in flight do not pile up', async () => {
  let release: () => void = () => { /* */ };
  const gate = new Promise<void>((r) => { release = r; });
  const panesIn: Array<[number, Pane]> = [[1, fresh('a')]];
  const h = harness(panesIn, () => ({}));
  // hold the first request open, then fire two more polls
  const slow = { sessionUnder: (want: number[]) => { h.calls.push(want); return gate.then(() => ({})); } };
  const src = [
    'let restoreQuitting = false; let restoreTimer = 0; let restorePending = null;',
    "const RESTORE_KEY = 'shellSessions'; const CLAUDE = 'claude';",
    grab(/function paneIsClaude\(cmd\) \{[\s\S]*?\n\}/, 'paneIsClaude'),
    grab(/function sessionsSnapshot\(\) \{[\s\S]*?\n\}/, 'sessionsSnapshot'),
    grab(/function persistSessions\(\) \{[\s\S]*?\n\}/, 'persistSessions'),
    grab(/let adoptInFlight = false;\nfunction adoptUnidentified\(\) \{[\s\S]*?\n\}/, 'adoptUnidentified'),
    'return adoptUnidentified;',
  ].join('\n');
  const adopt = new Function('panes', 'tabOrder', 'active', 'localStorage', 'window', 'setTimeout', 'clearTimeout', src)(
    new Map(panesIn), { main: [], term: [1] }, { term: 1 }, { getItem: () => null, setItem: () => { /* */ } },
    { glassShell: slow }, (fn: () => void) => { fn(); return 0; }, () => { /* */ });
  adopt(); adopt(); adopt();
  assert.equal(h.calls.length, 1, 'three polls, one request');
  release();
  await new Promise((r) => setImmediate(r));
});

test('the adoption runs from the same poll that reconciles panes', () => {
  assert.match(app, /function renderPulseRunning\(m\) \{[\s\S]*?adoptUnidentified\(\);/,
    'wired into the 2s pulse — a function nobody calls fixes nothing');
});
