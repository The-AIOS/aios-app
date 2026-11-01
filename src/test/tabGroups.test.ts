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
