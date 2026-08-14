/**
 * AI-83 — the update pill must show the DOWNLOAD, not only its end.
 *
 * The bug: the pill appeared only on `update-downloaded`. The payload is 108–131 MB depending
 * on platform, so between "an update exists" and "the pill appears" the app KNEW and showed
 * nothing for minutes. Measured twice on the same operator across two releases; the second time
 * he stopped waiting for the pill and used File › Check for Updates instead — the tell that a
 * papercut had become the interface.
 *
 * These tests EXECUTE `showUpdatePill` against a fake DOM rather than pattern-matching the
 * source. The distinction matters here: the guarantee is about what a user can *click*, and a
 * regex can only confirm the code still looks a certain way. The specific thing that must never
 * regress is that the downloading state is NOT actionable — `updaterInstall()` mid-download
 * fails, so offering it would be worse than showing nothing.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';

const app = fs.readFileSync('renderer/app.js', 'utf8');

/** A DOM thin enough to run one function, honest enough to catch a real mistake. */
type FakeEl = {
  id: string; className: string; textContent: string; title: string; hidden: boolean;
  disabled: boolean; dataset: Record<string, string>; classes: Set<string>;
  classList: { toggle: (c: string, on: boolean) => void };
  addEventListener: (ev: string, fn: () => unknown) => void;
  handlers: Record<string, Array<() => unknown>>;
  appendChild: (c: FakeEl) => void;
};

function harness() {
  const mk = (): FakeEl => {
    const el: FakeEl = {
      id: '', className: '', textContent: '', title: '', hidden: true, disabled: false,
      dataset: {}, classes: new Set<string>(), handlers: {},
      classList: { toggle: (c, on) => { if (on) el.classes.add(c); else el.classes.delete(c); } },
      addEventListener: (ev, fn) => { (el.handlers[ev] ||= []).push(fn); },
      appendChild: () => { /* container semantics are not what this tests */ },
    };
    return el;
  };
  const acts = mk();
  const byId: Record<string, FakeEl> = { dragacts: acts };
  const document = {
    getElementById: (id: string) => byId[id] ?? null,
    createElement: () => {
      const el = mk();
      // The real DOM does not register by id on create; showUpdatePill sets .id then appends.
      setTimeout(() => { /* no-op: registration happens via the Proxy below */ }, 0);
      return el;
    },
  };
  /* showUpdatePill looks the pill up by id on every call, so the harness has to remember the
     element it created — that is exactly the create-once-then-reuse path being tested. */
  const origCreate = document.createElement;
  document.createElement = () => { const el = origCreate(); byId['updPill'] = el; return el; };

  const t = (key: string, vars?: Record<string, string>) =>
    `${key}${vars ? '|' + JSON.stringify(vars) : ''}`;

  const m = /function showUpdatePill\(version, state = 'ready', pct = null\) \{[\s\S]*?\n\}/.exec(app);
  assert.ok(m, 'showUpdatePill must be findable with its state/pct signature');
  const fn = new Function('document', 't', 'window', `${m![0]} return showUpdatePill;`)(
    document, t, { confirm: () => false, glassShell: { updaterInstall: async () => {} } },
  ) as (v?: string, s?: string, p?: number | null) => void;
  return { fn, pill: () => byId['updPill'] };
}

test('AVAILABLE shows the pill immediately, reading as a download in progress', () => {
  const { fn, pill } = harness();
  fn('0.8.4', 'downloading');
  const p = pill();
  assert.equal(p.hidden, false, 'the pill must be visible the moment a download starts');
  assert.match(p.textContent, /update\.pillDownloading$/, 'no percentage before one is reported');
  assert.equal(p.dataset.version, '0.8.4');
});

test('a downloading pill is NOT actionable — install mid-download would fail', () => {
  const { fn, pill } = harness();
  fn('0.8.4', 'downloading', 12);
  const p = pill();
  assert.equal(p.disabled, true, 'disabled carries the behaviour');
  assert.ok(p.classes.has('downloading'), 'and the class carries the appearance');
  assert.equal(p.dataset.state, 'downloading');
});

test('progress renders the percentage, and only once there is one', () => {
  const { fn, pill } = harness();
  fn('0.8.4', 'downloading', null);
  assert.doesNotMatch(pill().textContent, /Pct/, 'a null percent must not claim 0%');
  fn('0.8.4', 'downloading', 41.6);
  assert.match(pill().textContent, /update\.pillDownloadingPct\|.*"pct":"42"/, 'rounded, not raw');
});

test('READY flips the same pill to actionable', () => {
  const { fn, pill } = harness();
  fn('0.8.4', 'downloading', 99);
  fn('0.8.4', 'ready');
  const p = pill();
  assert.equal(p.disabled, false, 'now it can be clicked');
  assert.equal(p.classes.has('downloading'), false, 'and it stops looking muted');
  assert.equal(p.dataset.state, 'ready');
  assert.match(p.textContent, /update\.pill$/);
});

