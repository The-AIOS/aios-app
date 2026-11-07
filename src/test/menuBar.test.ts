/**
 * The menu-bar icon (docs/rfcs/menu-bar.md) — the model it renders, and the promise that it says
 * the same thing about a session that the panel and the tabs say.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import {
  sessionState, menuBarModel, menuBarTitle, sameModel, BUSY_STATUSES, ERROR_STATUS_RE,
} from '../core/menuBar';

const ROOT = path.join(__dirname, '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test("the icon's four states are the renderer's statusInfo(), expression for expression", () => {
  /* The renderer is a classic script and cannot import core, so its copy is pinned here. If either
     side moves, this fails: an icon reading "ready" beside a blue "needs you" tab is the bug. */
  const src = read('renderer/app.js');
  const fn = src.match(/function statusInfo\(raw\) \{[\s\S]*?\n\}/);
  assert.ok(fn, 'statusInfo() not found in renderer/app.js — it moved, and this pin is now blind');
  const body = fn[0];
  const busy = body.match(/if \(([^)]*)\) return \{ cls: 'busy'/);
  assert.ok(busy, "statusInfo's busy test not found");
  const literals = [...busy[1].matchAll(/st === '([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(literals, [...BUSY_STATUSES], 'the busy statuses differ between the icon and the panel');
  const err = body.match(/if \((\/[^\n]+?\/)\.test\(st\)\) return \{ cls: 'error'/);
  assert.ok(err, "statusInfo's error test not found");
  assert.equal(err[1], String(ERROR_STATUS_RE), 'the error expression differs between the icon and the panel');
  /* And the order: busy is decided before input, input before error. */
  assert.ok(body.indexOf("cls: 'busy'") < body.indexOf("cls: 'input'") && body.indexOf("cls: 'input'") < body.indexOf("cls: 'error'"),
    'statusInfo decides in a different order than sessionState()');
});

test('sessionState reads what Claude Code writes', () => {
  assert.equal(sessionState('busy'), 'busy');
  assert.equal(sessionState('Working'), 'busy');
  assert.equal(sessionState('waiting'), 'input');
  assert.equal(sessionState('needs permission approval'), 'input');
  assert.equal(sessionState('crashed'), 'error');
  assert.equal(sessionState('idle'), 'idle');
  assert.equal(sessionState('shell'), 'idle', 'an app-specific status is a live, ready session — never unknown');
  assert.equal(sessionState(''), 'idle');
  assert.equal(sessionState(undefined), 'idle');
});

test('rows put the sessions that need you first, then working, then errors, then ready', () => {
  const m = menuBarModel([
    { name: 'zeta', sessionId: '1', status: 'idle' },
    { name: 'beta', sessionId: '2', status: 'busy' },
    { name: 'alpha', sessionId: '3', status: 'idle' },
    { name: 'gamma', sessionId: '4', status: 'waiting' },
    { name: 'delta', sessionId: '5', status: 'error' },
  ]);
  assert.deepEqual(m.rows.map((r) => `${r.name}:${r.state}`), ['gamma:input', 'beta:busy', 'delta:error', 'alpha:idle', 'zeta:idle']);
  assert.equal(m.waiting, 1);
  assert.equal(m.rows[0].id, '4', 'the session id travels with the row, so a click reveals THAT session');
});

test('two sessions with one name stay two rows, in a stable order', () => {
  const m = menuBarModel([
    { name: 'worker', sessionId: 'b', status: 'idle' },
    { name: 'worker', sessionId: 'a', status: 'idle' },
  ]);
  assert.deepEqual(m.rows.map((r) => r.id), ['a', 'b']);
});

test('a nameless registry entry is not a row', () => {
  assert.equal(menuBarModel([{ name: '', sessionId: 'x', status: 'idle' }]).rows.length, 0);
});

test('the title beside the icon is the waiting count, and empty when nothing waits', () => {
  assert.equal(menuBarTitle(menuBarModel([])), '');
  assert.equal(menuBarTitle(menuBarModel([{ name: 'a', status: 'idle' }])), '', 'never "0" — empty is the calm state');
  assert.equal(menuBarTitle(menuBarModel([{ name: 'a', status: 'waiting' }, { name: 'b', status: 'permission' }])), '2');
});

test('the model compares equal tick to tick, so an open menu is not rebuilt under the pointer', () => {
  const s = [{ name: 'a', sessionId: '1', status: 'busy' }];
  assert.equal(sameModel(undefined, menuBarModel(s)), false, 'the first observation always renders');
  assert.equal(sameModel(menuBarModel(s), menuBarModel(s)), true);
  assert.equal(sameModel(menuBarModel(s), menuBarModel([{ ...s[0], status: 'waiting' }])), false);
});

test('main wires the icon behind the same gates as the bus, and only on macOS', () => {
  const main = read('src/main/main.ts');
  assert.match(main, /const MENU_BAR_ALLOWED = \(\): boolean => process\.platform === 'darwin' && !SMOKE && !SHOT && !EVAL && !CHAT_SHOT;/);
  assert.match(main, /host\.onRunning = \(running\) => menuBar\?\.update\(running\);/, 'the icon is fed by the panel pulse, not a timer of its own');
  assert.match(main, /if \(key === 'menuBar'\) syncMenuBar\(\);/, 'turning the setting off removes the icon at once');
  assert.match(main, /menuBar\?\.relabel\(\);/, 'a locale change relabels the icon menu');
});

test('the template image ships inside the package', () => {
  /* build/ is not packaged; renderer/ is. A missing icon would make Tray throw at boot. */
  const pkg = JSON.parse(read('package.json')) as { build: { files: string[] } };
  assert.ok(pkg.build.files.some((f) => f.startsWith('renderer')), 'renderer/ is no longer packaged');
  for (const f of ['renderer/tray/iconTemplate.png', 'renderer/tray/iconTemplate@2x.png']) {
    assert.ok(fs.existsSync(path.join(ROOT, f)), `${f} is missing`);
  }
});

test('0.15.0 review: the menu is built when it opens, never swapped while open', () => {
  const src = fs.readFileSync('src/main/menuBar.ts', 'utf8');
  assert.doesNotMatch(src.replace(/\/\*[\s\S]*?\*\/|^\s*\*.*$/gm, ''), /setContextMenu\(/, 'no menu replaced on a state change');
  assert.match(src, /tr\.popUpContextMenu\(Menu\.buildFromTemplate\(this\.template\(this\.model/, 'built from the current model at the click');
  assert.match(src, /this\.tray\.on\('click', open\);/);
});

test('0.15.0 round: each session in the menu carries the sidebar\'s colour dot for its state, not a word', async () => {
  const { STATE_DOT_COLOR, dotBitmap } = await import('../core/menuBar');
  const css = fs.readFileSync('renderer/theme.css', 'utf8');
  const root = css.slice(0, css.indexOf('}', css.indexOf(':root')));   // the dark (default) tokens
  const tok = (name: string): string => (new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i').exec(root) || [])[1]?.toLowerCase() ?? '';
  assert.equal(STATE_DOT_COLOR.idle, tok('st-idle'), 'ready = the sidebar\'s green');
  assert.equal(STATE_DOT_COLOR.busy, tok('st-busy'), 'working = amber');
  assert.equal(STATE_DOT_COLOR.input, tok('st-input'), 'needs you = blue');
  assert.equal(STATE_DOT_COLOR.error, tok('st-error'), 'error = the real red');
  const px = dotBitmap('#3ec77a', 12);
  assert.equal(px.length, 12 * 12 * 4);
  const at = (x: number, y: number) => Array.from(px.slice((y * 12 + x) * 4, (y * 12 + x) * 4 + 4));
  assert.deepEqual(at(6, 6), [0x7a, 0xc7, 0x3e, 255], 'the middle is the colour, BGRA, opaque');
  assert.equal(at(0, 0)[3], 0, 'the corner is transparent: a dot, not a square');
  assert.throws(() => dotBitmap('green', 12), 'a malformed colour is an error, not a black dot');
  const main = fs.readFileSync('src/main/menuBar.ts', 'utf8');
  assert.match(main, /label: model\.groups\.length && r\.group >= 0 \? '   ' \+ r\.name : r\.name,[^\n]*\n\s*icon: stateDot\(r\.state\),/, 'the name, with the dot');
  assert.match(main, /toolTip: t\(STATE_KEY\[r\.state\]\)/, 'the state still in words on hover');
  assert.doesNotMatch(main, /label: `\$\{r\.name\} — /, 'no "— ready" text');
  const fn = main.slice(main.indexOf('function stateDot('), main.indexOf('\n}\n', main.indexOf('function stateDot(')));
  assert.doesNotMatch(fn, /setTemplateImage/, 'never a template image: macOS would drop the colour');
  assert.match(fn, /addRepresentation\(\{ scaleFactor: 2/, 'sharp on a Retina menu bar');
});

test('0.15.0 round 2: the menu lists sessions under their tab groups, in the group colour, with Ask AIOS at the top', async () => {
  const { menuBarModel, sanitizeGroups, GROUP_DOT_COLOR, groupDotColor } = await import('../core/menuBar');
  const sessions = [
    { name: 'ana', status: 'idle' }, { name: 'bo', status: 'waiting' }, { name: 'cy', status: 'busy' }, { name: 'dee', status: 'idle' },
  ];
  const groups = [{ name: 'Empty', color: 'pink', members: ['ghost'] }, { name: 'Release', color: 'blue', members: ['cy', 'bo'] }];
  const m = menuBarModel(sessions, groups);
  assert.deepEqual(m.groups, [{ name: 'Release', color: 'blue' }], 'a group with no live session is left out');
  assert.deepEqual(m.rows.map((r) => `${r.group}:${r.name}`), ['0:bo', '0:cy', '-1:ana', '-1:dee'], 'grouped first (waiting before working), then the rest');
  assert.equal(m.waiting, 1);
  assert.deepEqual(menuBarModel(sessions).groups, [], 'no groups reported: one flat list, as before');
  /* Negative control: ignoring membership puts everything ungrouped. */
  assert.notDeepEqual(menuBarModel(sessions, []).rows.map((r) => r.group), m.rows.map((r) => r.group));
  assert.deepEqual(sanitizeGroups([{ name: 'A', color: 'green', members: ['x', 3, ''] }, 'junk', null]), [{ name: 'A', color: 'green', members: ['x'] }]);
  assert.deepEqual(sanitizeGroups('nope'), []);
  /* The group dots are the App's own tab-group palette (dark tokens), so a colour means the same in both places. */
  const css = fs.readFileSync('renderer/theme.css', 'utf8');
  const root = css.slice(0, css.indexOf('}', css.indexOf(':root')));
  for (const [name, hex] of Object.entries(GROUP_DOT_COLOR)) {
    const tok = (new RegExp(`--tg-${name}:\\s*(#[0-9a-f]{6})`, 'i').exec(root) || [])[1]?.toLowerCase();
    assert.equal(hex, tok, `--tg-${name}`);
  }
  assert.equal(groupDotColor('nonsense'), GROUP_DOT_COLOR.grey);
  const main = fs.readFileSync('src/main/menuBar.ts', 'utf8');
  assert.match(main, /return \[\s*\{ label: t\('menuBar\.ask'\), click: \(\) => this\.hooks\.ask\(\) \},/, 'Ask AIOS… first in the menu');
  assert.match(main, /icon: groupDot\(g\.color\), enabled: false/, 'a group heading in its colour');
  const app = fs.readFileSync('renderer/app.js', 'utf8');
  assert.match(app, /function persistSessions\(\) \{\s*try \{ tgReportMenuBar\(\); \}/, 'the renderer reports its groups on every layout change');
  assert.match(fs.readFileSync('src/main/main.ts', 'utf8'), /ipcMain\.on\('menuBar:groups', \(_e, raw: unknown\) => \{ menuBarGroups = sanitizeGroups\(raw\);/);
});
