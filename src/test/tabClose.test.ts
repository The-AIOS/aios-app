/**
 * The X on a session tab asks before it closes.
 *
 * The failure this guards is not a crashed process — it is a lost record. The RUNNING strip
 * carries one tab per live session, and closePane() kills the pty outright, so a mis-aimed
 * click on a neighbouring tab's × ends a session that never ran /aios:close-session. The
 * day's note then has no entry for whatever that session did, and nothing downstream can
 * reconstruct it.
 *
 * Two invariants, and the second matters more than the first:
 *   1. the human × on a LIVE SESSION tab goes through the gate;
 *   2. nothing else does — every programmatic close still calls closePane() directly, because
 *      a modal raised where no hand is waiting would hang the caller forever.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';

const app = fs.readFileSync('renderer/app.js', 'utf8');

test('the tab × routes through the gate, not straight into closePane', () => {
  assert.match(app, /if \(e\.target === tx\) \{ void requestClosePane\(id\); return; \}/);
  assert.doesNotMatch(app, /if \(e\.target === tx\) \{ closePane\(id\); return; \}/,
    'the direct close is what a stray click used to reach');
});

test('the gate asks only for a live Claude session — everything else closes as before', () => {
  assert.match(app, /async function requestClosePane\(id\) \{/);
  assert.match(app, /if \(p\.kind !== 'term' \|\| !p\.isSession \|\| p\.exited\) \{ closePane\(id\); return; \}/,
    'a viewer, a browser pane, a plain terminal and an ended session must not be gated');
});

test('the dialog names the session, and reuses the app’s own confirm — no new dependency', () => {
  const gate = app.slice(app.indexOf('async function requestClosePane'), app.indexOf('function closePane(id)'));
  assert.match(gate, /await confirmModal\(/, 'the existing yes/no gate, not a native confirm()');
  assert.doesNotMatch(gate, /window\.confirm|\balert\(/);
  assert.match(gate, /t\('tab\.closeConfirmTitle', \{ name: p\.name \}\)/,
    '“Are you sure?” tells the operator nothing — the session has to be named');
  const afterCancel = gate.slice(gate.indexOf('if (!ok) {'));
  assert.ok(afterCancel.slice(0, afterCancel.indexOf('closePane(id);')).includes('return;'),
    'cancel must return before the close, not fall through into it');
});

test('the gate lives in the click handler, never inside closePane', () => {
  /* This is the one that keeps programmatic closes working. closePane() is called by the
     registry retiring a dead session, by watchThenKill() once a capture has landed, and by the
     command bus's `kill` — none of which has anybody there to answer a dialog. */
  const body = app.slice(app.indexOf('function closePane(id) {'));
  const end = body.indexOf('\n}\n');
  assert.doesNotMatch(body.slice(0, end), /confirmModal|requestClosePane/,
    'closePane must stay unconditional');
});

test('the three confirm strings exist in all three locales — a missing key renders as its own name', () => {
  for (const loc of ['en', 'es', 'pt-br']) {
    const j = JSON.parse(fs.readFileSync(`src/i18n/locales/${loc}.json`, 'utf8')) as Record<string, string>;
    for (const k of ['tab.closeConfirmTitle', 'tab.closeConfirmBody', 'tab.closeConfirmOk']) {
      assert.ok(j[k], `${loc} is missing ${k}`);
    }
    assert.match(j['tab.closeConfirmTitle'], /\{name\}/, `${loc} must interpolate the session name`);
  }
  const bundle = fs.readFileSync('renderer/i18n.js', 'utf8');
  assert.match(bundle, /tab\.closeConfirmTitle/,
    'the generated bundle is stale — run npm run gen-i18n');
});

test('cancel puts focus back — the pane must not be left live-looking but deaf', () => {
  /* confirmModal focuses its Cancel button and leaves focus on <body> when it closes, and
     setActive() is the only thing that focuses a terminal. Before this change the cancel path
     did not exist, so nobody had to care; now it is the path the feature exists to produce. */
  const gate = app.slice(app.indexOf('async function requestClosePane'), app.indexOf('function closePane(id)'));
  assert.match(gate, /const back = active\[zoneOf\(p\)\];/,
    'restore the zone’s active pane — a background tab’s × can be clicked while typing in the foreground one');
  assert.match(gate, /if \(back !== null && panes\.has\(back\)\) setActive\(back\);/);
});

test('Enter follows focus in confirmModal — a reflex Return must not confirm a destructive action', () => {
  /* The dialog focuses Cancel and says so in its own comment, but the key handler resolved
     `true` whatever was focused — and its preventDefault() stopped the focused Cancel button
     from ever seeing the native activation that would have said no. So the gate against one
     stray input was defeated by the next one. Shared with the connector delete and the
     frequent-task remove, both of which are destructive and both of which focus Cancel too. */
  const modal = app.slice(app.indexOf('function confirmModal(title, message, confirmLabel)'));
  const body = modal.slice(0, modal.indexOf('\n}\n'));
  assert.match(body, /e\.key === 'Enter'\) \{ e\.preventDefault\(\); e\.stopPropagation\(\); done\(document\.activeElement === ok\); \}/);
  assert.doesNotMatch(body, /e\.key === 'Enter'\)[^\n]*done\(true\)/,
    'Enter must not mean yes regardless of what holds focus');
  assert.match(body, /cancel\.focus\(\);/, 'and the safe option still holds focus');
});
