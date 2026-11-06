/**
 * Resuming several closed sessions starts them one at a time.
 *
 * Each `claude --resume` starts its own copy of every configured MCP server, so starting them all
 * in the same second makes the heavier local servers miss their connect window in every session.
 * These EXECUTE the real functions out of renderer/app.js: what matters is when each process
 * starts, and only running the code can say that.
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

type Pick = { id: string; name: string };
type Pane = { exited: boolean };
type Opts = {
  live?: (id: string, looks: number) => boolean;
  refuse?: string[];
  open?: string[];
  exitsAt?: Record<string, number>;
};

function harness(opts: Opts = {}) {
  const clock = { now: 1000 };
  const panes = new Map<string, Pane>();
  const starts: { name: string; at: number; background: boolean }[] = [];
  const toasts: string[] = [];
  const looks: Record<string, number> = {};
  for (const n of opts.open ?? []) panes.set('open-' + n, { exited: false });
  const createPane = async ({ name, background }: { name: string; background: boolean }) => {
    starts.push({ name, at: clock.now, background: !!background });
    if (opts.refuse?.includes(name)) return null;
    panes.set('pane-' + name, { exited: false });
    return 'pane-' + name;
  };
  const sessionIsLive = async (id: string) => {
    looks[id] = (looks[id] ?? 0) + 1;
    const exit = opts.exitsAt?.[id];
    if (exit !== undefined && looks[id] >= exit) { panes.get('pane-' + id)!.exited = true; return false; }
    return (opts.live ?? (() => true))(id, looks[id]);
  };
  const src = [
    grab(/const UNATTENDED_WINDOW_MS = [\s\S]*?\nconst RESUME_QUOTA_DIALOG = [^\n]*\n/, 'the unattended constants'),
    grab(/const sleepMs = [^\n]*\n/, 'sleepMs'),
    grab(/async function waitUntilLive\(sessionId, isOpen\) \{[\s\S]*?\n\}/, 'waitUntilLive'),
    grab(/async function resumeInSequence\(picked\) \{[\s\S]*?\n\}/, 'resumeInSequence'),
    'return resumeInSequence;',
  ].join('\n');
  const run = new Function('panes', 'createPane', 'byName', 'shq', 'CLAUDE', 'window', 'toast', 't', 'setTimeout', 'Date', src)(
    panes, createPane,
    (n: string) => (panes.has('open-' + n) ? ['open-' + n] : null),
    (x: string) => x, 'claude', { glassShell: { sessionIsLive } },
    (m: string) => toasts.push(m), (k: string, v: { name?: string; live?: number; n?: number; i?: number }) => (v.name !== undefined ? `${k}:${v.name}` : `${k}:${v.live ?? ''}/${v.n}`),
    (fn: () => void, ms: number) => { clock.now += ms; queueMicrotask(fn); return 0; },
    { now: () => clock.now }) as (p: Pick[]) => Promise<void>;
  return { run, starts, toasts, clock };
}
const pick = (...names: string[]): Pick[] => names.map((name) => ({ id: name, name }));

test('no two sessions start in the same instant, and each waits for the previous to be live', async () => {
  const h = harness({ live: (id, n) => id !== 'one' || n >= 3 });
  await h.run(pick('one', 'two', 'three'));
  assert.deepEqual(h.starts.map((s) => s.name), ['one', 'two', 'three'], 'all of them, in the order ticked');
  assert.equal(h.starts[1].at - h.starts[0].at, 2 * 2000 + 4000, 'two waits for one (two polls) plus the gap');
  assert.equal(h.starts[2].at - h.starts[1].at, 4000, 'three waits the gap after two, already live');
});

test('only the first session takes the focus', async () => {
  const h = harness();
  await h.run(pick('one', 'two', 'three'));
  assert.deepEqual(h.starts.map((s) => s.background), [false, true, true]);
});

test('a session that never comes up is said, and holds the rest back only up to the cap', async () => {
  const h = harness({ live: (id) => id !== 'stuck' });
  await h.run(pick('stuck', 'next'));
  assert.deepEqual(h.toasts.filter((m) => m.startsWith('unattended.')), ['unattended.notLive:stuck']);
  const waited = h.starts[1].at - h.starts[0].at;
  assert.ok(waited >= 90_000 && waited <= 90_000 + 2000 + 4000, `waited ${waited} ms`);
});

test('a session whose pane exits stops being waited for', async () => {
  const h = harness({ live: () => false, exitsAt: { gone: 2 } });
  await h.run(pick('gone', 'next'));
  assert.deepEqual(h.starts.map((s) => s.name), ['gone', 'next']);
  assert.ok(h.starts[1].at - h.starts[0].at < 10_000, 'no reason to sit out the cap');
});

test('a refused or already open session is skipped without a wait and without taking the first slot', async () => {
  const h = harness({ refuse: ['held'], open: ['open'] });
  await h.run(pick('open', 'held', 'one', 'two'));
  assert.deepEqual(h.starts.map((s) => s.name), ['held', 'one', 'two'], 'an open session is not started again');
  assert.equal(h.starts[0].at, h.starts[1].at, 'nothing was started, so nothing to wait for');
  assert.deepEqual(h.starts.slice(1).map((s) => s.background), [false, true], 'the first that really starts takes the focus');
});

test('the picker hands over to the sequence and returns', () => {
  const body = grab(/async function batchResume\(\) \{[\s\S]*?\n\}/, 'batchResume');
  assert.match(body, /void resumeInSequence\(picked\)/);
  assert.doesNotMatch(body, /createPane\(\{ name: nm/, 'no session is started from the picker itself');
});

test('0.15.0 round: the wait says what it is doing, one line per start, and how it ended', async () => {
  const h = harness({ live: (id) => id !== 'stuck' });
  await h.run(pick('one', 'stuck', 'two'));
  assert.deepEqual(h.toasts, [
    'resume.progress:one', 'resume.progress:stuck', 'unattended.notLive:stuck', 'resume.progress:two', 'resume.someUp:2/3',
  ]);
  const ok = harness();
  await ok.run(pick('one', 'two'));
  assert.deepEqual(ok.toasts, ['resume.progress:one', 'resume.progress:two', 'resume.allUp:/2'], 'all up: said once at the end');
  const single = harness();
  await single.run(pick('one'));
  assert.deepEqual(single.toasts, [], 'one session needs no running commentary (the picker already said it is resuming)');
  const open = harness({ open: ['one'] });
  await open.run(pick('one', 'two'));
  assert.deepEqual(open.toasts, [], 'an already open session is not counted: one left to start, no progress lines');
});

test('every locale has the resume progress lines with the same placeholders', () => {
  for (const loc of ['en', 'es', 'pt-br', 'el']) {
    const j = JSON.parse(fs.readFileSync(`src/i18n/locales/${loc}.json`, 'utf8')) as Record<string, string>;
    for (const [k, ph] of [['resume.progress', ['{i}', '{n}', '{name}']], ['resume.allUp', ['{n}']], ['resume.someUp', ['{live}', '{n}']]] as const) {
      assert.ok(j[k], `${loc} ${k}`);
      for (const p of ph) assert.ok(j[k].includes(p), `${loc} ${k} keeps ${p}`);
    }
  }
});
