/**
 * Chat skin — the assistant reply that is being written, read off the TUI screen (core/screenStream).
 *
 * Every screen below is written by hand to match the STRUCTURE the CLI paints (the `⏺` bullet and its
 * two-column gutter, `⎿` tool results, a spinner line, the input box, footer hints); none is a copy of a
 * real session. The half that matters most is the NEGATIVE half: the extractor feeds a bubble the
 * operator reads, so spinner text, the input box and the statusline must never end up in it, and a
 * screen with no reply being written (idle, a dialog, only tools) must give null.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { extractStreaming, sameMessage, anchorOf, normalizeForMatch, stitch, previewIsMessage, createStreamTracker, STREAM_ANCHOR_WORDS } from '../core/screenStream';

const RULE = '─'.repeat(56);
const BOX = ['╭' + RULE + '╮', '│ > ' + ' '.repeat(52) + ' │', '╰' + RULE + '╯'];
const FOOTER = ['  ? for shortcuts                                  Context 12%'];
const SPIN = '✻ Thinking… (4s · ↓ 312 tokens · esc to interrupt)';
const screen = (...parts: Array<string | string[]>): string => parts.flat().join('\n');

const STREAMING = screen(
  '> make the sync client retry with backoff',
  '',
  '⏺ I read the sync module and found two causes. The first is that the',
  '  retry timer is never reset after a success, so the client keeps backing',
  '  off long after the network is back.',
  '',
  SPIN,
  '',
  BOX,
  FOOTER,
);

test('the reply in progress comes back clean: no bullet, spinner, input box or footer', () => {
  const r = extractStreaming(STREAMING);
  assert.ok(r);
  assert.equal(r.text, 'I read the sync module and found two causes. The first is that the retry timer is never reset after a success, so the client keeps backing off long after the network is back.');
  assert.equal(r.headCut, false);
  for (const noise of ['⏺', 'Thinking', 'esc to interrupt', 'tokens', '> ', '? for shortcuts', 'Context 12%', '╭', '│']) {
    assert.ok(!r.text.includes(noise), `"${noise}" must not leak into the text`);
  }
});

test('the other spinner phrasings and the star/dot glyphs are noise too', () => {
  for (const spin of ['· Pondering… (esc to interrupt)', '✶ Cogitating… (12s · ↑ 1.2k tokens · esc to interrupt)', '✻ Thinking…', '✽ Running… (3s)', '* Hatching… (7s · esc to interrupt)']) {
    const r = extractStreaming(screen('⏺ Working on it now.', '', spin, '', BOX, FOOTER));
    assert.equal(r?.text, 'Working on it now.', spin);
  }
  // an "esc to interrupt" hint on its own line also marks a live turn
  assert.equal(extractStreaming(screen('⏺ Partial answer', '  (esc to interrupt)', BOX))?.text, 'Partial answer');
});

test('wrapped lines are rejoined, paragraphs and list items are kept apart', () => {
  const r = extractStreaming(screen(
    '⏺ Here is the plan, which has a few steps and',
    '  needs a little care:',
    '',
    '  1. Read the config file and check that the',
    '     port is not already taken',
    '  2. Change the port',
    '',
    '  • a bullet item',
    '  • another one that wraps because it is',
    '    long enough to need a second row',
    '',
    'ignored flush-left system line',
    SPIN, BOX,
  ));
  assert.equal(r, null, 'flush-left output after the block ends it: the last block is not text');
  const ok = extractStreaming(screen(
    '⏺ Here is the plan, which has a few steps and',
    '  needs a little care:',
    '',
    '  1. Read the config file and check that the',
    '     port is not already taken',
    '  2. Change the port',
    '',
    '  • a bullet item',
    '  • another one that wraps because it is',
    '    long enough to need a second row',
    SPIN, BOX,
  ));
  assert.equal(ok?.text, [
    'Here is the plan, which has a few steps and needs a little care:',
    '',
    '1. Read the config file and check that the port is not already taken',
    '2. Change the port',
    '',
    '• a bullet item',
    '• another one that wraps because it is long enough to need a second row',
  ].join('\n'));
});

test('partial markdown is returned as painted: a half-written code block, an unclosed bold, a cut table', () => {
  const code = extractStreaming(screen('⏺ Use this:', '', '    const retry = (fn) => {', '      return backoff(fn)', SPIN, BOX));
  assert.equal(code?.text, 'Use this:\n\n  const retry = (fn) => {\n    return backoff(fn)');
  assert.equal(extractStreaming(screen('⏺ This is **really impor', SPIN, BOX))?.text, 'This is **really impor');
  const table = extractStreaming(screen('⏺ Results:', '', '  ┌──────┬──────┐', '  │ name │ time │', '  ├──────┼──────┤', '  │ a    │ 1s   │', SPIN, BOX));
  assert.ok(table?.text.includes('│ name │ time │'), 'table rows survive');
  assert.equal(table?.text.split('\n').filter((l) => l.includes('│')).length, 2, 'one line per table row, not glued');
});

test('a reply that has a table in it is not mistaken for the input box and cut away', () => {
  const r = extractStreaming(screen(
    '> compare the two',
    '',
    '⏺ Here is the comparison:',
    '',
    '  ┌──────┬──────┐',
    '  │ name │ time │',
    '  └──────┴──────┘',
    '',
    '  The second one is faster.',
    SPIN, BOX,
  ));
  assert.ok(r?.text.includes('The second one is faster.'));
});

test('the anchor is the first words, normalised, and stays put while the text grows', () => {
  const a = extractStreaming(screen('⏺ **Good** question: the retry timer, in the sync client,', '  is never reset.', SPIN, BOX));
  assert.equal(a?.anchor, 'good question the retry timer in');
  assert.equal(a?.anchor.split(' ').length, STREAM_ANCHOR_WORDS);
  const grown = extractStreaming(screen('⏺ **Good** question: the retry timer, in the sync client,', '  is never reset. Fix it by', '  clearing the timer on success.', SPIN, BOX));
  assert.equal(grown?.anchor, a?.anchor);
  assert.equal(anchorOf('Hello there friend', 2), 'hello there');
});

// ── negative controls ───────────────────────────────────────────────────────

test('an idle screen gives null: the last answer is still visible but nothing is being written', () => {
  const idle = screen(
    '> make the sync client retry',
    '',
    '⏺ Done. The retry timer is now reset on success.',
    '',
    '✻ Worked for 12s',
    '',
    BOX,
    FOOTER,
  );
  assert.equal(extractStreaming(idle), null);
  // control: the same screen WITH a spinner under the text is a reply in progress
  assert.equal(extractStreaming(idle.replace('✻ Worked for 12s', SPIN))?.text, 'Done. The retry timer is now reset on success.');
  assert.equal(extractStreaming(''), null);
  assert.equal(extractStreaming('   \n\n  '), null);
});

test('only tools, or a tool after the text, give null: that text is complete and lives in the transcript', () => {
  assert.equal(extractStreaming(screen('> run the tests', '', '⏺ Bash(npm test)', '  ⎿  Running…', '', SPIN, BOX)), null);
  assert.equal(extractStreaming(screen('⏺ Read(src/sync.ts)', '  ⎿  Read 120 lines', '⏺ Searched for 2 patterns (ctrl+o to expand)', SPIN, BOX)), null);
  assert.equal(extractStreaming(screen('⏺ Let me run the tests.', '', '⏺ Bash(npm test)', '  ⎿  Running…', SPIN, BOX)), null);
  // control: a text block AFTER the tool is the one being written
  assert.equal(extractStreaming(screen('⏺ Bash(npm test)', '  ⎿  ok, 12 passed', '', '⏺ All twelve pass.', SPIN, BOX))?.text, 'All twelve pass.');
  // tool rows never leak into a later block's text
  const t = extractStreaming(screen('⏺ Bash(npm test)', '  ⎿  ok, 12 passed', '     detail line of the output', '', '⏺ All twelve pass.', SPIN, BOX));
  assert.ok(!t?.text.includes('Bash') && !t?.text.includes('detail'));
});

test('the operator just sent a message and nothing is painted yet: null', () => {
  assert.equal(extractStreaming(screen('⏺ An older answer.', '', '> and now this one', '', SPIN, BOX)), null);
  assert.equal(extractStreaming(screen('> and now this one', '', '⏺', SPIN, BOX)), null, 'an empty bullet is not a reply yet');
  assert.equal(extractStreaming(screen('> a question', '', '∴ Thinking…', '  weighing two options', SPIN, BOX)), null, 'thinking is not the reply');
});

test('a dialog on screen gives null, even with an answer above it', () => {
  const dialog = screen(
    '⏺ I will remove the build folder.',
    '',
    '⏺ Bash(rm -rf build)',
    '',
    'Do you want to proceed?',
    '❯ 1. Yes',
    '  2. No, and tell Claude what to do differently (esc)',
  );
  assert.equal(extractStreaming(dialog), null);
  assert.equal(extractStreaming(screen('⏺ Almost done.', SPIN, '', 'Make auto mode your default permission mode?', '', '❯ Yes, set auto mode', '  No, keep manual approval')), null);
});

test('words that look like TUI noise inside the answer are kept', () => {
  const r = extractStreaming(screen(
    '⏺ You can press esc to interrupt me at any time, and the line',
    '  ? for shortcuts is shown under the box. Thinking… is only the spinner.',
    SPIN, BOX,
  ));
  assert.equal(r?.text, 'You can press esc to interrupt me at any time, and the line ? for shortcuts is shown under the box. Thinking… is only the spinner.');
});

test('a reply taller than the window has lost its head: flagged, with no anchor', () => {
  const r = extractStreaming(screen(
    '  of the older rows were scrolled away, and this is the middle of a long',
    '  answer that keeps going down the screen.',
    SPIN, BOX,
  ));
  assert.equal(r?.headCut, true);
  assert.equal(r?.anchor, '');
  assert.ok(r?.text.startsWith('of the older rows'));
  // deeper-indented rows with no opener are as likely to be a tool's output: not claimed as a reply
  assert.equal(extractStreaming(screen('       a long line of tool output with no opener above it', SPIN, BOX)), null);
});

test('without an input box on screen the footer hints are still dropped', () => {
  const r = extractStreaming(screen('⏺ Answer in progress', '', SPIN, '', '  ? for shortcuts', '  ⏵⏵ auto-accept edits on (shift+tab to cycle)'));
  assert.equal(r?.text, 'Answer in progress');
});

// ── matching the finished message ───────────────────────────────────────────

test('sameMessage: the provisional text is the start of the final one, whatever the markdown did to it', () => {
  const final = [
    '## The plan',
    '',
    'I read the **sync module** and found two causes. See [the docs](https://example.com/docs) for `retry`.',
    '',
    '```ts',
    'const retry = 1;',
    '```',
    '',
    '- first thing',
    '- second thing',
  ].join('\n');
  assert.ok(sameMessage('The plan\n\nI read the sync module and found two causes. See the docs for retry.', final));
  assert.ok(sameMessage('The plan I read the sync mod', final), 'cut mid-word');
  assert.ok(sameMessage('The plan\n\nI read the sync module and found two causes. See the docs for retry.\n\nconst retry = 1;\n\n• first thing', final), 'code fence and bullet glyph');
  // negative controls
  assert.equal(sameMessage('A completely different reply about something else', final), false);
  assert.equal(sameMessage('The plan\n\nI read the sync module and found three causes.', final), false);
  assert.equal(sameMessage('', final), false);
  assert.equal(sameMessage('The plan', ''), false);
  // the provisional must not run past the final text
  assert.equal(sameMessage(final + ' and then some more words that never arrived', final), false);
});

test('sameMessage: a head-cut reply is matched as a substring, and a tiny fragment matches nothing', () => {
  const final = 'Intro paragraph that scrolled off the screen. Then the middle of the answer keeps going and the end follows.';
  assert.ok(sameMessage('the middle of the answer keeps going', final, { headCut: true }));
  assert.equal(sameMessage('the middle of the answer keeps going', final), false, 'without headCut it must be a prefix');
  assert.equal(sameMessage('keeps going', final, { headCut: true }), false, 'too short to identify a message');
  assert.equal(sameMessage('some other text that is long enough to count', final, { headCut: true }), false);
});

test('normalizeForMatch keeps letters and digits only', () => {
  assert.equal(normalizeForMatch('**Hello**, wörld! 42 [x](http://a.b)\n```ts\nq\n```'), 'hellowörld42xq');
});

test('reading the last text block of any screen (requireActive: false) still leaves the input box out', () => {
  const idle = screen('> hi', '', '⏺ Hello, how can I help?', '', BOX, FOOTER);
  assert.equal(extractStreaming(idle), null);
  assert.equal(extractStreaming(idle, { requireActive: false })?.text, 'Hello, how can I help?');
  // control: a draft typed in the box (multi-line) does not leak either
  const draft = screen('⏺ Hello, how can I help?', '', '╭' + RULE + '╮', '│ > a draft I am typing' + ' '.repeat(33) + ' │', '│   on two lines' + ' '.repeat(41) + ' │', '╰' + RULE + '╯', FOOTER);
  assert.equal(extractStreaming(draft, { requireActive: false })?.text, 'Hello, how can I help?');
  // a rule-framed box (no side borders) is cut the same way
  assert.equal(extractStreaming(screen('⏺ Hello again.', RULE, '> ', RULE, FOOTER), { requireActive: false })?.text, 'Hello again.');
});

// ── what the real CLI draws that the first version did not know (found by running it, written here by hand) ──

/** The box as 2.1.x paints it: a top border carrying the session's name, the prompt cell with a NO-BREAK space, a plain bottom border. */
const TITLED = ['─'.repeat(40) + ' my-session ─', '❯\u00a0', '─'.repeat(56)];
const LIVE_FOOTER = '  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt';
const IDLE_FOOTER = '  ⏵⏵ bypass permissions on (shift+tab to cycle)';
const EFFORT = ' '.repeat(58) + '◐ medium · /effort';

