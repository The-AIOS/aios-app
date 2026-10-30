/**
 * Terminals: below / left / right.
 *
 * Same two traps as the layouts (layouts.test.ts), now for the terminal zone:
 *
 * 1. Position must come from CSS (`flex-direction` + `order`), never from moving nodes —
 *    reparenting #termzone would tear down every live terminal in it.
 * 2. The splitter maths is POSITION-based, so it is side-dependent. A missing mirror pins the
 *    terminal zone to its limit on one side — a drag that looks broken but plausible.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';

const app = fs.readFileSync('renderer/app.js', 'utf8');
const css = fs.readFileSync('renderer/theme.css', 'utf8');
const LOCALES = ['en', 'es', 'pt-br', 'el'];

test('three positions, below by default, and a stored choice is validated', () => {
  assert.match(app, /const TERM_POS = \['below', 'left', 'right'\];/);
  assert.match(app, /let termPos = TERM_POS\.includes\(layoutState\.termPos\) \? layoutState\.termPos : 'below';/);
});

test('the choice persists with the layout state', () => {
  assert.match(app, /localStorage\.setItem\('shellLayout', JSON\.stringify\(\{[^}]*\btermPos\b/);
});

test('position is CSS order and flex-direction on #work — the DOM is never rearranged', () => {
  for (const [side, slots] of [
    ['left', { termzone: 1, hsplit: 2, viewzone: 3 }],
    ['right', { viewzone: 1, hsplit: 2, termzone: 3 }],
  ] as [string, Record<string, number>][]) {
    for (const [id, order] of Object.entries(slots)) {
      assert.match(css, new RegExp(`#work\\[data-termpos="${side}"\\] > #${id} \\{ order: ${order}; \\}`), `${side}/${id}`);
    }
  }
  assert.match(css, /#work\[data-termpos="left"\], #work\[data-termpos="right"\] \{ flex-direction: row; \}/);
  // below is the DOM order itself, so it must carry no rules of its own
  assert.doesNotMatch(css, /data-termpos="below"/);
  assert.doesNotMatch(app, /(appendChild|insertBefore|append|prepend)\([^)]*getElementById\('(termzone|viewzone|hsplit)'\)/);
  assert.match(app, /getElementById\('work'\)\.dataset\.termpos = termPos;/);
});

test('beside the view the zone is sized by width, below it by height, never both', () => {
  assert.match(app, /tz\.style\.height = termPos === 'below' \? size : '';/);
  assert.match(app, /tz\.style\.width = termPos === 'below' \? '' : size;/);
});

test('the divider drag mirrors per side', () => {
  assert.match(app, /termPos === 'left' \? \(ev\.clientX - wr\.left\) \/ wr\.width/);
  assert.match(app, /termPos === 'right' \? \(wr\.right - ev\.clientX\) \/ wr\.width/);
  assert.match(app, /: \(wr\.bottom - ev\.clientY\) \/ wr\.height;/, 'below keeps the old vertical maths');
  assert.match(css, /#work\[data-termpos="left"\] > #hsplit, #work\[data-termpos="right"\] > #hsplit \{ width: 3px; height: auto; cursor: col-resize; \}/);
});

test('the dock-height growth only applies when the dock is a strip below', () => {
  assert.match(app, /if \(termPos !== 'below'\) return;/);
});

test('the layout menu offers all three, the native intent validates, and every locale has the strings', () => {
  assert.match(app, /for \(const pos of TERM_POS\) \{/);
  assert.match(app, /if \(TERM_POS\.includes\(m\.termPos\)\) \{ termPos = m\.termPos; split = true; \}/);
  for (const l of LOCALES) {
    const d = JSON.parse(fs.readFileSync(`src/i18n/locales/${l}.json`, 'utf8')) as Record<string, string>;
    for (const k of ['layout.terminalsBelow', 'layout.terminalsLeft', 'layout.terminalsRight']) {
      assert.ok(typeof d[k] === 'string' && d[k].length > 0, `${l} lacks ${k}`);
    }
  }
});
