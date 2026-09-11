/**
 * Command-bus tests — the pure request/command model (parse · sanitize ·
 * whitelist · task-file handoff · command build), plus static invariant guards
 * that lock the 0.4.3 robustness fixes into the main-side dispatcher (mirroring
 * Glass's smoke-test guard: a refactor can't silently regress them).
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {
  parseRequest, sanitizeName, whitelistModel, whitelistTier,
  needsTaskFile, shq, taskFileInstruction, buildSpawnCmd,
} from '../core/commandBus';

test('sanitizeName: kebab handle, matches the app + Glass sanitizer', () => {
  assert.equal(sanitizeName('Heron Fleet'), 'heron-fleet');
  assert.equal(sanitizeName('  UPPER  '), 'upper');
  assert.equal(sanitizeName('a!!b'), 'ab');
  assert.equal(sanitizeName('--x--'), 'x');
  assert.equal(sanitizeName(''), '');
  assert.equal(sanitizeName(undefined), '');
});

test('whitelistModel: only claude-* ids pass; injection is dropped', () => {
  assert.equal(whitelistModel('claude-opus-4-8'), 'claude-opus-4-8');
  assert.equal(whitelistModel('claude-sonnet-5'), 'claude-sonnet-5');
  assert.equal(whitelistModel('rm -rf /'), undefined);
  assert.equal(whitelistModel('gpt-4'), undefined);
  assert.equal(whitelistModel('claude-opus; whoami'), undefined);
  assert.equal(whitelistModel(''), undefined);
});

test('whitelistTier validates SHAPE, never membership — the rung list is not ours to hold', () => {
  /* AI-129. This used to be `s === 'mechanical' || s === 'judgment'` beside a local rung→model
     table, and the pair failed two different ways once the ladder grew to four rungs: `fast`,
     `scale` and `frontier` were STRIPPED here — the field gone before anything could act on
     it, worker silently on the session default — while `mechanical` and `judgment` resolved
     through the stale table to the WRONG model, which is worse because it looks like it
     worked. Membership belongs to hooks/resolve-tier and nowhere else. */
  for (const rung of ['frontier', 'judgment', 'scale', 'fast', 'mechanical']) {
    assert.equal(whitelistTier(rung), rung, `${rung} must survive parsing`);
  }
  assert.equal(whitelistTier('JUDGMENT'), 'judgment', 'case-folded');
  // a rung this build has never heard of must still reach the resolver, which adjudicates
  assert.equal(whitelistTier('some-future-rung'), 'some-future-rung');
  // shape is still enforced — this value becomes an argv entry
  for (const bad of ['', '  ', '-lead', 'has space', 'semi;colon', '$(x)', 'a'.repeat(40), '9start']) {
    assert.equal(whitelistTier(bad), undefined, `must reject ${JSON.stringify(bad)}`);
  }
});

test('no rung→model table survives anywhere in the App — one table, and it is not ours', () => {
  /* The duplication IS the defect, so the guard is an absence. Comments are stripped first:
     both files now explain the stale ids they used to carry, and a naive scan would fire on
     that prose. The two asserts under the stripper are its control — an over-eager strip would
     make every doesNotMatch below pass for the wrong reason. */
  const strip = (src: string) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  for (const f of ['src/core/commandBus.ts', 'src/main/commandBus.ts']) {
    const code = strip(fs.readFileSync(f, 'utf8'));
    assert.doesNotMatch(code, /the stale table/, `${f}: the comment stripper did not strip`);
    assert.match(code, /export function|function /, `${f}: the comment stripper ate the code`);
    assert.doesNotMatch(code, /claude-(opus|sonnet|haiku|fable)-[\d.]/,
      `${f} names a concrete model id — rung→model belongs to hooks/resolve-tier alone`);
    assert.doesNotMatch(code, /TIER_MODELS|tierToModel/, `${f} still carries a rung table`);
  }
  // and main resolves by asking that script, by name
  const main = fs.readFileSync('src/main/commandBus.ts', 'utf8');
  assert.match(main, /path\.join\(root, 'hooks', 'resolve-tier'\)/);
});

