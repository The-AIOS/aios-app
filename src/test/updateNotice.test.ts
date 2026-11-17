/**
 * #183: the "update ready" notification came back on every update check once an update had
 * downloaded. The rule (src/core/updateNotice.ts) and the wiring (src/main/updater.ts) are both
 * checked here: the rule by running it, the wiring by reading the source, because the bug was a
 * call to the notifying check and nothing else would catch it coming back.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { shouldNotifyUpdate, parseNotified } from '../core/updateNotice';

test('the first downloaded version notifies', () => {
  assert.equal(shouldNotifyUpdate('0.16.0', ''), true);
});

test('the same version checked again does not notify again', () => {
  let last = '';
  const raised: string[] = [];
  for (let i = 0; i < 5; i++) {   // boot, focus, wake, menu, interval: all find the same staged update
    if (shouldNotifyUpdate('0.16.0', last)) { raised.push('0.16.0'); last = '0.16.0'; }
  }
  assert.deepEqual(raised, ['0.16.0']);
});

test('a newer version notifies once more', () => {
  assert.equal(shouldNotifyUpdate('0.16.1', '0.16.0'), true);
  assert.equal(shouldNotifyUpdate('0.16.1', '0.16.1'), false);
});

test('no version never notifies', () => {
  assert.equal(shouldNotifyUpdate('', ''), false);
  assert.equal(shouldNotifyUpdate('  ', 'x'), false);
});

test('the remembered version survives a restart, and a broken file means none', () => {
  assert.equal(parseNotified(JSON.stringify({ version: '0.16.0' })), '0.16.0');
  assert.equal(parseNotified(null), '');
  assert.equal(parseNotified('{not json'), '');
  assert.equal(parseNotified(JSON.stringify({ version: 7 })), '');
});

test('the updater never uses the notifying check again', () => {
  const src = fs.readFileSync('src/main/updater.ts', 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  assert.equal(/checkForUpdatesAndNotify\s*\(/.test(src), false, 'checkForUpdatesAndNotify() is back in updater.ts');
  assert.match(src, /shouldNotifyUpdate\(/, 'the downloaded handler must go through the once-per-version rule');
});

test('negative control: the source check catches the old call', () => {
  const old = 'void autoUpdater.checkForUpdatesAndNotify().catch(() => {});';
  assert.equal(/checkForUpdatesAndNotify\s*\(/.test(old), true);
});
