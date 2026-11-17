/**
 * #182: a bus-started session that stops on Claude Code's folder-trust question must be noticed.
 * The rule is run here; the wiring (main's watch, the bus dead letter) is checked by reading the
 * source, because the failure was silence and only the wiring breaks it.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { isTrustPrompt, watchesForTrust, trustBlockedReason, plainForTrust, trustSessionStarted } from '../core/trustPrompt';

test('the added-directory question is recognised, however the terminal wraps it', () => {
  const screen = 'Adding a new directory: /Users/x/.aios/run/handoff-ab12\n\n  Is this a directory you\n   created or one you trust?\n\n ❯ 1. Yes\n   2. No';
  assert.equal(isTrustPrompt(screen), true);
});

test('the working-folder question is recognised too', () => {
  assert.equal(isTrustPrompt('Do you trust the files in this folder?\n ❯ 1. Yes, proceed\n   2. No, exit'), true);
  assert.equal(isTrustPrompt('❯ 1. Yes, I trust this folder\n  2. No, exit'), true);
});

test('the shell echoing an inline task that mentions the question is not the question (review of #182)', () => {
  const echo = "claude --add-dir '/x/.aios/run/handoff-1' --name w 'Check why the App says: do you trust the files in this folder?'";
  assert.equal(isTrustPrompt(echo), false);
});

test('ordinary session output is not the question', () => {
  for (const s of ['Welcome to Claude Code', 'I trust you will like this folder layout.', 'Read /Users/x/.aios/run/handoff-1/task.md', '']) {
    assert.equal(isTrustPrompt(s), false, s);
  }
});

test('only tabs started with --add-dir are watched', () => {
  assert.equal(watchesForTrust("claude --add-dir '/Users/x/.aios/run/handoff-1' --name w 'Read …'"), true);
  assert.equal(watchesForTrust('claude --add-dir=/tmp/x --name w'), true);
  assert.equal(watchesForTrust("claude --name w 'Start session'"), false);
  assert.equal(watchesForTrust("claude --name w 'mention --add-dirs in prose'"), false);
  assert.equal(watchesForTrust(undefined), false);
});

test('the reason names the session, what to do now, and the one-time fix', () => {
  const r = trustBlockedReason('accountant-q1');
  assert.match(r, /'accountant-q1'/);
  assert.match(r, /has not started/);
  assert.match(r, /cd ~\/\.aios\/run && claude/);
});

test('the question drawn with cursor moves instead of spaces is still recognised', () => {
  const raw = '\x1b[2J\x1b[1;1HIs\x1b[1Cthis\x1b[1Ca\x1b[1Cdirectory\x1b[1Cyou\x1b[2;3Hcreated\x1b[1Cor\x1b[1Cone\x1b[1Cyou\x1b[1Ctrust?\x1b]0;claude\x07\x1b[4;1H\x1b[36m❯\x1b[39m\x1b[1C1.\x1b[1CYes\x1b[5;3H2.\x1b[1CNo';
  assert.equal(isTrustPrompt(plainForTrust(raw)), true);
  assert.equal(isTrustPrompt(raw), false, 'negative control: without stripping, the escapes hide the words');
});

test('wiring: main watches a bus tab started with --add-dir and leaves a dead letter, never an answer', () => {
  const main = fs.readFileSync('src/main/main.ts', 'utf8');
  const bus = fs.readFileSync('src/main/commandBus.ts', 'utf8');
  assert.match(main, /opts\.bus === true && watchesForTrust\(opts\.cmd\)/, 'only tabs the bus opened are watched (review of #182)');
  assert.match(main, /clearTrustLetterWhenLive\(String\(opts\.name\), spawnedAt\)/, 'the dead letter is removed once the session starts');
  assert.match(main, /const live = trustSessionStarted\(aios\.listRunningAgents\(\), name, spawnedAt,/, 'cleared through the tested rule');
  assert.match(bus, /export function clearTrustBlocked/);
  assert.equal((bus.match(/'terminal', \{ name: req\.name, cmd, background: true, \.\.\.where, group: req\.group, bus: true \}/g) || []).length, 2, 'spawn and resume mark their tabs');
  assert.match(main, /isTrustPrompt\(plainForTrust\(/, 'the stream is stripped before matching');
  assert.match(main, /reportTrustBlocked\(/, 'a match is reported to the bus');
  assert.match(bus, /export function reportTrustBlocked/, 'the bus owns the dead letter');
  assert.match(bus, /trustBlockedReason\(/, 'the dead letter carries the reason');
  const watchBlock = main.slice(main.indexOf('const trustWatch'), main.indexOf('reportTrustBlocked(String'));
  assert.ok(watchBlock.length > 100, 'the watch block was found');
  assert.equal(/\.write\(/.test(watchBlock), false, 'the App must never answer the trust question itself');
});

test('third review of #182: the letter clears only for the session that tab started, once it has really started', () => {
  const T = 1_800_000_000_000;
  const row = (name: string, startedAt: number, sessionId: string) => ({ name, startedAt, sessionId });
  const mt = (m: Record<string, number>) => (sid: string) => m[sid];
  assert.equal(trustSessionStarted([row('w', T + 1000, 's1')], 'w', T, mt({ s1: T + 9000 })), true, 'started after the tab, transcript written since');
  assert.equal(trustSessionStarted([row('w', T + 1000, 's1')], 'w', T, mt({})), false, 'no transcript yet: still on the question');
  assert.equal(trustSessionStarted([row('w', T - 3_600_000, 's0')], 'w', T, mt({ s0: T + 9000 })), false, 'another, older session of that name');
  assert.equal(trustSessionStarted([row('w', T + 1000, 's2')], 'w', T, mt({ s2: T - 86_400_000 })), false, 'a resumed session whose old transcript has not grown');
  assert.equal(trustSessionStarted([row('x', T + 1000, 's3')], 'w', T, mt({ s3: T + 9000 })), false, 'a different name');
  assert.equal(trustSessionStarted([row('w', T, 's4')], 'w', T, mt({ s4: T })), true, 'on the boundary: written the moment the tab opened counts (a >= turned > fails here)');
});
