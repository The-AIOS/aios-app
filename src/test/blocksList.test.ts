/**
 * Jump to the next session waiting on you (#23).
 *
 * The issue asked for "a list … plus one shortcut". The LIST is gone: it lived in a "Needs you"
 * card that was deleted, because every row it carried already had a truer home — the update pill
 * above the greeting, the Go With Agents button, the panel and tab dots, and `/today` and
 * `/close-day` for dead letters, which also RESOLVE them rather than only reporting. What the
 * list was actually for survives here: knowing which to answer FIRST, without walking the tabs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.join(__dirname, '..', '..');
const app = (): string => fs.readFileSync(path.join(ROOT, 'renderer', 'app.js'), 'utf8');

test('the jump reads the running list and orders it OLDEST BLOCKED FIRST', () => {
  const src = app();
  const fn = src.slice(src.indexOf('function jumpToNextWaiting()'), src.indexOf('function jumpToNextWaiting()') + 900);
  assert.match(fn, /pulse\.lastRunning && pulse\.lastRunning\.running/,
    'straight from the registry feed — no card in between');
  assert.match(fn, /statusInfo\(a\.status\)\.cls === 'input'/, 'blocked sessions only');
  assert.match(fn, /\(x\.statusUpdatedAt \?\? x\.updatedAt \?\? 0\) - \(y\.statusUpdatedAt \?\? y\.updatedAt \?\? 0\)/,
    'statusUpdatedAt is when the current status was ENTERED — "how long has this been waiting" '
    + 'with no bookkeeping of our own, so it survives a restart');
  assert.match(fn, /waiting\[\(at \+ 1\) % waiting\.length\]/,
    'starting AFTER the current pane is what makes a second press go somewhere');
  assert.match(fn, /toast\(t\('jump\.none'\)\)/, 'an empty queue says so — silence reads as a broken key');
});

test('the chord exists in BOTH places a keystroke has to exist', () => {
  const src = app();
  assert.match(src, /function jumpToNextWaiting\(\)/, 'the handler');
  assert.match(src, /label: 'shortcut\.nextWaiting', accel: 'CmdOrCtrl\+Shift\+J'/,
    'AND the shortcuts sheet. Nothing derives the sheet from the key handlers, which is exactly '
    + 'how the split chord went missing from both discovery surfaces once before.');
  assert.ok(!/accelerator: 'CmdOrCtrl\+Shift\+J'/.test(
    fs.readFileSync(path.join(ROOT, 'src', 'main', 'menu.ts'), 'utf8')),
    'and NOT also in the native menu — two owners means it fires twice per press');
});

test('the deleted card left nothing behind', () => {
  const src = app();
  for (const ghost of ['pInbox', 'renderInboxCard', 'inboxRows', 'inboxAction', 'lastInbox', 'INBOX_CAP']) {
    assert.ok(!src.includes(ghost), `${ghost} still referenced — a half-removed card is worse than either state`);
  }
  assert.ok(!fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8').includes('pInbox'),
    'and its element is gone from the markup');
});