test('presence is retracted on a clean exit, and only if the record is OURS', () => {
  /* A stale surfaces/*.json outlives its process — one advertising a pid dead since
     2026-08-14 sat beside a live one for three weeks. Readers gate on a RUNNING pid, which is
     the real defence and is unchanged; this only stops the directory lying to a human.
     The ownership check is the load-bearing part: two surfaces share that directory, and a
     quitting App must not delete a record it does not own (nor one a second instance
     re-announced over ours while we ran — then the live file is the correct one to leave). */
  const main = fs.readFileSync('src/main/commandBus.ts', 'utf8');
  assert.match(main, /if \(body\.pid !== mine\) \{[\s\S]{0,160}return; \}/,
    'must not delete another surface\'s record');
  assert.match(main, /app\.on\('before-quit', retractPresence\)/);
  // and it stays packaged-only, symmetric with the announce it undoes
  const gate = main.slice(main.indexOf('function announcePresence'), main.indexOf('function retractPresence'));
  assert.ok(gate.indexOf('!app.isPackaged') < gate.indexOf("app.on('before-quit'"),
    'the retract must be registered behind the same isPackaged gate as the announce');
});

test('an unresolvable rung REFUSES the spawn — defaulting on a typo is the bug itself', () => {
  const main = fs.readFileSync('src/main/commandBus.ts', 'utf8');
  // the refusal is a dead letter, and it RETURNS — it must not fall through into the launch
  assert.match(main, /if \('error' in r\) \{ markUndelivered\(heldPath, req, r\.error\); return; \}/);
  // a missing hook is the same class as a bad rung: refuse, and say how to get it
  assert.match(main, /is missing — run \/aios:update to sync it/);
  // empty resolution is a REAL answer, kept distinct from failure
  assert.match(main, /return model \? \{ model \} : \{\};/);
  // explicit model wins, exactly as the wrapper does it
  assert.match(main, /let model = req\.model;\s*\n\s*if \(!model && req\.tier\)/);
});

test('parseRequest: spawn is the default action (back-compat {name,task})', () => {
  const r = parseRequest('{"name":"Heron Fleet","task":"do a thing"}');
  assert.ok(r);
  assert.equal(r.action, 'spawn');
  assert.equal(r.name, 'heron-fleet');
  assert.equal(r.task, 'do a thing');
});

test('parseRequest: kill + send verbs', () => {
  const k = parseRequest('{"action":"kill","name":"worker-1"}');
  assert.equal(k?.action, 'kill');
  assert.equal(k?.name, 'worker-1');
  const s = parseRequest('{"action":"send","name":"worker-1","prompt":"go"}');
  assert.equal(s?.action, 'send');
  assert.equal(s?.prompt, 'go');
});

test('parseRequest: send falls back to task when prompt absent', () => {
  const s = parseRequest('{"action":"send","name":"x","task":"nudge"}');
  assert.equal(s?.action, 'send');
  assert.equal(s?.prompt, 'nudge');
});

test('parseRequest: an unknown action is REFUSED; only an absent one means spawn', () => {
  /* CONTRACT CHANGE (AI-149). This used to degrade any unrecognised verb to 'spawn'. Adding
     `resume` made that degrade dangerous rather than forgiving: the two verbs hand back
     different things — a fresh something vs the same someone — so a typo'd `"resmue"` would
     silently spawn a duplicate of a session the caller asked to reopen. The back-compat case
     the old rule actually existed for is a request with NO action at all (contract-1
     `{name, task}`), and that is preserved exactly. */
  const r = parseRequest('{"action":"frobnicate","name":"x"}');
  assert.equal(r?.action, 'unknown');
  assert.equal(r?.rawAction, 'frobnicate', 'the dead letter quotes what was written');
  assert.equal(parseRequest('{"name":"x","task":"go"}')?.action, 'spawn', 'contract-1 still spawns');
});

test('parseRequest: bad JSON / no name / empty → null (log-and-ignore)', () => {
  assert.equal(parseRequest('{not json'), null);
  assert.equal(parseRequest('{"task":"orphan, no name"}'), null);
  assert.equal(parseRequest('{"name":"!!!"}'), null); // sanitizes to empty
  assert.equal(parseRequest('   '), null);
});

