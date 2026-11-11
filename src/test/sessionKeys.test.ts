/**
 * The "Inside a session" group of the shortcuts sheet.
 *
 * The sheet used to answer only "what can I press in the APP". Operators asked the other
 * question — how to insert a newline without sending, how to reach the start of the line — and
 * the honest answer lived in another program's docs. These guards keep the group true rather
 * than merely present: a sheet that promises a key the terminal beside it swallows is worse than
 * no sheet, because it is read and believed.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';

const app = fs.readFileSync('renderer/app.js', 'utf8');
const LOCALES = ['en', 'es', 'pt-br'];
const LOC = (l: string): Record<string, string> => JSON.parse(fs.readFileSync(`src/i18n/locales/${l}.json`, 'utf8'));

const list = /const SESSION_KEYS = \[[\s\S]*?\n\];/.exec(app);
const labels = list ? [...list[0].matchAll(/label: '([a-zA-Z.]+)'/g)].map((m) => m[1]) : [];
const accels = list ? [...list[0].matchAll(/accel: '((?:[^'\\]|\\.)*)'/g)].map((m) => m[1]) : [];

test('the session group exists, is rendered by the sheet, and is not empty', () => {
  assert.ok(list, 'SESSION_KEYS must be findable — it is the third source of the shortcuts sheet');
  assert.ok(labels.length >= 12, `expected a useful set of session keys, found ${labels.length}`);
  const render = app.slice(app.indexOf('async function renderShortcuts('));
  assert.ok(render.slice(0, render.indexOf('\n}')).includes('SESSION_KEYS'),
    'renderShortcuts must render SESSION_KEYS, or the list documents nothing');
});

test('every session string exists in all three locales — a missing key renders as its own name', () => {
  const keys = [...labels, 'shortcuts.inSession', 'shortcuts.inSessionHint', 'shortcuts.inSessionDocs'];
  for (const l of LOCALES) {
    const d = LOC(l);
    for (const k of keys) assert.ok(d[k] && String(d[k]).trim(), `${l} is missing ${k}`);
    assert.ok(d['shortcuts.inSessionHint'].includes('{version}'),
      `${l}: the hint must print the Claude Code version the rows were verified against`);
  }
});

test('the sheet never promises a key the pane swallows before xterm sees it', () => {
  /* attachCustomKeyEventHandler returns false for ⌘/Ctrl + k/p/j so the app's own shortcuts win.
     That is right for ⌘K, and it also means Ctrl+J (newline), Ctrl+K (kill to end) and Ctrl+P
     (previous line) — real Claude Code keys — never reach the session in THIS terminal. The list
     reads the handler, so a future change to that set changes what the sheet may claim. */
  const eaten = /\(e\.metaKey \|\| e\.ctrlKey\) && \[([^\]]+)\]\.includes\(e\.key\.toLowerCase\(\)\)/.exec(app);
  assert.ok(eaten, 'sanity: the pane still swallows a known set of ⌘/Ctrl keys');
  const letters = [...eaten![1].matchAll(/'([a-z])'/g)].map((m) => m[1].toUpperCase());
  assert.ok(letters.length >= 3, 'sanity: the swallowed set is read, not assumed');
  for (const a of accels) {
    for (const L of letters) {
      assert.ok(!a.includes(`Ctrl+${L}`), `${a} is listed, but the pane eats Ctrl+${L} before the session sees it`);
    }
  }
});

test('the rows are dated: the verified Claude Code version is a real version string', () => {
  const v = /const SESSION_KEYS_VERIFIED = '([^']+)'/.exec(app);
  assert.ok(v, 'SESSION_KEYS_VERIFIED must exist — undated rows cannot be told from stale ones');
  assert.match(v![1], /^\d+\.\d+\.\d+$/, `not a version: ${v![1]}`);
  assert.match(app, /const SESSION_KEYS_DOCS = 'https:\/\/code\.claude\.com\/docs\/en\/interactive-mode'/,
    'the full reference must point at the official interactive-mode page');
});

test('Shift+Enter is listed as a newline, and only because the pane really sends one for it', () => {
  const nl = accels[labels.indexOf('shortcut.sessionNewline')];
  assert.ok(nl && /^Shift\+Enter\b/.test(nl), `the newline row must lead with Shift+Enter, found ${nl}`);
  // the promise is only true while the handler translates it: xterm alone sends a bare CR
  assert.match(app, /const nl = shiftEnterSeq\(e\); if \(nl\) \{ e\.preventDefault\(\); window\.glassShell\.ptyWrite\(id, nl\)/,
    'the sheet promises Shift+Enter is a newline, so the terminal key handler must send one for it');
});

test('no hint, in any locale, still says Shift+Enter sends in this terminal', () => {
  for (const l of ['en', 'es', 'pt-br', 'el']) {
    const h = String(LOC(l)['shortcuts.inSessionHint'] || '');
    assert.ok(!h.includes('Shift+Enter'), `${l}: the hint still mentions Shift+Enter: ${h}`);
  }
});

test('off macOS no row promises a plain Ctrl key the menu takes (CmdOrCtrl IS Ctrl there)', () => {
  const menu = fs.readFileSync('src/main/menu.ts', 'utf8');
  const taken = new Set([...menu.matchAll(/accelerator: '(?:CmdOrCtrl|Ctrl)\+([A-Z])'/g)].map((m) => m[1]));
  assert.ok(taken.has('W'), 'the menu scan must find Ctrl+W (close tab), or it found nothing');
  const block = /const SESSION_KEYS = \[[\s\S]*?\n\];/.exec(app)![0];
  const rows = block.split('\n').filter((l) => l.includes('label:'));
  for (const r of rows) {
    if (/macOnly: true/.test(r)) continue;
    const os = /os: \[([^\]]*)\]/.exec(r);
    if (os && !/'win'|'linux'/.test(os[1])) continue;
    const accel = /accel: '([^']*)'/.exec(r)![1];
    for (const m of accel.matchAll(/(?:^|[ /])Ctrl\+([A-Z])\b/g)) {
      assert.ok(!taken.has(m[1]), `${accel} is shown on Windows/Linux but the menu takes Ctrl+${m[1]} there`);
    }
  }
});

test('image paste names the key that works on each platform', () => {
  const block = /const SESSION_KEYS = \[[\s\S]*?\n\];/.exec(app)![0];
  assert.match(block, /sessionImage', accel: 'Ctrl\+V', os: \['mac', 'linux'\]/, 'Ctrl+V on macOS and Linux');
  assert.match(block, /sessionImage', accel: 'Alt\+V', os: \['win'\]/, 'Alt+V on Windows, where Ctrl+V pastes text');
  assert.match(app, /if \(k\.os && !k\.os\.includes\(/, 'renderShortcuts must honour os');
});
