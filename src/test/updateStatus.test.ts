/**
 * Framework-status cadence + Glass visual parity.
 *
 * The bug these lock down: the status was posted only on 'ready' and on a manual
 * click, so a running app never noticed a canonical push — and `.aios-update` was
 * watched but its callback only re-posted state, so the pill stayed on "update
 * available" even after /aios:update had landed. Both are wiring, not logic, so
 * they're guarded statically: nothing here can catch a regression at runtime.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';

const host = fs.readFileSync('src/main/panelHost.ts', 'utf8');
const main = fs.readFileSync('src/main/main.ts', 'utf8');
const css = fs.readFileSync('renderer/theme.css', 'utf8');

test('status is polled on a cadence, not only on ready/click', () => {
  assert.match(host, /const UPD_POLL_MS = 5 \* 60_000;/, 'a poll interval must exist');
  assert.match(host, /this\.updTimer = setInterval\(/, 'and must actually be scheduled');
  assert.match(host, /isVisible\(\) && !w\.isMinimized\(\)/, 'skipped while hidden — Glass parity, no wasted cycles');
  assert.match(host, /if \(this\.updTimer\) clearInterval\(this\.updTimer\)/, 'and cleared on dispose');
});

test('rapid triggers collapse — each check is a network round trip', () => {
  assert.match(host, /const UPD_MIN_GAP_MS = 60_000;/);
  assert.match(host, /refreshUpdateStatus\(force = false\)/);
  assert.match(host, /if \(!force && Date\.now\(\) - this\.updAt < UPD_MIN_GAP_MS\) return;/);
  assert.match(host, /this\.updAt = Date\.now\(\);/, 'every post records when it ran');
});

test('an explicit click bypasses the rate limit — the operator asked', () => {
  assert.match(host, /case 'recheck':[\s\S]{0,120}refreshUpdateStatus\(true\)/);
});

test('.aios-update flips the pill on its own callback, debounced', () => {
  // must NOT be the shared scheduleRefresh: that fires on every calendar/export write
  assert.match(host, /fs\.watch\(path\.join\(r, '\.aios-update'\), \(\) => \{[\s\S]{0,200}updateStatusSoon\(\)/);
  assert.match(host, /private updateStatusSoon\(\)/);
  assert.match(host, /clearTimeout\(this\.updDebounce\)/, 'fs.watch double-fires; debounce it');
  assert.match(host, /if \(this\.updDebounce\) clearTimeout\(this\.updDebounce\);/, 'cleared on dispose');
});

test('window focus re-checks — the App has no view-visibility event to lean on', () => {
  /* Focus now also re-checks the ROOTS. A newcomer's framework and vault do not exist when the
     window opens, so everything wired at boot — the panel's watchers, the explorer tree, the
     update tracker — was wired against a machine that no longer exists by the time setup
     finishes. Focus is the cheapest honest moment to notice, alongside the poll. */
  assert.match(main, /win\.on\('focus', \(\) => \{ host\?\.refreshUpdateStatus\(\); rewireForRoots\(win\); \}\)/);
  assert.match(main, /function rewireForRoots\(win: BrowserWindow\): void/);
  assert.match(main, /host\?\.wireWatchers\(\);/, 'the panel watchers must be re-wired, not just refreshed');
  assert.match(main, /setInterval\(\(\) => \{ if \(!win\.isDestroyed\(\)\) rewireForRoots\(win\); \}, 4000\)/);
  assert.match(main, /if \(sig === lastRootSig\) return;/, 'act on a CHANGE, so the common case costs nothing');
});

test('update-available is coral on both dot and word, and survives :hover', () => {
  assert.match(css, /\.pstatus\.updavail \{ color: var\(--accent\); \}/, 'word takes the accent, not a warning gold');
  assert.match(css, /\.pstatus\.updavail \.pdot \{ background: var\(--accent\); \}/, 'dot too — Glass .status.upd .dot');
  // .pstatus:hover sets color:var(--ink); without this the accent washes out on hover
  assert.match(css, /\.pstatus\.updavail:hover \{ color: var\(--accent\); \}/);
  assert.match(css, /\.pstatus\.updavail:hover \.pupdtext \{ text-decoration: underline; \}/);
});

