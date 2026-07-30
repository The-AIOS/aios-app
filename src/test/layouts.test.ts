/**
 * The four layouts — Stacked · Facing · IDE · Zen.
 *
 * Named on ONE axis (where the docks sit) because the old set mixed three vocabularies:
 * Full described visibility, IDE a tool category, Zen a mood — and once three of four show
 * everything, "Full" distinguished nothing.
 *
 * Two things here fail in ways a screenshot won't show:
 *
 * 1. Position must come from CSS `order`, never from moving nodes. Reparenting #panel or
 *    #work would tear down every live terminal and browser pane inside them.
 * 2. The splitter maths is POSITION-based (`clientX - left`), so it is side-dependent, and
 *    now BOTH docks can be on the right (panel in IDE, explorer in Facing). A missing
 *    mirror pins that dock to its minimum width — a drag that looks broken but plausible.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';

const app = fs.readFileSync('renderer/app.js', 'utf8');
const css = fs.readFileSync('renderer/theme.css', 'utf8');
const html = fs.readFileSync('renderer/index.html', 'utf8');

test('four layouts, in menu order', () => {
  assert.match(app, /const LAYOUTS = \['Stacked', 'Facing', 'IDE', 'Zen'\];/);
});

test('a renamed preset migrates instead of silently resetting the layout', () => {
  // 'Full' → 'Stacked' is the same arrangement; without the migration a returning
  // operator's saved preset fails includes() and their layout quietly reverts
  assert.match(app, /const migratePreset = \(v\) => \(v === 'Full' \? 'Stacked' : v\);/);
  assert.match(app, /LAYOUTS\.includes\(migratePreset\(layoutState\.preset\)\)/);
  assert.match(app, /for \(const v of \[migratePreset\(layoutState\.lastPanelPreset\), migratePreset\(layoutState\.preset\)\]\)/,
    'the remembered panel layout needs migrating too');
});

test('dock position is CSS order — the DOM is never rearranged', () => {
  for (const [layout, slots] of [
    ['facing', { panel: 1, psplit: 2, work: 3, xsplit: 4, xwrap: 5 }],
    ['ide', { xwrap: 1, xsplit: 2, work: 3, psplit: 4, panel: 5 }],
  ] as [string, Record<string, number>][]) {
    for (const [id, order] of Object.entries(slots)) {
      assert.match(css, new RegExp(`#app\\.${layout} > #${id}\\s*\\{ order: ${order};`), `${layout}/${id}`);
    }
  }
  assert.match(app, /classList\.toggle\('facing', preset === 'Facing'\)/);
  assert.match(app, /classList\.toggle\('ide', preset === 'IDE'\)/);
  // Stacked is the DOM order itself, so it must NOT carry its own rules
  assert.doesNotMatch(css, /#app\.stacked/);
  assert.doesNotMatch(app, /(appendChild|insertBefore|append|prepend)\([^)]*getElementById\('(panel|work|xwrap)'\)/);
});

test('each splitter mirrors exactly when its own dock is on the right', () => {
  assert.match(app, /const panelRight = \(pr = preset\) => pr === 'IDE';/);
  assert.match(app, /const explorerRight = \(pr = preset\) => pr === 'Facing';/);
  assert.match(app, /const raw = panelRight\(\) \? r\.right - ev\.clientX : ev\.clientX - r\.left;/);
  assert.match(app, /const raw = explorerRight\(\) \? r\.right - ev\.clientX : ev\.clientX - r\.left;/);
  // the old code hardcoded the layout name in the panel drag and left the explorer
  // permanently unmirrored — correct until Facing existed
  assert.doesNotMatch(app, /preset === 'IDE' \? r\.right/);
});

test('presets are tested by capability, never by name equality', () => {
  assert.match(app, /const hasPanel = /);
  assert.match(app, /const hasExplorer = /);
  assert.doesNotMatch(app, /preset !== 'Full'|preset === 'Full'/, 'a renamed literal is a silent bug');
  // coming back from Zen restores the layout you were in, not a hardcoded one
  assert.match(app, /if \(!hasExplorer\(\)\) \{ preset = lastPanelPreset; xOn = true; \}/);
  assert.match(app, /if \(!hasPanel\(\)\) \{ preset = lastPanelPreset; pOn = true; \} else \{ pOn = !pOn; \}/);
});

test('the menu carries a position diagram, and picking a layout remembers it', () => {
  assert.match(app, /const LAYOUT_BARS = \{/);
  for (const name of ['Stacked', 'Facing', 'IDE', 'Zen']) {
    assert.match(app, new RegExp(`${name}: \\[`), `${name} needs a diagram entry`);
  }
  assert.match(app, /function layoutGlyph\(name\)/);
  assert.match(app, /if \(hasPanel\(name\)\) lastPanelPreset = name;/);
  assert.match(css, /\.lglyph \{/);
});

test('the NATIVE menu owns ⌘1–4, and the renderer does not duplicate it', () => {
  const menu = fs.readFileSync('src/main/menu.ts', 'utf8');
  // A menu accelerator is resolved by the OS before the renderer sees the keystroke, so a
  // second handler in app.js is shadowed on macOS and drifts silently. That is exactly what
  // happened: the menu still sent preset 'Full' (renamed long before) on ⌘1, ⌘2 went to Zen
  // rather than Facing, and ⌘3 toggled terminals instead of selecting IDE.
  const pairs: [string, string][] = [['1', 'Stacked'], ['2', 'Facing'], ['3', 'IDE'], ['4', 'Zen']];
  for (const [key, name] of pairs) {
    assert.match(menu, new RegExp(`accelerator: 'CmdOrCtrl\\+${key}', click: \\(\\) => intent\\('layout', \\{ preset: '${name}' \\}\\)`),
      `⌘${key} must select ${name}`);
  }
  // terminals-below had to leave ⌘3 for a layout
  assert.match(menu, /accelerator: 'CmdOrCtrl\+0', click: \(\) => intent\('layout', \{ toggleSplit: true \}\)/);
  assert.doesNotMatch(menu, /menu\.layoutFull|preset: 'Full'/, 'a renamed preset left in the menu is a dead key');
  // and no competing renderer accelerator
  assert.doesNotMatch(app, /n > LAYOUTS\.length\) return;/, 'the renderer must not re-handle ⌘1–4');
});

test('the renderer validates a preset handed to it by the menu', () => {
  // `if (m.preset) preset = m.preset` let an unknown value sail into the persisted layout
  assert.match(app, /if \(m\.preset && LAYOUTS\.includes\(m\.preset\)\) \{/);
  assert.match(app, /if \(hasPanel\(preset\)\) lastPanelPreset = preset;/);
});

test('every surface that names the shortcut range or the layouts is current', () => {
  assert.match(html, /⌘1–4<\/kbd> layouts/);                       // empty state
  /* The ⌘/ sheet no longer LISTS these — it is generated from the installed menu, so the menu
     bindings below are what publishes them. Assert the source of truth instead of a transcript
     of it: a hand-kept copy is exactly what had drifted four entries behind in one day. */
  const menuSrc = fs.readFileSync('src/main/menu.ts', 'utf8');
  for (const n of ['1', '2', '3', '4']) {
    assert.ok(menuSrc.includes(`accelerator: 'CmdOrCtrl+${n}'`), `⌘${n} must be bound in the menu`);
  }
  assert.ok(menuSrc.includes("accelerator: 'CmdOrCtrl+0'"), '⌘0 must remain the terminal dock');
  assert.doesNotMatch(app, /⌘1–2|⌘1–3/, 'a stale range in a comment becomes a stale range in the UI');
  for (const loc of ['en', 'es', 'pt-br']) {
    const j = JSON.parse(fs.readFileSync(`src/i18n/locales/${loc}.json`, 'utf8')) as Record<string, string>;
    for (const key of ['layout.stacked', 'layout.facing', 'layout.ide', 'layout.zen',
                       'menu.layoutStacked', 'menu.layoutFacing', 'menu.layoutIde', 'menu.layoutZen']) {
      assert.ok(j[key], `${loc} must label ${key}`);
    }
    assert.ok(!j['layout.full'] && !j['menu.layoutFull'], `${loc} must not keep retired 'Full' labels`);
    assert.match(j['empty.keysHint'], /⌘1–4/, `${loc} hint must match the real range`);
    // the sheet's description listed only two layouts by their old names
    for (const name of ['Zen']) assert.ok(j['shortcuts.layouts'].includes(name), `${loc} sheet must list ${name}`);
    assert.doesNotMatch(j['shortcuts.layouts'], /Full/, `${loc} sheet must not name a retired layout`);
    assert.equal(j['shortcuts.layouts'].split('·').length, 4, `${loc} sheet must list all four layouts`);
  }
});

