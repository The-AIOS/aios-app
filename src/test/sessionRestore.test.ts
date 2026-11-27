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
    // Tab groups ride in the snapshot; no group here, so the real lookup over an empty set.
    'const tabGroups = new Map();',
    grab(/const tgOf = [^\n]*\n/, 'tgOf'),
    grab(/function paneIsClaude\(cmd\) \{[\s\S]*?\n\}/, 'paneIsClaude'),
    grab(/function sessionsSnapshot\(\) \{[\s\S]*?\n\}/, 'sessionsSnapshot'),
    grab(/function persistSessions\(\) \{[\s\S]*?\n\}/, 'persistSessions'),
    grab(/function adoptUnidentified\(m\) \{[\s\S]*?\n\}/, 'adoptUnidentified'),
    'return { adoptUnidentified, sessionsSnapshot };',
  ].join('\n');
  // Timers fire at once: persistSessions debounces by 250ms, which a test must not wait for.
  const now = (fn: () => void) => { fn(); return 0; };
  const api: { adoptUnidentified: (m?: unknown) => void; sessionsSnapshot: () => unknown } = new Function('panes', 'tabOrder', 'active', 'localStorage', 'window', 'setTimeout', 'clearTimeout', src)(
    panes, tabOrder, active, localStorage, { glassShell }, now, () => { /* */ });
  const stored = () => JSON.parse(store.shellSessions || '{"sessions":[]}').sessions as Array<{ sessionId: string; name: string }>;
  const settle = () => new Promise((r) => setImmediate(r));
  return { ...api, panes, calls, stored, settle };
}

const fresh = (name: string): Pane => ({ kind: 'term', name, cmd: `claude --name ${name}`, sessionId: null, isSession: true });
const ids = { 1: 'aaaaaaaa-0000-4000-8000-000000000001', 2: 'aaaaaaaa-0000-4000-8000-000000000002',
              3: 'aaaaaaaa-0000-4000-8000-000000000003', 4: 'aaaaaaaa-0000-4000-8000-000000000004' } as Record<number, string>;

/* What main sends on each pulse: every running row carries the pane its tree walk found it under. */
type Row = { id: string; name: string; pane?: number };
const pulseOf = (rows: Row[]) => ({ running: rows });
const none = () => ({});

test('THE REPORTED CASE: four fresh sessions, none identified by title, all four are stored', () => {
  const h = harness([[1, fresh('a')], [2, fresh('b')], [3, fresh('c')], [4, fresh('d')]], none);
  assert.equal(h.stored().length, 0, 'before: nothing — exactly what the operator saw on relaunch');
  h.adoptUnidentified(pulseOf([1, 2, 3, 4].map((id) => ({ id: ids[id], name: 'abcd'[id - 1], pane: id }))));
  assert.deepEqual(h.stored().map((s) => s.sessionId), [ids[1], ids[2], ids[3], ids[4]],
    'every session open at quit is in the list, in tab order');
  for (const id of [1, 2, 3, 4]) {
    assert.equal(h.panes.get(id)?.confirmedName, 'abcd'[id - 1],
      'an adopted pane also gets confirmedName — the liveness pass keys on it to notice an ending');
  }
});

test('a session not registered YET is picked up on the next poll, not given up on', () => {
  const h = harness([[1, fresh('a')]], none);
  h.adoptUnidentified(pulseOf([]));
  assert.equal(h.stored().length, 0, 'claude still starting — nothing to adopt yet');
  h.adoptUnidentified(pulseOf([{ id: ids[1], name: 'a', pane: 1 }]));
  assert.equal(h.stored()[0]?.sessionId, ids[1], 'the next poll finds it');
});