test('while text is written the CLI draws NO spinner: the footer under the box is the only sign of a live turn', () => {
  const body = ['> list three trees', '', '⏺ 1. Oak, which lives for centuries.', '  2. Birch, pale and papery.', '  3.'];
  const live = extractStreaming(screen(body, '', EFFORT, TITLED, LIVE_FOOTER));
  assert.equal(live?.text, '1. Oak, which lives for centuries.\n2. Birch, pale and papery.\n3.');
  // negative control: the very same screen once the footer stops saying it is running
  assert.equal(extractStreaming(screen(body, '', EFFORT, TITLED, IDLE_FOOTER)), null);
  // …and an answer that merely SAYS the words, on an idle screen, is not a live turn (the marker is read where it lives)
  assert.equal(extractStreaming(screen('⏺ Press esc to interrupt', '', TITLED, IDLE_FOOTER)), null);
  // the bare hint as the whole footer (default permission mode) counts too
  assert.equal(extractStreaming(screen('⏺ Working on it', '', TITLED, '  esc to interrupt'))?.text, 'Working on it');
});

test('the no-break space, the titled border and the effort indicator are all noise, never text', () => {
  const r = extractStreaming(screen('⏺ First line of the reply', '  second line', '', EFFORT, TITLED, LIVE_FOOTER));
  assert.equal(r?.text, 'First line of the reply second line');
  for (const leak of ['effort', 'medium', 'my-session', '─', '❯']) assert.ok(!r?.text.includes(leak), `"${leak}" must not leak`);
  // control: take the titled-border rule away and the border row is read as a flush-left block that ends the reply
  assert.equal(extractStreaming(screen('⏺ First line', '', '─'.repeat(30) + ' x ─', LIVE_FOOTER)), null);
});