test('parseRequest: the door whitelists model ids and rung SHAPE, not rung membership', () => {
  const ok = parseRequest('{"name":"x","model":"claude-opus-4-8","tier":"mechanical"}');
  assert.equal(ok?.model, 'claude-opus-4-8');
  assert.equal(ok?.tier, 'mechanical');
  // injection is still refused at the door — both fields land in argv
  const bad = parseRequest('{"name":"x","model":"$(whoami)","tier":"$(id)"}');
  assert.equal(bad?.model, undefined);
  assert.equal(bad?.tier, undefined);
  /* CHANGED with AI-129, deliberately: an unknown-but-well-formed rung used to be dropped
     HERE (this line asserted `tier: "turbo"` → undefined). That silent strip is the defect —
     it is how `fast`, `scale` and `frontier` disappeared and the worker ran on the session
     default with nothing reported. The door no longer decides which rungs exist; it passes a
     safe token through and hooks/resolve-tier refuses an unknown one by name, listing the
     valid rungs. The refusal is asserted in "an unresolvable rung REFUSES the spawn". */
  assert.equal(parseRequest('{"name":"x","tier":"turbo"}')?.tier, 'turbo');
});

test('needsTaskFile: long or multi-line tasks go to a file (0.4.3 crash fix)', () => {
  assert.equal(needsTaskFile('short task'), false);
  assert.equal(needsTaskFile(undefined), false);
  assert.equal(needsTaskFile('line one\nline two'), true);
  assert.equal(needsTaskFile('x'.repeat(241)), true);
  assert.equal(needsTaskFile('x'.repeat(240)), false);
});

test('shq: POSIX single-quote escaping (embedded quotes safe)', () => {
  assert.equal(shq('plain'), "'plain'");
  assert.equal(shq("it's"), "'it'\\''s'");
});

test('buildSpawnCmd: bare · task · resolved model · never an empty --model · task-file', () => {
  assert.equal(buildSpawnCmd('claude', 'heron', {}), 'claude --name heron');
  assert.equal(buildSpawnCmd('claude', 'heron', { task: 'do it' }), "claude --name heron 'do it'");
  assert.equal(buildSpawnCmd('claude', 'heron', { model: 'claude-opus-4-8', task: 'x' }), "claude --model claude-opus-4-8 --name heron 'x'");
  /* `judgment` resolves to EMPTY at exit 0 — a real answer meaning "inherit the binary's
     frontier default". It must emit no flag: `--model ""` pins the empty string instead. */
  for (const empty of [undefined, '', '   ']) {
    assert.equal(buildSpawnCmd('claude', 'heron', { model: empty }), 'claude --name heron',
      `model ${JSON.stringify(empty)} must emit no --model at all`);
  }
  // task-file replaces the inline task with a read-instruction
  assert.equal(
    buildSpawnCmd('claude', 'heron', { task: 'huge...', taskFile: '/tmp/aios-spawn-task-heron.md' }),
    `claude --name heron ${shq(taskFileInstruction('/tmp/aios-spawn-task-heron.md'))}`,
  );
  // a custom claudeCmd is honored (Settings override)
  assert.ok(buildSpawnCmd('claude-fast', 'heron', {}).startsWith('claude-fast '));
});

// ── static invariant guards: the 0.4.3 robustness fixes must stay in the dispatcher ──
test('INVARIANT: kill resolves pid from the registry (reaches resumed sessions)', () => {
  const src = fs.readFileSync('src/main/commandBus.ts', 'utf8');
  assert.match(src, /listRunningAgents/, 'kill must resolve the pid from the session registry, not a pane name');
  assert.match(src, /process\.kill\(/, 'kill must signal the resolved pid');
});

test('INVARIANT: spawn hands long tasks off via a temp file, never types them', () => {
  const src = fs.readFileSync('src/main/commandBus.ts', 'utf8');
  assert.match(src, /needsTaskFile/, 'spawn must gate on needsTaskFile');
  assert.match(src, /tmpdir\(\)|writeFileSync/, 'the long task must be written to a temp file');
});

test('INVARIANT: verbs reuse existing renderer intents (no bespoke renderer code)', () => {
  const src = fs.readFileSync('src/main/commandBus.ts', 'utf8');
  for (const intent of ['terminal', 'closeByName', 'sendByName', 'focusByName']) {
    assert.match(src, new RegExp(`'${intent}'`), `bus must emit the existing '${intent}' intent`);
  }
});
