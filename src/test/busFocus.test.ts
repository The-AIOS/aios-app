/**
 * Command-bus panes stay in the background (setting `busFocus`, default 'stay').
 *
 * Agents spawn sessions and pass messages between them through the spawn-inbox all day. Each
 * request used to switch the operator's screen to the target tab, mid-sentence. These are source
 * invariants because the failure is a focus change, which no unit can observe and a smoke boot
 * never triggers: the bus has to fire for it to show.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';

const app = fs.readFileSync('renderer/app.js', 'utf8');
const bus = fs.readFileSync('src/main/commandBus.ts', 'utf8');
const aios = fs.readFileSync('src/main/aios.ts', 'utf8');
const css = fs.readFileSync('renderer/theme.css', 'utf8');

test('the bus marks its spawns and reveals as background', () => {
  assert.match(bus, /emit\(win\(\), 'terminal', \{ name: req\.name, cmd, background: true \}\)/);
  assert.match(bus, /emit\(win\(\), 'focusByName', \{ name: req\.name, background: true \}\)/);
});

test("default is 'stay'; only an explicit 'follow' restores switching", () => {
  assert.match(aios, /busFocus: raw\.busFocus === 'follow' \? 'follow' : 'stay'/);
  assert.match(app, /BUS_FOCUS = c\.busFocus === 'follow' \? 'follow' : 'stay';/);
  assert.match(app, /const busBackground = \(m\) => !!\(m && m\.background\) && BUS_FOCUS !== 'follow';/);
});

test('a background pane is sized, then the view is handed back in the same pass', () => {
  const create = /async function createPane\([\s\S]*?\n\}/.exec(app)?.[0] ?? '';
  assert.match(create, /background = false/, 'createPane takes the flag');
  assert.match(create, /homePane\(id, p, \{ fresh: !background \}\)/, 'no zone reveal for a background pane');
  // order matters: sizing needs the pane visible, the restore must follow the geometry push
  const geom = create.indexOf('pushPtyGeom(id, p);');
  const back = create.indexOf('if (snap) { restoreFocus(snap, id); markActivity(id); }');
  assert.ok(geom > 0 && back > geom, 'restore after pushPtyGeom, never before');
  assert.match(app, /case 'terminal':\n\s+await createPane\(\{ name: m\.name \|\| 'terminal', cmd: m\.cmd, background: busBackground\(m\) \}\);/);
});

test('a bus send types in the background; the operator\'s own navigation still switches', () => {
  assert.match(app, /if \(BUS_FOCUS === 'follow'\) setActive\(hit\[0\]\); else markActivity\(hit\[0\]\);/);
  assert.doesNotMatch(app, /submitToPty\(hit\[0\], m\.text\);\n\s+setActive\(hit\[0\]\);/, 'the unconditional switch is gone');
  assert.match(app, /if \(hit && busBackground\(m\)\) markActivity\(hit\[0\]\);[^\n]*\n\s+else if \(hit\) setActive\(hit\[0\]\);/);
});

test('the activity mark IS #45\'s unseen marker: one meaning, one marker, cleared by watching', () => {
  /* Follow-up to this PR (merged): a second coral dot beside the status dot and #45's bold name
     both meant "something happened here you have not seen". markActivity now sets the same
     unseen state, which #45's nextUnseen clears once the pane has been watched. */
  const mark = /function markActivity\(id\) \{[\s\S]*?\n\}/.exec(app)?.[0] ?? '';
  assert.match(mark, /p\.unseen = true;/);
  assert.match(mark, /nm\.classList\.add\('unseen'\)/);
  assert.doesNotMatch(css, /tab-activity/, 'no second marker on the tab');
  assert.match(app, /const seen = nextUnseen\(p\.lastCls, info\.cls, p\.unseen,/, 'cleared by the same watched-for-3s rule');
});
