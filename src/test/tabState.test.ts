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

test('NOTHING animates a non-composited property — the compositor-loop guard', () => {
  /* AI-157, measured 2026-09-15. The pulse animated `box-shadow`; the panel's "Working" verb
     animated `background-position` on `background-clip: text`. Neither property can be
     composited, so every frame re-ran style and paint on the main thread: 960 style
     recalculations per 8 seconds — 120 PER SECOND, forever — against 8 with animations off.
     WindowServer then sat at ~32%, and because compositing is serialised that queued every other
     window's input: the report was typing lagging in EVERY app on the machine, with ⌘H dropping
     WindowServer to 0.1% instantly. After the rewrite: ZERO recalcs, 3ms of task time per 8s.
     The rule is about the PROPERTY, not the effect — animate what the compositor owns. */
  /* Brace-matched, not regex-sliced: a keyframes block can be written on one line or many, and
     a greedy pattern runs straight past its closing brace into ordinary rules — which reports
     every property in the stylesheet and reads exactly like a real failure. */
  const c = css();
  const animated = new Set<string>();
  /* ONLY the animations that never end. A one-shot flash costs a handful of frames and is fine;
     the defect is a loop that pays that cost forever. So the guard follows `infinite` to the
     keyframes it names, rather than policing every @keyframes in the file. */
  const endless = new Set<string>();
  for (const decl of c.matchAll(/animation:\s*([^;]*infinite[^;]*);/g)) {
    for (const tok of decl[1].trim().split(/\s+/)) {
      if (/^[A-Za-z][\w-]*$/.test(tok) && !['infinite','linear','ease','ease-in','ease-out',
          'ease-in-out','both','forwards','backwards','alternate','none','running','paused',
          'normal','reverse'].includes(tok)) endless.add(tok);
    }
  }
  assert.ok(endless.size > 0, 'no infinite animations found — the extractor is broken, not the CSS');
  for (const m of c.matchAll(/@keyframes\s+([\w-]+)\s*\{/g)) {
    if (!endless.has(m[1])) continue;
    let depth = 0, i = m.index!;
    while (i < c.length) {
      if (c[i] === '{') depth++;
      else if (c[i] === '}' && --depth === 0) break;
      i++;
    }
    const body = c.slice(m.index! + m[0].length, i);
    for (const step of body.matchAll(/\{([^{}]*)\}/g)) {
      for (const decl of step[1].split(';')) {
        const prop = decl.split(':')[0].trim();
        if (prop) animated.add(prop);
      }
    }
  }
  const COMPOSITED = new Set(['transform', '-webkit-transform', 'opacity', 'filter', 'visibility']);
  const offenders = [...animated].filter((x) => !COMPOSITED.has(x));
  assert.deepEqual(offenders, [],
    'animated in @keyframes and not compositable, so each costs a style recalc and a main-thread '
    + 'paint every frame, forever: ' + offenders.join(', '));
});

test('busy and needs-you still pulse, in their OWN colour, on the GPU', () => {
  const c = css();
  assert.match(c, /\.tab \.tdot\.busy::after, \.tab \.tdot\.input::after \{/,
    'the ring is a pseudo-element, so the dot itself never repaints');
  assert.match(c, /@keyframes ringpulse \{[\s\S]*?transform: scale\(1\);\s+opacity: \.45;/,
    'and it animates transform + opacity — the two the compositor owns');
  assert.match(c, /body\.unfocused \*[^{]*\{ animation-play-state: paused !important; \}/,
    'and nothing animates while the window is not in front — compositing is serialised, so an '
    + 'unfocused window that keeps painting costs the whole machine, not just this app');
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

test('NO session lookup keys on the name unless it SAYS why — the sweep, not the site', () => {
  /* THE MECHANISM FOR A CLASS FIXED FIVE TIMES IN ONE DAY, one site at a time, each time
     believing it was the last: the tab dot, `theater` (the panel's working-time), `feedMark`
     (the row's entry animation), the tab-name shimmer, and `byName` (reveal · close · interrupt ·
     the bus's own send). Every one was "resolve a session by `name`", and names are not unique —
     nothing enforces it, the registry is one file per PID, so `spawn ingest` twice yields two
     live sessions called `ingest`.

     Fixing them one at a time cost three rounds of operator testing, because each fix made the
     NEXT one visible: correcting the dot exposed the shimmer, correcting the shimmer exposed the
     entry animation. A lookup keyed on a non-unique field is never one site.

     So this sweeps the FILE rather than asserting about whichever site was reported — a list of
     known sites is exactly what let four of the five hide. Name-keying is sometimes right (an
     ambiguity COUNT, a set-membership test, a deliberate fallback when the name is unambiguous),
     so a legitimate site declares itself with `name-ok:` and a reason. The marker is the point:
     it forces the question to be answered at the site instead of assumed. */
  const src = app();
  const lines = src.split('\n');
  const offenders: string[] = [];
  lines.forEach((line, i) => {
    if (!/\ba\.name === /.test(line)) return;
    const code = line.trim();
    if (code.startsWith('*') || code.startsWith('//') || code.startsWith('`')) return;  // prose about the bug
    const window = lines.slice(Math.max(0, i - 3), i + 1).join('\n');
    if (/name-ok:/.test(window)) return;                                                // declared, with a reason
    offenders.push(`line ${i + 1}: ${code.slice(0, 100)}`);
  });
  assert.deepEqual(offenders, [],
    'a session resolved by NAME with no `name-ok:` reason above it. Two live sessions can share '
    + 'one, so this acts on whichever comes first. Resolve by sessionId (or a.key) — or, if the '
    + 'name really is the right key here, say so with `name-ok: <why>`:\n  ' + offenders.join('\n  '));
});