test('opening a pane into a crushed zone restores the balanced split', () => {
  /* Maximize the terminals, then open a file: the editor was a sliver, so the app did exactly
     what was asked and appeared to do nothing. Asking for something is an implicit request to
     see it. Only the SQUEEZED extreme triggers this — a deliberate 70/30 is a preference. */
  const app = fs.readFileSync('renderer/app.js', 'utf8');
  assert.match(app, /function revealZone\(z\) \{/);
  assert.match(app, /revealZone\(z\);/, 'called from homePane, the one place every pane lands');
  // it must fire only from the extreme, never rebalance a zone the operator merely resized
  assert.match(app, /const squeezed = z === 'term' \? th <= TH_MIN \+ 0\.01 : th >= TH_MAX - 0\.01;/);
  assert.match(app, /if \(!squeezed\) return;/);
  /* And it must sit BELOW the constants it reads. A function placed above the `const`s it
     depends on is only safe by call timing, which is precisely how a `const` called twenty
     lines early blanked the whole Setup tab. */
  assert.ok(app.indexOf('const TH_DEFAULT') < app.indexOf('function revealZone'),
    'revealZone must be defined after TH_DEFAULT/TH_MAX/TH_MIN');
});

test('reveal-on-open must be driven by the operator, never by a repaint', () => {
  /* The regression this exists to prevent, measured live: revealZone was hooked into homePane
     unconditionally, on the belief that homePane is "where a new pane lands". It is not —
     applySplit() re-homes EVERY pane on every layout change. So expanding a zone set th to 0.93,
     applySplit re-homed a main-zone pane, revealZone saw main squeezed and snapped back to 0.38.
     The expand button did nothing from any starting point, and revealZone → applySplit →
     homePane → revealZone only terminated because the second pass was no longer squeezed.
     Verified after the fix: 0.93 → 0.38 → 0.07 across three clicks. */
  const app = fs.readFileSync('renderer/app.js', 'utf8');
  assert.match(app, /function homePane\(id, p, \{ fresh = false \} = \{\}\)/);
  assert.match(app, /if \(fresh\) revealZone\(z\);/, 'the reveal must be opt-in');
  // applySplit's re-home loop must NOT opt in — that is the whole bug
  const applySplit = /function applySplit\(\)[\s\S]*?\n\}/.exec(app)?.[0] ?? '';
  assert.ok(applySplit, 'applySplit must exist');
  assert.match(applySplit, /for \(const \[id, p\] of panes\) homePane\(id, p\);/);
  assert.doesNotMatch(applySplit, /fresh/, 'a repaint is not an operator action');
  // and every genuine creation path must opt in, or opening into a crushed zone regresses
  assert.equal((app.match(/homePane\(id, (?:p|paneObj), \{ fresh: true \}\)/g) || []).length, 4,
    'all four pane-creation sites pass fresh');
});

