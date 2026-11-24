/**
 * #201: on Windows the quit-time install left no trace on disk and never reopened the App.
 * The rules (src/core/updaterLog.ts) are checked by running them; the wiring (src/main/updater.ts)
 * by reading the source, because the bug was one argument in a library call and nothing else
 * would catch it coming back.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  formatUpdaterLine, shouldRotateUpdaterLog, quitInstallPlan, ownsQuitInstall, UPDATER_LOG_MAX_BYTES,
} from '../core/updaterLog';

const base = { platform: 'win32', downloaded: true, alreadyTriggered: false, exitCode: 0 };

test('Windows, update staged, clean quit: install silently and reopen the App', () => {
  assert.deepEqual(quitInstallPlan(base), { silent: true, runAfter: true });
});

test('nothing staged, an install already running, or a non-zero exit: no install', () => {
  assert.equal(quitInstallPlan({ ...base, downloaded: false }), null);
  assert.equal(quitInstallPlan({ ...base, alreadyTriggered: true }), null);   // the pill / unattended already started one
  assert.equal(quitInstallPlan({ ...base, exitCode: 1 }), null);              // same rule as electron-updater's own handler
});

test('macOS and Linux keep the library handler untouched', () => {
  for (const platform of ['darwin', 'linux']) {
    assert.equal(ownsQuitInstall(platform), false);
    assert.equal(quitInstallPlan({ ...base, platform }), null);
  }
  assert.equal(ownsQuitInstall('win32'), true);
});

test('a log line is one line, timestamped, with its level', () => {
  const line = formatUpdaterLine('error', 'boom\nat stack\r\nmore', new Date('2026-11-24T14:00:00Z'));
  assert.equal(line.endsWith('\n'), true);
  assert.equal(line.slice(0, -1).includes('\n'), false, 'a stack must not span lines');
  assert.match(line, /^2026-11-24T14:00:00\.000Z error boom/);
});

test('rotation only once the cap is reached', () => {
  assert.equal(shouldRotateUpdaterLog(0), false);
  assert.equal(shouldRotateUpdaterLog(UPDATER_LOG_MAX_BYTES - 1), false);
  assert.equal(shouldRotateUpdaterLog(UPDATER_LOG_MAX_BYTES), true);
  assert.equal(shouldRotateUpdaterLog(NaN), false);
});

test('the lines land on a real disk and rotate to .1 (the same calls the updater makes)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-updlog-'));
  const file = path.join(dir, 'updater.log');
  const write = (msg: string, max: number): void => {
    try { if (shouldRotateUpdaterLog(fs.statSync(file).size, max)) fs.renameSync(file, file + '.1'); } catch { /* none yet */ }
    fs.appendFileSync(file, formatUpdaterLine('info', msg, new Date()));
  };
  try {
    write('first', 10_000);
    write('second', 10_000);
    assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 2);
    write('third', 1);   // over the cap: the old file moves aside, a fresh one starts
    assert.match(fs.readFileSync(file + '.1', 'utf8'), /second/);
    assert.match(fs.readFileSync(file, 'utf8'), /third/);
    write('fourth', 1);  // .1 already exists: replaced, never an error (rename over a file on Windows)
    assert.match(fs.readFileSync(file + '.1', 'utf8'), /third/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

const upd = fs.readFileSync('src/main/updater.ts', 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

test('wiring: Windows turns the library quit-install off and installs with run-after itself', () => {
  assert.match(upd, /autoInstallOnAppQuit\s*=\s*!ownQuit/, 'the library handler must be off only where ours replaces it');
  assert.match(upd, /ownsQuitInstall\(process\.platform\)\s*&&\s*typeof nsis\.install === 'function'/);
  assert.match(upd, /app\.on\('quit'/);
  assert.match(upd, /nsis\.install!\(plan\.silent,\s*plan\.runAfter\)/);
  assert.equal(/autoInstallOnAppQuit\s*=\s*true/.test(upd), false, 'a hard-coded true brings back the no-relaunch install on Windows');
});

test('wiring: every updater line goes through the file logger', () => {
  assert.equal(/console\.(log|error)\(\s*['`]\[updater\]/.test(upd), false, 'an updater line written straight to the console never reaches the file');
  assert.match(upd, /appendFileSync\(file, formatUpdaterLine\(/);
  assert.match(upd, /'updater\.log'/);
});

test('negative control: the source checks catch the old code', () => {
  const old = "autoUpdater.autoInstallOnAppQuit = true;\n    info: (m: unknown) => console.log('[updater]', String(m)),";
  assert.equal(/autoInstallOnAppQuit\s*=\s*true/.test(old), true);
  assert.equal(/console\.(log|error)\(\s*['`]\[updater\]/.test(old), true);
});