test('a list number painted before its text is its own item, not the tail of the line above', () => {
  const r = extractStreaming(screen('⏺ 1. First item is complete.', '  2.', SPIN, BOX));
  assert.equal(r?.text, '1. First item is complete.\n2.');
  // control: a wrapped continuation that merely contains a number is still joined
  assert.equal(extractStreaming(screen('⏺ The limit is', '  25. That is all.', SPIN, BOX))?.text, 'The limit is\n25. That is all.', 'a number then text IS an item');
  assert.equal(extractStreaming(screen('⏺ The limit is about', '  twenty five.', SPIN, BOX))?.text, 'The limit is about twenty five.');
});

// ── joining windows over a reply that outgrows the terminal ────────────────

test('stitch: a window that starts inside what was already assembled extends it, and only the last line may have grown', () => {
  const acc = ['1. alpha one', '2. beta two', '3. gamma three', '4. delta fo'].join('\n');
  const win = ['2. beta two', '3. gamma three', '4. delta four', '5. epsilon'].join('\n');
  assert.equal(stitch(acc, win), ['1. alpha one', '2. beta two', '3. gamma three', '4. delta four', '5. epsilon'].join('\n'));
  // a window cut in the middle of a wrapped line extends it from its end
  assert.equal(stitch('intro line\nthe quick brown fox jumps over', 'fox jumps over the lazy dog'), 'intro line\nthe quick brown fox jumps over the lazy dog');
  // negative controls: nothing in common, a short fragment that could be anywhere, and a window that is OLDER than what we have
  assert.equal(stitch(acc, ['9. unrelated tail', '10. more'].join('\n')), null);
  assert.equal(stitch('1. a\n2. b\n3. c', '3.\n4. d'), null, 'a three-character fragment is not evidence of position');
  assert.equal(stitch(acc, ['1. alpha one', '2. beta two'].join('\n')), null, 'a window that ends before the assembled text does is older');
});

