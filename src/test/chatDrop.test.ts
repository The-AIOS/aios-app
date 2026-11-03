/**
 * A file dropped on a pane in CHAT VIEW lands in the composer, never in the hidden terminal.
 *
 * The bug: the chat card's own drop zone covers only the box, and an empty box is one line tall.
 * A screenshot dropped on the conversation above it fell through to the pane's drop zone, which
 * writes the quoted path to the pty — into the Claude Code prompt hidden under the chat — while
 * the box the operator was looking at stayed empty.
 *
 * These tests EXECUTE the real `chatSkinTakeDrop` and check the two call sites route through it
 * before they reach `ptyWrite`.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';

const app = fs.readFileSync('renderer/app.js', 'utf8');

function grab(re: RegExp, what: string): string {
  const m = re.exec(app);
  if (!m) assert.fail(`${what} must be findable in renderer/app.js`);
  return m[0];
}

function harness() {
  const inserted: string[][] = [];
  const src = grab(/function chatSkinTakeDrop\([\s\S]*?\n\}/, 'chatSkinTakeDrop');
  const fn = new Function('chatSkinInsertPaths', `${src}; return chatSkinTakeDrop;`)(
    (_cs: unknown, paths: string[]) => { inserted.push(paths); },
  ) as (p: unknown, paths: string[] & { source?: string }) => boolean;
  return { fn, inserted };
}
const tag = (arr: string[], source: string) => Object.assign(arr, { source });

test('a file dropped on a chat-view pane goes to the composer', () => {
  const { fn, inserted } = harness();
  const p = { view: 'chat', chatSkin: {} };
  assert.equal(fn(p, tag(['/tmp/Screenshot 1.png'], 'files')), true);
  assert.deepEqual(inserted, [['/tmp/Screenshot 1.png']]);
});

test('a terminal-view pane keeps the terminal path', () => {
  const { fn, inserted } = harness();
  assert.equal(fn({ view: 'term', chatSkin: {} }, tag(['/tmp/a.png'], 'files')), false);
  assert.equal(fn({ view: 'chat' }, tag(['/tmp/a.png'], 'files')), false);   // no chat skin yet
  assert.deepEqual(inserted, []);
});

test('a dialog that brought the terminal forward keeps the terminal path', () => {
  const { fn } = harness();
  assert.equal(fn({ view: 'chat', chatSkin: { promptKind: 'select' } }, tag(['/tmp/a.png'], 'files')), false);
});

test('dropped text that is not a path is taken but never typed into the hidden prompt', () => {
  const { fn, inserted } = harness();
  const p = { view: 'chat', chatSkin: {} };
  assert.equal(fn(p, tag(['hola mundo', '/Users/x/nota.md'], 'text')), true);
  assert.equal(fn(p, tag(['solo texto'], 'text')), true);
  assert.deepEqual(inserted, [['/Users/x/nota.md']]);
});

test('both terminal drop sites ask chatSkinTakeDrop before writing to the pty', () => {
  const pane = grab(/attachDropZone\(el, \(paths\) => \{[\s\S]*?\n {2}\}\);/, 'pane drop zone');
  assert.ok(pane.indexOf('chatSkinTakeDrop(') >= 0 && pane.indexOf('chatSkinTakeDrop(') < pane.indexOf('ptyWrite'));
  const zone = grab(/attachDropZone\(document\.getElementById\('tpanes'\)[\s\S]*?\n\}\);/, 'tpanes drop zone');
  assert.ok(zone.indexOf('chatSkinTakeDrop(') >= 0 && zone.indexOf('chatSkinTakeDrop(') < zone.indexOf('ptyWrite'));
});
