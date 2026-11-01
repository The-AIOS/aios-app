/**
 * Tab groups — Chrome's model (name + colour, fold away).
 *
 * The two decisions that can go quietly wrong are pure and are tested here straight out of the
 * renderer, by extraction, so there is no second copy to keep in step: where a group's tabs sit
 * (always one contiguous run inside the ONE tab order), and which group a dragged tab ends up in.
 * The rest is guarded structurally — every colour exists in both themes and every locale, the
 * store is keyed by session id, and closing a group goes through the tab's own close.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';

const app = fs.readFileSync('renderer/app.js', 'utf8');

function fn<T>(name: string): T {
  const m = new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}\\n`).exec(app);
  assert.ok(m, `could not find ${name} in renderer/app.js — this test would measure nothing`);
  return new Function(`${m[0]} return ${name};`)() as T;
}

type Contig = (order: string[], groupOf: (id: string) => string) => string[];
type AfterMove = (order: string[], groupOf: (id: string) => string, id: string) => string;
const tgContiguous = fn<Contig>('tgContiguous');
const tgAfterMove = fn<AfterMove>('tgAfterMove');
const of = (m: Record<string, string>) => (id: string): string => m[id] || '';

test('a group is one contiguous run, at its first member, everything else in place', () => {
  const g = of({ b: 'G', d: 'G', f: 'H', a: '' });
  assert.deepEqual(tgContiguous(['a', 'b', 'c', 'd', 'e', 'f'], g), ['a', 'b', 'd', 'c', 'e', 'f']);
  assert.deepEqual(tgContiguous(['x', 'y'], of({})), ['x', 'y'], 'no groups → the order is untouched');
  const order = ['a', 'b', 'c'];
  assert.deepEqual(tgContiguous(order, of({ a: 'G', b: 'G' })), order, 'an already-contiguous run does not move');
});

test('removing a tab from the middle of its group puts it right after the run', () => {
  /* tgRemove clears the membership and re-normalizes: the run closes up and the freed tab sits
     just past it, rather than splitting the group in two. */
  assert.deepEqual(tgContiguous(['a', 'x', 'b', 'c'], of({ a: 'G', b: 'G' })), ['a', 'b', 'x', 'c']);
});

test('dragging: into a run joins, out of it leaves, along its edge keeps', () => {
  const g = of({ a: 'G', b: 'G', c: 'G', y: 'H' });
  assert.equal(tgAfterMove(['a', 'x', 'b', 'c'], of({ a: 'G', b: 'G', c: 'G' }), 'x'), 'G', 'dropped between two members → joins');
  assert.equal(tgAfterMove(['a', 'b', 'q', 'c'], of({ a: 'G', b: 'G', c: 'H', q: 'H' }), 'q'), 'H', 'still touching its own run → keeps it');
  assert.equal(tgAfterMove(['b', 'c', 'n', 'a'], of({ a: 'G', b: 'G', c: 'G' }), 'a'), '', 'dragged past an ungrouped tab, away from its run → leaves');
  assert.equal(tgAfterMove(['n', 'y', 'a', 'b'], g, 'y'), 'H', 'a group of one travels with its tab');
  assert.equal(tgAfterMove(['a', 'b', 'z'], g, 'z'), '', 'an ungrouped tab at a run\'s edge stays ungrouped');
});

