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

test('GREEN MEANS ALIVE and GREY MEANS DEAD — the tab says what the panel says', () => {
  /* Corrected 2026-09-14 after the operator noticed terminals reading grey on their tab and
     green in the panel. The panel is the older convention and it is the right one: `.pdot` bare
     is grey, `.pdot.idle` is green, so a LIVE plain terminal is green over there. The note we
     had both been repeating — "grey is reserved for plain terminals" — was reading statusInfo's
     UNKNOWN case as though it were about terminals. Grey has always meant dead. */
  const c = css();
  assert.match(c, /--st-idle:\s*#3ec77a/, 'the palette itself calls this "alive & ready (calm green)"');
  assert.match(c, /\.tab \.tdot\.idle\s*\{\s*--sc: var\(--st-idle\);/,
    'alive and idle is green — for a session AND for a plain terminal. The issue proposed moving '
    + 'idle to grey, but its only reason was a clash with green GROUP colours, and groups are '
    + 'deferred: the reason does not apply yet while the cost does.');
  assert.match(c, /\.tab \.tdot\.dead\s*\{[^}]*--subtle/, 'grey is the ENDED pane');
  assert.match(c, /\.tab \.tdot\.off\s*\{ display: none; \}/,
    'and a file tab gets no dot at all — it has no state to report');
  assert.ok(!/\.tab \.tdot\.idle\s*\{[^}]*--subtle/.test(c),
    'recolouring idle to grey would make a healthy session indistinguishable from a dead one');
});

test('nothing but the pulse animates box-shadow on a tab dot', () => {
  /* The finished-unseen RING was drawn with box-shadow, and so is the pulse — two rules
     animating one property on one element. Operator-reported: "sometimes it pulsates properly,
     sometimes it has the outer circle", and some tabs ended with the ring and others with a
     halo, depending which rule won the frame. The ring is gone; unread now lives in the badge
     alone. If it ever needs a tab marker, a bolder tab NAME is the place — a weight change
     competes with neither the status dot nor the group stripe still to come. */
  const c = css();
  assert.ok(!/\.tab \.tdot\.unread/.test(c), 'no ring rule survives');
  assert.ok(!/--st-unread|--st-unseen|--st-new/.test(c), 'and it was never solved with a new hue');
  const shadows = (c.match(/\.tab \.tdot[^{]*\{[^}]*box-shadow/g) || []);
  assert.deepEqual(shadows, [], 'the ONLY box-shadow on this element comes from @keyframes tpulse');
  assert.match(c, /@keyframes tpulse \{[^}]*var\(--sc\)/, 'which pulses in the dot\'s own colour');
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

test('a pane with no live session shows alive-or-dead, never a stale state', () => {
  assert.match(app(), /if \(!entry\) \{[\s\S]{0,700}?dot\.className = 'tdot ' \+ \(p\.exited \? 'dead' : 'idle'\);/,
    'a tab left showing "working" for a session that no longer exists is worse than showing '
    + 'nothing — and a LIVE terminal is green, matching the panel rather than contradicting it');
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
