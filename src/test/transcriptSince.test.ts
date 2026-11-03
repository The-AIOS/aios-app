/**
 * A send is verified from what its target's transcript gained SINCE the send began, never by
 * reading the whole file. Measured: a 554 MB transcript made the whole-file read throw (V8's ~512 MB
 * string limit), the throw read as "zero deliveries", and an idle target got the message three times.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function fakeHome(): { dir: string; file: (sid: string) => string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsince-'));
  fs.mkdirSync(path.join(dir, 'projects', '-x'), { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = dir;
  return { dir, file: (sid) => path.join(dir, 'projects', '-x', `${sid}.jsonl`) };
}

test('only what was appended after the first look is read', async () => {
  const { file } = fakeHome();
  const { TranscriptSince } = await import('../main/transcriptSince');
  fs.writeFileSync(file('s1'), '{"old":1}\n'.repeat(1000));
  const since = new TranscriptSince();
  assert.equal(since.read('s1'), '', 'the first look records the size and returns nothing old');
  fs.appendFileSync(file('s1'), '{"new":1}\n');
  assert.equal(since.read('s1'), '{"new":1}\n', 'exactly the appended line');
  fs.appendFileSync(file('s1'), '{"new":2}\n');
  assert.equal(since.read('s1'), '{"new":1}\n{"new":2}\n', 'every look reads from the same start, so a line cut mid-write is whole next time');
});

test('no transcript yet is "" (nothing to count), not "unreadable"', async () => {
  fakeHome();
  const { TranscriptSince } = await import('../main/transcriptSince');
  assert.equal(new TranscriptSince().read('nope'), '');
});

test('a transcript that cannot be read is null — "cannot verify" — never ""', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async () => {
  const { file } = fakeHome();
  const { TranscriptSince } = await import('../main/transcriptSince');
  fs.writeFileSync(file('s2'), '{"a":1}\n');
  const since = new TranscriptSince();
  since.read('s2');
  fs.appendFileSync(file('s2'), '{"b":1}\n');
  fs.chmodSync(file('s2'), 0o000);
  try { assert.equal(since.read('s2'), null); } finally { fs.chmodSync(file('s2'), 0o600); }
});

test('CONTROL: the old whole-file read turned an unreadable transcript into "" — zero deliveries', async () => {
  const { file } = fakeHome();
  const { readTranscript } = await import('../main/transcriptSince');
  fs.writeFileSync(file('s3'), '{"a":1}\n');
  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    fs.chmodSync(file('s3'), 0o000);
    try { assert.equal(readTranscript('s3'), '', 'the whole read cannot tell "unreadable" from "empty" — why sends no longer use it'); }
    finally { fs.chmodSync(file('s3'), 0o600); }
  }
});

test('the send path never reads the whole transcript, never re-types on "cannot verify", and checks the request before typing', () => {
  const bus = fs.readFileSync('src/main/commandBus.ts', 'utf8');
  assert.doesNotMatch(bus, /countDeliveries\(readTranscript/, 'sends count only what was appended');
  assert.ok((bus.match(/=== null\) \{ finishUnverifiable\(\); return; \}/g) || []).length >= 3, 'every count site exits on null without typing');
  const emitAt = bus.indexOf("emit(win(), 'sendByName'");
  const guard = bus.lastIndexOf('if (!fs.existsSync(heldPath)) return;', emitAt);
  assert.ok(guard > 0 && emitAt - guard < 400, 'the request file is checked right before every type');
});
