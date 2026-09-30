/**
 * Finished-unseen on the tab (operator request: "green is also the colour that stays after I've
 * checked what the chat has done, so I find myself rechecking the same tabs again").
 *
 * A session that finishes while the operator is elsewhere gets a BOLD tab name until its pane has
 * been on screen, in a focused window, for SEEN_AFTER_MS. The rule lives in nextUnseen(), which
 * is pure, so it is exercised here directly; the wiring is pinned by source assertions in the
 * style of tabState.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

const ROOT = path.join(__dirname, '..', '..');
const app = (): string => fs.readFileSync(path.join(ROOT, 'renderer', 'app.js'), 'utf8');
const css = (): string => fs.readFileSync(path.join(ROOT, 'renderer', 'theme.css'), 'utf8');

type Next = (prev: string | undefined, cls: string, unseen: boolean, watched: boolean, since: number, now: number)
  => { unseen: boolean; watchedSince: number };

function load(): Next {
  const src = app();
  const a = src.indexOf('const SEEN_AFTER_MS');
  const b = src.indexOf('function paintTabStates(m)');
  assert.ok(a > 0 && b > a, 'nextUnseen block not found where expected');
  const ctx: Record<string, unknown> = {};
  vm.runInNewContext(src.slice(a, b) + '\nthis.nextUnseen = nextUnseen;', ctx);
  return ctx.nextUnseen as Next;
}

test('a finish you did not watch marks the tab unseen', () => {
  const n = load();
  assert.equal(n('busy', 'idle', false, false, 0, 1000).unseen, true);
  assert.equal(n('busy', 'error', false, false, 0, 1000).unseen, true, 'a crash you missed matters too');
});

test('a finish you watched happen is not marked', () => {
  assert.equal(load()('busy', 'idle', false, true, 0, 1000).unseen, false);
});

test('first sight of a session is never a finish', () => {
  assert.equal(load()(undefined, 'idle', false, false, 0, 1000).unseen, false,
    'otherwise every tab would go bold at launch');
});

test('it clears only after the pane has been watched for SEEN_AFTER_MS', () => {
  const n = load();
  let s = n('busy', 'idle', false, false, 0, 0);                  // finished while away
  s = n('idle', 'idle', s.unseen, true, s.watchedSince, 10_000);   // you land on it
  assert.equal(s.unseen, true, 'a glance is not a read');
  s = n('idle', 'idle', s.unseen, true, s.watchedSince, 12_000);   // one 2s tick later
  assert.equal(s.unseen, true);
  s = n('idle', 'idle', s.unseen, true, s.watchedSince, 14_000);   // second tick, 4s watched
  assert.equal(s.unseen, false);
});

test('leaving before SEEN_AFTER_MS resets the clock', () => {
  const n = load();
  let s = n('busy', 'idle', false, false, 0, 0);
  s = n('idle', 'idle', s.unseen, true, s.watchedSince, 10_000);
  s = n('idle', 'idle', s.unseen, false, s.watchedSince, 12_000);  // clicked away
  assert.equal(s.watchedSince, 0);
  s = n('idle', 'idle', s.unseen, true, s.watchedSince, 20_000);   // back
  assert.equal(s.unseen, true, 'the clock restarts on return');
});

test('working again, or asking you something, is not "finished"', () => {
  const n = load();
  assert.equal(n('idle', 'busy', true, false, 0, 1000).unseen, false);
  assert.equal(n('busy', 'input', false, false, 0, 1000).unseen, false, 'blue already says it');
});

test('the marker is on the NAME, never the dot', () => {
  const src = app();
  assert.match(src, /nm\.classList\.toggle\('unseen', p\.unseen\)/);
  assert.ok(!/tdot[^\n]*unseen/.test(css()), 'the dot pixel belongs to state; a ring there fought the pulse');
  assert.match(css(), /\.tab \.tname\.unseen \{ font-weight: 700;/);
});
