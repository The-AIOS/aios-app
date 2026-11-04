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