test('stitch: the last two shared lines may disagree (a repaint caught half way); everything before them may not', () => {
  const acc = ['l1 aaaaaaaaaaaa', 'l2 bbbbbbbbbbbb', 'l3 cccccccccccc', 'l4 dddddddddddd', 'l5 eeeeeeeeeeee', 'l6 ffffff'].join('\n');
  const torn = ['l2 bbbbbbbbbbbb', 'l3 cccccccccccc', 'l4 dddddddddddd', 'l5 eeee gggg torn', 'l7 hhhhhhhhhhhh'].join('\n');
  const joined = stitch(acc, torn);
  assert.ok(joined && joined.startsWith('l1 aaaaaaaaaaaa\nl2 bbbbbbbbbbbb') && joined.endsWith('l7 hhhhhhhhhhhh'), 'the newer paint of the tail wins');
  const wrong = ['l2 bbbbbbbbbbbb', 'l3 DIFFERENT cccc', 'l4 dddddddddddd', 'l5 eeeeeeeeeeee', 'l6 ffffff!'].join('\n');
  assert.equal(stitch(acc, wrong), null, 'a disagreement above the tail means it is not the same reply');
});

// ── the tracker: what is sent, and when a preview becomes the message ──────

const tallScreen = (lines: string[], opts: { first?: boolean; live?: boolean } = {}): string => screen(
  lines.map((l, i) => (i === 0 && opts.first !== false ? '⏺ ' + l : '  ' + l)), '', EFFORT, TITLED, opts.live === false ? IDLE_FOOTER : LIVE_FOOTER);
