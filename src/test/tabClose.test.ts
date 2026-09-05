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

test('the × asks the operator’s OWN question — killBehavior, not a yes/no of ours', () => {
  /* The first version of this gate raised its own Cancel / Close-session confirm. That stopped
     the accident but still destroyed the record whenever the operator genuinely meant to close
     — and a lost record is the thing the gate exists to protect. It also made the Settings row
     labelled “When you kill a session” untrue of the × specifically. Both are fixed by asking
     the question the operator already configured, which offers capture. */
  const gate = app.slice(app.indexOf('async function requestClosePane'), app.indexOf('function closePane(id)'));
  assert.match(gate, /await endSession\(\{ name: p\.name, paneId: id \}\)/,
    'the × routes into the shared decision, naming the session and its pane');
  assert.doesNotMatch(gate, /window\.confirm|\balert\(/);
  assert.doesNotMatch(gate, /confirmModal|listModal/,
    'the gate must not grow a second dialog of its own — endSession owns the question');
});

test('there is exactly ONE killBehavior decision, and both affordances reach it', () => {
  /* The whole point of the follow-up. Two copies of a three-branch rule drift, and the branch
     that drifts is the one nobody exercises — `capture`, which is precisely the branch that
     protects the work. Asserted as ONE test because they are one decision: splitting a pair
     into two assertions is how the pair silently comes apart. */
  const sites = [...app.matchAll(/KILLBEHAVIOR === '(kill|capture)'/g)];
  assert.equal(sites.length, 2, 'exactly one site branches on killBehavior (its two early returns)');
  const decision = app.slice(app.indexOf('async function endSession'));
  assert.match(decision.slice(0, decision.indexOf('\n}\n')), /KILLBEHAVIOR === 'kill'/,
    'and that site is endSession');
  // both entry points, one function
  assert.match(app, /actBtn\('trash', t\('session\.kill'\), 'kill', \(\) => void endSession\(\{ name: a\.name, pid: a\.pid \}\)\)/,
    'the RUNNING card trash button');
  assert.match(app, /await endSession\(\{ name: p\.name, paneId: id \}\)/, 'the tab ×');
});

test('every HAND-DRIVEN close is gated — “only programmatic callers are exempt” must mean every hand', () => {
  /* Left out of the first pass and reported rather than fixed: ⌘W, File → Close Tab, and the
     RUNNING card’s Terminals row all ended a live session with no gate, so the same session had
     one affordance that asked and three that did not. They are one-line routings because
     requestClosePane() still closes a plain terminal instantly. */
  assert.match(app, /case 'closeActive':\s*\n\s*if \(active\.main !== null\) void requestClosePane\(active\.main\);/);
  assert.match(app, /case 'closeTerminal':\s*\n\s*if \(active\.term !== null\) void requestClosePane\(active\.term\);/);
  assert.match(app, /close\.addEventListener\('click', \(e\) => \{ e\.stopPropagation\(\); void requestClosePane\(tid\); \}\);/,
    'the Terminals row trash button');
  // and the programmatic ones are untouched — a modal with no hand waiting hangs the caller
  assert.match(app, /case 'closeByName': \{\s*\n\s*const hit = byName\(m\.name\);\s*\n\s*if \(hit\) closePane\(hit\[0\]\);/,
    'the command bus kill must never raise a dialog');
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

test('the picker’s strings exist in all three locales, and the retired ones are gone', () => {
  /* The × now raises the session picker, so these are the strings it renders. The bespoke
     tab.closeConfirm* keys it used to own are deliberately deleted rather than left behind:
     a dead key reads as a live one to the next person editing a locale file. */
  for (const loc of ['en', 'es', 'pt-br']) {
    const j = JSON.parse(fs.readFileSync(`src/i18n/locales/${loc}.json`, 'utf8')) as Record<string, string>;
    for (const k of ['session.killConfirmTitle', 'session.killCapture', 'session.killCaptureHint',
                     'session.killNow', 'session.killNowHint', 'session.killPlaceholder']) {
      assert.ok(j[k], `${loc} is missing ${k}`);
    }
    assert.match(j['session.killConfirmTitle'], /\{name\}/, `${loc} must interpolate the session name`);
    for (const dead of ['tab.closeConfirmTitle', 'tab.closeConfirmBody', 'tab.closeConfirmOk']) {
      assert.ok(!(dead in j), `${loc} still carries the retired ${dead}`);
    }
  }
  const bundle = fs.readFileSync('renderer/i18n.js', 'utf8');
  assert.match(bundle, /session\.killConfirmTitle/, 'the generated bundle is stale — run npm run gen-i18n');
  assert.doesNotMatch(bundle, /closeConfirm/, 'the generated bundle still carries the retired keys');
});

test('cancel puts focus back — the pane must not be left live-looking but deaf', () => {
  /* A modal takes focus and leaves it on <body> when it closes, and setActive() is the only
     thing that focuses a terminal. Before the gate existed the cancel path did not exist, so
     nobody had to care; now it is the path the feature exists to produce. endSession() returns
     null on dismissal precisely so this caller can tell "nothing happened" from "it closed". */
  const gate = app.slice(app.indexOf('async function requestClosePane'), app.indexOf('function closePane(id)'));
  assert.match(gate, /if \(!acted\) \{/, 'a dismissed picker must restore focus, not fall through');
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
