/**
 * AI-153 — counters that only moved on a restart. agents / skills / commands are read from framework
 * folders nothing watches, frequent tasks from a file Glass writes, the nudge from the clock: none of
 * them re-pushed, so the panel showed whatever was true at launch.
 *
 * The fix is a change-GATED re-check (a 30s poll while visible, plus window focus), not more
 * watchers — a watcher on a path the App itself writes can feed itself, and a redraw loop is the
 * one bug class this ship must not add (AI-157). So the property under test is two-sided:
 * a changed counter posts exactly once, and an unchanged window posts NOTHING.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

type Host = { postState(): void; refreshStateIfChanged(): void; start(): void; dispose(): void };

function realHost(visible: () => boolean) {
  const Module = require('module') as { _load(r: string, p: unknown, m: boolean): unknown };
  const win = { isDestroyed: () => false, isVisible: visible, isMinimized: () => false };
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
    const saved = aios.discoverAgents;
    let agents = 3;
    aios.discoverAgents = () => Array.from({ length: agents }, (_, i) => ({ name: 'a' + i }));
    const { PanelHost } = require('../main/panelHost') as { PanelHost: new (wc: unknown) => Host };
    const posted: { type?: string }[] = [];
    const h = new PanelHost({ isDestroyed: () => false, send: (_c: string, m: { type?: string }) => posted.push(m) });
    const states = () => posted.filter((m) => m.type === 'state').length;
    return { h, states, setAgents: (n: number) => { agents = n; }, restore: () => { aios.discoverAgents = saved; } };
  } finally { Module._load = orig; }
}

test('an unchanged window posts NOTHING — the re-check cannot become a redraw loop', () => {
  const { h, states, restore } = realHost(() => true);
  try {
    h.postState();
    const base = states();
    for (let i = 0; i < 5; i++) h.refreshStateIfChanged();
    assert.equal(states(), base,
      'five checks over an idle vault: zero posts. If this fails, some field of the snapshot changes on its own (a timestamp, a relative time) and every poll repaints the panel');
  } finally { restore(); }
});

test('a counter that changed is posted once — then the gate closes again', () => {
  const { h, states, setAgents, restore } = realHost(() => true);
  try {
    h.postState();
    const base = states();
    setAgents(4);                       // an agent file appeared under agents/ — nothing watches it
    h.refreshStateIfChanged();
    assert.equal(states(), base + 1, 'the new count reaches the panel without a restart');
    h.refreshStateIfChanged();
    h.refreshStateIfChanged();
    assert.equal(states(), base + 1, 'and is not re-sent while it stays the same');
  } finally { restore(); }
});

test('the poll runs only while someone can see the window', () => {
  const ticks: (() => void)[] = [];
  const realSI = global.setInterval, realCI = global.clearInterval;
  (global as unknown as { setInterval: unknown }).setInterval = ((fn: () => void) => { ticks.push(fn); return ticks.length; });
  (global as unknown as { clearInterval: unknown }).clearInterval = (() => { /* */ });
  let shown = false;
  const { h, states, setAgents, restore } = realHost(() => shown);
  try {
    (h as unknown as { wireWatchers(): void }).wireWatchers = () => { /* no fs watchers in a unit test */ };
    h.start();
    h.postState();
    const base = states();
    setAgents(7);
    for (const t of ticks) { try { t(); } catch { /* the running-sessions poll needs a process table */ } }
    assert.equal(states(), base, 'hidden: counters changed, nothing is posted — the focus check catches up');
    shown = true;
    for (const t of ticks) { try { t(); } catch { /* */ } }
    assert.equal(states(), base + 1, 'visible: the next tick delivers it');
  } finally { restore(); global.setInterval = realSI; global.clearInterval = realCI; }
});
