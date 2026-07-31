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
  assert.match(src, /env:\s*termEnv\(opts\.cmd,\s*opts\.name\)/, 'pty:spawn must route env through termEnv and pass the name EXPLICITLY — deriving it from the command string is what let resume ship unnamed');
});

test('INVARIANT: termEnv sets CLAUDE_AGENT_NAME so the session ritual runs', () => {
  // The `spawn` wrapper exports CLAUDE_AGENT_NAME; without it a launched session has
  // no identity and skips CLAUDE.md's Session Start Ritual (agent match + context).
  const src = fs.readFileSync('src/main/main.ts', 'utf8');
  assert.match(src, /env\.CLAUDE_AGENT_NAME\s*=/, 'must set CLAUDE_AGENT_NAME for named sessions');
  assert.match(src, /--name/, 'the command-embedded fallback must remain for callers that spell --name themselves');
  // AI-64: the name is a PARAMETER now. Regex-over-the-command was the whole bug — a path
  // that never spells --name (every resume) came up unnamed with nothing reporting it.
  assert.match(src, /function termEnv\(cmd\?: string, name\?: string\)/, 'termEnv must accept the name explicitly, not only recover it from the command');
  assert.match(src, /const explicit = \(name \|\| ''\)/, 'the explicit name must take precedence over the command-derived fallback');
});

test('INVARIANT: every renderer pane passes its name to ptySpawn', () => {
  // The pane already knew its name for the tab; it just never reached the pty env.
  const app = fs.readFileSync('renderer/app.js', 'utf8');
  assert.match(app, /ptySpawn\(\{[^}]*name[^}]*\}\)/, 'createPane must forward `name` to ptySpawn');
});

test('INVARIANT: a session launched with no task still gets a ritual bootstrap prompt', () => {
  // A bare `claude --name X` sits idle and never runs the ritual; the wrapper always
  // passes a bootstrap. Renderer + command bus must both supply one.
  const app = fs.readFileSync('renderer/app.js', 'utf8');
  assert.match(app, /RITUAL_BOOTSTRAP/, 'renderer must pass a bootstrap prompt when no task is given');
  const bus = fs.readFileSync('src/main/commandBus.ts', 'utf8');
  assert.match(bus, /req\.task \|\| 'Start session'/, 'the bus must bootstrap a task-less spawn');
});

test('INVARIANT: paste is never hand-rolled — one write, bracketed', () => {
  // A custom Cmd+V handler pasted twice: returning false from attachCustomKeyEventHandler
  // stops xterm's KEY handling but not the native `paste` event it also listens for. It also
  // bypassed bracketed paste, so multi-line pastes submitted line by line.
  const app = fs.readFileSync('renderer/app.js', 'utf8');
  assert.doesNotMatch(app, /k === 'v'\s*\)\s*\{[^}]*ptyWrite/, 'Cmd+V must not write the clipboard itself');
  assert.match(app, /k === 'c'/, "Cmd+C must stay — xterm has no native copy for a terminal selection");
});

/* Every launch site is BUILT, never concatenated (2026-07-31).
   --remote-control went missing from the app for the same structural reason --name once did:
   six places each spelled their own `claude …` string, so a flag added to one reached none of
   the others. The main process routes through buildSpawnCmd; the renderer cannot import it
   (app.js is a plain <script>, no bundler), so it has claudeLaunchCmd as its half of the same
   chokepoint. These assertions exist so the next flag has one place to be added. */
test('INVARIANT: the renderer builds every Claude launch in one place', () => {
  const app = fs.readFileSync('renderer/app.js', 'utf8');
  assert.match(app, /function claudeLaunchCmd\(name, task\)/, 'the renderer chokepoint must exist');
  assert.doesNotMatch(
    app, /CLAUDE \+ ' --name '/,
    'no pane may concatenate its own launch command — that duplication is what lost --remote-control',
  );
  assert.match(app, /if \(REMOTE\) parts\.push\('--remote-control'\)/, 'the renderer must pass the flag when Remote Control is on');
});

test('INVARIANT: the main process builds its launches too, and sources the flag from Claude config', () => {
  const panel = fs.readFileSync('src/main/panelHost.ts', 'utf8');
  assert.match(panel, /buildSpawnCmd\(/, 'panelHost must build, not concatenate');
  assert.doesNotMatch(panel, /claudeCmd\} --name/, 'no template-literal launch commands');
  // One toggle, not two: Settings already exposes Claude's own remoteControlAtStartup, so the
  // flag must follow THAT value rather than introduce a second competing switch.
  assert.match(panel, /aios\.claudeConfig\(\)\.remoteControl/, 'the flag must follow the existing Remote control toggle');
  const bus = fs.readFileSync('src/main/commandBus.ts', 'utf8');
  assert.match(bus, /remoteControl: aios\.claudeConfig\(\)\.remoteControl/, 'the bus spawn must follow it as well');
});
