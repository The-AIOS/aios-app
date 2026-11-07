/**
 * A question taller than the screen (0.15.0 hand test): an AskUserQuestion whose question and described options do not
 * fit, so the question, the chips, option 1 and the cursor have scrolled off the top. The screen alone cannot be read
 * (core/tuiPrompt), and the chat fell back to the raw terminal. The transcript holds the whole call: the pending
 * tool_use carries every question and option, and `detectWithAsk` builds the card from it when exactly one question
 * matches every numbered row still on screen.
 *
 * Every group carries a NEGATIVE CONTROL: the same input with the one property that should make a difference removed.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { detectTuiPrompt, detectWithAsk, askQuestionsOf, createPromptMonitor, type AskQuestion, type TuiPrompt } from '../core/tuiPrompt';
import { createTranscriptTracker } from '../core/transcriptChat';

const OPTIONS = [
  { label: 'Push the release', description: 'Finish the hand test, merge and tag tonight, so the update reaches everyone over the weekend.' },
  { label: 'Write the essay', description: 'Spend the evening on the draft that has been waiting, while the week is still fresh.' },
  { label: 'Explore something new', description: 'Try out a tool, read an essay, or prototype an idea that isn\'t on any roadmap. It costs nothing and might spark a new direction, but it adds no progress to current commitments.' },
  { label: 'Log off completely', description: 'Close the laptop and do nothing work-related until Monday. You recover fully and come back sharper, and anything open simply carries over, which is fine.' },
];
const QUESTION = 'It is Friday evening and the week has been long. What would you like to do with the rest of tonight, given everything that is still open?';
const ASK: AskQuestion[] = askQuestionsOf({ questions: [{ question: QUESTION, header: 'Tonight', multiSelect: false, options: OPTIONS }] })!;

/** What the terminal shows once the dialog is taller than the pane: the tail of option 3's description, then 4-6 and the footer. */
const SCROLLED = [
  '     Try out a tool, read an essay, or prototype an idea that isn\'t on any roadmap. It costs nothing',
  '     and might spark a new direction, but it adds no progress to current commitments.',
  '  4. Log off completely',
  '     Close the laptop and do nothing work-related until Monday. You recover fully and come back',
  '     sharper, and anything open simply carries over, which is fine.',
  '  5. Type something.',
  '─'.repeat(70),
  '  6. Chat about this',
  '',
  'Enter to select · ↑/↓ to navigate · Esc to cancel',
].join('\n');

/** The same dialog when it fits: the screen alone reads it (the PR 130 path). */
const WHOLE = [
  '☐ Tonight',
  '',
  QUESTION,
  '',
  '❯ 1. Push the release',
  '     Finish the hand test, merge and tag tonight.',
  '  2. Write the essay',
  '     Spend the evening on the draft.',
  '  3. Explore something new',
  '     Try out a tool.',
  '  4. Log off completely',
  '     Close the laptop.',
  '  5. Type something.',
  '─'.repeat(70),
  '  6. Chat about this',
  '',
  'Enter to select · ↑/↓ to navigate · Esc to cancel',
].join('\n');

test('the screen alone cannot read a question taller than the pane: this is the case being fixed', () => {
  const r = detectTuiPrompt(SCROLLED);
  assert.ok(!r || r.kind !== 'question' || !r.options, `no question card from the screen alone (got ${JSON.stringify(r)})`);
});

test('the transcript turns it into the whole card: the full question, every option with its description, the digits to press', () => {
  const r = detectWithAsk(SCROLLED, ASK) as TuiPrompt;
  assert.equal(r.kind, 'question');
  assert.equal(r.question, QUESTION);
  assert.equal(r.header, 'Tonight');
  assert.deepEqual(r.options!.map((o) => [o.n, o.label, o.key]), [
    [1, 'Push the release', '1'], [2, 'Write the essay', '2'], [3, 'Explore something new', '3'],
    [4, 'Log off completely', '4'], [5, 'Type something.', '5'], [6, 'Chat about this', '6'],
  ]);
  assert.deepEqual(r.options!.slice(0, 4).map((o) => o.desc), OPTIONS.map((o) => o.description), 'each option keeps its description');
  assert.equal(r.options![4].freeText, true, 'Type something opens the input, as on the screen card');
  assert.equal(r.options!.some((o) => o.selected), false, 'the cursor is off screen, so nothing is marked as selected');
  // negative control: with no pending question the result is exactly the screen's
  assert.deepEqual(detectWithAsk(SCROLLED, null), detectTuiPrompt(SCROLLED));
  assert.deepEqual(detectWithAsk(SCROLLED, []), detectTuiPrompt(SCROLLED));
});

test('never a question the dialog is not asking: one visible row that does not match, and it falls back to the screen', () => {
  const other = askQuestionsOf({ questions: [{ question: QUESTION, multiSelect: false, options: [...OPTIONS.slice(0, 3), { label: 'Go for a walk' }] }] })!;
  assert.deepEqual(detectWithAsk(SCROLLED, other), detectTuiPrompt(SCROLLED), 'option 4 on screen is not the transcript\'s option 4');
  const five = askQuestionsOf({ questions: [{ question: QUESTION, multiSelect: false, options: [...OPTIONS, { label: 'A fifth' }] }] })!;
  assert.deepEqual(detectWithAsk(SCROLLED, five), detectTuiPrompt(SCROLLED), 'with five options, row 5 would be an option, not Type something');
});