const LINES = Array.from({ length: 12 }, (_, i) => `${i + 1}. line number ${i + 1} about the harbour lights`);

test('tracker: growth is sent once per change, a window over a tall reply is stitched back to the head, silence freezes it once', () => {
  const tr = createStreamTracker();
  const e1 = tr.screen(tallScreen(LINES.slice(0, 3)));
  assert.ok(e1 && e1.type === 'stream' && typeof e1.text === 'string' && e1.text.startsWith('1. line number 1') && e1.headCut === false);
  assert.equal(tr.screen(tallScreen(LINES.slice(0, 3))), null, 'the same screen again says nothing');
  const e2 = tr.screen(tallScreen(LINES.slice(0, 5)));
  assert.ok(e2 && typeof e2.text === 'string' && e2.text.split('\n').length === 5);
  // the terminal is shorter than the reply now: the window lost its first rows, and the head comes back from earlier snapshots
  const e3 = tr.screen(tallScreen(LINES.slice(3, 9), { first: false }));
  assert.ok(e3 && typeof e3.text === 'string');
  assert.equal(e3.text.split('\n').length, 9, 'lines 1-9, not just the window');
  assert.ok(e3.text.startsWith('1. line number 1'));
  assert.equal(e3.headCut, false, 'the head is known, so it is not "cut"');
  // the screen goes idle: one freeze event, then nothing
  const idle = tallScreen(LINES.slice(3, 9), { first: false, live: false });
  assert.deepEqual(tr.screen(idle), { type: 'stream', text: null });
  assert.equal(tr.screen(idle), null);
  // negative control: the same windows WITHOUT the tracker's memory are headless
  assert.equal(extractStreaming(tallScreen(LINES.slice(3, 9), { first: false }))?.headCut, true);
});

