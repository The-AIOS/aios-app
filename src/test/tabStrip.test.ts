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
  assert.match(css, /transition: all \.14s; flex: 0 0 auto; max-width: 190px; \}/, '0.17.1: by default a tab is as wide as its name, as before 0.17');
  assert.match(css, /body\.tabs-shrink \.tab \{ flex: 0 1 150px; min-width: 90px; max-width: none; overflow: hidden; transition: background \.14s, color \.14s, border-color \.14s; \}/, 'shrinking, when chosen: one width for every tab while they fit');
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
  assert.match(app, /if \(!tab\.title \|\| tab\.title === tab\.dataset\.hoverTitle\) \{ tab\.title = nm\.textContent \|\| ''; tab\.dataset\.hoverTitle = tab\.title; \}/, 'the name on hover, current after a rename, never over another tooltip');
  assert.equal((app.match(/revealTab\((p|q)\.tab\)/g) || []).length, 2, 'the active tab is scrolled into view wherever it is marked');
});

test('hand test of 0.17.0: a tab takes its new width at once (no width animation), and a close through the picker does not hold the strip', () => {
  const app = fs.readFileSync('renderer/app.js', 'utf8');
  assert.match(app, /const acted = await endSession\(\{ name: p\.name, paneId: id \}\);\n[\s\S]{0,400}?if \(KILLBEHAVIOR !== 'kill' && KILLBEHAVIOR !== 'capture' && strip && strip\.dataset\.tfrozen && strip\._thaw\) strip\._thaw\(\);/);
});

test('hand test of 0.17.0: compact tabs are never held after a close, and a hold ends a second after the last close', () => {
  const app = fs.readFileSync('renderer/app.js', 'utf8');
  assert.match(app, /if \(strip\.classList\.contains\('tcompact'\) && !strip\.dataset\.tfrozen\) return;/);
  assert.match(app, /const TAB_THAW_MS = 1000;/);
  assert.match(app, /strip\._thawT = setTimeout\(\(\) => \{ if \(strip\.dataset\.tfrozen && strip\._thaw\) strip\._thaw\(\); \}, TAB_THAW_MS\);/);
});

test('0.17.1: shrinking is a setting, off by default; off, the strip never goes compact and a close holds nothing', () => {
  const app = fs.readFileSync('renderer/app.js', 'utf8');
  assert.match(app, /let TABSIZING = 'scroll';/);
  assert.match(app, /function syncStripStage\(strip\) \{\n  if \(TABSIZING !== 'shrink'\) \{ strip\.classList\.remove\('tcompact'\); return; \}/);
  assert.match(app, /if \(TABSIZING !== 'shrink'\) return;   \/\/ tabs as wide as their names/);
  const aios = fs.readFileSync('src/main/aios.ts', 'utf8');
  assert.match(aios, /tabSizing: raw\.tabSizing === 'shrink' \? 'shrink' : 'scroll',/, 'anything but shrink reads as the default');
  assert.match(fs.readFileSync('src/main/main.ts', 'utf8'), /if \(key === 'tabSizing' && value !== 'scroll' && value !== 'shrink'\) return aios\.shellSettings\(\);/);
});
