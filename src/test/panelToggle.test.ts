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
  /* It no longer has to be LISTED anywhere: the shortcut map is generated from the installed
     menu, so binding it in the menu is what publishes it. That is the point of the change — the
     hardcoded table had already drifted four entries behind the menu in a single day. */
  assert.match(app, /await window\.glassShell\.menuShortcuts\(\)/,
    'the map must be read from the installed menu, not from a list in the renderer');
});

test('the shortcut map is GENERATED, and both surfaces share one renderer', () => {
  /* Was: "no label points at its own container" — a real problem when the rows were hand-written
     and rendered in two places, so "This sheet" named the wrong thing on Home. Labels now come
     from the menu itself, which cannot be self-referential, and both surfaces call the same
     function, so they cannot disagree at all. The invariant worth guarding moved. */
  assert.doesNotMatch(app, /shortcuts\.this/, 'no self-referential label may return');
  assert.doesNotMatch(app, /const SHORTCUTS = \[/,
    'a hardcoded table is what drifted — it must not come back');

  const renderer = /async function renderShortcuts\(wrap\) \{[\s\S]*?\n\}/.exec(app);
  assert.ok(renderer, 'one shared renderer must exist');
  const calls = [...app.matchAll(/await renderShortcuts\(wrap\);/g)];
  assert.equal(calls.length, 2, 'the ⌘/ sheet AND Home must both render through it');

  /* The map must also cover keys the MENU does not know about. Without this it would be
     confidently incomplete, which is worse than absent: a map that omits ⌘F reads as
     "⌘F is not a shortcut here". */
  assert.match(app, /const RENDERER_KEYS = \[/, 'renderer-owned keys must be declared');
  for (const accel of ['CmdOrCtrl+F', 'Escape', 'CmdOrCtrl+Click']) {
    assert.ok(app.includes(`accel: '${accel}'`), `${accel} is renderer-owned and must be listed`);
  }
});

test('every renderer-owned key in the map still has a live handler', () => {
  /* The other half of honesty: the declared list must not outlive its implementation. ⌘F must
     still be intercepted, Escape must still leave Zen. A map that lists a key nothing handles is
     the same lie as a menu binding nothing publishes. */
  assert.match(app, /e\.key\.toLowerCase\(\) !== 'f'\) return;/, '⌘F must still be handled');
  assert.match(app, /e\.key === 'Escape' && zenOn/, 'Escape must still exit a maximized pane');
  assert.match(app, /if \(!ev\.metaKey && !ev\.ctrlKey\) return;/, '⌘-click must still gate on the modifier');
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
