/**
 * Issue #131: on Windows the App's process-table poll could freeze a loaded machine and open blank
 * console windows. Three properties keep it from coming back:
 *  1. the scan is a background reading: callers never wait, scans never overlap, slow scans space
 *     themselves out, a failed scan keeps the last table;
 *  2. the Windows scan is wired through that reading, asynchronously;
 *  3. no child process the App starts on Windows opens a console window.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { backgroundScan } from '../core/backgroundScan';

function harness() {
  let t = 0;
  const pending: Array<{ res: (s: string) => void; rej: (e: Error) => void }> = [];
  let runs = 0;
  const scan = backgroundScan({
    run: () => { runs += 1; return new Promise<string>((res, rej) => pending.push({ res, rej })); },
    minIntervalMs: 4_000, maxIntervalMs: 60_000, slowFactor: 5, now: () => t,
  });
  const settle = async () => { await new Promise((r) => setImmediate(r)); };
  return {
    scan, pending, settle,
    get runs() { return runs; },
    advance(ms: number) { t += ms; },
  };
}

test('read() never waits and a scan never overlaps another, however often it is read', async () => {
  const h = harness();
  assert.equal(h.scan.read(), '', 'nothing known before the first scan, and no waiting for it');
  for (let i = 0; i < 50; i++) { h.advance(1_000); h.scan.read(); }
  assert.equal(h.runs, 1, 'fifty reads over 50 s while one scan is stuck: still one PowerShell, not fifty');
  h.pending[0].res('1 0 10');
  await h.settle();
  assert.equal(h.scan.read(), '1 0 10', 'the finished table is served');
});

test('a slow scan spaces the next one out, a fast one keeps the regular cadence', async () => {
  const h = harness();
  h.scan.read();
  h.advance(600); h.pending[0].res('fast'); await h.settle();
  assert.equal(h.scan.state().intervalMs, 4_000, '0.6 s scan: the 4 s floor');
  h.advance(4_000); h.scan.read();
  assert.equal(h.runs, 2);
  h.advance(6_000); h.pending[1].res('slow'); await h.settle();
  assert.equal(h.scan.state().intervalMs, 30_000, 'a 6 s scan waits 30 s before the next: cheaper when the machine is struggling');
  h.advance(20_000); h.scan.read();
  assert.equal(h.runs, 2, 'not due yet');
  h.advance(10_000); h.scan.read();
  assert.equal(h.runs, 3, 'due');
  h.advance(30_000); h.pending[2].res('very slow'); await h.settle();
  assert.equal(h.scan.state().intervalMs, 60_000, 'and never longer than the cap');
});

test('a failed scan keeps the last table and backs off', async () => {
  const h = harness();
  h.scan.read(); h.advance(500); h.pending[0].res('good'); await h.settle();
  h.advance(4_000); h.scan.read();
  h.pending[1].rej(new Error('timeout')); await h.settle();
  assert.equal(h.scan.read(), 'good', 'a failure is not an empty process list');
  assert.equal(h.scan.state().intervalMs, 8_000, 'first failure doubles the wait');
});

const ROOT = path.join(__dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('the Windows process table is that background reading, started asynchronously and hidden', () => {
  const src = read('src/main/aios.ts');
  const block = src.slice(src.indexOf('const winScan = backgroundScan({'), src.indexOf('const winProcTable'));
  assert.ok(block.length > 0, 'winScan is built with backgroundScan');
  assert.match(block, /execFile\('powershell\.exe'/, 'async execFile, never execFileSync: the main thread does not wait');
  assert.doesNotMatch(block, /execFileSync/);
  assert.match(block, /windowsHide: true/);
  assert.match(src, /const winProcTable = \(\): string => winScan\.read\(\);/);
});

/* Every child_process call in main and core, with its argument text (balanced parens). */
function childCalls(text: string): Array<{ at: number; call: string }> {
  const out: Array<{ at: number; call: string }> = [];
  const re = /(?<![.\w])(execFileSync|execFile|spawnSync|spawn)\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    let depth = 0, i = m.index + m[0].length - 1;
    for (; i < text.length; i++) {
      const c = text[i];
      if (c === '(') depth++;
      else if (c === ')' && --depth === 0) break;
    }
    out.push({ at: m.index, call: text.slice(m.index, i + 1) });
  }
  return out;
}

/* Binaries that only exist on macOS/Linux: their calls never run on Windows. */
const POSIX_ONLY = /^(?:execFileSync|execFile|spawnSync|spawn)\(\s*'(?:\/usr\/bin\/osascript|\/usr\/bin\/sudo|ps|lsof|\/bin\/zsh)'/;

test('no child process the App starts on Windows opens a console window', () => {
  const dirs = ['src/main', 'src/core'];
  const missing: string[] = [];
  let checked = 0;
  for (const d of dirs) {
    for (const f of fs.readdirSync(path.join(ROOT, d))) {
      if (!f.endsWith('.ts')) continue;
      /* Comments blanked out (same length, newlines kept, so line numbers still point right). */
      const text = read(`${d}/${f}`)
        .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
        .replace(/\/\/[^\n]*/g, (c) => ' '.repeat(c.length));
      for (const { at, call } of childCalls(text)) {
        if (POSIX_ONLY.test(call)) continue;
        checked++;
        if (!/windowsHide:\s*true/.test(call)) missing.push(`${d}/${f}:${text.slice(0, at).split('\n').length}`);
      }
    }
  }
  assert.ok(checked >= 20, `the scan found the calls (${checked}); a broken matcher must not pass by finding none`);
  assert.deepEqual(missing, [], 'each of these would flash a console window on Windows');
});
