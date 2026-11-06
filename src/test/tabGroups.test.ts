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
  assert.match(adopt, /color: tgColorOf\(g\.color\)/, 'an unknown colour must never reach a CSS variable name');
  const of = new Function(app.slice(app.indexOf('const TG_COLORS'), app.indexOf('\n', app.indexOf('const tgColorOf')) + 1) + 'return tgColorOf;')() as (c: unknown) => string;
  assert.equal(of('red'), 'coral', 'a group saved as red comes back coral');
  assert.equal(of('blue'), 'blue');
  assert.equal(of('x); background: url(evil)'), 'grey', 'anything else is grey');
  assert.equal((/const TG_COLORS = \[([^\]]+)\]/.exec(app)![1].match(/'/g) || []).length / 2, 12, 'twelve colours: two rows of six');
  assert.match(fs.readFileSync('renderer/theme.css', 'utf8'), /\.tgedit-sw \{ display: grid; grid-template-columns: repeat\(6, 18px\)/, 'laid out as rows of six');
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


test('the Running card mirrors the tab groups in Sessions AND Terminals: a heading in the group colour, a click folds the strip', () => {
  /* 0.14.0 round: "is it feasible to group sessions in running card", then "we dont do it in terminals". */
  const run = app.slice(app.indexOf('function pgroupRunner'), app.indexOf('\n}\n', app.indexOf('function pgroupRunner')));
  assert.match(run, /groupBox = el\('div', 'pgroup'\);/);
  assert.match(run, /head\.addEventListener\('click', \(\) => \{ tgToggle\(gid, hz\); renderPulseRunning\(\); \}\);/, 'folds the strip the tabs are in, like the pill');
  assert.match(run, /\(groupBox \|\| box\)\.appendChild\(row\);/, 'a row in no group stays in the plain list');
  const fn = app.slice(app.indexOf('function renderPulseRunning'), app.indexOf('\n}\n', app.indexOf('function renderPulseRunning')));
  assert.equal((fn.match(/pgroupRunner\(box\)/g) || []).length, 2, 'used by the Sessions and the Terminals section');
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

test('a restored session keeps its group even when the group was pruned while it was between placeholder and tab', () => {
  const mr = app.slice(app.indexOf('async function materializeRestore'), app.indexOf('\n}\n', app.indexOf('async function materializeRestore')));
  assert.match(mr, /if \(!tabGroups\.has\(ph\.group\) && ph\.groupDef\) tabGroups\.set\(ph\.group, \{ \.\.\.ph\.groupDef \}\);/);
  assert.ok(mr.indexOf('np.group = ph.group;\n    tgRepaint();') > mr.indexOf('closePane(id);'), 'applied after the placeholder is gone');
  assert.match(app, /groupDef: s\.group && tabGroups\.has\(s\.group\)/);
});

test('a restore makes its placeholders with pruning held, so no group is lost before its tab exists', () => {
  /* 0.14.0 round, measured: the group of the placeholder made second was pruned while the first was being made. */
  assert.match(app, /function tgPrune\(\) \{\n  if \(tgPruneHold\) return;/);
  assert.match(app, /tgPruneHold\+\+;\n\s*let ids;\n\s*try \{ ids = order\.map\(createRestoreTab\); \} finally \{ tgPruneHold--; \}/, 'unattended');
  assert.match(app, /try \{ ids = picked\.map\(createRestoreTab\); \} finally \{ tgPruneHold--; \}/, 'the offer');
});

test('the panel ↑/↓ reorders a session without regrouping it; only a drop joins or leaves a group', () => {
  assert.match(app, /moveTab\(z, paneId, order\[j\], dir > 0, true\);/);
  assert.match(app, /if \(dp && !keepGroup\) dp\.group = /);
});

test('a restart brings the workspace back: plain terminals (same folder) and file tabs, each in its group', () => {
  /* 0.14.0 round: an App update quits the App, and only the sessions came back; a group of terminals vanished. */
  const snap = app.slice(app.indexOf('function sessionsSnapshot'), app.indexOf('\n}\n', app.indexOf('function sessionsSnapshot')));
  assert.match(snap, /others\.push\(\{ kind: 'term', name: p\.name \|\| 'terminal', cwd: p\.cwd \|\| '', \.\.\.group \}\)/);
  assert.match(snap, /others\.push\(\{ kind: 'view', path: p\.path, \.\.\.group \}\)/);
  assert.match(snap, /\[\.\.\.sessions, \.\.\.others\]\.map\(\(x\) => x\.group\)/, 'their groups are saved too');
  const ro = app.slice(app.indexOf('async function restoreOthers'), app.indexOf('\n}\n', app.indexOf('async function restoreOthers')));
  assert.match(ro, /tgPruneHold\+\+;/, 'laid out with pruning held, like the sessions');
  const offer = app.slice(app.indexOf('async function offerRestore'), app.indexOf('\n}\n', app.indexOf('async function offerRestore')));
  assert.ok((offer.match(/restoreOthers\(saved\)/g) || []).length >= 4, 'unattended, on a yes, with no session, and with no session left');
});

test('dragging a pill moves the whole group as one block, never splitting another group, and nobody changes group', () => {
  const mg = app.slice(app.indexOf('function tgMoveGroup'), app.indexOf('\n}\n', app.indexOf('function tgMoveGroup')));
  assert.match(mg, /const block = list\.filter\(\(v\) => tgOf\(v\) === gid\);/);
  assert.match(mg, /if \(og\) \{/, 'dropped on another group: before or after that whole group');
  assert.doesNotMatch(mg, /\.group = /, 'no tab changes group');
  assert.match(app, /c\.draggable = true;\n\s*c\.addEventListener\('dragstart', \(ev\) => \{\n\s*dragTab = \{ id: null, group: gid, zone: z \};/);
  assert.match(app, /if \(dragTab\.group\) tgMoveGroup\(dragTab\.zone, dragTab\.group, id,/);
});

test('a session is not "quiet for a while" while Claude Code\'s spinner is live (a long think writes nothing to the transcript)', () => {
  assert.match(app, /quiet > CS_STALL_MS && !chatSkinSpinnerOn\(p\);/);
});

/* ── 0.15 round: a folded group folds in the sidebar too, and a session can be started inside a group. ── */

type Runner = (paneId: string | null, row: unknown, keep?: boolean) => void;
/** pgroupRunner, driven: the renderer's real function over a fake DOM and a fake group table. */
function sidebar(folded: boolean, activeId: string) {
  const m = /function pgroupRunner\(box\) \{[\s\S]*?\n\}\n/.exec(app);
  assert.ok(m, 'could not find pgroupRunner in renderer/app.js — this test would measure nothing');
  type Node = { cls: string; kids: Node[]; text?: string; append(...n: Node[]): void; appendChild(n: Node): void;
    style: { setProperty(): void }; classList: { toggle(c: string, on: boolean): void }; setAttribute(): void; addEventListener(): void; title?: string; type?: string };
  const node = (cls: string, text?: string): Node => {
    const n: Node = { cls, text, kids: [], append: (...k) => { n.kids.push(...k); }, appendChild: (k) => { n.kids.push(k); },
      style: { setProperty: () => { } }, classList: { toggle: (c, on) => { if (on) n.cls += ' ' + c; } }, setAttribute: () => { }, addEventListener: () => { } };
    return n;
  };
  const env = {
    panes: new Map([['a', {}], ['b', {}], ['c', {}], ['x', {}]]),
    tgOf: (id: string) => (id === 'x' ? '' : 'G'),
    tabGroups: new Map([['G', { color: 'blue' }]]),
    zoneOf: () => 'main',
    tgFoldedIn: () => folded,
    tgMembersIn: () => ['a', 'b', 'c'],
    tgLabel: () => 'Build', t: (k: string) => k, tgToggle: () => { }, renderPulseRunning: () => { },
    el: (_tag: string, cls: string, text?: string) => node(cls, text),
    active: { main: activeId, term: null },
  };
  const make = new Function(...Object.keys(env), `${m[0]} return pgroupRunner;`) as (...a: unknown[]) => (box: Node) => Runner;
  const box = node('box');
  const run = make(...Object.values(env))(box);
  return { box, run, rows: (): string[] => box.kids.flatMap((k) => (k.cls.startsWith('pgroup') ? k.kids.filter((r) => r.cls === 'row').map((r) => r.text!) : k.cls === 'row' ? [k.text!] : [])) , node };
}

test('sidebar: an open group lists its sessions under its heading', () => {
  const s = sidebar(false, 'x');
  for (const id of ['a', 'b', 'c']) s.run(id, s.node('row', id));
  assert.deepEqual(s.rows(), ['a', 'b', 'c']);
});

test('sidebar: a folded group shows only its heading — but never hides the session you are on, or one waiting on you', () => {
  const s = sidebar(true, 'b');
  s.run('a', s.node('row', 'a'));
  s.run('b', s.node('row', 'b'));          // the focused tab
  s.run('c', s.node('row', 'c'), true);    // waiting on the operator
  s.run('x', s.node('row', 'x'));          // not in the group: untouched
  assert.deepEqual(s.rows(), ['b', 'c', 'x']);
  assert.match(s.box.kids[0].cls, /\bfolded\b/, 'the heading carries the fold, so its caret turns');
});

test('sidebar: the session rows pass "waiting on you" as keep', () => {
  assert.match(app, /runIntoGroups\(hit \? hit\[0\] : null, r, statusInfo\(a\.status\)\.cls === 'input'\)/);
});

test('a group can start a session inside itself, through the same New session flow', () => {
  assert.match(app, /\{ label: t\('tg\.newSession'\), value: 'newSession' \}/, 'the group menu offers it');
  assert.match(app, /if \(pick === 'newSession'\) void spawnWorkerFlow\(gid\);/);
  assert.match(app, /const id = await createPane\(\{ name: handle,[^\n]*\n[\s\S]{0,300}?if \(group && id != null && tabGroups\.has\(group\)\) tgAdd\(id, group\);/,
    'the new pane joins the group once it exists');
  for (const loc of ['en', 'es', 'pt-br', 'el']) {
    const j = JSON.parse(fs.readFileSync(`src/i18n/locales/${loc}.json`, 'utf8'));
    assert.ok(j['tg.newSession'] && j['tg.newSessionTitle']?.includes('{group}'), `${loc} has the strings`);
  }
});