test('more than one notification is actually visible, and the cap cannot hang', () => {
  /* Every toast was `position: fixed; bottom: 18px; right: 18px` — the SAME pixel — so a second
     one landed exactly behind the first and was never seen. Two things happening at once is
     precisely when both need saying. */
  const css = fs.readFileSync('renderer/theme.css', 'utf8');
  assert.match(css, /#toasts \{[^}]*flex-direction: column/);
  assert.match(css, /#toasts \{[^}]*pointer-events: none/, 'the stack must never swallow a click');
  assert.doesNotMatch(css, /\.toast \{ position: fixed/, 'individual toasts must not self-position');
  const app = fs.readFileSync('renderer/app.js', 'utf8');
  // identical text refreshes rather than twinning — a polling check that keeps failing would
  // otherwise paper the screen with the same sentence
  assert.match(app, /const existing = \[\.\.\.host\.children\]\.find\(\(c\) => c\.textContent === text\)/);
  /* The cap must retire SYNCHRONOUSLY. `retire` fades for 300ms before removing, so
     `while (children.length > MAX) retire(...)` cannot ever terminate — it froze the renderer,
     caught only because a probe hung. A deferred effect can never satisfy a synchronous loop. */
  const cap = /while \(host\.children\.length > TOAST_MAX\) \{[\s\S]*?\n  \}/.exec(app)?.[0] ?? '';
  assert.ok(cap, 'the cap loop must exist');
  assert.match(cap, /oldest\.remove\(\);/, 'remove immediately inside the loop');
  assert.doesNotMatch(cap, /retire\(/, 'a fading removal cannot bound a synchronous loop');
});
