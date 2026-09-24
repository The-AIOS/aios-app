/**
 * macOS: the red button hides the window instead of quitting (operator-reported 2026-09-23 —
 * quitting on a reflexive close ended live terminal sessions and left the spawn-inbox unanswered).
 * A real quit must still get through: ⌘Q/Dock/logout via before-quit, and an update install,
 * which closes the windows BEFORE before-quit fires and so has to mark the quit itself.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { closeShouldHide } from '../main/quitState';

const src = (f: string) => fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main', f), 'utf8');

test('the decision: hide only on macOS, only when not quitting, never in a test run', () => {
  assert.equal(closeShouldHide('darwin', false, false), true, 'red button on a Mac → hide, sessions keep running');
  assert.equal(closeShouldHide('darwin', true, false), false, '⌘Q / update install → really close');
  assert.equal(closeShouldHide('win32', false, false), false, 'Windows keeps close = quit');
  assert.equal(closeShouldHide('linux', false, false), false, 'Linux keeps close = quit');
  assert.equal(closeShouldHide('darwin', false, true), false, 'smoke/eval runs must be able to exit');
});

test('every real quit is marked before the windows close', () => {
  const main = src('main.ts');
  assert.match(main, /app\.on\('before-quit', markQuitting\)/, '⌘Q, Dock Quit, logout, shutdown');
  assert.match(main, /win\.on\('close', \(e\) => \{\s*if \(!closeShouldHide\(process\.platform, isQuitting\(\)/, 'the close handler asks the shared state');
  assert.match(main, /app\.on\('activate', \(\) => \{[\s\S]{0,120}mainWin\.show\(\)/, 'the Dock icon brings the window back');
  const upd = src('updater.ts');
  assert.match(upd, /markQuitting\(\); autoUpdater\.quitAndInstall\(\)/,
    'the install marks the quit FIRST — quitAndInstall closes windows before before-quit fires, so a hidden-on-close window would block it');
});
