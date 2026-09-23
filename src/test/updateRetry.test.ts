/**
 * A failed framework check retries itself — reported 2026-09-22: Wi-Fi back on showed "can't check"
 * and it never moved until the App was restarted. The reconnect triggered a check at the one moment
 * it is least likely to work (the `online` event fires before DNS is ready), and after that failure
 * the next attempt was the 5-minute poll.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { frameworkCheckable, updateRetryDelay } from '../main/aios';

test('only a check that COULD have worked is worth retrying', () => {
  assert.equal(frameworkCheckable({ repo: 'git@github.com:The-AIOS/aios.git', hash: '585f3d3' }), true,
    'a tracker with a real commit — the unknown came from the network, which a retry can fix');
  assert.equal(frameworkCheckable(null), false, 'no tracker — retrying changes nothing');
  assert.equal(frameworkCheckable({ repo: 'x', hash: 'initial' }), false, 'placeholder hash — "cannot tell", not a failed call');
  assert.equal(frameworkCheckable({ repo: '', hash: '585f3d3' }), false);
});

test('backoff starts short, because the commonest failure is a network that just came back', () => {
  const cap = 5 * 60_000;
  assert.deepEqual([1, 2, 3, 4, 5, 6].map((n) => updateRetryDelay(n, cap)), [5_000, 10_000, 20_000, 40_000, 80_000, 160_000]);
  assert.equal(updateRetryDelay(7, cap), cap, 'and never waits longer than the regular poll');
  assert.equal(updateRetryDelay(50, cap), cap, 'offline for hours costs one check per poll, no more');
});

const aiosSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main', 'aios.ts'), 'utf8');

/**
 * Build a REAL PanelHost with electron stubbed, so the retry is exercised rather than read.
 * This replaced a regex over postUpdateStatus that matched `state === 'unknown' && …` — and still
 * matched after the condition was turned into `false && state === 'unknown' && …`. It passed the
 * very mutation that disables the retry: a guard sensitive to spelling, blind to behaviour.
 */
function realHost(check: () => 'up-to-date' | 'available' | 'unknown', checkable: boolean) {
  const Module = require('module') as { _load(r: string, p: unknown, m: boolean): unknown };
  const win = { isDestroyed: () => false, isVisible: () => true, isMinimized: () => false };
  const electron = {
    BrowserWindow: { fromWebContents: () => win },
    nativeImage: { createFromDataURL: () => ({}) },
    app: { setBadgeCount: () => { /* */ } },
    Notification: Object.assign(class { on() { return this; } show() { /* */ } }, { isSupported: () => false }),
  };
  const orig = Module._load;
  Module._load = function (this: unknown, r: string, p: unknown, m: boolean) { return r === 'electron' ? electron : orig.call(this, r, p, m); } as typeof Module._load;
  try {
    for (const k of Object.keys(require.cache)) if (/[\\/]main[\\/](panelHost|attention)\.js$/.test(k)) delete require.cache[k];
    const aios = require('../main/aios') as Record<string, unknown>;
    const saved = { c: aios.checkForUpdates, r: aios.readFrameworkStatus };
    aios.checkForUpdates = () => Promise.resolve(check());
    aios.readFrameworkStatus = () => (checkable ? { repo: 'https://github.com/The-AIOS/aios.git', hash: '585f3d3' } : null);
    const { PanelHost } = require('../main/panelHost') as { PanelHost: new (wc: unknown) => { postUpdateStatus(): void; onMessage(m: unknown): void } };
    const posted: unknown[] = [];
    const h = new PanelHost({ isDestroyed: () => false, send: (_c: string, m: unknown) => posted.push(m) });
    const restore = () => { aios.checkForUpdates = saved.c; aios.readFrameworkStatus = saved.r; };
    return { h, posted, restore };
  } finally { Module._load = orig; }
}

