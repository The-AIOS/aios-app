/**
 * The active-blocks list and its jump shortcut (#23).
 *
 * "Colour tells me THAT something is waiting, not WHICH ONE to handle first. With several
 * sessions I still walk the tabs." Tab order deliberately never re-sorts itself on a state
 * change — spatial memory beats sorting — so the ordering has to live somewhere else, and the
 * NEEDS YOU card is that somewhere. No new surface: the card already carries blocked sessions,
 * it just could not say which had been waiting longest or what it was waiting FOR.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as aios from '../main/aios';

let bus = '';
try { bus = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-blocks-')); } catch { /* handled below */ }

const A = (name: string, status: string, statusUpdatedAt?: number, waitingFor?: string): aios.RunningAgent => ({
  pid: Math.abs(name.split('').reduce((a, c) => a + c.charCodeAt(0), 0)),
  name, status, sessionId: 's-' + name, cwd: '/tmp', startedAt: 1, updatedAt: statusUpdatedAt ?? 1,
  ...(statusUpdatedAt ? { statusUpdatedAt } : {}),
  ...(waitingFor ? { waitingFor } : {}),
});

const sessionsOf = (running: aios.RunningAgent[]): aios.InboxItem[] =>
  aios.inboxItems(running, 14, 4, bus).filter((i) => i.kind === 'session');

test('blocked sessions come out OLDEST FIRST — the one to answer next is the one at the top', () => {
  const rows = sessionsOf([
    A('newest', 'waiting', 3_000, 'input needed'),
    A('oldest', 'waiting', 1_000, 'permission'),
    A('middle', 'waiting', 2_000, 'input needed'),
  ]);
  assert.deepEqual(rows.map((r) => r.name), ['oldest', 'middle', 'newest'],
    'registry order is arbitrary; how long it has been blocked is the only useful ranking');
});

test('the row says WHAT it is waiting for, not merely that it is', () => {
  const [row] = sessionsOf([A('writer', 'waiting', 1_000, 'Bash(rm -rf build)')]);
  assert.equal(row.detail, 'Bash(rm -rf build)',
    'the difference between answering in two seconds and having to go and look');
  assert.equal(row.since, 1_000, 'and carries the timestamp the renderer counts up from');
});

test('a session with no waitingFor still lists — it falls back to the status', () => {
  const [row] = sessionsOf([A('writer', 'waiting')]);
  assert.equal(row.detail, 'waiting', 'waitingFor is absent on older records and while not blocked');
  assert.equal(row.since, undefined, 'and an absent timestamp is simply not rendered');
});

test('a session that is not blocked is not on the list at all', () => {
  assert.deepEqual(sessionsOf([A('busy-one', 'busy', 1_000), A('idle-one', 'idle', 2_000)]), []);
});

test('being blocked on something NEW resurfaces a dismissed row', () => {
  const first = sessionsOf([A('writer', 'waiting', 1_000, 'permission')])[0];
  const later = sessionsOf([A('writer', 'waiting', 2_000, 'a different question')])[0];
  assert.notEqual(later.sig, first.sig,
    'a dismissal must not swallow a NEW thing to be blocked on — same status, different question');
});

test('the signature still keys on status when nothing else is known', () => {
  const [row] = sessionsOf([A('writer', 'waiting for input')]);
  assert.equal(row.sig, 'waiting for input', 'unchanged contract for records carrying no waitingFor');
});

test('sorting is stable against a missing timestamp rather than throwing it to the top', () => {
  const rows = sessionsOf([A('no-stamp', 'waiting'), A('stamped', 'waiting', 5_000, 'q')]);
  assert.equal(rows.length, 2, 'both still listed — an absent timestamp is not a reason to hide work');
  assert.equal(rows[0].name, 'no-stamp', 'falls back to updatedAt (1) and sorts as the older of the two');
});

test('the elapsed time is rendered in the RENDERER, never baked into the pushed label', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'renderer', 'app.js'), 'utf8');
  assert.match(src, /function waitedFor\(since\)/,
    'a duration computed at push time is wrong the moment it is drawn — postState fires from '
    + 'file watchers, so a session blocked at 09:00 would still read "just now" at 09:40');
  assert.match(src, /msg\.type === 'running'\) \{[^}]*refreshWaited\(\);/,
    'it advances on the 2s pulse that already reports sessions — no second timer. Matched loosely '
    + 'on purpose: pinning the whole handler line makes this fail every time something unrelated '
    + 'joins the same pulse, which teaches people to edit the test rather than read it.');
  assert.match(src, /querySelectorAll\('\[data-since\]'\)/,
    'and refreshes only that text: a full re-render every 2s would fight hover and focus');
});

test('the jump chord exists in BOTH places a keystroke has to exist', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'renderer', 'app.js'), 'utf8');
  assert.match(src, /function jumpToNextWaiting\(\)/, 'the handler');
  assert.match(src, /label: 'shortcut\.nextWaiting', accel: 'CmdOrCtrl\+Shift\+J'/,
    'AND the shortcuts sheet. Nothing derives the sheet from the key handlers, which is exactly '
    + 'how the split chord went missing from both discovery surfaces once before.');
  assert.ok(!/accelerator: 'CmdOrCtrl\+Shift\+J'/.test(
    fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main', 'menu.ts'), 'utf8')),
    'and NOT also in the native menu — two owners means the handler fires twice per press');
});

test('the jump walks the list in its own order, not the tab order', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'renderer', 'app.js'), 'utf8');
  assert.match(src, /pulse\.lastInbox \|\| \[\]\)\.filter\(\(i\) => i\.kind === 'session' && i\.name\)/,
    'it reads the already-oldest-first inbox rather than re-deriving an order');
  assert.match(src, /waiting\[\(at \+ 1\) % waiting\.length\]/,
    'starting AFTER the current pane is what makes a second press go somewhere');
  assert.match(src, /toast\(t\('jump\.none'\)\)/,
    'an empty queue says so — a silent no-op reads as a broken key');
});
