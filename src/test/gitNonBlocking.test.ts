/**
 * Adding ~/Decks as a workspace folder froze the App (operator-reported 2026-09-23). It is a git
 * repo with 43 GB of media where `git status` takes 8s, and the explorer asks for status every 4s.
 * The call was execFileSync with a 4s timeout, so the main process was held most of the time.
 *
 * These run the real gitStatusForRoots against a real repo folder with a FAKE git that takes as
 * long as we say, and check the three promises: the App keeps running while git works, a slow
 * repo is never run twice at once, and it is re-checked less often the slower it is.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as aios from '../main/aios';

function repo(): string {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-git-'));
  fs.mkdirSync(path.join(r, '.git'));
  return r;
}

test('the refresh interval follows how slow the repo is', () => {
  assert.equal(aios.gitRefreshInterval(40, false), 2000, 'fast repo: live, as before');
  assert.equal(aios.gitRefreshInterval(8000, false), 80_000, 'the 8s repo: every 80s, not every 4s');
  assert.equal(aios.gitRefreshInterval(1000, false), 30_000, 'floor 30s once it is slow at all');
  assert.equal(aios.gitRefreshInterval(60_000, false), 300_000, 'ceiling 5 min');
  assert.equal(aios.gitRefreshInterval(0, true), 300_000, 'too slow: every 5 min');
});

test('a slow git never holds the App: timers keep firing while it runs', async () => {
  const r = repo();
  let runs = 0;
  aios.__setGitRunnerForTest((_repo, cb) => { runs++; setTimeout(() => cb(null, '?? big.mov\n'), 1500); });
  try {
    let ticks = 0;
    const iv = setInterval(() => ticks++, 50);
    const t0 = Date.now();
    const snap = await aios.gitStatusForRoots([r]);
    const took = Date.now() - t0;
    clearInterval(iv);
    assert.ok(took < 1200, `answered in ${took}ms without waiting for the 1.5s git (the old code would have blocked for all of it)`);
    assert.ok(ticks >= 10, `the event loop kept running (${ticks} ticks) — nothing blocked`);
    assert.deepEqual(snap.files, {}, 'no answer yet → no markers, rather than a frozen window');
    assert.equal(runs, 1);
  } finally { aios.__setGitRunnerForTest(null); fs.rmSync(r, { recursive: true, force: true }); }
});

test('a slow repo is never run twice at once, and not again until its interval', async () => {
  const r = repo();
  let runs = 0;
  aios.__setGitRunnerForTest((_repo, cb) => { runs++; setTimeout(() => cb(null, ' M deck.key\n'), 1200); });
  try {
    const first = aios.gitStatusForRoots([r]);
    await new Promise((res) => setTimeout(res, 100));
    await Promise.all([first]);
    assert.equal(runs, 1, 'one run in flight');
    await new Promise((res) => setTimeout(res, 1400));               // let the 1.2s run finish
    // force past the 4s snapshot cache by asking with a different root list containing the same repo
    const snap = await aios.gitStatusForRoots([r, path.join(r, 'nope')]);
    assert.equal(snap.files[path.join(r, 'deck.key')], 'M', 'the answer lands once git finishes');
    assert.equal(runs, 1, 'a 1.2s repo is not re-run 1.4s later — its interval is 30s');
  } finally { aios.__setGitRunnerForTest(null); fs.rmSync(r, { recursive: true, force: true }); }
});

test('a run that hits the timeout marks the repo slow, drops its markers, and reports it', async () => {
  const r = repo();
  aios.__setGitRunnerForTest((_repo, cb) => { const e = Object.assign(new Error('timeout'), { killed: true }); setTimeout(() => cb(e, ''), 10); });
  try {
    await aios.gitStatusForRoots([r]);
    await new Promise((res) => setTimeout(res, 50));
    const snap = await aios.gitStatusForRoots([r, path.join(r, 'x')]);
    assert.deepEqual(snap.slow, [r], 'the renderer is told which repo, once');
    assert.deepEqual(snap.files, {});
  } finally { aios.__setGitRunnerForTest(null); fs.rmSync(r, { recursive: true, force: true }); }
});

test('the IPC handler awaits it, and no sync git status is left on the explorer path', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main', 'main.ts'), 'utf8');
  assert.match(main, /ipcMain\.handle\('fs:git', \(\) => aios\.gitStatusForRoots\(allowedRoots\(\)\)\)/);
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main', 'aios.ts'), 'utf8');
  assert.doesNotMatch(src, /execFileSync\(gitBin\(\), \['-C', repo(Root)?, 'status'/, 'git status must not run synchronously');
});
