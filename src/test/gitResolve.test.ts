/**
 * Which `git` the App runs (AI-157, second defect).
 *
 * A packaged macOS app launched from Finder inherits a MINIMAL PATH, and on macOS
 * `/usr/bin/git` is not git — it is the Xcode Command Line Tools shim, which exists, is
 * executable, and exits non-zero with "You have not agreed to the Xcode license agreements"
 * until someone runs `xcodebuild -license`. So `execFile('git', …)` finds something, and that
 * something fails.
 *
 * Measured on a live machine: ALL of the App's git calls were failing this way — the framework
 * update check, the explorer's `git status` badges, the credential-helper probe — while the same
 * commands worked in any terminal, because a terminal's PATH reaches Homebrew first. The visible
 * symptom was a pill reading "✓ synced {date}", which is the fallback for "the remote check
 * could not run" and reads as success.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { pickGit, gitCandidates } from '../core/gitResolve';

test('EXISTENCE IS NOT ENOUGH — the Xcode shim exists and must not win', () => {
  /* The bug in one assertion: a resolver that stopped at "this file is there" picks the shim,
     because the shim is there. Only "does it RUN" separates them. */
  const picked = pickGit({
    platform: 'darwin',
    pathHit: '/usr/bin/git',
    works: (p) => p !== '/usr/bin/git',   // the shim exists but fails
  });
  assert.equal(picked, '/opt/homebrew/bin/git');
});

test('a real Homebrew git outranks the shim even when PATH offers only the shim', () => {
  const order = gitCandidates('darwin', '/usr/bin/git');
  assert.ok(order.indexOf('/opt/homebrew/bin/git') < order.indexOf('/usr/bin/git'),
    'Homebrew first — a packaged app never sees it on PATH, so ordering is the only thing that finds it');
  assert.equal(order[order.length - 1], '/usr/bin/git',
    'and the shim is LAST, not absent: with Xcode licensed it is a perfectly good git, and a '
    + 'machine without Homebrew has nothing else');
});

test('the shim wins when it is the only thing that runs', () => {
  assert.equal(pickGit({ platform: 'darwin', works: (p) => p === '/usr/bin/git' }), '/usr/bin/git');
});

test('nothing usable still returns a command, never an empty string', () => {
  assert.equal(pickGit({ platform: 'darwin', works: () => false }), 'git',
    'an empty string would spawn nothing and be reported as "git is missing" — a different, wrong diagnosis');
});

test('no bare git spawn survives anywhere in main', () => {
  /* The resolver is worthless if one call site still says `'git'`: that one keeps failing, and
     it fails silently, which is how this went unnoticed across ELEVEN call sites. */
  const dir = path.join(__dirname, '..', 'main');
  const offenders: string[] = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.ts'))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of src.matchAll(/execFile(?:Sync)?\(\s*'git'/g)) {
      offenders.push(`${f}: ${src.slice(m.index!, m.index! + 40)}`);
    }
  }
  assert.deepEqual(offenders, [],
    'these spawn a bare `git`, which a packaged app resolves to the Xcode shim — use gitBin(): '
    + offenders.join(' · '));
});
