/**
 * The zone header — tabs scroll, controls stay.
 *
 * Each zone's header used to be ONE horizontally scrolling strip holding the tabs AND the zone's
 * controls (+, Chat | Terminal, expand). Only expand was sticky, so a long session name or a narrow
 * zone pushed the (+) and the Chat | Terminal switch past the right edge, and expand sat on top of
 * the tab name. All four controls now live together beside the scroller, not inside it. This is
 * guarded structurally: a control moved back into the strip would pass every behavioural test and
 * only show up at a narrow width.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';

const html = fs.readFileSync('renderer/index.html', 'utf8');
const css = fs.readFileSync('renderer/theme.css', 'utf8');

for (const [strip, z] of [['tabs', 'Main'], ['ttabs', 'Term']] as const) {
  test(`#${strip}: (+), Chat | Terminal and expand sit outside the scrolling strip`, () => {
    const m = new RegExp(`<div class="zbar"><div id="${strip}" class="tabstrip">([\\s\\S]*?)</div>([\\s\\S]*?)</div>`).exec(html);
    assert.ok(m, `#${strip} is not wrapped in a .zbar — the controls would scroll with the tabs`);
    const [, inside, beside] = m;
    assert.doesNotMatch(inside, /newTab|zview|zexp/, 'no zone control inside the scroller');
    assert.match(beside, /class="newTab"/, 'the (+) beside the scroller, with the others');
    assert.match(beside, new RegExp(`id="zview${z}"`), 'Chat | Terminal beside the scroller');
    assert.match(beside, new RegExp(`id="zexp${z}"`), 'expand beside the scroller');
  });
}

test('the strip shrinks instead of pushing the controls out', () => {
  assert.match(css, /\.tabstrip \{[^}]*flex: 1 1 auto; min-width: 0;/);
});

test('tabs are appended to the strip, not inserted before a (+) that no longer lives there', () => {
  const app = fs.readFileSync('renderer/app.js', 'utf8');
  const paint = app.slice(app.indexOf('function paintStrip'), app.indexOf('\n}\n', app.indexOf('function paintStrip')));
  assert.match(paint, /strip\.appendChild\(p\.tab\)/);
  assert.doesNotMatch(paint, /newTab/);
});

/* 0.15.0 round: tabs hidden past an edge are said, with a fade and a chevron on that side. */
const appSrc = fs.readFileSync('renderer/app.js', 'utf8');
const fnSrc = (name: string): string => appSrc.slice(appSrc.indexOf('function ' + name + '('), appSrc.indexOf('\n}\n', appSrc.indexOf('function ' + name + '(')) + 2);
function overflowHarness(src: string) {
  const fn = (name: string): string => src.slice(src.indexOf('function ' + name + '('), src.indexOf('\n}\n', src.indexOf('function ' + name + '(')) + 2);
  return new Function(fn('stripOverflowState') + fn('syncStripOverflow') + 'return syncStripOverflow;')() as (s: unknown) => void;
}
function fakeStrip(scrollWidth: number, clientWidth: number, scrollLeft: number) {
  const cls = new Set<string>();
  return {
    scrollWidth, clientWidth, scrollLeft, cls,
    classList: { toggle: (c: string, on: boolean) => { if (on) cls.add(c); else cls.delete(c); } },
    _ovL: { hidden: true }, _ovR: { hidden: true },
  };
}

test('a strip with tabs past its right edge fades there and shows the right chevron; scrolled to the end, the left one', () => {
  const sync = overflowHarness(appSrc);
  const fits = fakeStrip(400, 400, 0); sync(fits);
  assert.deepEqual([...fits.cls], [], 'everything fits: no fade');
  assert.equal(fits._ovL.hidden && fits._ovR.hidden, true, 'and no chevrons');
  const start = fakeStrip(700, 400, 0); sync(start);
  assert.deepEqual([...start.cls], ['ov-r'], 'tabs hide on the right only');
  assert.equal(start._ovR.hidden, false); assert.equal(start._ovL.hidden, true);
  const mid = fakeStrip(700, 400, 150); sync(mid);
  assert.deepEqual([...mid.cls].sort(), ['ov-l', 'ov-r'], 'both sides hide tabs');
  const end = fakeStrip(700, 400, 300); sync(end);
  assert.deepEqual([...end.cls], ['ov-l'], 'scrolled to the end: only the left hides tabs');
  /* Negative control: a sync that never looks at scrollLeft would call the end state "right" too. */
  const broken = overflowHarness(appSrc.replace('strip.scrollLeft < max - 1', 'true'));
  const e2 = fakeStrip(700, 400, 300); broken(e2);
  assert.ok(e2.cls.has('ov-r'), 'control: without the scroll position the right edge is wrongly flagged');
});

test('both zone strips get the chevrons, kept current on scroll, resize and tab changes, translated, and faded by a mask', () => {
  assert.match(appSrc, /for \(const sid of \['tabs', 'ttabs'\]\) setupStripOverflow\(document\.getElementById\(sid\)\);/);
  const setup = fnSrc('setupStripOverflow');
  assert.match(setup, /strip\.addEventListener\('scroll', sync/);
  assert.match(setup, /new ResizeObserver\(sync\)\.observe\(strip\)/);
  assert.match(setup, /new MutationObserver\(sync\)\.observe\(strip, \{ childList: true/);
  assert.match(setup, /data-i18n-title/, 're-resolved when the locale changes');
  assert.match(css, /\.tabstrip\.ov-r \{ -webkit-mask-image:/, 'a mask, so it fades into any zone colour in either theme');
  assert.match(css, /\.zbar > \.tsMore\[hidden\] \{ display: none; \}/);
  for (const loc of ['en', 'es', 'pt-br', 'el']) {
    const j = JSON.parse(fs.readFileSync(`src/i18n/locales/${loc}.json`, 'utf8')) as Record<string, string>;
    assert.ok(j['tab.moreLeft'] && j['tab.moreRight'], loc);
  }
});
