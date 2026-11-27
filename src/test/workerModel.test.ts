/**
 * #230 — the worker's model: nothing is dropped in silence, and `judgment` starts what the
 * wrapper starts.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import {
  parseRequest, whitelistModel, modelField, tierField, MODEL_SHAPE,
  buildSpawnCmd, launcherModelArg, paneShellKind, shq,
} from '../core/commandBus';
import { resolveTierWith, type HookRun } from '../core/tierResolve';

const INJECTIONS = [
  '$(whoami)', '`id`', 'opus; rm -rf ~', 'opus && curl x', 'opus|sh', 'opus > /tmp/x', 'opus\nwhoami',
  'opus whoami', "opus'", 'opus"', '--dangerously-skip-permissions', '-p', 'opus\\', 'opus$HOME', '${IFS}',
  'opus[1m]x', '[1m]', 'opus[2m]', 'opus[1m][1m]', 'a'.repeat(65), 'opus\u0000', 'ópus', 'opus}', 'opus{', 'opus*', 'opus?',
  'opus#', 'opus!', 'opus~', 'opus(', 'opus=1', 'a/b', 'a:b', 'a,b', 'a%b', 'a@b', '.opus', '_opus',
];

test('model: the shape takes ids, aliases and [1m]; every injection attempt is outside it', () => {
  for (const ok of ['claude-opus-4-8', 'claude-opus-4-8[1m]', 'opus', 'sonnet', 'Opus', 'a', 'us.vendor.model-v1_0', 'a'.repeat(64)]) {
    assert.equal(whitelistModel(ok), ok, `${ok} is a model a surface may pass`);
  }
  for (const bad of INJECTIONS) {
    assert.equal(whitelistModel(bad), undefined, `${JSON.stringify(bad)} must not pass`);
    assert.equal(MODEL_SHAPE.test(bad), false);
  }
  /* Not a string: never coerced into one that happens to pass. */
  for (const bad of [42, true, ['opus'], { id: 'opus' }]) assert.equal(whitelistModel(bad), undefined);
});