test('tracker: the transcript line that IS the preview is adopted, any other is not, and a torn tail does not stop the match', () => {
  const tr = createStreamTracker();
  tr.screen(tallScreen(LINES.slice(0, 6)));
  assert.equal(tr.items([{ uuid: 'u0', role: 'user', text: LINES[0] }]), null, 'only assistant text can be the message');
  assert.equal(tr.items([{ uuid: 'a0', role: 'assistant', text: 'A different reply altogether, about gardens.' }]), null);
  assert.equal(tr.items([{ uuid: 't', role: 'tool' }]), null);
  const ev = tr.items([{ uuid: 'a1', role: 'assistant', text: LINES.join('\n') }]);
  assert.deepEqual(ev, { type: 'stream', text: null, adopt: 'a1' });
  assert.equal(tr.current(), null, 'adopted once');
  assert.equal(tr.items([{ uuid: 'a1', role: 'assistant', text: LINES.join('\n') }]), null, 'a re-sent line does not adopt again');
  // a preview whose last lines were caught mid-repaint still matches, by its undamaged beginning
  const torn = createStreamTracker();
  torn.screen(tallScreen([...LINES.slice(0, 5), '6. line number 6 abo', '7. garbled tail from a half-erased row']));
  assert.equal((torn.items([{ uuid: 'a2', role: 'assistant', text: LINES.join('\n') }]) as { adopt?: string } | null)?.adopt, 'a2');
  assert.equal(previewIsMessage('x\ny\nz', 'something else entirely', false), false);
  assert.equal(previewIsMessage('hello wxx', 'hello world', false), false, 'a tiny preview is only matched strictly: what is left after the tolerance is too short to mean anything');
});

test('tracker: the finished message seen again on a stale screen is not drawn a second time, until a new turn begins', () => {
  const tr = createStreamTracker();
  tr.screen(tallScreen(LINES.slice(0, 6)));
  assert.equal((tr.items([{ uuid: 'a1', role: 'assistant', text: LINES.join('\n') }]) as { adopt?: string } | null)?.adopt, 'a1');
  tr.end();
  // the screen still says "esc to interrupt" for a moment and shows the whole reply
  assert.equal(tr.screen(tallScreen(LINES)), null, 'no second preview of a message that is already in the transcript');
  tr.begin();
  assert.ok(tr.screen(tallScreen(LINES.slice(0, 2))), 'a new turn that opens with the same words is a preview again');
  // negative control: without the memory the stale screen DOES revive it
  const bare = createStreamTracker();
  bare.screen(tallScreen(LINES.slice(0, 6)));
  bare.items([{ uuid: 'a1', role: 'assistant', text: LINES.join('\n') }]);
  bare.reset();
  assert.ok(bare.screen(tallScreen(LINES)), 'a reset forgets it');
});

test('tracker: a window that cannot be joined is held back a few times instead of shrinking the preview to it, and believed once it keeps coming', () => {
  const tr = createStreamTracker();
  tr.screen(tallScreen(LINES.slice(0, 5)));
  const big = tr.screen(tallScreen(LINES.slice(0, 9)));
  assert.ok(big && typeof big.text === 'string' && big.text.split('\n').length === 9);
  // windows from somewhere else entirely (a torn paint, or a gap): nothing is sent, the bubble keeps its text
  const alien = tallScreen(['91. torn row that matches nothing', '92. and neither does this one', '93. nor this one'], { first: false });
  for (let i = 0; i < 3; i++) assert.equal(tr.screen(alien), null, `miss ${i + 1} is ignored`);
  assert.equal(tr.current()?.text.split('\n').length, 9);
  const believed = tr.screen(alien);
  assert.ok(believed && typeof believed.text === 'string' && believed.text.startsWith('91. torn row'), 'the fourth in a row is a real change');
  // negative control: a window that DOES join resets the count
  const t2 = createStreamTracker();
  t2.screen(tallScreen(LINES.slice(0, 5)));
  t2.screen(tallScreen(LINES.slice(0, 9)));
  t2.screen(alien); t2.screen(alien);
  const joined = t2.screen(tallScreen(LINES.slice(5, 11), { first: false }));
  assert.ok(joined && typeof joined.text === 'string' && joined.text.split('\n').length === 11, 'a good window is accepted and wipes the misses');
  t2.screen(alien); t2.screen(alien); t2.screen(alien);
  assert.equal(t2.current()?.text.split('\n').length, 11, 'still holding after three new misses');
});

test('the CLI\'s progress lines for a tool that is running are not a reply', () => {
  for (const line of ['Running 1 shell command…', 'Running 3 shell commands…', 'Reading 2 files…', 'Searching 4 patterns…', 'Ran 2 shell commands', 'Fetching 1 page…']) {
    assert.equal(extractStreaming(screen('> do it', '', '⏺ ' + line, SPIN, BOX)), null, line);
  }
  // control: prose that merely starts with a gerund is a reply
  assert.equal(extractStreaming(screen('⏺ Running the tests is the next step.', SPIN, BOX))?.text, 'Running the tests is the next step.');
});