test('every group colour exists in both themes and every locale', () => {
  const colors = /const TG_COLORS = \[([^\]]+)\]/.exec(app)![1].match(/'(\w+)'/g)!.map((c) => c.slice(1, -1));
  assert.ok(colors.length >= 8, 'Chrome\'s palette');
  const css = fs.readFileSync('renderer/theme.css', 'utf8');
  const root = css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {')));
  const light = css.slice(css.indexOf('body.light {'), css.indexOf('}', css.indexOf('body.light {')));
  for (const c of [...colors, 'ink']) {
    assert.match(root, new RegExp(`--tg-${c}:`), `--tg-${c} missing from the dark theme`);
    assert.match(light, new RegExp(`--tg-${c}:`), `--tg-${c} missing from the light theme`);
  }
  for (const loc of fs.readdirSync('src/i18n/locales')) {
    const d = JSON.parse(fs.readFileSync(`src/i18n/locales/${loc}`, 'utf8')) as Record<string, string>;
    for (const c of colors) assert.ok(d[`tg.color.${c}`], `${loc} has no tg.color.${c}`);
    for (const k of [...app.matchAll(/t\('(tg\.[\w.]+)'/g)].map((m) => m[1]).filter((k) => !k.endsWith('.'))) assert.ok(d[k], `${loc} has no ${k}`);
  }
});

test('groups persist with the sessions, keyed by session id, and come back validated', () => {
  const snap = app.slice(app.indexOf('function sessionsSnapshot'), app.indexOf('function persistSessions'));
  assert.match(snap, /group: tgOf\(id\)/, 'each session entry carries its group');
  assert.match(snap, /groups/, 'the snapshot carries the group definitions');
  const adopt = app.slice(app.indexOf('function tgAdopt'), app.indexOf('/** On launch: offer back'));
  assert.match(adopt, /TG_COLORS\.includes\(g\.color\)/, 'an unknown colour must never reach a CSS variable name');
  assert.match(app, /if \(ph\.group\) np\.group = ph\.group;/, 'resuming a restored tab keeps its group');
});

test('closing a group closes each tab the way its × does, and the tab menu offers grouping', () => {
  const menu = app.slice(app.indexOf('async function tgChipMenu'), app.indexOf('function tgTabMenuItems'));
  assert.match(menu, /await requestClosePane\(id\)/, 'a live session must still get its capture-or-end picker');
  assert.doesNotMatch(menu, /(^|[^A-Za-z])closePane\(/, 'never the raw close, which skips the picker');
  const tabMenu = app.slice(app.indexOf("tab.addEventListener('contextmenu'"), app.indexOf('/* ── drag to reorder'));
  assert.match(tabMenu, /tgTabMenuItems\(id\)/);
  const main = fs.readFileSync('src/main/main.ts', 'utf8');
  assert.match(main, /submenu: build\(it\.items\)/, 'the native tab menu renders "Add to group ▸" as a submenu');
});

/* ── 0.14.0 walkthrough round ─────────────────────────────────────────────────────────────────── */
type HomeOf = (orders: Record<string, string[]>, groupOf: (id: string) => string) => Map<string, string>;
const tgHomeOf = fn<HomeOf>('tgHomeOf');

test('a group lives in every zone that holds one of its tabs: never evicted, a pill in each strip that has members', () => {
  /* 0.14.0 round 3: evicting the "minority" zone's tabs cost a group its members when the layout moved them. */
  assert.match(app, /function tgSettleZones\(\) \{\}/, 'nothing is evicted');
  const add = app.slice(app.indexOf('function tgAdd'), app.indexOf('\n}\n', app.indexOf('function tgAdd')));
  assert.doesNotMatch(add, /never across zones/, 'a tab from either zone can join');
  const menu = app.slice(app.indexOf('function tgTabMenuItems'), app.indexOf('\n}\n', app.indexOf('function tgTabMenuItems')));
  assert.match(menu, /filter\(\(g\) => g !== own\)/, '"Add to group" offers every group');
  const paint = app.slice(app.indexOf('function paintGroups'), app.indexOf('\n}\n', app.indexOf('function paintGroups')));
  assert.match(paint, /const seen = new Set\(\);[\s\S]*for \(const id of tabOrder\[z\]\)/, 'a pill only in a strip where the group has a tab (the stray "A" of round 1 stays fixed)');
});


test('a fold never moves the focus: you stay on your tab, so one fold can never open another group', () => {
  /* Rounds 1-3 (0.14.0): moving the focus out of the folded group first unfolded ANOTHER group (its tab was the nearest),
     then landed on any ungrouped tab. The operator's rule: folding the group you are in leaves you on your tab. */
  const tog = app.slice(app.indexOf('function tgToggle'), app.indexOf('\n}\n', app.indexOf('function tgToggle')));
  assert.doesNotMatch(tog, /setActive\(/, 'a fold never changes the active tab');
  assert.match(tog, /const keep = vis\.filter\(\(v\) => tgOf\(v\) !== gid \|\| v === active\[z\]\);/, 'a folded member leaves the split, except the tab you are on');
  assert.match(app, /p\.tab\.classList\.toggle\('tgcollapsed', !!g && tgFoldedIn\(gid, z\) && id !== active\[z\] && !zones\[z\]\.visible\.includes\(id\)\);/,
    'the focused member of a folded group keeps its tab');
});


test('the chip and its members draw their group line on one baseline', () => {
  const css = fs.readFileSync('renderer/theme.css', 'utf8');
  assert.match(css, /\.tgchip \{[^}]*align-self: stretch;/, 'the chip is as tall as the row');
  assert.match(css, /\.tabstrip > \.tab \{ align-self: stretch; \}/, 'and so are the tabs');
  assert.match(css, /\.tgchip \.tgpill \{[^}]*background: var\(--tg\);/, 'the colour is on the pill inside');
  assert.match(app, /pill\.className = 'tgpill';/);
});

test('a new group asks for its name AND its colour together; Esc puts both back', () => {
  const edit = app.slice(app.indexOf('function tgEdit'), app.indexOf('\n}\n', app.indexOf('function tgEdit')));
  assert.match(app.slice(app.indexOf('async function tgNew'), app.indexOf('\n}\n', app.indexOf('async function tgNew'))), /await tgEdit\(gid, t\('tg\.nameTitle'\)\);/);
  assert.match(edit, /for \(const c of TG_COLORS\)/, 'every colour is a swatch');
  assert.match(edit, /if \(e\.key === 'Enter'\) \{ e\.preventDefault\(\); done\(true\); \}/);
  assert.match(edit, /else if \(e\.key === 'Escape'\) \{ e\.preventDefault\(\); e\.stopPropagation\(\); done\(false\); \}/);
  assert.match(edit, /if \(keep\) g\.name = input\.value\.trim\(\)\.slice\(0, 40\); else Object\.assign\(g, before\);/);
  assert.ok(!/inputModal\(t\('tg\./.test(app), 'no native prompt left for groups');
  for (const loc of ['en', 'es', 'pt-br', 'el']) {
    const L = JSON.parse(fs.readFileSync(`src/i18n/locales/${loc}.json`, 'utf8')) as Record<string, string>;
    assert.ok(L['tg.edit'], `${loc} has tg.edit`);
  }
});


test('the Running card mirrors the tab groups: a heading in the group colour, its sessions under it, a click folds it', () => {
  /* 0.14.0 round: "is it feasible to group sessions in running card in panel to reflect the groupings?" */
  const fn = app.slice(app.indexOf('function renderPulseRunning'), app.indexOf('\n}\n', app.indexOf('function renderPulseRunning')));
  assert.match(fn, /const gid = hit \? tgOf\(hit\[0\]\) : null;/);
  assert.match(fn, /groupBox = el\('div', 'pgroup'\);/);
  assert.match(fn, /head\.addEventListener\('click', \(\) => \{ tgToggle\(gid, hz\); renderPulseRunning\(\); \}\);/);
  assert.match(fn, /\(groupBox \|\| box\)\.appendChild\(r\);/, 'an ungrouped session stays in the plain list');
  const rp = app.slice(app.indexOf('function tgRepaint'), app.indexOf('\n}\n', app.indexOf('function tgRepaint')));
  assert.match(rp, /renderPulseRunning\(\)/, 'a rename, a colour or a fold shows in the card at once');
});

test('a layout change settles the groups into their zones at once', () => {
  const fn = app.slice(app.indexOf('function applyLayout'), app.indexOf('\n}\n', app.indexOf('function applyLayout')));
  assert.match(fn, /setTimeout\(\(\) => \{ if \(typeof tgRepaint === 'function' && tabGroups\.size\) tgRepaint\(\); \}, 0\);/);
});

test('a group folds per strip: the editor pill and the running pill fold on their own, and each counts its own tabs', () => {
  /* 0.14.0 round 3: a click on the running pill showed the editor tabs' count and folded both. */
  const tog = app.slice(app.indexOf('function tgToggle'), app.indexOf('\n}\n', app.indexOf('function tgToggle')));
  assert.match(tog, /const zs = zone \? \[zone\] : \['main', 'term'\];/);
  assert.match(app, /c\.addEventListener\('click', \(\) => tgToggle\(gid, z\)\);/, 'a pill folds its own strip');
  assert.match(app, /n\.textContent = String\(tgMembersIn\(gid, z\)\.length\);/, 'and counts its own tabs');
  assert.match(app, /if \(fold && tgFold\(fold\)\[z\]\) tgFold\(fold\)\[z\] = false;/, 'reaching a tab unfolds only its strip');
  assert.match(app, /fold: \{ \.\.\.tgFold\(tabGroups\.get\(g\)\) \}/, 'saved per strip');
  assert.match(app, /\{ main: !!g\.collapsed, term: !!g\.collapsed \}/, 'an older save still loads');
});

test('dropping a tab onto any tab of a group joins it, either half; onto a tab in no group, it leaves', () => {
  const mv = app.slice(app.indexOf('function moveTab'), app.indexOf('\n}\n', app.indexOf('function moveTab')));
  assert.match(mv, /dp\.group = overId && panes\.has\(overId\) && overId !== dragId \? tgOf\(overId\) : tgAfterMove\(list, tgOf, dragId\);/);
});