test('model: a value the App will not pass is REFUSED by name, never dropped', () => {
  /* The defect: {"model":"opus"} was stripped at the door and the worker started on the default. */
  assert.equal(parseRequest('{"name":"x","model":"opus"}')?.model, 'opus');
  assert.equal(parseRequest('{"name":"x","model":"opus"}')?.fieldError, undefined);
  for (const bad of INJECTIONS) {
    const r = parseRequest(JSON.stringify({ name: 'x', model: bad }));
    assert.equal(r?.model, undefined);
    assert.equal(r?.fieldError?.field, 'model', `${JSON.stringify(bad)} is a dead letter that names the field`);
    assert.match(r?.fieldError?.reason ?? '', /^model '/);
    assert.doesNotMatch(r?.fieldError?.reason ?? '', /[\u0000-\u001f]/, 'the reason carries no control characters');
  }
  assert.equal(parseRequest('{"name":"x","model":42}')?.fieldError?.field, 'model');
  /* Absent is absent: no refusal for a request that never named a model. */
  for (const none of ['{"name":"x"}', '{"name":"x","model":null}', '{"name":"x","model":""}']) {
    assert.equal(parseRequest(none)?.fieldError, undefined);
  }
  assert.deepEqual(modelField(undefined), {});
  /* A resume may fall back to a spawn, so it is read there too; a send starts nothing. */
  assert.equal(parseRequest('{"action":"resume","name":"x","fallback":"spawn","model":"$(id)"}')?.fieldError?.field, 'model');
  assert.equal(parseRequest('{"action":"resume","name":"x","fallback":"spawn","model":"opus"}')?.model, 'opus');
  /* A plain resume starts nothing new: the fields mean nothing to it, and are no reason to refuse it. */
  const plain = parseRequest('{"action":"resume","name":"x","model":"$(id)","tier":"$(id)"}');
  assert.equal(plain?.fieldError, undefined);
  assert.equal(plain?.model, undefined);
  assert.equal(plain?.tier, undefined);
  assert.equal(parseRequest('{"action":"send","name":"x","prompt":"hi","model":"$(id)"}')?.fieldError, undefined);
});

test('tier: a value that is not even a rung name is refused by name; case is not a reason', () => {
  assert.equal(parseRequest('{"name":"x","tier":"Fast"}')?.tier, 'fast');
  assert.equal(parseRequest('{"name":"x","tier":" JUDGMENT "}')?.tier, 'judgment');
  for (const bad of ['$(id)', 'fast; whoami', 'fast scale', '-x', '9fast', 'a'.repeat(25)]) {
    const r = parseRequest(JSON.stringify({ name: 'x', tier: bad }));
    assert.equal(r?.tier, undefined);
    assert.equal(r?.fieldError?.field, 'tier', `${JSON.stringify(bad)} is a dead letter that names the field`);
    assert.match(r?.fieldError?.reason ?? '', /resolve-tier --list/);
  }
  assert.equal(parseRequest('{"name":"x","tier":7}')?.fieldError?.field, 'tier');
  assert.deepEqual(tierField(null), {});
});

/* A stand-in for the framework's script: `table` is the plain answer per rung, `launch` the
   --launch-model answer, absent = a framework that predates the question (exit 2, like the real one). */
function script(table: Record<string, string>, launch?: Record<string, string>): (args: string[]) => HookRun {
  const unknown = (r: string): HookRun => ({ status: 2, stdout: '', stderr: `resolve-tier: unknown rung '${r}'\nrungs: ${Object.keys(table).join(' ')}` });
  return (args) => {
    if (args[0] === '--launch-model') {
      if (!launch) return unknown('--launch-model');
      return args[1] in launch ? { status: 0, stdout: launch[args[1]] + '\n', stderr: '' } : unknown(args[1]);
    }
    return args[0] in table ? { status: 0, stdout: table[args[0]] ? table[args[0]] + '\n' : '', stderr: '' } : unknown(args[0]);
  };
}
const TABLE = { top: 'model-top', middle: '', low: 'model-low' };

test('tier: a rung with a model resolves to it, and the second question is never asked', () => {
  const asked: string[][] = [];
  const run = script(TABLE, { middle: 'model-pinned[1m]' });
  assert.deepEqual(resolveTierWith('low', (a) => { asked.push(a); return run(a); }), { model: 'model-low' });
  assert.deepEqual(asked, [['low']]);
});

test('tier: a rung that answers EMPTY starts what the launcher starts, and says $CLAUDE_MODEL wins', () => {
  /* The defect: the App read the empty answer as "no --model" and the worker inherited the saved model. */
  assert.deepEqual(resolveTierWith('middle', script(TABLE, { top: 'model-top', middle: 'model-pinned[1m]', low: 'model-low' })),
    { model: 'model-pinned[1m]', launcherDefault: true });
});

test('tier: a framework without --launch-model behaves as before, and the log says why', () => {
  const r = resolveTierWith('middle', script(TABLE));
  assert.ok(!('error' in r));
  assert.equal(r.model, undefined);
  assert.equal(r.launcherDefault, undefined);
  assert.match(r.note ?? '', /--launch-model/);
});

test('tier: an unknown rung is refused with the script\'s own list; an odd answer is refused too', () => {
  const r = resolveTierWith('turbo', script(TABLE, { middle: 'x' }));
  assert.ok('error' in r);
  assert.match(r.error, /unknown rung 'turbo'/);
  assert.match(r.error, /top middle low/);
  for (const odd of ['$(whoami)', 'two words', '--flag']) {
    const a = resolveTierWith('middle', script(TABLE, { middle: odd }));
    assert.ok('error' in a, `--launch-model answering ${odd} is never typed into a shell`);
    const b = resolveTierWith('low', script({ ...TABLE, low: odd }));
    assert.ok('error' in b, `a plain answer of ${odd} is never typed into a shell`);
  }
});

test('command: the launcher\'s default is written for the pane\'s shell to decide', () => {
  assert.equal(paneShellKind('darwin', '/bin/zsh'), 'posix');
  assert.equal(paneShellKind('linux', '/usr/bin/bash'), 'posix');
  assert.equal(paneShellKind('linux', undefined), 'posix');
  assert.equal(paneShellKind('linux', '/usr/bin/fish'), 'other');
  assert.equal(paneShellKind('win32', '/usr/bin/bash'), 'powershell', 'the pane is PowerShell on Windows whatever $SHELL says');
  assert.equal(launcherModelArg('model-pinned[1m]', 'posix'), '"${CLAUDE_MODEL:-model-pinned[1m]}"');
  assert.equal(launcherModelArg('model-pinned[1m]', 'powershell'), "$(if ($env:CLAUDE_MODEL) { $env:CLAUDE_MODEL } else { 'model-pinned[1m]' })");
  assert.equal(launcherModelArg('model-pinned[1m]', 'other'), "'model-pinned[1m]'");
  assert.throws(() => launcherModelArg('x"; rm -rf ~; "', 'posix'), /not a model id/);
  assert.equal(
    buildSpawnCmd('claude', 'heron', { model: 'model-pinned[1m]', envModelWins: 'posix', task: 'x' }),
    `claude --model "\${CLAUDE_MODEL:-model-pinned[1m]}" --name heron 'x'`);
  /* An explicit model is the caller's pin: $CLAUDE_MODEL does not override it, and [ is quoted (a glob to zsh). */
  assert.equal(buildSpawnCmd('claude', 'heron', { model: 'model-pinned[1m]' }), `claude --model ${shq('model-pinned[1m]')} --name heron`);
  assert.equal(buildSpawnCmd('claude', 'heron', { model: 'opus' }), 'claude --model opus --name heron');
});

test('command: real shells expand it the way the wrapper does, and run nothing a value carries', { skip: process.platform === 'win32' }, (t) => {
  const { execFileSync } = require('child_process') as typeof import('child_process');
  const arg = launcherModelArg('model-pinned[1m]', 'posix');
  let ran = 0;
  for (const sh of ['/bin/sh', '/bin/bash', '/bin/zsh']) {
    if (!fs.existsSync(sh)) continue;
    ran++;
    const out = (env: NodeJS.ProcessEnv) => execFileSync(sh, ['-c', `printf %s ${arg}`], { encoding: 'utf8', env });
    assert.equal(out({ PATH: process.env.PATH }), 'model-pinned[1m]', sh);
    assert.equal(out({ PATH: process.env.PATH, CLAUDE_MODEL: '' }), 'model-pinned[1m]', `${sh}: set but empty falls back, as in the wrapper`);
    assert.equal(out({ PATH: process.env.PATH, CLAUDE_MODEL: 'mine' }), 'mine', sh);
    assert.equal(out({ PATH: process.env.PATH, CLAUDE_MODEL: 'a b;$(echo PWN)*' }), 'a b;$(echo PWN)*', `${sh}: the operator's value is one word, never run or globbed`);
    /* An explicit model with [1m] is one literal word too (bare, zsh reads [ as a glob). */
    assert.equal(execFileSync(sh, ['-c', `printf %s ${buildSpawnCmd('echo', 'n', { model: 'model-pinned[1m]' }).split(' ')[2]}`], { encoding: 'utf8' }), 'model-pinned[1m]', sh);
  }
  if (!ran) t.skip('no POSIX shell at the usual paths');
});

test('wiring: main asks both questions through the core, and holds no model id', () => {
  const main = fs.readFileSync('src/main/commandBus.ts', 'utf8');
  assert.match(main, /resolveTierWith\(tier, \(args\) =>/);
  assert.match(main, /execFileSync\(bash, \[hook, \.\.\.args\]/);
  assert.match(main, /envModelWins = paneShellKind\(process\.platform, process\.env\.SHELL\)/);
  assert.match(main, /buildSpawnCmd\([^;]*\bmodel, envModelWins, taskFile\b/, 'and the launch command is built with it: without the hand-off $CLAUDE_MODEL is never read');
  const core = fs.readFileSync('src/core/tierResolve.ts', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(core, /run\(\['--launch-model', tier\]\)/);
  assert.doesNotMatch(core, /claude-(opus|sonnet|haiku|fable)/, 'the id comes from the framework, never from here');
});
