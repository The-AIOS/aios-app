/**
 * AI-149 — `resume` reopens the SAME someone, or says it cannot.
 *
 * These pin the two decisions that make that true: which session a name resolves to, and what
 * the bus does when it resolves to nothing. Both are pure, so they are tested without a
 * filesystem; main's `resumeIdFor` only supplies candidates to `pickResume`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentNamesIn, latestAgentName, pickResume, type ResumeCandidate } from '../core/resumeTarget';
import { parseRequest, buildResumeCmd, buildSpawnCmd } from '../core/commandBus';

const rec = (name: string, sid = 's1') =>
  JSON.stringify({ type: 'agent-name', agentName: name, sessionId: sid });

test('agent-name records are read in file order', () => {
  const t = [rec('app-walker'), '{"type":"user"}', rec('aios-app')].join('\n');
  assert.deepEqual(agentNamesIn(t), ['app-walker', 'aios-app']);
});

test('a renamed session answers to its LAST name, not its first', () => {
  // 0.9.3 shipped tab rename, so one transcript can hold several names. Resolving on the first
  // would resume a session under a name it no longer has — a different someone.
  const t = [rec('app-walker'), rec('aios-app')].join('\n');
  assert.equal(latestAgentName(t), 'aios-app');
  assert.equal(latestAgentName('{"type":"user"}'), undefined);
});

test('names match case-insensitively and ignore surrounding space', () => {
  assert.equal(latestAgentName(rec('  AIOS-App  ')), 'aios-app');
  assert.equal(pickResume('AIOS-APP', [{ sessionId: 'a', mtimeMs: 1, latestName: 'aios-app' }]), 'a');
});

test('pickResume takes the NEWEST session that currently answers to the name', () => {
  const c: ResumeCandidate[] = [
    { sessionId: 'old', mtimeMs: 100, latestName: 'writer' },
    { sessionId: 'new', mtimeMs: 900, latestName: 'writer' },
    { sessionId: 'other', mtimeMs: 999, latestName: 'reviewer' },
  ];
  assert.equal(pickResume('writer', c), 'new');
});

test('a session cannot resume ITSELF', () => {
  // A session filing a resume for its own name would reopen itself — a duplicate at best.
  const c: ResumeCandidate[] = [
    { sessionId: 'me', mtimeMs: 900, latestName: 'writer' },
    { sessionId: 'older', mtimeMs: 100, latestName: 'writer' },
  ];
  assert.equal(pickResume('writer', c, 'me'), 'older');
  assert.equal(pickResume('writer', [c[0]], 'me'), undefined);
});

test('no candidate answers to the name → undefined, never a near miss', () => {
  const c: ResumeCandidate[] = [{ sessionId: 'a', mtimeMs: 1, latestName: 'writer-2' }];
  assert.equal(pickResume('writer', c), undefined);
  assert.equal(pickResume('', c), undefined);
});

test('buildResumeCmd resumes by sessionId and carries no identity flags', () => {
  const cmd = buildResumeCmd('claude', 'abc-123', { prompt: "pick up where you left off" });
  assert.match(cmd, /--resume abc-123/);
  // --name would RE-name the session and --model would re-pin it; a resume inherits both.
  assert.ok(!cmd.includes('--name'), cmd);
  assert.ok(!cmd.includes('--model'), cmd);
});

test('buildResumeCmd quotes the prompt, and omits it when absent', () => {
  assert.match(buildResumeCmd('claude', 'x', { prompt: "it's done" }), /'it'\\''s done'/);
  assert.equal(buildResumeCmd('claude', 'x'), 'claude --resume x');
  assert.equal(buildResumeCmd('claude', 'x', { prompt: '   ' }), 'claude --resume x');
});

test('a taskFile replaces the inline prompt for both spawn and resume', () => {
  // Windows PowerShell mangles POSIX-quoted apostrophes, so every prompt spills to a file there.
  const r = buildResumeCmd('claude', 'x', { prompt: "won't survive", taskFile: '/tmp/t.md' });
  assert.ok(r.includes('/tmp/t.md'), r);
  assert.ok(!r.includes("won't survive"), r);
  assert.ok(buildSpawnCmd('claude', 'n', { task: "won't", taskFile: '/tmp/t.md' }).includes('/tmp/t.md'));
});

test("parse accepts resume and its opt-in fallback", () => {
  const r = parseRequest('{"action":"resume","name":"writer","prompt":"hi"}');
  assert.equal(r?.action, 'resume');
  assert.equal(r?.prompt, 'hi');
  assert.equal(r?.fallback, undefined, 'fallback is opt-in — absent means refuse');
  assert.equal(parseRequest('{"action":"resume","name":"w","fallback":"spawn"}')?.fallback, 'spawn');
  // Not a boolean, so a future second fallback needs no second field; unrecognised = no fallback.
  assert.equal(parseRequest('{"action":"resume","name":"w","fallback":true}')?.fallback, undefined);
  assert.equal(parseRequest('{"action":"resume","name":"w","fallback":"kill"}')?.fallback, undefined);
});

test('an ABSENT action still means spawn — contract-1 back-compat', () => {
  assert.equal(parseRequest('{"name":"w","task":"go"}')?.action, 'spawn');
  assert.equal(parseRequest('{"name":"w","action":"  "}')?.action, 'spawn');
});

test('a WRITTEN but unrecognised verb is refused, not defaulted to spawn', () => {
  // The whole point of resume is that a someone is not a something; silently spawning for a
  // typo'd verb performs exactly that substitution.
  const r = parseRequest('{"action":"resmue","name":"writer"}');
  assert.equal(r?.action, 'unknown');
  assert.equal(r?.rawAction, 'resmue', 'the dead letter has to quote what was written');
  assert.equal(parseRequest('{"action":"spawn","name":"w"}')?.rawAction, undefined);
});

test('every known verb survives a round trip, case-insensitively', () => {
  for (const v of ['spawn', 'kill', 'send', 'resume']) {
    assert.equal(parseRequest(`{"action":"${v.toUpperCase()}","name":"w","prompt":"p"}`)?.action, v);
  }
});

/* ── main-side wiring ───────────────────────────────────────────────────────────────────────
   runImmediate cannot be imported (only initCommandBus is exported), so these read the source.
   They assert SEAMS — that a path exists and disposes its request — never exact prose. */

