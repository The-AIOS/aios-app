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

test('A SESSION IS GREEN, A TERMINAL IS GREY — and the tab says what the panel says', () => {
  /* Settled by the operator after seeing both: "what's a dead terminal? they are never dead,
     and never moving — this is why I believe we should use grey for terminals in both panel and
     tab." Green on a session means alive and ready to be asked something; a shell is neither, so
     lending it the same green made every pane look alike. Grey is the absence of state, which is
     exactly what a terminal has. The side panel was changed to match, not the other way round. */
  const c = css();
  assert.match(c, /--st-idle:\s*#3ec77a/, 'the palette calls this "alive & ready (calm green)"');
  assert.match(c, /\.tab \.tdot\.idle\s*\{\s*--sc: var\(--st-idle\);/,
    'an alive, idle SESSION is green. The issue proposed moving idle to grey, but its only reason '
    + 'was a clash with green GROUP colours, and groups are deferred: the reason does not apply '
    + 'yet while the cost does.');
  assert.match(c, /\.tab \.tdot\.plain \{ --sc: var\(--subtle\); \}/, 'a terminal is grey');
  assert.match(app(), /r\.appendChild\(el\('span', 'pdot'\)\);/,
    'and the panel row agrees — it used to add `idle`, painting live terminals green over there '
    + 'while the tab showed grey, which is the disagreement that surfaced this');
});

test('a tab dot is hidden until it has been painted', () => {
  /* It defaulted to visible-and-green, so every newly opened tab — a file, Settings, anything —
     flashed a green dot for the two seconds until the next poll told it it had no state at all.
     "a green dot came, then vanished. this happens for any element in editor." */
  const c = css();
  assert.match(c, /\.tab \.tdot \{ display: none;/, 'hidden by default');
  assert.match(c, /\.tab \.tdot\.plain, \.tab \.tdot\.idle, \.tab \.tdot\.busy,\s*\n\.tab \.tdot\.input, \.tab \.tdot\.error \{ display: inline-block; \}/,
    'shown only once a real state has been set');
  assert.match(app(), /if \(p\.kind !== 'term'\) \{ dot\.className = 'tdot off'; dot\.title = ''; continue; \}/,
    'and a file tab is explicitly cleared rather than left at whatever it was born with');
});

test('nothing but the pulse animates box-shadow on a tab dot', () => {
  /* The finished-unseen RING was drawn with box-shadow, and so is the pulse — two rules
     animating one property on one element. Reported as "sometimes it pulsates properly,
     sometimes it has the outer circle". The ring is gone with the counter that fed it. */
  const c = css();
  assert.ok(!/\.tab \.tdot\.unread/.test(c), 'no ring rule survives');
  const shadows = (c.match(/\.tab \.tdot[^{]*\{[^}]*box-shadow/g) || []);
  assert.deepEqual(shadows, [], 'the ONLY box-shadow on this element comes from @keyframes tpulse');
  assert.match(c, /@keyframes tpulse \{[^}]*var\(--sc\)/, "which pulses in the dot's own colour");
});

test('busy and needs-you pulse, and in their OWN colour', () => {
  const c = css();
  assert.match(c, /\.tab \.tdot\.busy\s*\{[^}]*animation: tpulse/);
  assert.match(c, /\.tab \.tdot\.input\s*\{[^}]*animation: tpulse/);
  assert.match(c, /@keyframes tpulse \{[^}]*var\(--sc\)/,
    'its own keyframe because the panel\'s ppulse hardcodes amber — which haloes a blue dot amber');
});

test('a pane with no live session shows a terminal, never a stale state', () => {
  assert.match(app(), /if \(!entry\) \{[\s\S]{0,700}?dot\.className = 'tdot plain';/,
    'a tab left showing "working" for a session that no longer exists is worse than showing that '
    + 'it is just a shell');
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
  assert.match(src, /pulse\.cmd\('aios\.revealAgent', next\.name, next\.id \|\| ''\)/, 'the jump chord');
  assert.ok(!/const hit = byName\(a\.name\);/.test(src),
    'the sessions list holds the running entry, so it has no excuse to look up by name alone');
  const host = fs.readFileSync(path.join(ROOT, 'src', 'main', 'panelHost.ts'), 'utf8');
  assert.match(host, /'focusByName', \{ name: String\(args\[0\] \?\? ''\), id: String\(args\[1\] \?\? ''\) \}/,
    'and main forwards it on every *ByName intent');
});
