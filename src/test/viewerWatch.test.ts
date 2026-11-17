/**
 * #177: an open file reloads when it changes on disk, even when it was opened by another path to
 * the same place (a symlinked root). Files outside the allowed roots are not readable, so not watched. Main's watch needs
 * Electron, so its wiring is read from the source; the folder rule is exercised with a real watch.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

test('wiring: each open viewer watches its file through its real folder, and stops on close', () => {
  const main = fs.readFileSync('src/main/main.ts', 'utf8');
  const pre = fs.readFileSync('src/preload/preload.ts', 'utf8');
  const app = fs.readFileSync('renderer/app.js', 'utf8');
  assert.match(main, /ipcMain\.handle\('fs:watchFile'/);
  assert.match(main, /fs\.realpathSync\.native\(abs\)/, 'the real path (case folded), so a symlinked root still matches');
  assert.match(main, /const watchKey = \(senderId: number, p: string\)/, 'watches belong to one window');
  assert.match(main, /e\.sender\.once\('destroyed', \(\) => \{ closeWatches\(id\)/, 'and close with it');
  assert.match(main, /ipcMain\.handle\('fs:unwatchAll'/);
  assert.match(app, /void window\.glassShell\.fsUnwatchAll\?\.\(\)/, 'a reloaded page drops the watches its earlier self left');
  assert.match(main, /fs\.watch\(path\.dirname\(real\)/, 'the folder, not the file (an atomic replace kills a file watch)');
  assert.match(main, /resolveIn\(given\)/, 'only files the viewer may read');
  assert.match(pre, /fsWatchFile:/); assert.match(pre, /onFileChanged:/);
  assert.match(app, /fsWatchFile\?\.\(file\.path\)/, 'the viewer starts watching when it opens');
  assert.match(app, /if \(p\.unwatch\) p\.unwatch\(\);/, 'and stops when its tab closes');
  assert.match(app, /p\.path === m\.path\) void p\.onDiskMaybeChanged\(\)/, 'a change reaches that viewer');
});

test('a folder watch sees an atomic replace of the file, which a watch on the file itself misses', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vwatch-')));
  const f = path.join(dir, 'report.html');
  fs.writeFileSync(f, '<p>old</p>');
  const seen: string[] = [];
  const w = fs.watch(dir, (_e, name) => { if (name && String(name) === 'report.html') seen.push('x'); });
  await new Promise((r) => setTimeout(r, 100));
  fs.writeFileSync(f + '.tmp', '<p>new</p>');
  fs.renameSync(f + '.tmp', f);   // how agents and editors write
  for (let i = 0; i < 40 && !seen.length; i++) await new Promise((r) => setTimeout(r, 50));
  w.close();
  assert.ok(seen.length > 0, 'the folder watch reported the replaced file');
});
