/**
 * Chat skin — recognising a TUI dialog from the tail of the pty output (core/tuiPrompt).
 *
 * The screens below are written by hand to match the structure the CLI prints (box borders, the ❯
 * selection cursor, numbered options, a footer hint); the strings were checked against the shipped
 * binary. The half that matters most is the NEGATIVE half: an ordinary answer is full of numbered
 * lists and sentences like "Do you want to proceed?", and flagging those sends the operator to a
 * terminal for nothing.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { detectTuiPrompt, stripAnsi, createPromptMonitor, keyChunks, KEY_DOWN, KEY_UP, type TuiPromptKind, type TuiPrompt } from '../core/tuiPrompt';

const kindOf = (s: string): TuiPromptKind | null => detectTuiPrompt(s)?.kind ?? null;

const box = (lines: string[]): string =>
  ['╭────────────────────────────────────────╮', ...lines.map((l) => `│ ${l.padEnd(38)} │`), '╰────────────────────────────────────────╯'].join('\n');

const PERMISSION = box([
  'Bash command',
  '',
  '  rm -rf build',
  '  Remove the build folder',
  '',
  'Do you want to proceed?',
  '❯ 1. Yes',
  "  2. Yes, and don't ask again for rm commands",
  '  3. No, and tell Claude what to do differently (esc)',
]);
const TRUST = [
  'Quick safety check: Is this a project you created or one you trust?',
  '',
  '❯ 1. Yes, I trust this folder',
  '  2. No, exit',
  '',
  'Enter to confirm · Esc to cancel',
].join('\n');
const MODEL = [
  'Select model',
  'Switch between Claude models. Your pick becomes the default for new sessions.',
  '',
  '❯ 1. Default (recommended) ✔',
  '  2. Other model',
  '',
  'Enter to confirm · Esc to exit',
].join('\n');
const QUESTION = [
  '← ☐ Approach  ☐ Scope  ✔ Submit →',
  '',
  'Which approach should I take?',
  '',
  '❯ 1. Small change',
  '     Touch one file',
  '  2. Larger refactor',
  '     Touch several files',
  '  3. Type something.',
  '  4. Chat about this',
  '',
  'Enter to select · ↑/↓ to navigate · Esc to cancel',
].join('\n');
const SELECT = [
  'Pick a theme',
  '',
  '  1. Dark',
  '❯ 2. Light',
  '  3. Auto',
  '',
  'Enter to select · ↑/↓ to navigate · Esc to cancel',
].join('\n');

test('each kind of dialog is recognised', () => {
  assert.equal(kindOf(PERMISSION), 'permission');
  assert.equal(kindOf(TRUST), 'trust');
  assert.equal(kindOf(MODEL), 'model');
  assert.equal(kindOf(QUESTION), 'question');
  assert.equal(kindOf(SELECT), 'select');
  assert.equal(kindOf('Update ready.\nPress Enter to continue'), 'other');
  assert.equal(kindOf('Overwrite the file? (y/n)'), 'other');
});

test('the hint is the question the TUI is asking, trimmed', () => {
  assert.equal(detectTuiPrompt(PERMISSION)?.hint, 'Do you want to proceed?');
  assert.equal(detectTuiPrompt(QUESTION)?.hint, 'Which approach should I take?');
  assert.ok((detectTuiPrompt(SELECT)?.hint ?? '').length > 0);
  assert.ok((detectTuiPrompt(PERMISSION)?.hint ?? '').length <= 160);
});

test('recognition survives colours, cursor moves and the cursor sitting on another option', () => {
  const painted = PERMISSION.split('\n').map((l) => `\x1b[2K\x1b[1G\x1b[38;5;174m${l}\x1b[39m`).join('\r\n');
  assert.equal(kindOf(painted), 'permission');
  const moved = PERMISSION.replace('❯ 1. Yes', '  1. Yes').replace('  3. No,', '❯ 3. No,');
  assert.equal(kindOf(moved), 'permission');
  // an answer streamed above the dialog does not hide it
  assert.equal(kindOf('Some earlier output\n'.repeat(60) + PERMISSION), 'permission');
});

// ── negative controls ───────────────────────────────────────────────────────

test('a normal markdown answer does not trigger anything', () => {
  const answer = [
    '⏺ Here is the plan:',
    '',
    '1. Read the config',
    '2. Change the port',
    '3. Restart the service',
    '',
    'Do you want to proceed? I can start with step 1 if you like.',
    'You can also select model options with /model, or press Enter to continue reading.',
    '',
    '> a quoted line',
    '',
    'Esc to cancel is how you stop me.',
  ].join('\n');
  assert.equal(kindOf(answer), null);
  // a numbered list AND a cursor-looking glyph in prose still lack the structure of a dialog
  assert.equal(kindOf('1. one\n2. two\n3. three\n❯ npm test\nok'), null);
  assert.equal(kindOf(''), null);
  assert.equal(kindOf('plain text with no structure'), null);
});

test('a lone prompt-looking option is not a menu, and a typed list in the input box is not either', () => {
  assert.equal(kindOf('╭──────╮\n│ ❯ 1. fix the build │\n╰──────╯\n  ? for shortcuts'), null);
  // a cursor on a numbered line with nothing the TUI prints around a dialog: refuse to guess
  assert.equal(kindOf('❯ 1. alpha\n  2. beta\n  3. gamma'), null);
});

test('a dialog that was answered and scrolled away is gone', () => {
  const after = PERMISSION + '\n' + [
    '⏺ Bash(rm -rf build)',
    '  ⎿  done',
    '',
    '⏺ The build folder is removed.',
    '',
    'I also checked the other folders and they are fine.',
    'Nothing else needs cleaning.',
    'Let me know if you want anything more.',
    '',
    '✻ Thinking… (3s)',
    '  esc to interrupt',
  ].join('\n');
  assert.equal(kindOf(after), null);
  // control: the same text WITHOUT the trailing output is still a dialog, and so is one followed
  // by the status lines the TUI itself keeps under a dialog
  assert.equal(kindOf(PERMISSION), 'permission');
  assert.equal(kindOf(PERMISSION + '\n  Esc to cancel · Tab to amend\n  ? for shortcuts'), 'permission');
});

test('an older numbered list above the dialog does not break recognition of the dialog', () => {
  const older = '1. step one\n2. step two\n3. step three\n4. step four\n';
  assert.equal(kindOf(older + PERMISSION), 'permission');
});

test('stripAnsi keeps the words and drops the sequences', () => {
  assert.equal(stripAnsi('\x1b[31mred\x1b[0m plain'), 'red plain');
  assert.equal(stripAnsi('\x1b]0;title\x07text'), 'text');
  assert.equal(stripAnsi('\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\'), 'link');
  assert.equal(stripAnsi('a\x1b[3Cb'), 'a   b', 'cursor-forward is spacing');
  assert.equal(stripAnsi('x\x1b(By\x08z'), 'xyz');
  assert.equal(stripAnsi('keep\ttabs\nand newlines'), 'keep\ttabs\nand newlines');
});

// ── the debounced monitor ───────────────────────────────────────────────────

function fakeClock() {
  let now = 0; let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    setTimer: (fn: () => void, ms: number): unknown => { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimer: (h: unknown): void => { timers.delete(h as number); },
    advance(ms: number): void {
      now += ms;
      for (const [id, t] of [...timers]) if (t.at <= now) { timers.delete(id); t.fn(); }
    },
    pending: (): number => timers.size,
  };
}

test('the monitor reports transitions only, after output settles', () => {
  const clock = fakeClock();
  const seen: Array<[TuiPromptKind | null, string | undefined]> = [];
  const m = createPromptMonitor({ onChange: (k, h) => seen.push([k, h]), debounceMs: 100, setTimer: clock.setTimer, clearTimer: clock.clearTimer });

  // a dialog painted in several small writes: nothing until the output goes quiet
  const parts = PERMISSION.split('\n');
  for (const p of parts) { m.push(p + '\r\n'); clock.advance(10); }
  assert.deepEqual(seen, []);
  clock.advance(100);
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0], 'permission');

  // a repaint of the same dialog is not a new event
  m.push(PERMISSION + '\r\n'); clock.advance(200);
  assert.equal(seen.length, 1, 'same kind twice is one event');

  // the transcript proves it was answered: null, and the stale text is not re-detected
  m.clear();
  assert.deepEqual(seen[1], [null, undefined]);
  m.push('⏺ next output\r\n'); clock.advance(200);
  assert.equal(seen.length, 2);

  // a different dialog afterwards is reported
  m.push(TRUST + '\r\n'); clock.advance(200);
  assert.equal(seen[2][0], 'trust');
});

test('the monitor reports null when output moves past the dialog, and dispose stops everything', () => {
  const clock = fakeClock();
  const seen: Array<TuiPromptKind | null> = [];
  const m = createPromptMonitor({ onChange: (k) => seen.push(k), debounceMs: 50, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  m.push(SELECT); clock.advance(60);
  assert.deepEqual(seen, ['select']);
  m.push('\n' + 'line of output\n'.repeat(20)); clock.advance(60);
  assert.deepEqual(seen, ['select', null]);

  m.push(TRUST);
  m.dispose();
  assert.equal(clock.pending(), 0, 'no timer survives dispose');
  clock.advance(500);
  m.push(PERMISSION); clock.advance(500);
  assert.deepEqual(seen, ['select', null], 'nothing is emitted after dispose');
});

test('the monitor keeps a bounded tail', () => {
  const clock = fakeClock();
  const seen: Array<TuiPromptKind | null> = [];
  const m = createPromptMonitor({ onChange: (k) => seen.push(k), debounceMs: 10, maxChars: 2000, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  // a dialog followed by far more output than the buffer holds: the dialog has been pushed out
  m.push(PERMISSION); clock.advance(20);
  assert.deepEqual(seen, ['permission']);
  m.push('filler output line\n'.repeat(400)); clock.advance(20);
  assert.deepEqual(seen, ['permission', null]);
});

// ── question and options, and the key that picks each one ───────────────────

const TRUST_UNNUMBERED = [
  'Quick safety check: Is this a project you created or one you trust?',
  '',
  '❯ No, exit',
  '  Yes, I trust this folder',
  '',
  'Enter to confirm · Esc to cancel',
].join('\n');

test('a numbered dialog carries its question and one option per row, keyed by the digit', () => {
  const v = detectTuiPrompt(PERMISSION);
  assert.equal(v?.question, 'Do you want to proceed?');
  assert.deepEqual(v?.options?.map((o) => [o.n, o.selected, o.key]), [[1, true, '1'], [2, false, '2'], [3, false, '3']]);
  assert.equal(v?.options?.[1].label, "Yes, and don't ask again for rm commands");
  // the digit does not depend on where the cursor is: move it and the keys are the same
  const moved = detectTuiPrompt(PERMISSION.replace('❯ 1. Yes', '  1. Yes').replace('  3. No,', '❯ 3. No,'));
  assert.deepEqual(moved?.options?.map((o) => [o.selected, o.key]), [[false, '1'], [false, '2'], [true, '3']]);
  // {kind, hint} is what it always was
  assert.equal(v?.kind, 'permission');
  assert.equal(v?.hint, 'Do you want to proceed?');
});

test('an AskUserQuestion keeps its free-text row flagged, and the question line is the model\'s', () => {
  const v = detectTuiPrompt(QUESTION);
  assert.equal(v?.question, 'Which approach should I take?');
  assert.equal(v?.options?.length, 4);
  assert.equal(v?.options?.[2].freeText, true, '"Type something." is an input row, not an answer');
  assert.equal(v?.options?.[0].freeText, undefined);
});

test('an unnumbered menu is keyed by arrows from the cursor, then Enter', () => {
  const v = detectTuiPrompt(TRUST_UNNUMBERED);
  assert.equal(v?.kind, 'trust');
  assert.deepEqual(v?.options?.map((o) => [o.n, o.label, o.selected, o.key]), [
    [null, 'No, exit', true, '\r'],
    [null, 'Yes, I trust this folder', false, KEY_DOWN + '\r'],
  ]);
  // with the cursor on the second row, the first is one step UP
  const v2 = detectTuiPrompt(TRUST_UNNUMBERED.replace('❯ No, exit', '  No, exit').replace('  Yes, I trust', '❯ Yes, I trust'));
  assert.deepEqual(v2?.options?.map((o) => o.key), [KEY_UP + '\r', '\r']);
  assert.deepEqual(keyChunks(KEY_DOWN + KEY_DOWN + '\r'), [KEY_DOWN, KEY_DOWN, '\r'], 'written one piece at a time');
  assert.deepEqual(keyChunks('2'), ['2']);
});

test('options are omitted, not guessed, when the rows cannot be read with confidence', () => {
  // a scrolled list: the numbering does not start at 1, so a digit would pick a different row
  const scrolled = ['Pick a theme', '', '  3. Dark', '❯ 4. Light', '  5. Auto', '', 'Enter to select · Esc to cancel'].join('\n');
  assert.equal(kindOf(scrolled), 'select');
  assert.equal(detectTuiPrompt(scrolled)?.options, undefined);
  // multi-select: a digit toggles instead of submitting
  const multi = ['Which parts?  (Select all that apply)', '', '❯ 1. Docs', '  2. Tests', '  3. Type something.', '', 'Enter to select · Esc to cancel'].join('\n');
  assert.equal(kindOf(multi), 'question');
  assert.equal(detectTuiPrompt(multi)?.options, undefined);
  // an unnumbered menu with a wrapped label: the lowercase tail looks like a third row
  const wrapped = ['Quick safety check: Is this a project you trust?', '', '❯ No, exit', '  Yes, I trust this folder and every file', '  inside it', '', 'Enter to confirm · Esc to cancel'].join('\n');
  assert.equal(kindOf(wrapped), 'trust', 'still a dialog');
  assert.equal(detectTuiPrompt(wrapped)?.options, undefined, 'but no buttons: the arrow count would be a guess');
  // control: the unwrapped one has them
  assert.equal(detectTuiPrompt(TRUST_UNNUMBERED)?.options?.length, 2);
});

// ── Yes/No offers with no numbers and no footer ─────────────────────────────

const AUTO_MODE = [
  'Make auto mode your default permission mode?',
  '',
  '  A safety check approves routine actions and blocks the rest.',
  '',
  '  ❯ Yes, set auto mode as my default permission mode',
  '    No, keep manual approval',
].join('\n');

test('a Yes/No offer with no numbers and no footer is a dialog, with its question and options', () => {
  const v = detectTuiPrompt(AUTO_MODE);
  assert.equal(v?.kind, 'select');
  assert.equal(v?.question, 'Make auto mode your default permission mode?');
  assert.deepEqual(v?.options?.map((o) => [o.label, o.selected, o.key]), [
    ['Yes, set auto mode as my default permission mode', true, '\r'],
    ['No, keep manual approval', false, KEY_DOWN + '\r'],
  ]);
  // the TUI may leave its status line under the offer
  assert.equal(kindOf(AUTO_MODE + '\n  ? for shortcuts'), 'select');
  // boxed, and coloured, the way the screen snapshot arrives
  assert.equal(kindOf(box(AUTO_MODE.split('\n')).replace(/^/gm, '\x1b[2m')), 'select');
  // other offers of the same shape
  assert.equal(kindOf(['Enter plan mode?', '', '❯ Yes', '  No'].join('\n')), 'select');
  assert.equal(kindOf(['Ready to code?', '', '  ❯ Yes, clear context and start', '    No, keep planning'].join('\n')), 'select');
  assert.equal(kindOf(['Trust this directory?', '❯ Yes, continue', '  No, exit'].join('\n')), 'select');
});

test('prose that asks the same thing, or a composer holding a Yes, is not a Yes/No dialog', () => {
  // the question in ordinary prose, with Yes/No spelled out but no cursor rows
  assert.equal(kindOf(['⏺ Make auto mode your default permission mode?', '', '  Yes, set it now', '  No, keep manual approval', '', '  I can do either.'].join('\n')), null);
  // the same rows under a question but the cursor is a prompt glyph in a list with nothing to answer: only one row
  assert.equal(kindOf(['Make auto mode your default permission mode?', '', '❯ Yes, set auto mode'].join('\n')), null);
  // the composer holding the word "Yes" (status line under it): no No row, no question
  assert.equal(kindOf(['─'.repeat(40), '❯ Yes', '─'.repeat(40), '  ? for shortcuts'].join('\n')), null);
  // a Yes/No pair and a cursor, but NO question above them: wording alone is not enough
  assert.equal(kindOf(['Some output', '', '❯ Yes, do it', '  No, skip it'].join('\n')), null);
  // a question and cursor rows, but not Yes/No-shaped and no footer: not enough to claim a dialog
  assert.equal(kindOf(['Which colour do you prefer?', '', '❯ Red', '  Blue'].join('\n')), null);
  // a dialog that was answered and then followed by output
  assert.equal(kindOf(AUTO_MODE + '\n\n⏺ Done, auto mode is on.\n\n  Nothing else to change.\n  Let me know.\n  Bye.'), null);
});

test('a normal answer with a numbered list and a question never gets options', () => {
  const answer = ['⏺ Here is what I would do:', '', '  1. Read the config', '  2. Change the port', '  3. Restart', '', '  Do you want to proceed?'].join('\n');
  assert.equal(detectTuiPrompt(answer), null);
});

// ── the monitor with the richer verdict ─────────────────────────────────────

test('the monitor emits when the dialog changes, not on a moved cursor, and hands out the whole verdict', () => {
  const clock = fakeClock();
  const seen: Array<[TuiPromptKind | null, TuiPrompt | undefined]> = [];
  const refreshed: TuiPrompt[] = [];
  const m = createPromptMonitor({ onChange: (k, _h, p) => seen.push([k, p]), onRefresh: (p) => refreshed.push(p), debounceMs: 10, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  m.screen(AUTO_MODE); clock.advance(20);
  assert.equal(seen.length, 1);
  assert.equal(seen[0][1]?.options?.length, 2);
  // the same dialog repainted: nothing
  m.screen(AUTO_MODE); clock.advance(20);
  assert.equal(seen.length, 1);
  // the cursor moved in the terminal: not a new dialog, but the keys changed, so the consumer is told
  m.screen(AUTO_MODE.replace('❯ Yes', '  Yes').replace('    No,', '  ❯ No,')); clock.advance(20);
  assert.equal(seen.length, 1, 'a moved cursor is not a new dialog');
  assert.equal(refreshed.length, 1);
  assert.deepEqual(refreshed[0].options?.map((o) => o.key), [KEY_UP + '\r', '\r']);
  // the same refresh again is not repeated
  m.screen(AUTO_MODE.replace('❯ Yes', '  Yes').replace('    No,', '  ❯ No,')); clock.advance(20);
  assert.equal(refreshed.length, 1);
  // same kind, different question/options: a NEW event even though the kind did not change
  m.screen(['Enter plan mode?', '', '❯ Yes', '  No'].join('\n')); clock.advance(20);
  assert.equal(seen.length, 2);
  assert.equal(seen[1][1]?.question, 'Enter plan mode?');
  // gone
  m.screen('⏺ ok\n'.repeat(10)); clock.advance(20);
  assert.equal(seen[2][0], null);
});
