/**
 * AI-77 — Option could not type @ (or # | \ [ ] { } ~) on a Spanish keyboard in the terminal
 * (operator-reported, Spanish ISO): macOptionIsMeta turned ⌥2 into ESC-2. The rule now is "Option
 * types the character your layout makes when it makes a plain one; otherwise it is Meta". These
 * run the real optionComposedChar with the key events each layout actually produces.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';

const app = fs.readFileSync('renderer/app.js', 'utf8');
const m = /function optionComposedChar\(e\) \{[\s\S]*?\n\}/.exec(app);
assert.ok(m, 'optionComposedChar must be findable in renderer/app.js');
const fn = new Function(`${m![0]}; return optionComposedChar;`)() as (e: object) => string | null;
const opt = (key: string, code: string, extra: object = {}) => fn({ key, code, altKey: true, metaKey: false, ctrlKey: false, ...extra });

test('Spanish ISO: Option types its symbols', () => {
  assert.equal(opt('@', 'Digit2'), '@');
  assert.equal(opt('#', 'Digit3'), '#');
  assert.equal(opt('|', 'Digit1'), '|');
  assert.equal(opt('\\', 'Backquote'), '\\');
  assert.equal(opt('[', 'BracketLeft'), '[');
  assert.equal(opt('{', 'Quote'), '{');
  assert.equal(opt('~', 'Digit4'), '~');
});

test('German: ⌥L is @ — a letter key that composes a symbol still types it', () => {
  assert.equal(opt('@', 'KeyL'), '@');
});

test('US: nothing changes — Option stays Meta for Claude', () => {
  assert.equal(opt('™', 'Digit2'), null, '⌥2 composes ™ on US → Meta, as before');
  assert.equal(opt('π', 'KeyP'), null, '⌥p → Meta-p (model picker)');
  assert.equal(opt('Dead', 'KeyE'), null, 'dead keys → Meta');
  assert.equal(opt(' ', 'Space'), null, 'non-breaking space → Meta');
});

test('the keys Claude needs are never intercepted', () => {
  for (const [key, code] of [['Enter', 'Enter'], ['ArrowLeft', 'ArrowLeft'], ['ArrowRight', 'ArrowRight'], ['Backspace', 'Backspace']])
    assert.equal(opt(key, code), null, `⌥${key} stays Meta`);
});

test('Option that changes nothing is Meta; ⌘ and Ctrl combos are not ours', () => {
  assert.equal(opt('a', 'KeyA'), null, 'a layout where ⌥a is still a → Meta-a');
  assert.equal(opt('2', 'Digit2'), null);
  assert.equal(opt('@', 'Digit2', { metaKey: true }), null);
  assert.equal(opt('@', 'Digit2', { ctrlKey: true }), null);
  assert.equal(fn({ key: '@', code: 'Digit2', altKey: false }), null, 'no Option → not ours');
});

test('wired into the terminal before the ⌘ conventions, and the event is cancelled', () => {
  assert.match(app, /const ch = optionComposedChar\(e\); if \(ch\) \{ e\.preventDefault\(\); window\.glassShell\.ptyWrite\(id, ch\); return false; \}/);
  assert.match(app, /macOptionIsMeta: true/, 'Meta stays on — ⌥↵ and word jumps depend on it');
});