test('the click handler re-checks state — a disabled attribute is a style, not a guarantee', async () => {
  /* `disabled` stops a real browser dispatching the event, but the handler is the only thing
     that holds if anything ever triggers it directly (a synthetic click, a future keyboard
     path). Belt and braces on the one action that closes the operator's live terminals. */
  const { fn, pill } = harness();
  let installs = 0;
  const m = /function showUpdatePill\(version, state = 'ready', pct = null\) \{[\s\S]*?\n\}/.exec(app)!;
  let created = false;   // the pill does not exist until showUpdatePill creates it
  const document = {
    getElementById: (id: string) =>
      id === 'dragacts' ? ({ appendChild: () => {} } as unknown) : (created ? held : null),
    createElement: () => { created = true; return held; },
  };
  const held: Record<string, unknown> = {
    dataset: {}, classes: new Set<string>(), handlers: {} as Record<string, Array<() => unknown>>,
    classList: { toggle: () => {} },
    addEventListener: (_e: string, f: () => unknown) => { (held.handlers as Record<string, Array<() => unknown>>).click = [f]; },
  };
  const win = { confirm: () => true, glassShell: { updaterInstall: async () => { installs++; } } };
  const fn2 = new Function('document', 't', 'window', `${m[0]} return showUpdatePill;`)(
    document, (k: string) => k, win,
  ) as (v?: string, s?: string, p?: number | null) => void;
  fn2('0.8.4', 'downloading', 50);
  const click = (held.handlers as Record<string, Array<() => Promise<void>>>).click[0];
  await click();
  assert.equal(installs, 0, 'clicking a downloading pill must never start an install');
  fn2('0.8.4', 'ready');
  await click();
  assert.equal(installs, 1, 'and a ready pill must');
  void fn;
});

test('CHECKING stays silent — a poll that finds nothing is not news', () => {
  /* Surfacing every check would make the chrome flicker on each window focus, which is how a
     status indicator becomes noise the operator learns to ignore. */
  const handler = /window\.glassShell\.onUpdater\(\(\{ channel, payload \}\) => \{[\s\S]*?\n  \}\);/.exec(app);
  assert.ok(handler, 'the updater handler must be findable');
  const body = handler![0];
  assert.match(body, /channel === 'available'\) showUpdatePill/, 'available reaches the UI');
  assert.match(body, /channel === 'progress'\)/, 'progress reaches the UI');
  assert.doesNotMatch(body, /channel === 'checking'\) showUpdatePill/, 'checking must not');
  // and every transition is still logged, which is what made v0.7.0's dead feed diagnosable
  assert.match(body, /console\.log\('\[updater\]', channel/);
});

test('progress keeps the version the available event already gave us', () => {
  /* electron-updater's download-progress payload carries no version. Passing it straight
     through would blank dataset.version mid-download, and the tooltip names the version being
     fetched — so the fallback to the pill's own current value is load-bearing. */
  const handler = /window\.glassShell\.onUpdater\(\(\{ channel, payload \}\) => \{[\s\S]*?\n  \}\);/.exec(app)![0];
  assert.match(handler, /\(cur && cur\.dataset\.version\)/, 'progress falls back to the known version');
});

test('all three locales carry the download strings — a missing key renders as its own name', () => {
  for (const loc of ['en', 'es', 'pt-br']) {
    const d = JSON.parse(fs.readFileSync(`src/i18n/locales/${loc}.json`, 'utf8')) as Record<string, string>;
    for (const k of ['update.pillDownloading', 'update.pillDownloadingPct', 'update.tipDownloading']) {
      assert.ok(d[k], `${loc} is missing ${k}`);
    }
    assert.match(d['update.pillDownloadingPct'], /\{pct\}/, `${loc} must interpolate {pct}`);
    assert.match(d['update.tipDownloading'], /\{version\}/, `${loc} must interpolate {version}`);
  }
});

test('the downloading style flips with the theme instead of pinning a grey', () => {
  /* A hardcoded grey looks right in one theme and wrong in the other, and check:tokens only
     guards hex outside theme.css — inside it, nothing stops a literal. */
  const css = fs.readFileSync('renderer/theme.css', 'utf8');
  const block = /#dragacts \.updpill\.downloading[\s\S]*?\n\}/.exec(css);
  assert.ok(block, 'the downloading state must be styled');
  assert.match(block![0], /var\(--surface-2\)/);
  assert.match(block![0], /var\(--subtle\)/);
  assert.doesNotMatch(block![0], /#[0-9a-fA-F]{3,6}/, 'no literal colours in the downloading state');
  assert.match(block![0], /cursor: default/, 'it must not look pressable while it is not');
});

test('the downloading label is never wider than the actionable one — the title bar has no room to spare', () => {
  /* `#dragacts` is `position: absolute; right: 12px` with no max-width, so the pill grows
     LEFTWARD and will happily overlay the tab strip on a narrow window. Windows and Linux draw a
     native frame, so that row is tighter there than on macOS — which is where this would show up
     first, and on the platform we can least easily eyeball.
     The downloading state is transient and informational; the ready state is the call to action.
     So the transient one gets the shorter wording, and this asserts it stays that way: a
     well-meant "Downloading update… 42%" is +8 characters of overlay risk. One character of slack
     for English, which is already the shortest locale. */
  for (const loc of ['en', 'es', 'pt-br']) {
    const d = JSON.parse(fs.readFileSync(`src/i18n/locales/${loc}.json`, 'utf8')) as Record<string, string>;
    const ready = d['update.pill'].length;
    const dl = d['update.pillDownloadingPct'].replace('{pct}', '42').length;
    assert.ok(dl <= ready + 1,
      `${loc}: downloading label (${dl}) must not exceed the ready label (${ready}) by more than 1 char`);
  }
});
