/**
 * Shift+Enter in a session pane sent the prompt instead of breaking the line: xterm encodes
 * Shift+Enter exactly like Enter (a bare \r), so Claude Code cannot tell them apart. The pane now
 * sends ESC CR for it, the sequence ⌥↵ already sends here and /terminal-setup installs for VS Code.
 * These run the real shiftEnterSeq from renderer/app.js with the key events the browser produces.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';

const app = fs.readFileSync('renderer/app.js', 'utf8');
const m = /function shiftEnterSeq\(e\) \{[\s\S]*?\n\}/.exec(app);
assert.ok(m, 'shiftEnterSeq must be findable in renderer/app.js');
const fn = new Function(`${m![0]}; return shiftEnterSeq;`)() as (e: object) => string | null;
const key = (k: string, extra: object = {}) =>
  fn({ key: k, shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, isComposing: false, ...extra });

test('Shift+Enter sends ESC CR, the newline Claude Code reads, not a bare CR', () => {
  assert.equal(key('Enter', { shiftKey: true }), '\x1b\r');
  assert.notEqual(key('Enter', { shiftKey: true }), '\r', 'a bare CR is what xterm sends, and it submits');
});

test('plain Enter is left to xterm, so it still sends (and still runs a shell command)', () => {
  assert.equal(key('Enter'), null);
});

test('other modifiers are not ours: ⌥↵ already reaches Claude via Meta, ⌘ and Ctrl belong to others', () => {
  assert.equal(key('Enter', { shiftKey: true, altKey: true }), null);
  assert.equal(key('Enter', { shiftKey: true, metaKey: true }), null);
  assert.equal(key('Enter', { shiftKey: true, ctrlKey: true }), null);
});

test('IME composition: Shift+Enter confirms the composition, it is never turned into a newline', () => {
  assert.equal(key('Enter', { shiftKey: true, isComposing: true }), null);
});

test('only Enter: Shift with any other key types as before', () => {
  for (const k of ['A', 'Tab', 'ArrowUp', 'Backspace', ' ']) assert.equal(key(k, { shiftKey: true }), null, `Shift+${k}`);
});

test('wired into the terminal key handler on keydown, and the event is cancelled so no second CR follows', () => {
  assert.match(app,
    /if \(e\.type === 'keydown'\) \{ const nl = shiftEnterSeq\(e\); if \(nl\) \{ e\.preventDefault\(\); window\.glassShell\.ptyWrite\(id, nl\); return false; \} \}/);
  const handler = app.indexOf('term.attachCustomKeyEventHandler((e) =>');
  const wired = app.indexOf('const nl = shiftEnterSeq(e)');
  const metaBail = app.indexOf("if (e.type !== 'keydown' || !e.metaKey || e.altKey) return true;", handler);
  assert.ok(handler > 0 && wired > handler && wired < metaBail,
    'it must run inside the pane handler, before the ⌘ section returns everything else to xterm');
});