test('several questions in one call: the one whose options are on screen; two that both fit is not trusted', () => {
  const plan = { question: 'Which plan?', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] };
  const r = detectWithAsk(SCROLLED, askQuestionsOf({ questions: [plan, { question: QUESTION, header: 'Tonight', multiSelect: false, options: OPTIONS }] }));
  assert.equal(r?.question, QUESTION, 'the second question is the one being asked');
  const twin = askQuestionsOf({ questions: [{ question: QUESTION, multiSelect: false, options: OPTIONS }, { question: 'Same options, other question?', multiSelect: false, options: OPTIONS }] });
  assert.deepEqual(detectWithAsk(SCROLLED, twin), detectTuiPrompt(SCROLLED), 'ambiguous: the screen fallback, never a guess');
});

test('a dialog the screen reads whole keeps the screen\'s card; multi-select and a missing footer stay as before', () => {
  const screen = detectTuiPrompt(WHOLE);
  assert.equal(screen?.kind, 'question');
  assert.ok(screen?.options?.length, 'control: the screen reads the whole dialog');
  assert.deepEqual(detectWithAsk(WHOLE, ASK), screen, 'PR 130\'s path is untouched');
  const multi = askQuestionsOf({ questions: [{ question: QUESTION, multiSelect: true, options: OPTIONS }] });
  const m = detectWithAsk(SCROLLED, multi);
  assert.equal(m?.question, QUESTION, 'the question is shown');
  assert.equal(m?.options, undefined, 'but checkboxes are answered in the terminal, as for the screen card');
  const noFooter = SCROLLED.split('\n').slice(0, -2).join('\n');
  assert.deepEqual(detectWithAsk(noFooter, ASK), detectTuiPrompt(noFooter), 'no footer: not a dialog the TUI is showing');
});

test('the transcript carries the questions on the AskUserQuestion item, and its result closes it', () => {
  const t = createTranscriptTracker();
  const j = (o: unknown): string => JSON.stringify(o);
  const a = t.feed(j({ type: 'assistant', uuid: 'u1', timestamp: '2026-01-01T10:00:00Z', message: { id: 'm1', role: 'assistant', stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'tq', name: 'AskUserQuestion', input: { questions: [{ question: QUESTION, header: 'Tonight', multiSelect: false, options: OPTIONS }] } }] } }));
  const item = a.items.find((i) => i.tool?.id === 'tq');
  assert.equal(item?.tool?.status, 'running');
  assert.deepEqual(item?.tool?.ask, ASK, 'the whole call, bounded');
  const b = t.feed(j({ type: 'user', uuid: 'u2', timestamp: '2026-01-01T10:00:05Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tq', content: 'User answered' }] } }));
  assert.equal(b.items.find((i) => i.tool?.id === 'tq')?.tool?.status, 'ok', 'answered: main drops it as pending');
  // negative control: another tool, or a malformed input, carries nothing
  const c = t.feed(j({ type: 'assistant', uuid: 'u3', timestamp: '2026-01-01T10:00:06Z', message: { id: 'm2', role: 'assistant', stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'tb', name: 'Bash', input: { command: 'ls', questions: [] } }] } }));
  assert.equal(c.items.find((i) => i.tool?.id === 'tb')?.tool?.ask, undefined);
  assert.equal(askQuestionsOf({ questions: [{ question: 'x', options: [] }] }), undefined, 'no options is not a question');
  assert.equal(askQuestionsOf({ questions: 'nope' }), undefined);
});

test('main keeps the pending question per pane and hands the monitor the transcript-aware detector', () => {
  const main = fs.readFileSync('src/main/main.ts', 'utf8');
  assert.match(main, /detect: \(text\) => detectWithAsk\(text, holder\.k\?\.pendingAsk\?\.ask\)/);
  assert.match(main, /if \(t\.status === 'running' && t\.ask\) skin\.pendingAsk = \{ id: t\.id, ask: t\.ask \};\s*else if \(skin\.pendingAsk\?\.id === t\.id\) skin\.pendingAsk = null;/, 'its result ends it');
  assert.match(main, /\} else if \(ev\.type === 'reset'\) skin\.pendingAsk = null;/);
  assert.match(main, /k\.pendingAsk = null;\s*\/\/ and its open question belongs to the old one/, 'a new transcript starts with none');
});

test('the monitor runs the detector it is given', () => {
  const seen: Array<string | null> = [];
  let fire: (() => void) | undefined;
  const m = createPromptMonitor({
    detect: (text) => (text.includes('ASK') ? { kind: 'question', hint: 'from the transcript', question: 'q?' } : null),
    onChange: (kind, hint) => seen.push(kind ? `${kind}:${hint}` : null),
    setTimer: (fn) => { fire = fn; return 1; }, clearTimer: () => { fire = undefined; },
  });
  m.screen('ASK'); fire?.();
  assert.deepEqual(seen, ['question:from the transcript']);
  // control: without `detect`, the same text is not a dialog
  const plain: Array<string | null> = [];
  let f2: (() => void) | undefined;
  const m2 = createPromptMonitor({ onChange: (kind) => plain.push(kind), setTimer: (fn) => { f2 = fn; return 1; }, clearTimer: () => { f2 = undefined; } });
  m2.screen('ASK'); f2?.();
  assert.deepEqual(plain, []);
});
