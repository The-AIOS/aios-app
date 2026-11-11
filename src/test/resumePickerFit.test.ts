/**
 * #144: on a 14-inch Windows laptop (1920 × 1200 at 150%) the Resume picker's button sat below the screen and Enter did
 * nothing. Three causes, each guarded here with a control that breaks it:
 *   · the window opened at 1360 × 860, taller than the ~1280 × 752 work area → it is fitted to the screen;
 *   · the picker had no height limit → it fits the window and the list gives up the height;
 *   · a click on a row left the focus on <body>, where Enter is not read → the focus goes back to the filter box,
 *     and with nothing ticked Enter opens the highlighted row.
 * What these cannot see is the picker on a real short screen: that is the release hand test.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { fitToWorkArea } from '../core/windowFit';

const app = fs.readFileSync('renderer/app.js', 'utf8');
const css = fs.readFileSync('renderer/theme.css', 'utf8');
const main = fs.readFileSync('src/main/main.ts', 'utf8');
const MIN = { width: 880, height: 560 };
const WANT = { width: 1360, height: 860 };

test('the window never opens taller or wider than the work area, nor below its minimum', () => {
  assert.deepEqual(fitToWorkArea(WANT, { width: 1280, height: 752 }, MIN), { width: 1280, height: 752 }, '14-inch at 150%');
  assert.deepEqual(fitToWorkArea(WANT, { width: 2560, height: 1415 }, MIN), WANT, 'control: a big screen keeps the usual size');
  assert.deepEqual(fitToWorkArea(WANT, { width: 800, height: 500 }, MIN), MIN, 'a tiny screen gets the minimum, never less');
  assert.deepEqual(fitToWorkArea(WANT, null, MIN), WANT, 'no screen information: the usual size');
  assert.deepEqual(fitToWorkArea(WANT, { width: 1280.6, height: 752.9 }, MIN), { width: 1280, height: 752 }, 'whole pixels, rounded down');
});

const sizedByFit = (src: string) => /const size = fitToWorkArea\(\{ width: 1360, height: 860 \}, work, \{ width: 880, height: 560 \}\);/.test(src)
  && /width: CHAT_SHOT \? CHAT_SHOT_SIZE\.width : size\.width,/.test(src) && /height: CHAT_SHOT \? CHAT_SHOT_SIZE\.height : size\.height,/.test(src)
  && /screen\.getPrimaryDisplay\(\)\.workAreaSize/.test(src);
test('the main window takes its size from fitToWorkArea', () => {
  assert.ok(sizedByFit(main));
  assert.equal(sizedByFit(main.replace('CHAT_SHOT_SIZE.height : size.height', 'CHAT_SHOT_SIZE.height : 860')), false, 'control: the fixed height fails');
});

function checkModalSrc(src: string): string {
  const at = src.indexOf('function checkModal(');
  return src.slice(at, src.indexOf('\n}\n', at) + 2);
}
const fits = (js: string, sheet: string) => /<div class="modal mcheck">/.test(checkModalSrc(js))
  && /\.modal\.mcheck \{ display: flex; flex-direction: column; max-height: calc\(100vh - 17vh - 16px\);/.test(sheet)
  && /\.modal\.mcheck > \.plist \{ flex: 0 1 auto; min-height: 64px; \}/.test(sheet)
  && /\.modal\.mcheck > \* \{ flex-shrink: 0; \}/.test(sheet)
  && /padding-top: 17vh;/.test(sheet);
test('the picker fits the window: capped height, and the list is what shrinks', () => {
  assert.ok(fits(app, css));
  assert.equal(fits(app.replace('<div class="modal mcheck">', '<div class="modal">'), css), false, 'control: the picker without the class');
  assert.equal(fits(app, css.replace('.modal.mcheck > .plist { flex: 0 1 auto;', '.modal.mcheck > .plist { flex: 0 0 auto;')), false, 'control: a list that cannot shrink');
});

const enterWorks = (js: string) => {
  const s = checkModalSrc(js);
  return /list\.addEventListener\('click', \(\) => \{ if \(wrap\.isConnected\) input\.focus\(\{ preventScroll: true \}\); \}\);/.test(s)
    && /it\.on = !it\.on; sel = idx; paint\(\); paintGo\(\);/.test(s)
    && /if \(state\.some\(\(s\) => s\.on\) \|\| allowEmpty\) done\(chosen\(\)\);\n\s+else if \(it\) done\(\[it\.value\]\);/.test(s)
    && !/list\.addEventListener\('mousedown'/.test(s);   // cancelling mousedown would stop the scrollbar being dragged
};
test('after a click the filter box has the focus again, and Enter opens the highlighted row when nothing is ticked', () => {
  assert.ok(enterWorks(app));
  assert.equal(enterWorks(app.replace("list.addEventListener('click', () => { if (wrap.isConnected) input.focus({ preventScroll: true }); });", '')), false, 'control: no refocus');
  assert.equal(enterWorks(app.replace('        else if (it) done([it.value]);', '')), false, 'control: Enter needs a tick again');
});
