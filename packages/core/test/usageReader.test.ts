/** Review should-fix 17 — the shared usage reader: async, bounded, pruned, and whole characters. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UsageReader, feedUsage, type UsageIo } from '../src/usageReader';

const skill = (name: string) => JSON.stringify({ message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: name } }] } }) + '\n';

function memIo(files: Record<string, Uint8Array>, calls = { find: 0, read: 0 }): UsageIo & { calls: typeof calls } {
  return {
    calls,
    async find(id) { calls.find++; return files[id] ? id : undefined; },
    async size(f) { return files[f].length; },
    async read(f, off, len) { calls.read++; return files[f].subarray(off, off + len); },
  };
}

test('a character cut across a chunk edge decodes whole (the old string carry produced U+FFFD)', () => {
  const bytes = new TextEncoder().encode(skill('diseño-ñandú'));
  const st = { carry: new Uint8Array(0), usage: { skills: [] as string[], agents: [] as string[] } };
  for (const b of bytes) feedUsage(st, Uint8Array.of(b));   // one BYTE at a time: every multi-byte char is split
  assert.deepEqual(st.usage.skills, ['diseño-ñandú']);
});

test('reads are bounded per tick and catch up over later ticks, never one giant read', async () => {
  const body = new TextEncoder().encode(skill('a') + 'x'.repeat(5000) + '\n' + skill('b'));
  const io = memIo({ s1: body });
  const r = new UsageReader(io, { chunkBytes: 1000, maxBytesPerTick: 2000 });
  await r.refresh('s1');
  assert.deepEqual(r.get('s1')?.skills, ['a'], 'first tick: only what the budget reached');
  for (let i = 0; i < 5; i++) await r.refresh('s1');
  assert.deepEqual(r.get('s1')?.skills, ['a', 'b'], 'later ticks finish the file');
});

test('a session with no transcript is not re-scanned every tick', async () => {
  let t = 0;
  const io = memIo({});
  const r = new UsageReader(io, { missRetryMs: 30_000, now: () => t });
  await r.refresh('ghost'); await r.refresh('ghost'); await r.refresh('ghost');
  assert.equal(io.calls.find, 1, 'one scan, then back off');
  t = 31_000; await r.refresh('ghost');
  assert.equal(io.calls.find, 2, 'retried after the back-off');
});

test('the cache follows the running list', async () => {
  const io = memIo({ a: new TextEncoder().encode(skill('x')), b: new TextEncoder().encode(skill('y')) });
  const r = new UsageReader(io);
  await r.refresh('a'); await r.refresh('b');
  assert.equal(r.size, 2);
  r.prune(['b']);
  assert.equal(r.size, 1, 'an ended session is forgotten');
});

test('a transcript that shrank (rewritten) is re-read from the start', async () => {
  const files: Record<string, Uint8Array> = { s: new TextEncoder().encode(skill('old') + skill('older')) };
  const r = new UsageReader(memIo(files));
  await r.refresh('s');
  files.s = new TextEncoder().encode(skill('new'));
  await r.refresh('s');
  assert.deepEqual(r.get('s')?.skills, ['new']);
});
