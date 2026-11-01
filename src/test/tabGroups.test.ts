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

test('a group lives in ONE zone: the one holding most of its members, so a stray tab leaves, not the group', () => {
  /* Home in the Editor strip and two terminals in Running shared group A, and its chip showed in both strips. */
  const home = tgHomeOf({ main: ['home'], term: ['t1', 't2', 't3'] }, of({ home: 'A', t1: 'A', t2: 'A', t3: 'B' }));
  assert.equal(home.get('A'), 'term', 'two members in Running outvote one in the Editor');
  assert.equal(home.get('B'), 'term');
  assert.equal(tgHomeOf({ main: ['a'], term: ['b'] }, of({ a: 'G', b: 'G' })).get('G'), 'main', 'a tie goes to the editor zone');
  assert.equal(tgHomeOf({ main: [], term: [] }, of({})).size, 0);
  assert.match(app, /function tgSettleZones\(\) \{[\s\S]*?if \(g && home\.get\(g\) !== z\) panes\.get\(id\)\.group = '';/, 'members elsewhere leave');
  assert.match(fn<() => void>('tgNormalize').toString(), /tgSettleZones\(\);/, 'settled on every normalize');
  const menu = app.slice(app.indexOf('function tgTabMenuItems'), app.indexOf('\n}\n', app.indexOf('function tgTabMenuItems')));
  assert.match(menu, /home\.get\(g\) === z/, '"Add to group" offers only this zone\'s groups');
  assert.match(app, /if \(tgHomeZones\(\)\.get\(gid\) && tgHomeZones\(\)\.get\(gid\) !== zoneOf\(p\)\) return;/, 'tgAdd refuses across zones');
});

test('folding one group never unfolds another, and a split lets the folded members go', () => {
  /* Folding B moved the focus to the nearest tab outside B, which was inside folded A, and activating it unfolded A. */
  const tog = app.slice(app.indexOf('function tgToggle'), app.indexOf('\n}\n', app.indexOf('function tgToggle')));
  assert.match(tog, /\.find\(\(v\) => tgOf\(v\) !== gid && !tgFolded\(tgOf\(v\)\) && panes\.get\(v\)\.kind !== 'restore'\)/);
  assert.match(tog, /const keep = vis\.filter\(\(v\) => tgOf\(v\) !== gid\);/, 'a folded member leaves the split');
  assert.match(app, /p\.tab\.classList\.toggle\('tgcollapsed', !!g && g\.collapsed && id !== active\[z\] && !zones\[z\]\.visible\.includes\(id\)\);/,
    'a pane on screen always keeps its tab');
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

test('the composer key hint cannot blink: it is decided on the room the input has WITHOUT the hint', () => {
  /* Showing the hint narrowed the input below 380px, which hid it, which widened the input: on every resize at a split
     width the "↵ send" hint went on and off. */
  const ph = app.slice(app.indexOf('function chatSkinPlaceholder'), app.indexOf('\n}\n', app.indexOf('function chatSkinPlaceholder')));
  assert.match(ph, /const room = cs\.input\.clientWidth \+ \(keys\.hidden \? 0 : kw\);/);
  assert.match(ph, /keys\.hidden = chatSkinCardOn\(cs\) \|\| room - kw < 380;/);
  assert.ok(!/cs\.input\.clientWidth < 380/.test(ph), 'the self-reversing test is gone');
});
