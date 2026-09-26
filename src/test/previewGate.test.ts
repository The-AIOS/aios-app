/**
 * The viewer READ the whole file as text before asking what it was. ⌘-clicking a 123 MB .dmg
 * printed in a terminal froze the window: main read it with readFileSync(…, 'utf8'), shipped the
 * string over IPC, and the renderer tried to lay it out as source. Operator-reported, the App had
 * to be force-quit — and the path had been printed by an agent as "here is your build".
 *
 * The fix is a gate BEFORE the read, in one importable function, tested here against real files:
 *   asset  — images and PDFs render from their PATH (an <img>/<iframe> src); their bytes are never
 *            needed, so they are never read, whatever their size
 *   large  — over the text limit: not read
 *   binary — a NUL byte in the first 8 KB: not read
 *   text   — everything else
 * and what main returns for the unreadable kinds is a FLAG the renderer acts on: reveal the file
 * in its folder instead of building a pane. The desktop is where a .dmg is useful anyway.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { classifyForRead, TEXT_LIMIT } from '../main/preview';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-preview-'));
const write = (name: string, data: Buffer | string) => { const p = path.join(dir, name); fs.writeFileSync(p, data); return p; };

test('a text file is text — the only kind that gets read', () => {
  assert.deepEqual(classifyForRead(write('notes.md', '# hola\n')), { kind: 'text' });
});

test('an image or a PDF is an asset: classified by extension, WITHOUT opening it', () => {
  // NUL bytes inside on purpose: a sniff would call this binary; the extension must win first,
  // because the pane renders it from its path and never wants the bytes.
  const png = write('avatar.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));
  assert.deepEqual(classifyForRead(png), { kind: 'asset' });
  assert.deepEqual(classifyForRead(write('deck.pdf', Buffer.from([0x25, 0x50, 0x44, 0x46, 0]))), { kind: 'asset' });
  assert.deepEqual(classifyForRead(write('HUGE.PDF', Buffer.alloc(0)), 1), { kind: 'asset' }, 'case-insensitive, and size is irrelevant');
});

test('a NUL byte in the first 8 KB makes it binary — a .dmg, a .zip, an executable', () => {
  const dmg = write('AIOS.dmg', Buffer.concat([Buffer.from('koly'), Buffer.alloc(100), Buffer.from('x')]));
  assert.deepEqual(classifyForRead(dmg), { kind: 'binary', size: 105 });
});

test('over the text limit it is large and is not read, even when it would decode', () => {
  const big = write('log.txt', 'a'.repeat(50));
  assert.deepEqual(classifyForRead(big, 49), { kind: 'large', size: 50 });
  assert.deepEqual(classifyForRead(big, 50), { kind: 'text' }, 'the limit is inclusive');
  assert.ok(TEXT_LIMIT >= 1024 * 1024, 'the default is measured in megabytes, not bytes — notes and code must still open');
});

test('main gates fs:read with it, and hands the renderer a flag rather than a string', () => {
  const main = fs.readFileSync('src/main/main.ts', 'utf8');
  const h = main.slice(main.indexOf("ipcMain.handle('fs:read'"), main.indexOf("ipcMain.handle('fs:read'") + 900);
  const gate = h.indexOf('classifyForRead(abs)');
  const read = h.indexOf("fs.readFileSync(abs, 'utf8')");
  assert.ok(gate >= 0 && read > gate, 'the classification happens BEFORE the read');
  assert.match(h, /kind === 'asset'\) return \{ path: abs, content: '' \}/, 'assets come back empty, never read');
  assert.match(h, /unreadable: c\.kind/, 'the unreadable kinds are named to the renderer');
});

test('the viewer reveals an unreadable file instead of building a pane', () => {
  const app = fs.readFileSync('renderer/app.js', 'utf8');
  const v = app.slice(app.indexOf('async function openViewer(p) {'), app.indexOf('async function openViewer(p) {') + 1500);
  const flag = v.indexOf('if (file.unreadable)');
  const pane = v.indexOf("el.className = 'pane viewer'");
  assert.ok(flag >= 0 && pane > flag, 'the check comes before any pane exists');
  assert.ok(v.slice(flag, flag + 300).includes('window.glassShell.revealInOS(file.path)'), 'and it reveals');
  assert.ok(v.slice(flag, flag + 300).includes("t('viewer.revealedInstead'"), 'and says so');
  for (const loc of ['en', 'es', 'pt-br']) {
    const j = JSON.parse(fs.readFileSync(`src/i18n/locales/${loc}.json`, 'utf8')) as Record<string, string>;
    assert.ok(j['viewer.revealedInstead']?.includes('{name}'), `${loc} names the file`);
  }
});
