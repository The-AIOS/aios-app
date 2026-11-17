/**
 * Reordering the panel's cards by dragging their titles (0.16.0). The order rule is lifted out of renderer/app.js and run;
 * the wiring is read from the source.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';

const app = fs.readFileSync('renderer/app.js', 'utf8');
const css = fs.readFileSync('renderer/theme.css', 'utf8');

function rule(): (ids: string[], dragged: string, target: string, after: boolean) => string[] {
  const m = /function cardDropOrder\(ids, dragged, target, after\) \{[\s\S]*?\n\}/.exec(app);
  assert.ok(m, 'cardDropOrder not found in renderer/app.js');
  return new Function(`${m![0]}; return cardDropOrder;`)() as (ids: string[], dragged: string, target: string, after: boolean) => string[];
}

test('dropping a card before or after another puts it exactly there', () => {
  const f = rule();
  const ids = ['pRun', 'pCal', 'pLearn', 'pOut'];
  assert.deepEqual(f(ids, 'pOut', 'pRun', false), ['pOut', 'pRun', 'pCal', 'pLearn'], 'to the top');
  assert.deepEqual(f(ids, 'pRun', 'pOut', true), ['pCal', 'pLearn', 'pOut', 'pRun'], 'to the bottom');
  assert.deepEqual(f(ids, 'pRun', 'pLearn', false), ['pCal', 'pRun', 'pLearn', 'pOut'], 'down, before a card');
  assert.deepEqual(f(ids, 'pOut', 'pCal', true), ['pRun', 'pCal', 'pOut', 'pLearn'], 'up, after a card');
});

test('a drop on itself, or with an unknown card, changes nothing', () => {
  const f = rule();
  const ids = ['a', 'b', 'c'];
  assert.deepEqual(f(ids, 'b', 'b', true), ids);
  assert.deepEqual(f(ids, 'x', 'b', true), ids);
  assert.deepEqual(f(ids, 'b', 'x', false), ids);
});

test('wiring: titles drag, the panel takes the drop once, frames step aside, the arrows stay', () => {
  assert.match(app, /ti\.draggable = true;/, 'a card title is the drag handle');
  assert.match(app, /setData\('application\/x-aios-card', card\.id\)/, 'a private type, so no other drop target reads it as a file');
  assert.match(app, /panel\.dataset\.cardDrag = '1';/, 'drop listeners are installed once, not per redraw');
  assert.match(app, /^wirePanelCardDrag\(\);/m, 'and installed at startup');
  const drop = app.slice(app.indexOf("panel.addEventListener('drop'"), app.indexOf("panel.addEventListener('drop'") + 1400);
  assert.match(drop, /panel\.insertBefore\(dragged, nextEl\)/, 'only the dragged card moves (moving a board frame reloads it)');
  assert.doesNotMatch(drop, /applyPulseOrder\(\)/, 'never re-places every card on a drop');
  assert.match(app, /isTabDrag = \(ev\) => \{[^}]*application\/x-aios-card/, 'a card drag lights no drop-here overlays');
  assert.match(app, /window\.addEventListener\('dragend', endCardDrag, true\);/, 'cleared from the window too, when a refresh replaced the source');
  assert.match(app, /window\.addEventListener\('mousemove', \(\) => \{ if \(dragCardId\) endCardDrag\(\); \}\);/, 'and on the first mouse move after the drag');
  assert.match(css, /body\.pcard-dragging #panel iframe \{ pointer-events: none; \}/, 'board frames do not swallow the drag');
  assert.match(app, /moveCard\(card, -1\)/, 'the arrows and keys still work');
});
