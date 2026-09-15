/**
 * Session state on the tab itself (#24.2b).
 *
 * "With several sessions open, the one that needs a permission is invisible unless I happen to
 * be looking at its pane" — state lived only in the side panel. These assertions mostly guard
 * DECISIONS rather than mechanics, because the mechanics are four CSS rules and the decisions
 * are the part someone will otherwise undo in good faith.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.join(__dirname, '..', '..');
const app = (): string => fs.readFileSync(path.join(ROOT, 'renderer', 'app.js'), 'utf8');
const css = (): string => fs.readFileSync(path.join(ROOT, 'renderer', 'theme.css'), 'utf8');

test('every tab carries a state dot, and it is its OWN element', () => {
  const src = app();
  assert.match(src, /dot\.className = 'tdot';/, 'the element exists');
  assert.match(src, /tab\.append\(dot, ic, nm, tx\);/, 'and is in the tab, ahead of the name');
  /* Not a tint on the icon and not a border on the tab: the group colour stripe is a separate
     axis (#24.2a) and the issue is explicit that status and group must not share a pixel. */
  assert.ok(!/ticon[^\n]*st-(busy|input|idle|error)/.test(src),
    'state must not be painted onto the icon — that pixel belongs to the group stripe');
});

test('the tab reuses statusInfo() rather than deriving state a second time', () => {
  const src = app();
  assert.match(src, /function paintTabStates\(m\) \{/);
  assert.match(src, /const info = statusInfo\(entry\.status\);/,
    'a tab and the side panel disagreeing about what a session is doing is worse than neither showing it');
});

test('IDLE IS GREEN, and grey means a plain terminal — the one distinction grey exists for', () => {
  const c = css();
  assert.match(c, /--st-idle:\s*#3ec77a/, 'the palette itself calls this "alive & ready (calm green)"');
  assert.match(c, /\.tab \.tdot\.idle\s*\{\s*--sc: var\(--st-idle\);/,
    'an alive, idle session is green. The issue proposed grey, but its only reason was a clash '
    + 'with green GROUP colours — and groups are deferred, so the reason does not apply while the '
    + 'cost does.');
  assert.match(c, /\.tab \.tdot\.plain\s*\{[^}]*--subtle/,
    'grey is reserved for a bare terminal — "a registered, alive session is NEVER the grey unknown dot"');
  assert.ok(!/\.tab \.tdot\.idle\s*\{[^}]*--subtle/.test(c),
    'recolouring idle to grey would make a healthy session indistinguishable from a bare shell');
});

test('finished-unseen adds a MARKER, never a sixth colour', () => {
  const c = css();
  assert.match(c, /\.tab \.tdot\.unread\s*\{\s*box-shadow:/, 'a ring, drawn in the dot\'s own --sc');
  assert.ok(!/--st-unread|--st-unseen|--st-new/.test(c),
    'a new hue would have to compete with four meanings the operator already learned — and unread '
    + 'is orthogonal to all of them: a session can be idle-and-unread or error-and-unread');
  assert.match(c, /\.tab \.tdot\.unread\.busy, \.tab \.tdot\.unread\.input \{ animation: none; \}/,
    'the ring outranks the pulse — it is the state that is easy to miss');
});

test('busy and needs-you pulse, and in their OWN colour', () => {
  const c = css();
  assert.match(c, /\.tab \.tdot\.busy\s*\{[^}]*animation: tpulse/);
  assert.match(c, /\.tab \.tdot\.input\s*\{[^}]*animation: tpulse/);
  assert.match(c, /@keyframes tpulse \{[^}]*var\(--sc\)/,
    'its own keyframe because the panel\'s ppulse hardcodes amber — which haloes a blue dot amber');
});

test('the unread set is computed ONCE and shared with the Dock badge', () => {
  const host = fs.readFileSync(path.join(ROOT, 'src', 'main', 'panelHost.ts'), 'utf8');
  assert.match(host, /const unread = this\.attention\.tick\(running, aios\.shellSettings\(\)\.attention\);/,
    'the tab marker and the badge count are the same state');
  assert.match(host, /^\s+unread,$/m, 'and it rides the running message the tabs already receive');
  const src = app();
  assert.ok(!/busy['"]?\s*&&[^\n]*idle[^\n]*unread/.test(src),
    'the renderer must not re-derive unread from status transitions — two derivations of "what '
    + 'have you seen" is how a badge and a tab come to disagree');
});

test('the tab resolves a session by IDENTITY — two sessions can share one name', () => {
  /* OPERATOR-REPORTED 2026-09-14, and the reason this test exists: two `ingest` sessions, one
     working and one idle, made BOTH tabs run the working animation. The side panel was correct
     because it renders a ROW PER ENTRY; the tabs were a LOOKUP keyed on name, and `new Map()`
     keeps only the last entry for a duplicate key, so both panes resolved to the same session.

     Nothing enforces unique names — the registry is one file per PID. And the renderer already
     knew this: "The name was never the identity. `sessionId` is." sits ~100 lines above where
     the name-keyed lookup was reintroduced. */
  const src = app();
  assert.ok(!/new Map\(\(m\.running \|\| \[\]\)\.map\(\(a\) => \[a\.name, a\]\)\)/.test(src),
    'a Map keyed on name silently merges two sessions that share one');
  assert.match(src, /const byKey = new Map\(running\.filter\(\(a\) => a\.key\)\.map\(\(a\) => \[a\.key, a\]\)\)/,
    'keyed on the session identity the host now sends');
  assert.match(src, /p\.sessionId\s*\n?\s*\? byKey\.get\(p\.sessionId\)/,
    'and a pane resolves through its own sessionId first');
  assert.match(src, /nameCount\.get\(p\.confirmedName\) === 1/,
    'the name fallback (for panes predating sessionId) fires ONLY when the name is unambiguous — '
    + 'with a duplicate, guessing is the bug and showing no state is the honest answer');
  assert.match(src, /unread\.has\(entry\.key\)/, 'the unread marker is keyed the same way');
});

test('what the renderer reports as on-screen is ids, never names', () => {
  const src = app();
  assert.match(src, /p\.isSession && p\.sessionId\) ids\.push\(p\.sessionId\)/,
    'a name here would mark the wrong session as seen');
  assert.match(src, /pulse\.send\(\{ type: 'paneVisible', ids \}\)/);
});

test('a pane whose session ended falls back to plain, not to a stale state', () => {
  assert.match(app(), /if \(!entry\) \{[\s\S]{0,400}?dot\.className = 'tdot plain';/,
    'a tab left showing "working" for a session that no longer exists is worse than showing nothing');
});

test('a name alone never decides a DESTRUCTIVE action on a duplicate', () => {
  /* `byName` used `.find()`, which returns the first match — so with two `ingest` panes, close,
     interrupt and the bus's own `send` all acted on whichever came first. Navigation landing on
     the wrong pane is visible and one keystroke from corrected; the other three are not:
     closing throws away a session, interrupting throws away work in flight, and a `send`
     delivers a brief to the wrong session while telling the sender it worked. That last one is
     the same class this file already carries a comment about — "how a brief ended up executing
     at a bash prompt". */
  const src = app();
  assert.match(src, /const byName = \(name, id\) => \{/, 'identity first');
  assert.match(src, /p\.kind === 'term' && p\.sessionId === id/, 'resolved by sessionId when known');
  assert.match(src, /const ambiguous = \(name\) =>/, 'and a way to know a name cannot decide');

  for (const [intent, why] of [
    ["closeByName", 'closing the wrong session is not recoverable'],
    ["escByName", 'interrupting the wrong session throws away work in flight'],
  ] as const) {
    const block = src.slice(src.indexOf(`case '${intent}':`), src.indexOf(`case '${intent}':`) + 400);
    assert.match(block, /if \(!m\.id && ambiguous\(m\.name\)\)/, `${intent} refuses an ambiguous name — ${why}`);
  }

  const send = src.slice(src.indexOf("case 'sendByName':"), src.indexOf("case 'escByName':"));
  assert.match(send, /if \(!m\.id && ambiguous\(m\.name\)\) \{[\s\S]*?busSendResult\(m\.name, false,/,
    'a bus send REPORTS the refusal rather than guessing — delivering to the wrong session is '
    + 'worse than not delivering, because the sender is told it worked');

  /* Navigation is the deliberate exception, and it is stated so nobody "fixes" it later. */
  const focus = src.slice(src.indexOf("case 'focusByName':"), src.indexOf("case 'closeByName':"));
  assert.ok(!focus.includes('ambiguous('), 'focus still resolves rather than refusing — a dead control is worse');
});

test('every caller that knows the session id passes it', () => {
  const src = app();
  assert.match(src, /pulse\.cmd\('aios\.revealAgent', item\.name, item\.id \|\| ''\)/, 'the inbox row');
  assert.match(src, /pulse\.cmd\('aios\.revealAgent', next\.name, next\.id \|\| ''\)/, 'the jump chord');
  assert.ok(!/const hit = byName\(a\.name\);/.test(src),
    'the sessions list holds the running entry, so it has no excuse to look up by name alone');
  const host = fs.readFileSync(path.join(ROOT, 'src', 'main', 'panelHost.ts'), 'utf8');
  assert.match(host, /'focusByName', \{ name: String\(args\[0\] \?\? ''\), id: String\(args\[1\] \?\? ''\) \}/,
    'and main forwards it on every *ByName intent');
});