test('up-to-date keeps a green dot with quiet text — also Glass parity', () => {
  assert.match(css, /\.pstatus \.pdot\.st-ok \{ background: var\(--st-ok\); \}/);
  assert.doesNotMatch(css, /\.pstatus\.updok \{ color:/, 'up-to-date must not colour its label');
});

test('labels are the bare Glass words in every locale — no decorative glyphs', () => {
  for (const loc of ['en', 'es', 'pt-br']) {
    const j = JSON.parse(fs.readFileSync(`src/i18n/locales/${loc}.json`, 'utf8')) as Record<string, string>;
    for (const key of ['pulse.updAvailable', 'pulse.updUpToDate']) {
      assert.ok(j[key], `${loc} must define ${key}`);
      assert.doesNotMatch(j[key], /[↓✓]/, `${loc} ${key} must not carry a glyph Glass does not render`);
      assert.equal(j[key], j[key].trim(), `${loc} ${key} must not keep the glyph's leading space`);
    }
  }
});

test('a placeholder hash means "cannot tell", never "you are behind"', () => {
  /* A freshly written tracker can carry `hash=initial` until the first real sync fills it in,
     and `remote.startsWith('initial')` is false — so the pill announced an update on a vault
     that had JUST synced, then silently corrected itself when the real sha landed. Observed on a
     real run. A false alarm that resolves on its own is worse than no alarm: it teaches the
     operator to ignore the pill. */
  const src = fs.readFileSync('src/main/aios.ts', 'utf8');
  assert.match(src, /if \(!\/\^\[0-9a-f\]\{7,40\}\$\/i\.test\(status\.hash\)\) return Promise\.resolve\('unknown'\);/);
  // and the guard must come BEFORE the comparison, or it protects nothing
  const iGuard = src.indexOf("test(status.hash)) return Promise.resolve('unknown')");
  const iCompare = src.indexOf('remote.startsWith(status.hash)');
  assert.ok(iGuard > 0 && iCompare > iGuard, 'validate the hash before comparing against it');
});

test('no tracker is its own state, not a spinner that never resolves', () => {
  /* "Checking…" served both "a check is in flight" and "there is nothing to check against", so a
     vault that had never run /aios:update showed a permanent spinner. */
  const app = fs.readFileSync('renderer/app.js', 'utf8');
  assert.match(app, /\} else if \(state === 'unknown'\) \{/);
  assert.match(app, /t\('pulse\.updUntracked'\)/);
  // "Checking…" survives ONLY for the genuine boot state
  const iUntracked = app.indexOf("t('pulse.updUntracked')");
  const iChecking = app.indexOf("t('pulse.updChecking')");
  assert.ok(iUntracked > 0 && iChecking > iUntracked, 'untracked is handled before the in-flight fallback');
  for (const loc of ['en', 'es', 'pt-br']) {
    const j = JSON.parse(fs.readFileSync(`src/i18n/locales/${loc}.json`, 'utf8')) as Record<string, string>;
    assert.ok(j['pulse.updUntracked'] && j['rail.updateUntracked'], `${loc} needs the untracked strings`);
  }
});

test('the greeting learns the operator name when the interview writes it', () => {
  /* postState() has always SENT the operator's name; nothing ever watched the file it comes from.
     So through the entire cold-start interview the app greeted an anonymous stranger, and the name
     appeared only when /aios:today happened to write a calendar file and trip a different watcher.
     The operator caught it precisely: "Setup said You're in, the onboarding agent used my name,
     and the app still didn't." Their name showing up is the most legible proof the whole setup
     worked — it must not arrive by accident. Verified live: "Good morning" → "Good morning, <name>"
     with no interaction. */
  const host = fs.readFileSync('src/main/panelHost.ts', 'utf8');
  assert.match(host, /watch\(path\.join\(v, '00 - notes', 'context', 'declared'\), \{ recursive: true \}\)/);
  // and the state push must actually carry the name, or watching it changes nothing
  assert.match(host, /operator: aios\.operatorName\(\)/);
});