import fs from 'node:fs';

/** runImmediate's body, with comments stripped so prose never counts as code. */
function runImmediateBody(): string {
  const src = fs.readFileSync('src/main/commandBus.ts', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  const start = src.indexOf('function runImmediate');
  assert.ok(start > 0, 'runImmediate not found — this guard is reading the wrong thing');
  const end = src.indexOf('\nfunction ', start + 10);
  const body = src.slice(start, end === -1 ? undefined : end);
  // Controls: the stripper must have stripped, and must not have eaten the code.
  assert.doesNotMatch(body, /ALREADY AWAKE/, 'the comment stripper did not strip');
  assert.match(body, /req\.action === 'resume'/, 'the comment stripper ate the code');
  return body;
}

test('no path leaves runImmediate without disposing the held request', () => {
  /* THE SEAM THAT BROKE. Extracting runSpawn out of runImmediate moved cleanup ownership: the
     extracted `return`s now exit runSpawn, not runImmediate, so each early return in the caller
     has to dispose for itself and the shared tail catches the rest. A missing or doubled
     disposal leaves a request either replayed forever or silently dropped — neither of which
     the compiler can see. */
  const body = runImmediateBody();
  const disposes = (s: string) => /unlinkSync\(heldPath\)|markUndelivered\(heldPath/.test(s);
  let from = 0, seen = 0;
  for (;;) {
    const at = body.indexOf('return', from);
    if (at === -1) break;
    from = at + 6;
    if (!/^\s*[;\n]/.test(body.slice(at + 6))) continue;   // `return x` / `returns` — not an exit
    seen++;
    assert.ok(disposes(body.slice(Math.max(0, at - 420), at)),
      `a return at offset ${at} leaves runImmediate without unlinking or dead-lettering the request`);
  }
  assert.ok(seen >= 3, `expected several early exits to check, saw ${seen}`);
  // and exactly one shared tail for the branches that fall through
  assert.equal(body.match(/unlinkSync\(heldPath\)/g)?.length ?? 0, 3,
    'expected exactly three disposals: unknown-verb (via dead letter), already-awake, resumed, and one shared tail');
});

test('resume reaches the SAME launcher spawn does — one extracted function, two callers', () => {
  const body = runImmediateBody();
  assert.equal(body.match(/runSpawn\(win, heldPath, req\)/g)?.length, 2,
    'runSpawn must be called from both the default spawn path and resume\'s opt-in fallback');
});

test('a live session is revealed and SENT to — never resumed into a second process', () => {
  const body = runImmediateBody();
  const branch = body.slice(body.indexOf("req.action === 'resume'"), body.indexOf('resumeIdFor'));
  assert.match(branch, /focusByName/, 'an already-running target is revealed');
  assert.match(branch, /runSend\(/, 'and its prompt lands through the send path');
  assert.doesNotMatch(branch, /buildResumeCmd|emit\(win\(\), 'terminal'/,
    'resuming a session that is already running would create a second process for one identity');
});

test('no transcript REFUSES by default, and names the miss', () => {
  const body = runImmediateBody();
  const gate = body.slice(body.indexOf('resumeIdFor'), body.indexOf('runSpawn(win, heldPath, req)'));
  assert.match(gate, /fallback !== 'spawn'/, 'the fallback is opt-in — absent means refuse');
  assert.match(gate, /markUndelivered\(heldPath, req,[\s\S]{0,200}\$\{req\.name\}/,
    'the dead letter must name the session that could not be found, or it is not actionable');
});

test('an unrecognised verb is dead-lettered before any launcher runs', () => {
  const body = runImmediateBody();
  const at = body.indexOf("req.action === 'unknown'");
  assert.ok(at > 0 && at < body.indexOf('runSpawn('), 'the unknown-verb refusal must precede every launch');
  assert.match(body.slice(at, at + 400), /markUndelivered/);
});
