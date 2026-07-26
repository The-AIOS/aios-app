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
  tierToModel, needsTaskFile, shq, taskFileInstruction, buildSpawnCmd,
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

test('whitelistTier: only mechanical|judgment', () => {
  assert.equal(whitelistTier('mechanical'), 'mechanical');
  assert.equal(whitelistTier('JUDGMENT'), 'judgment');
  assert.equal(whitelistTier('frontier'), undefined);
  assert.equal(tierToModel('mechanical'), 'claude-sonnet-5');
  assert.equal(tierToModel('judgment'), 'claude-opus-4-8');
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

test('parseRequest: unknown action degrades to spawn', () => {
  assert.equal(parseRequest('{"action":"frobnicate","name":"x"}')?.action, 'spawn');
});

test('parseRequest: bad JSON / no name / empty → null (log-and-ignore)', () => {
  assert.equal(parseRequest('{not json'), null);
  assert.equal(parseRequest('{"task":"orphan, no name"}'), null);
  assert.equal(parseRequest('{"name":"!!!"}'), null); // sanitizes to empty
  assert.equal(parseRequest('   '), null);
});

test('parseRequest: model/tier are whitelisted at the door', () => {
  const ok = parseRequest('{"name":"x","model":"claude-opus-4-8","tier":"mechanical"}');
  assert.equal(ok?.model, 'claude-opus-4-8');
  assert.equal(ok?.tier, 'mechanical');
  const bad = parseRequest('{"name":"x","model":"$(whoami)","tier":"turbo"}');
  assert.equal(bad?.model, undefined);
  assert.equal(bad?.tier, undefined);
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

test('buildSpawnCmd: bare · task · model · tier · model-beats-tier · task-file', () => {
  assert.equal(buildSpawnCmd('claude', 'heron', {}), 'claude --name heron');
  assert.equal(buildSpawnCmd('claude', 'heron', { task: 'do it' }), "claude --name heron 'do it'");
  assert.equal(buildSpawnCmd('claude', 'heron', { model: 'claude-opus-4-8', task: 'x' }), "claude --model claude-opus-4-8 --name heron 'x'");
  assert.equal(buildSpawnCmd('claude', 'heron', { tier: 'mechanical' }), 'claude --model claude-sonnet-5 --name heron');
  // explicit model beats tier
  assert.equal(buildSpawnCmd('claude', 'heron', { model: 'claude-opus-4-8', tier: 'mechanical' }), 'claude --model claude-opus-4-8 --name heron');
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