test('#223: a session typed by hand into a plain terminal tab is bound to that tab', () => {
  /* A plain tab (`zsh -l`) in which the operator typed `claude`. Its launch command is the shell, so the old adoption never
     asked about it: the side panel, filled from main's tree walk, showed it working while the tab stayed a grey terminal. */
  const h = harness([[1, { kind: 'term', name: 'zsh', cmd: '', isSession: false, sessionId: null }]], none);
  h.adoptUnidentified(pulseOf([{ id: ids[1], name: 'm-lectura', pane: 1 }]));
  assert.equal(h.panes.get(1)?.sessionId, ids[1], 'the tab holds the session main found beneath its pty');
  assert.equal(h.panes.get(1)?.confirmedName, 'm-lectura', 'and is confirmed, so the liveness pass notices when it ends');
  assert.equal(h.panes.get(1)?.isSession, true);
});

test('the binding never overwrites, and only a live terminal pane is bound', () => {
  const h = harness([
    [1, { ...fresh('a'), sessionId: ids[1] }],                                   // already holds a session
    [2, { kind: 'term', name: 'zsh', cmd: '', exited: true, sessionId: null }],  // its shell has exited
    [3, { kind: 'file', name: 'note.md', sessionId: null }],                     // not a terminal
  ], none);
  h.adoptUnidentified(pulseOf([{ id: ids[2], name: 'x', pane: 1 }, { id: ids[3], name: 'y', pane: 2 }, { id: ids[4], name: 'z', pane: 3 },
    { id: 'outside', name: 'elsewhere' }]));   // a session in Terminal.app: no pane at all
  assert.equal(h.panes.get(1)?.sessionId, ids[1], 'a tab keeps its session; a changed id is followRotatedId\'s job');
  assert.equal(h.panes.get(2)?.sessionId, null);
  assert.equal(h.panes.get(3)?.sessionId, null);
});

test('ONE METHOD: adoption asks nothing of its own — no request, no `ps`, on any pulse', () => {
  /* It used to call `session:under` and bound that with an in-flight flag and a filter. The answer now arrives with the pulse,
     from the walk main already made for the panel, so a plain shell on an idle window costs nothing here. */
  const h = harness([[1, fresh('a')], [2, { kind: 'term', name: 'zsh', cmd: '', isSession: false, sessionId: null }]], none);
  h.adoptUnidentified(pulseOf([{ id: ids[1], name: 'a', pane: 1 }]));
  h.adoptUnidentified(pulseOf([]));
  h.adoptUnidentified();
  assert.equal(h.calls.length, 0);
  assert.doesNotMatch(grab(/function adoptUnidentified\(m\) \{[\s\S]*?\n\}/, 'adoptUnidentified'), /glassShell|sessionUnder/);
});

test('#223: main sends each row\'s pane from the SAME tree walk the panel\'s list came from', () => {
  const host = fs.readFileSync('src/main/panelHost.ts', 'utf8');
  assert.match(host, /const paneOf = aios\.paneOfSessions\(aios\.listRunningAgents\(\)\.filter\(aios\.isOperatorSession\)\);/,
    'the input listOperatorSessions() walks, so the memoized walk is reused rather than a second `ps` per pulse');
  assert.match(host, /pane: paneOf\.get\(a\.sessionId\)/, 'and every running row carries it');
  const core = fs.readFileSync('src/main/aios.ts', 'utf8');
  assert.match(core, /const all = listRunningAgents\(\)\.filter\(isOperatorSession\);[\s\S]{0,900}?paneSessionIdsFromTree\(all\)/,
    'the walk this reuses — if listOperatorSessions stops making it, the reuse claim above is false');
  assert.match(core, /export function paneSessionIdsFromTree[\s\S]{0,200}?return walkTree\(running, procTable\)\.ids;/,
    'membership (panel) and binding (tab) are two readings of one walk');
  assert.match(core, /export function paneOfSessions[\s\S]{0,300}?walkTree\(running, procTable\)\.ptyOf/);
});

test('the adoption runs from the same poll that reconciles panes', () => {
  assert.match(app, /function renderPulseRunning\(m\) \{[\s\S]*?adoptUnidentified\(pulse\.lastRunning\);/,
    'wired into the 2s pulse — a function nobody calls fixes nothing');
});
