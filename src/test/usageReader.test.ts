/** Review should-fix 17 — the shared AI-171 reader: async, bounded, pruned, and whole characters. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UsageReader, feedUsage, type UsageIo } from '../core/usageReader';
import { parseStatuslinePayload, mergeStatus, scopeStatusToSession } from '../core/chatEvents';

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

/* ── the chat usage row: reset times and the context window, read from the statusline payload ──────────
   The parser that reads that payload (`parseStatuslinePayload`, with `mergeStatus`) lives in core/chatEvents.ts,
   next to the usage bar's other pure helpers; its tests sit here with the rest of the usage work.
   The one rule they pin: a field the payload does not carry stays ABSENT. A reset time guessed from the
   window length, or a window size defaulted to a round number, would read to the operator as a fact. */
// Hand-written, in the shape Claude Code's statusline really writes (field names verified against a live payload; values invented).
const PAYLOAD = {
  model: { id: 'example-model', display_name: 'Example 1' },
  effort: { level: 'high' },
  context_window: { total_input_tokens: 290000, context_window_size: 1000000, used_percentage: 29 },
  rate_limits: {
    five_hour: { used_percentage: 42, resets_at: 1793001000 },
    seven_day: { used_percentage: 71, resets_at: 1793012400 },
  },
};

test('the payload\'s reset times and context window are read as Unix seconds and tokens', () => {
  const s = parseStatuslinePayload(PAYLOAD);
  assert.equal(s.fiveHourResetsAt, 1793001000);
  assert.equal(s.sevenDayResetsAt, 1793012400);
  assert.equal(s.contextWindow, 1000000);
  assert.equal(s.fiveHourPct, 42);
  assert.equal(s.sevenDayPct, 71);
  assert.equal(parseStatuslinePayload(JSON.stringify(PAYLOAD)).fiveHourResetsAt, 1793001000, 'a JSON string reads the same');
});

test('a payload without resets or a window size yields none of them — nothing is inferred', () => {
  const bare = { rate_limits: { five_hour: { used_percentage: 12 }, seven_day: { used_percentage: 3 } }, context_window: { used_percentage: 8 } };
  const s = parseStatuslinePayload(bare);
  assert.equal(s.fiveHourPct, 12);
  assert.ok(!('fiveHourResetsAt' in s) && !('sevenDayResetsAt' in s) && !('contextWindow' in s), `unexpected keys: ${Object.keys(s).join(', ')}`);
  // an older payload with no rate limits at all
  assert.deepEqual(parseStatuslinePayload({ model: 'example' }), { model: 'example' });
  assert.deepEqual(parseStatuslinePayload('not json'), {});
  assert.deepEqual(parseStatuslinePayload(null), {});
});

test('values that are not a usable instant or size are dropped, never coerced', () => {
  const s = parseStatuslinePayload({
    rate_limits: { five_hour: { used_percentage: 5, resets_at: '1793001000' }, seven_day: { used_percentage: 6, resets_at: 0 } },
    context_window: { context_window_size: -5 },
  });
  assert.ok(!('fiveHourResetsAt' in s), 'a numeric STRING is a payload we do not understand');
  assert.ok(!('sevenDayResetsAt' in s), 'zero is "not given", not 1970');
  assert.ok(!('contextWindow' in s), 'a negative size is not a size');
  assert.equal(parseStatuslinePayload({ rate_limits: { five_hour: { resets_at: Number.NaN } } }).fiveHourResetsAt, undefined);
  assert.equal(parseStatuslinePayload({ rate_limits: { five_hour: { resets_at: -3 } } }).fiveHourResetsAt, undefined);
});

test('a reset written in milliseconds is scaled to seconds instead of landing in the year 58000', () => {
  assert.equal(parseStatuslinePayload({ rate_limits: { five_hour: { resets_at: 1793001000123 } } }).fiveHourResetsAt, 1793001000);
  // control: a value in seconds is left alone
  assert.equal(parseStatuslinePayload({ rate_limits: { five_hour: { resets_at: 1793001000 } } }).fiveHourResetsAt, 1793001000);
});

test('mergeStatus carries the new fields from the file, and the session still wins field by field', () => {
  const file = parseStatuslinePayload(PAYLOAD);
  const merged = mergeStatus(undefined, file);
  assert.equal(merged.fiveHourResetsAt, 1793001000);
  assert.equal(merged.sevenDayResetsAt, 1793012400);
  assert.equal(merged.contextWindow, 1000000);
  assert.equal(merged.source, 'file');
  const mixed = mergeStatus({ contextWindow: 200000 }, file);
  assert.equal(mixed.contextWindow, 200000, 'the live session\'s own number outranks the global file');
  assert.equal(mixed.fiveHourResetsAt, 1793001000);
  assert.equal(mixed.source, 'mixed');
  // control: with nothing read, nothing appears
  const empty = mergeStatus(undefined, {});
  assert.ok(!('fiveHourResetsAt' in empty) && !('contextWindow' in empty));
});

