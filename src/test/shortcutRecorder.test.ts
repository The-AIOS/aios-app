/**
 * Settings › Ask AIOS from any app: a key recorder instead of a text field expecting an Electron accelerator
 * (0.15.0 round 3: the operator could not tell what to type). These run the real functions out of renderer/app.js.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';

const app = fs.readFileSync('renderer/app.js', 'utf8');
const slice = (src: string, head: string): string => {
  const i = src.indexOf(head);
  assert.ok(i >= 0, `${head} must be findable`);
  return src.slice(i, src.indexOf('\n}\n', i) + 2);
};
const load = (src: string) => {
  const named = src.slice(src.indexOf('const ACCEL_NAMED = '), src.indexOf('};', src.indexOf('const ACCEL_NAMED = ')) + 3);
  return new Function(named + slice(src, 'function accelFromKeydown(') + slice(src, 'function accelLabel(') + 'return { accelFromKeydown, accelLabel };')() as {
    accelFromKeydown: (e: Record<string, unknown>) => string | null; accelLabel: (a: string) => string;
  };
};
const k = (code: string, mods: Partial<Record<'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey', boolean>> = {}, key = '') => ({ code, key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });

test('a keydown becomes an Electron accelerator: letters, digits, Space, F-keys, punctuation, with every modifier', () => {
  const { accelFromKeydown: a } = load(app);
  assert.equal(a(k('Space', { ctrlKey: true, altKey: true })), 'Control+Alt+Space');
  assert.equal(a(k('KeyA', { metaKey: true, shiftKey: true })), 'Shift+Command+A');
  assert.equal(a(k('Digit7', { altKey: true })), 'Alt+7');
  assert.equal(a(k('F12', { ctrlKey: true })), 'Control+F12');
  assert.equal(a(k('Slash', { metaKey: true, altKey: true })), 'Alt+Command+/');
  assert.equal(a(k('KeyK', { metaKey: true }, 'κ')), 'Command+K', 'from the code, so the layout does not matter');
});

test('a lone modifier keeps listening; a key without ⌘/⌃/⌥ is refused; an unknown key is refused', () => {
  const { accelFromKeydown: a } = load(app);
  for (const m of ['MetaLeft', 'ControlRight', 'AltLeft', 'ShiftLeft']) assert.equal(a(k(m, { metaKey: true })), null, m);
  assert.equal(a(k('KeyA')), '', 'plain A would steal typing everywhere');
  assert.equal(a(k('KeyA', { shiftKey: true })), '', 'Shift alone is not enough');
  assert.equal(a(k('IntlRo', { metaKey: true })), '', 'a key the recorder cannot name is not saved');
  /* Control: a recorder that skips the modifier check accepts plain A. */
  const broken = load(app.replace("if (!(e.metaKey || e.ctrlKey || e.altKey)) return '';", ''));
  assert.equal(broken.accelFromKeydown(k('KeyA')), 'A', 'control: without the check a bare key gets through');
});

test('an accelerator is shown the Mac way, ⌃⌥⇧⌘ then the key, including the older CommandOrControl form', () => {
  const { accelLabel: l } = load(app);
  assert.equal(l('Control+Alt+Space'), '⌃⌥Space');
  assert.equal(l('Shift+Command+A'), '⇧⌘A');
  assert.equal(l('CommandOrControl+Shift+A'), '⇧⌘A');
  assert.equal(l('Command+Up'), '⌘↑');
  assert.equal(l(''), '');
});

test('the Settings row is a recorder: click to listen, Esc cancels, Clear turns it off, refusals warn', () => {
  const body = app.slice(app.indexOf('"Ask AIOS from any app": its global shortcut'), app.indexOf('/* #22 — how a session blocked on you'));
  assert.doesNotMatch(body, /placeholder = 'CommandOrControl\+Shift\+A'/, 'no accelerator text field any more');
  assert.match(body, /qbBtn\.addEventListener\('keydown', \(e\) => \{[\s\S]*?if \(e\.key === 'Escape'\) \{ recording = false;/);
  assert.match(body, /const accel = accelFromKeydown\(e\);/);
  assert.match(body, /qbClear\.addEventListener\('click', \(\) => \{ current = ''; paintKey\(\); void save\(''\); \}\);/);
  assert.match(body, /warn\.hidden = st\.ok !== false;/, 'the OS refusing the keys is still shown');
  for (const l of ['en', 'es', 'pt-br', 'el']) {
    const j = JSON.parse(fs.readFileSync(`src/i18n/locales/${l}.json`, 'utf8')) as Record<string, string>;
    for (const key of ['settings.quickBarShortcutRecord', 'settings.quickBarShortcutRecording', 'settings.quickBarShortcutClear', 'settings.quickBarShortcutNeedsModifier']) assert.ok(j[key], `${l} ${key}`);
  }
});