test('a failed check that COULD have worked schedules its own retry — and an answer cancels it', async () => {
  const delays: number[] = [];
  const realST = global.setTimeout, realCT = global.clearTimeout;
  let pending = 0;
  (global as unknown as { setTimeout: unknown }).setTimeout = ((_fn: () => void, ms: number) => { delays.push(ms); return ++pending; });
  (global as unknown as { clearTimeout: unknown }).clearTimeout = (() => { /* */ });
  let answer: 'unknown' | 'up-to-date' = 'unknown';
  const { h, posted, restore } = realHost(() => answer, true);
  try {
    h.postUpdateStatus(); await new Promise((r) => setImmediate(r));
    h.postUpdateStatus(); await new Promise((r) => setImmediate(r));
    assert.deepEqual(delays.filter((d) => d <= 5 * 60_000), [5_000, 10_000],
      'Wi-Fi back, DNS not ready: retry in 5s, then 10s — not "wait for the 5-minute poll"');
    /* The header's word comes from here: main says whether it armed a retry, so "retrying…" is
       never shown for an unknown that nothing is going to retry. */
    const last = posted.filter((m) => (m as { type?: string }).type === 'updateStatus').at(-1) as { retrying?: boolean };
    assert.equal(last?.retrying, true, 'a fixable failure is reported as retrying');
    answer = 'up-to-date';
    const before = delays.length;
    h.postUpdateStatus(); await new Promise((r) => setImmediate(r));
    assert.equal(delays.length, before, 'an answer arrives → nothing more is scheduled: no work on a healthy window');
  } finally { restore(); global.setTimeout = realST; global.clearTimeout = realCT; }
});

test('RECONNECTING after a long offline starts the backoff over — the case the operator hit', async () => {
  /* Offline for a couple of minutes grows the backoff (5s, 10s, 20s, 40s, 80s…). The reconnect
     check fails once because DNS is not ready, and without a reset the next retry was 160s away —
     "can't check" until clicked. Reproduced with the real checker before the reset existed:
     network up at 3s, no answer at 25s. */
  const delays: number[] = [];
  const realST = global.setTimeout, realCT = global.clearTimeout;
  (global as unknown as { setTimeout: unknown }).setTimeout = ((_fn: () => void, ms: number) => { delays.push(ms); return 1; });
  (global as unknown as { clearTimeout: unknown }).clearTimeout = (() => { /* */ });
  const { h, restore } = realHost(() => 'unknown', true);
  try {
    (h as unknown as { updFailures: number }).updFailures = 5;          // ~2.5 min offline already
    (h as unknown as { onMessage(m: unknown): void }).onMessage({ type: 'recheck' });   // the online event
    await new Promise((r) => setImmediate(r));
    assert.equal(delays.filter((d) => d <= 5 * 60_000).at(-1), 5_000,
      'the first retry after reconnecting is 5s — not the 160s the offline streak had grown to');
  } finally { restore(); global.setTimeout = realST; global.clearTimeout = realCT; }
});

test('no tracker at all is NOT retried — nothing a retry could change', async () => {
  const delays: number[] = [];
  const realST = global.setTimeout;
  (global as unknown as { setTimeout: unknown }).setTimeout = ((_fn: () => void, ms: number) => { delays.push(ms); return 1; });
  const { h, posted, restore } = realHost(() => 'unknown', false);
  try {
    h.postUpdateStatus(); await new Promise((r) => setImmediate(r));
    assert.deepEqual(delays, [], '"Not tracked yet" is a state, not a failed call');
    const last = posted.filter((m) => (m as { type?: string }).type === 'updateStatus').at(-1) as { retrying?: boolean };
    assert.equal(last?.retrying, false, 'and is never labelled "retrying…"');
  } finally { restore(); global.setTimeout = realST; }
});

test('ONE rule decides "checkable" — the check and its retry cannot disagree', () => {
  const i = aiosSrc.indexOf('export function checkForUpdates()');
  const body = aiosSrc.slice(i, aiosSrc.indexOf('\n}\n', i));
  assert.match(body, /frameworkCheckable\(status\)/, 'checkForUpdates uses the shared rule');
  assert.doesNotMatch(body, /\[0-9a-f\]\{7,40\}/, 'and no longer carries its own copy of it');
});
