/**
 * #182: a bus-started session that stops on Claude Code's folder-trust question must be noticed.
 * The rule is run here; the wiring (main's watch, the bus dead letter) is checked by reading the
 * source, because the failure was silence and only the wiring breaks it.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { isTrustPrompt, watchesForTrust, trustBlockedReason, plainForTrust } from '../core/trustPrompt';

test('the added-directory question is recognised, however the terminal wraps it', () => {
  const screen = 'Adding a new directory: /Users/x/.aios/run/handoff-ab12\n\n  Is this a directory you\n   created or one you trust?\n\n ❯ 1. Yes\n   2. No';
  assert.equal(isTrustPrompt(screen), true);
});

test('the working-folder question is recognised too', () => {
  assert.equal(isTrustPrompt('Do you trust the files in this folder?'), true);
  assert.equal(isTrustPrompt('❯ 1. Yes, I trust this folder'), true);
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
  const raw = '\x1b[2J\x1b[1;1HIs\x1b[1Cthis\x1b[1Ca\x1b[1Cdirectory\x1b[1Cyou\x1b[2;3Hcreated\x1b[1Cor\x1b[1Cone\x1b[1Cyou\x1b[1Ctrust?\x1b]0;claude\x07';
  assert.equal(isTrustPrompt(plainForTrust(raw)), true);
  assert.equal(isTrustPrompt(raw), false, 'negative control: without stripping, the escapes hide the words');
});

test('wiring: main watches a bus tab started with --add-dir and leaves a dead letter, never an answer', () => {
  const main = fs.readFileSync('src/main/main.ts', 'utf8');
  const bus = fs.readFileSync('src/main/commandBus.ts', 'utf8');
  assert.match(main, /watchesForTrust\(opts\.cmd\)/, 'pty:spawn decides to watch from the command');
  assert.match(main, /isTrustPrompt\(plainForTrust\(/, 'the stream is stripped before matching');
  assert.match(main, /reportTrustBlocked\(/, 'a match is reported to the bus');
  assert.match(bus, /export function reportTrustBlocked/, 'the bus owns the dead letter');
  assert.match(bus, /trustBlockedReason\(/, 'the dead letter carries the reason');
  const watchBlock = main.slice(main.indexOf('const trustWatch'), main.indexOf('reportTrustBlocked(String'));
  assert.ok(watchBlock.length > 100, 'the watch block was found');
  assert.equal(/\.write\(/.test(watchBlock), false, 'the App must never answer the trust question itself');
});