/* ── the payload file is GLOBAL: model, effort and context are shown only for the session that wrote them ──
   Hand-written ids, invented. The negative control (tab Y vs payload X) is the test that matters: it is the one that
   fails if the filter is removed and `scopeStatusToSession` just hands the payload back. */
const SID_X = '11111111-1111-4111-8111-111111111111';
const SID_Y = '22222222-2222-4222-8222-222222222222';
const SCOPED_PAYLOAD = { ...PAYLOAD, session_id: SID_X };
const SESSION_FIELDS = ['model', 'effort', 'contextPct', 'contextWindow'] as const;

test('parseStatuslinePayload reads session_id from the tolerated paths', () => {
  assert.equal(parseStatuslinePayload(SCOPED_PAYLOAD).sessionId, SID_X);
  assert.equal(parseStatuslinePayload({ sessionId: SID_X }).sessionId, SID_X);
  assert.equal(parseStatuslinePayload({ session: { id: SID_X } }).sessionId, SID_X);
  assert.ok(!('sessionId' in parseStatuslinePayload(PAYLOAD)), 'no session_id in the payload: none invented');
});

test('scope: the tab whose id equals the payload\'s keeps model, effort and context, and sessionMatch is true', () => {
  const s = scopeStatusToSession(parseStatuslinePayload(SCOPED_PAYLOAD), SID_X);
  assert.equal(s.sessionMatch, true);
  assert.equal(s.model, 'Example 1');
  assert.equal(s.effort, 'high');
  assert.equal(s.contextPct, 29);
  assert.equal(s.contextWindow, 1000000);
  assert.equal(s.fiveHourPct, 42);
  assert.equal(s.sevenDayResetsAt, 1793012400);
  assert.ok(!('sessionId' in s), 'the payload\'s own id is not passed on');
  const merged = mergeStatus(undefined, s);
  assert.equal(merged.sessionMatch, true);
  assert.equal(merged.model, 'Example 1');
});

test('scope NEGATIVE CONTROL: the same payload for ANOTHER tab hides the per-session fields and keeps the account\'s', () => {
  const s = scopeStatusToSession(parseStatuslinePayload(SCOPED_PAYLOAD), SID_Y);
  assert.equal(s.sessionMatch, false);
  for (const f of SESSION_FIELDS) assert.ok(!(f in s), `${f} belongs to another session and must be absent`);
  assert.equal(s.fiveHourPct, 42);
  assert.equal(s.sevenDayPct, 71);
  assert.equal(s.fiveHourResetsAt, 1793001000);
  assert.equal(s.sevenDayResetsAt, 1793012400);
  const merged = mergeStatus(undefined, s);
  assert.equal(merged.sessionMatch, false);
  for (const f of SESSION_FIELDS) assert.ok(!(f in merged), `${f} must not survive the merge either`);
  assert.equal(merged.fiveHourPct, 42);
});

test('scope: a missing id on either side is "no match" — hide rather than show another session\'s data', () => {
  const withId = parseStatuslinePayload(SCOPED_PAYLOAD);
  const withoutId = parseStatuslinePayload(PAYLOAD);
  const cases: Array<[string, ReturnType<typeof parseStatuslinePayload>, string | null | undefined]> = [
    ['payload without session_id, tab with an id', withoutId, SID_X],
    ['tab id null', withId, null],
    ['tab id undefined', withId, undefined],
    ['tab id empty', withId, ''],
    ['both missing', withoutId, null],
    ['payload id empty string', parseStatuslinePayload({ ...PAYLOAD, session_id: '' }), ''],
  ];
  for (const [label, file, tab] of cases) {
    const s = scopeStatusToSession(file, tab);
    assert.equal(s.sessionMatch, false, label);
    for (const f of SESSION_FIELDS) assert.ok(!(f in s), `${label}: ${f} must be absent`);
    assert.equal(s.fiveHourPct, 42, `${label}: account numbers stay`);
  }
});

test('mergeStatus without a scoping verdict leaves sessionMatch absent (nothing was scoped, nothing is claimed)', () => {
  assert.ok(!('sessionMatch' in mergeStatus(undefined, parseStatuslinePayload(PAYLOAD))));
  assert.equal(mergeStatus(undefined, { sessionMatch: false }).sessionMatch, false);
});
