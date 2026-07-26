/**
 * Title-bar sidebar toggle — show/hide the Glass panel.
 *
 * Replaces the collapse-to-icon-rail experiment, which looked worse than simply
 * reclaiming the space. The design point worth guarding: this is a per-layout
 * VISIBILITY flag (pOn), exactly mirroring xOn for the explorer — not a preset change.
 * A preset-based toggle would drag the explorer and the chosen layout along with it,
 * which is what made the old Zen-based togglePanel wrong.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';

const app = fs.readFileSync('renderer/app.js', 'utf8');
const css = fs.readFileSync('renderer/theme.css', 'utf8');
const html = fs.readFileSync('renderer/index.html', 'utf8');

test('the toggle sits in the title bar, immediately left of the layouts button', () => {
  assert.match(html, /<div id="dragacts"><button id="dragPanel" class="ribtn"><\/button><button id="railLayout"/);
});

test('panel visibility is a per-layout flag, symmetric with the explorer', () => {
  assert.match(app, /let pOn = layoutState\.pOn !== false;/);
  assert.match(app, /const showP = hasPanel\(\) && pOn;/);
  assert.match(app, /pOn \}\)\)|pOn,/, 'must persist with the rest of the layout state');
});

test('from Zen the toggle brings the panel back rather than doing nothing', () => {
  assert.match(app, /if \(!hasPanel\(\)\) \{ preset = lastPanelPreset; pOn = true; \} else \{ pOn = !pOn; \}/);
});

test('the button reflects state and is labelled for it, in every locale', () => {
  assert.match(app, /dp\.classList\.toggle\('on', showP\)/);
  assert.match(app, /dp\.innerHTML = icon\('panel', 15\)/, 'a sidebar glyph, not a chevron');
  assert.match(app, /dp\.title = t\(showP \? 'panel\.hide' : 'panel\.show'\)/);
  for (const loc of ['en', 'es', 'pt-br']) {
    const j = JSON.parse(fs.readFileSync(`src/i18n/locales/${loc}.json`, 'utf8')) as Record<string, string>;
    assert.ok(j['panel.hide'] && j['panel.show'], `${loc} needs both labels`);
    assert.ok(!j['panel.collapse'] && !j['panel.expand'], `${loc} must not keep retired collapse strings`);
  }
});

test('⌘B toggles the panel from the native menu, mirroring ⌘E for the explorer', () => {
  const menu = fs.readFileSync('src/main/menu.ts', 'utf8');
  assert.match(menu, /accelerator: 'CmdOrCtrl\+B', click: \(\) => intent\('layout', \{ togglePanel: true \}\)/);
  // it must sit with the explorer toggle it mirrors, and be the ONLY handler — a renderer
  // keydown would be shadowed, since the OS resolves menu accelerators first
  assert.match(menu, /CmdOrCtrl\+E'[\s\S]{0,600}CmdOrCtrl\+B'/);
  assert.doesNotMatch(app, /key(?:Code)? === 'b'|'KeyB'[^)]*togglePanel/);
  assert.match(app, /\['⌘B', 'shortcuts\.panel'\]/, 'and it must appear in the sheet');
});

test('no label in the shortcuts sheet points at its own container', () => {
  // The same rows render in the ⌘/ tab AND inline on Home, so "This sheet" named the wrong
  // thing in one of the two places. Labels name the artifact instead.
  assert.doesNotMatch(app, /shortcuts\.this/);
  for (const loc of ['en', 'es', 'pt-br']) {
    const j = JSON.parse(fs.readFileSync(`src/i18n/locales/${loc}.json`, 'utf8')) as Record<string, string>;
    assert.ok(!j['shortcuts.this'], `${loc} must drop the self-referential label`);
    assert.ok(j['shortcuts.sheet'], `${loc} must name the sheet`);
    assert.ok(j['shortcuts.panel'] && j['menu.togglePanel'], `${loc} must label the panel toggle`);
    assert.doesNotMatch(j['shortcuts.sheet'], /\bthis\b|\beste\b|\besta\b/i, `${loc} label is still self-referential`);
  }
  // Home renders the very same array — that is WHY the label had to be context-free
  const homeUse = app.indexOf('Shortcuts live on Home');
  assert.ok(homeUse > 0 && app.indexOf('for (const [groupKey, rows] of SHORTCUTS)', homeUse) > homeUse);
});

test('the splitter hides with the panel — nothing to drag against', () => {
  assert.match(app, /getElementById\('psplit'\)\.style\.display = showP \? '' : 'none';/);
});

test('every trace of the icon-rail collapse is gone', () => {
  for (const dead of ['pCol', 'pCollapse', 'paintCollapse', "setProperty('--pw'"]) {
    assert.ok(!app.includes(dead), `${dead} left behind in app.js`);
  }
  assert.doesNotMatch(css, /body\.pcol|\.pcolbtn|--prail/, 'rail CSS left behind');
  assert.ok(!html.includes('pCollapse'), 'the collapse button is still in the markup');
  // …but the UNRELATED per-card collapse must survive: same word, different feature
  assert.match(css, /\.pcard\.pcollapsed > \*:not\(\.ptitle\)/);
});

test('per-card coral glyphs stay — they earn their place independently of the rail', () => {
  assert.match(app, /const CARD_ICONS = \{/);
  assert.match(css, /\.ptcon \{/);
  assert.doesNotMatch(css, /\.ptitle::before/, 'the shared dot stays retired');
});
