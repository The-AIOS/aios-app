/** #189: the tab strip squeezes, then goes compact, then scrolls, like Chrome's; closing in place keeps the widths. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';

const app = fs.readFileSync('renderer/app.js', 'utf8');
const css = fs.readFileSync('renderer/theme.css', 'utf8');

function stage(): (avail: number, count: number, extra: number, gap: number) => string {
  const min = /const TAB_SQUEEZE_MIN = (\d+);/.exec(app);
  const fn = /function tabStripStage\(avail, tabCount, extra, gap\) \{[\s\S]*?\n\}/.exec(app);
  assert.ok(min && fn, 'tabStripStage and TAB_SQUEEZE_MIN not found');
  return new Function(`const TAB_SQUEEZE_MIN = ${min![1]}; ${fn![0]}; return tabStripStage;`)() as (a: number, c: number, e: number, g: number) => string;
}

test('tabs fit while each can have at least 90px; past that the strip goes compact', () => {
  const s = stage();
  assert.equal(s(800, 0, 0, 5), 'fit');
  assert.equal(s(800, 8, 0, 5), 'fit', '8 tabs x 90 + 7 gaps = 755 fits in 800');
  assert.equal(s(800, 9, 0, 5), 'compact', '9 tabs need 850');
  assert.equal(s(800, 8, 60, 5), 'compact', 'group pills take room too');
});

test('the CSS: tabs shrink evenly to 90px, compact shows icon and dot, the active tab keeps its title', () => {
  assert.match(css, /transition: all \.14s; flex: 0 1 auto; min-width: 90px; overflow: hidden; \}/);
  assert.match(css, /\.tabstrip\.tcompact \.tab:not\(\.active\) \.tname, \.tabstrip\.tcompact \.tab:not\(\.active\) \.tx \{ display: none; \}/);
  assert.match(css, /\.tabstrip\.tcompact \.tab\.active \{ min-width: 120px; \}/);
});

test('wiring: the stage is recomputed with the overflow, close holds the widths until the pointer leaves', () => {
  const sync = app.slice(app.indexOf('  const sync = () => {'), app.indexOf('  const sync = () => {') + 1200);
  assert.ok(sync.indexOf('syncStripStage(strip)') < sync.indexOf('revealTab(act)') && sync.indexOf('revealTab(act)') < sync.indexOf('syncStripOverflow(strip)'), 'stage, then reveal, then the fades');
  assert.match(sync, /act !== strip\._lastActive \|\| wasCompact !== strip\.classList\.contains\('tcompact'\)/, 'only when the active tab or the stage changes');
  assert.match(app, /s\.scrollTo\(\{ left: s\.scrollLeft \+ d, behavior: 'instant' \}\)/, 'an instant jump, never a smooth scroll a hidden window would not finish');
  assert.match(app, /if \(e\.target === tx\) \{ freezeStripForClose\(tab\.parentElement\); void requestClosePane\(id\); return; \}/);
  assert.match(app, /strip\.addEventListener\('mouseleave', \(\) => \{ if \(strip\.dataset\.tfrozen\) strip\._thaw\(\); \}\);/);
  assert.match(app, /if \(strip\.dataset\.tfrozen\) return;/, 'no stage change while frozen');
  assert.match(app, /tab\.addEventListener\('mouseenter', \(\) => \{ tab\.title = nm\.textContent/, 'the full name on hover');
  assert.equal((app.match(/revealTab\((p|q)\.tab\)/g) || []).length, 2, 'the active tab is scrolled into view wherever it is marked');
});
