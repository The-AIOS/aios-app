/**
 * termEnv invariant (Glass parity — runner.ts). Every terminal the app launches
 * routes through the single pty:spawn chokepoint, whose env MUST clear the
 * inherited CLAUDE_CODE_CHILD_SESSION marker (left set, it turns OFF transcript
 * saving + the session registry → sessions come up invisible + non-resumable:
 * "Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker") and
 * force session persistence. Static assertion so a refactor can't silently
 * regress it (main.ts imports electron, so we assert against the source).
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';

test('INVARIANT: termEnv clears CLAUDE_CODE_CHILD_SESSION + forces session persistence', () => {
  const src = fs.readFileSync('src/main/main.ts', 'utf8');
  assert.match(src, /function termEnv\(/, 'a termEnv() chokepoint must exist');
  assert.match(src, /delete env\.CLAUDE_CODE_CHILD_SESSION/, 'must CLEAR the inherited child-session marker');
  assert.match(src, /CLAUDE_CODE_FORCE_SESSION_PERSIST\s*=\s*'1'/, 'must FORCE session persistence');
  assert.match(src, /env:\s*termEnv\(opts\.cmd\)/, 'pty:spawn must use termEnv(opts.cmd), not raw process.env');
});

test('INVARIANT: termEnv sets CLAUDE_AGENT_NAME so the session ritual runs', () => {
  // The `spawn` wrapper exports CLAUDE_AGENT_NAME; without it a launched session has
  // no identity and skips CLAUDE.md's Session Start Ritual (agent match + context).
  const src = fs.readFileSync('src/main/main.ts', 'utf8');
  assert.match(src, /env\.CLAUDE_AGENT_NAME\s*=/, 'must set CLAUDE_AGENT_NAME for named sessions');
  assert.match(src, /--name/, 'must derive the name from the command so every launch path is covered');
});

test('INVARIANT: a session launched with no task still gets a ritual bootstrap prompt', () => {
  // A bare `claude --name X` sits idle and never runs the ritual; the wrapper always
  // passes a bootstrap. Renderer + command bus must both supply one.
  const app = fs.readFileSync('renderer/app.js', 'utf8');
  assert.match(app, /RITUAL_BOOTSTRAP/, 'renderer must pass a bootstrap prompt when no task is given');
  const bus = fs.readFileSync('src/main/commandBus.ts', 'utf8');
  assert.match(bus, /req\.task \|\| 'Start session'/, 'the bus must bootstrap a task-less spawn');
});
