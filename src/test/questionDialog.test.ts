/**
 * A question dialog in the chat view is read from the SCREEN only.
 *
 * MEASURED (0.15.0 round 4, Claude Code 2.1.31x): an AskUserQuestion's tool_use reaches the transcript only when the
 * question is ANSWERED (a pending question was in no transcript minutes after it appeared), so a card cannot be built
 * from the transcript while the dialog is open. And on macOS a session runs in the alternate screen (it sends
 * `ESC[?1049h` at start), which keeps no scrollback: rows of a dialog taller than the pane are gone, not scrolled. The
 * transcript-question path (askQuestionsOf / detectWithAsk / pending-question tracking / recheck) could never fire and
 * was removed; these tests keep it removed and keep the clear rule's order.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as tui from '../core/tuiPrompt';
import { answeredBy } from '../core/tuiPrompt';

test('the transcript-question path is gone: the monitor runs the screen detector, main keeps no pending question', () => {
  const t = tui as unknown as Record<string, unknown>;
  for (const k of ['detectWithAsk', 'askQuestionsOf']) assert.equal(t[k], undefined, `${k} removed`);
  const main = fs.readFileSync('src/main/main.ts', 'utf8');
  assert.doesNotMatch(main, /pendingAsk|detectWithAsk|monitor\.recheck/);
  assert.match(main, /if \(ev\.type === 'items' && answeredBy\(ev\.items\)\) skin\.monitor\.clear\(\);/);
  const core = fs.readFileSync('src/core/tuiPrompt.ts', 'utf8');
  assert.match(core, /emit\(detectTuiPrompt\(buf\)\);/, 'the screen detector, nothing injected');
  assert.doesNotMatch(fs.readFileSync('src/core/transcriptChat.ts', 'utf8'), /askQuestionsOf|ask\?: /);
});

test('a batch answers the open dialog by order: a message or a finished tool, unless a running question comes after it', () => {
  const user = { role: 'user' };
  const ask = { role: 'tool', tool: { name: 'AskUserQuestion', status: 'running' } };
  const done = { role: 'tool', tool: { name: 'Bash', status: 'done' } };
  assert.equal(answeredBy([user]), true);
  assert.equal(answeredBy([done]), true);
  assert.equal(answeredBy([{ role: 'assistant' }]), false);
  assert.equal(answeredBy([user, ask]), false);
  assert.equal(answeredBy([ask, user]), true);
});
