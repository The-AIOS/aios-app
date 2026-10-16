/**
 * Private run files (reviewer, canonical PR #218): a worker's task, a resume prompt, a handoff and
 * the setup scripts are written where no other local user can plant them. On Linux os.tmpdir() is
 * the shared /tmp, so a fixed name there let anyone pre-create the file — or a symlink at its path.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runDir, writePrivateFile } from '../main/privateRun';

const posix = process.platform !== 'win32';
const fresh = () => fs.mkdtempSync(path.join(os.tmpdir(), 'privrun-'));

test('the run dir is ~/.aios/run, private (0700), and a written file is private (0600)', { skip: !posix }, () => {
  const home = fresh();
  const dir = runDir(undefined, { home });
  assert.equal(dir, path.join(home, '.aios', 'run'));
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  const f = writePrivateFile(dir, 'aios-spawn-task-heron.md', 'the task');
  assert.equal(fs.readFileSync(f, 'utf8'), 'the task');
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  assert.equal(fs.statSync(runDir('setup', { home })).mode & 0o777, 0o700, 'a subfolder is private too');
});

test('an older file of this user\'s is replaced, not appended to or refused', () => {
  const dir = fresh();
  writePrivateFile(dir, 't.md', 'old task');
  assert.equal(fs.readFileSync(writePrivateFile(dir, 't.md', 'new'), 'utf8'), 'new');
});

test('a planted SYMLINK at the task path is refused, and its target is untouched', { skip: !posix }, () => {
  const dir = fresh();
  const victim = path.join(fresh(), 'victim.txt');
  fs.writeFileSync(victim, 'original');
  fs.symlinkSync(victim, path.join(dir, 'aios-spawn-task-heron.md'));
  assert.throws(() => writePrivateFile(dir, 'aios-spawn-task-heron.md', 'attacker-visible task'), /refusing/);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'original');
});

test('CONTROL: without the guard, the same plant DOES redirect the write — so the test above can fail', { skip: !posix }, () => {
  const dir = fresh();
  const victim = path.join(fresh(), 'victim.txt');
  fs.writeFileSync(victim, 'original');
  fs.symlinkSync(victim, path.join(dir, 'aios-spawn-task-heron.md'));
  fs.writeFileSync(path.join(dir, 'aios-spawn-task-heron.md'), 'redirected');   // what the old code did
  assert.equal(fs.readFileSync(victim, 'utf8'), 'redirected', 'the plant works against a plain write');
});

test('a run dir that is a symlink, or not a directory, is refused — never a fallback to /tmp', { skip: !posix }, () => {
  const home = fresh();
  fs.mkdirSync(path.join(home, '.aios'));
  fs.symlinkSync(fresh(), path.join(home, '.aios', 'run'));
  assert.throws(() => runDir(undefined, { home }), /symlink/);
  const home2 = fresh();
  fs.mkdirSync(path.join(home2, '.aios'));
  fs.writeFileSync(path.join(home2, '.aios', 'run'), 'not a dir');
  assert.throws(() => runDir(undefined, { home: home2 }), /not a directory/);
});

test('a name with a path in it is refused', () => {
  assert.throws(() => writePrivateFile(fresh(), '../escape.md', 'x'), /unsafe/);
});

test('Windows keeps its per-user temp dir', () => {
  assert.equal(runDir(undefined, { platform: 'win32' }), os.tmpdir());
});

test('App parity with Glass: a task file that cannot be written dead-letters — it is never typed inline', () => {
  const bus = fs.readFileSync('src/main/commandBus.ts', 'utf8');
  assert.doesNotMatch(bus, /taskFile = undefined/, 'the silent inline fallback is gone');
  assert.match(bus, /writePrivateFile\(runDir\(\), `aios-spawn-task-\$\{req\.name\}\.md`[\s\S]{0,120}catch \(e\) \{\s*markUndelivered\(heldPath, req,/);
  assert.match(bus, /writePrivateFile\(runDir\(\), `aios-resume-task-\$\{req\.name\}\.md`[\s\S]{0,120}catch \(e\) \{\s*markUndelivered\(heldPath, req,/);
});

test('SWEEP: no file a session reads or runs is written under a fixed name in the shared temp dir', () => {
  for (const f of ['src/main/commandBus.ts', 'src/main/main.ts', 'src/main/aios.ts']) {
    const src = fs.readFileSync(f, 'utf8');
    assert.doesNotMatch(src, /os\.tmpdir\(\),\s*[`'](aios-(spawn|resume)-task|aios-task-|aios-designer-|aios-report-|aios-setup)/, f);
  }
});
