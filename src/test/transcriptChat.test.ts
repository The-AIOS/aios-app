/**
 * Chat skin — the transcript → chat items rules (core/transcriptChat). Fixtures are written by hand
 * and neutral; the shape mirrors what a real transcript holds (see the header of the module).
 *
 * Every group carries a NEGATIVE CONTROL: the same input with the one property that should make a
 * difference removed, so a test that passes because the parser ignores everything cannot hide.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  createTranscriptTracker, previewToolOutput, TOOL_OUTPUT_MAX_CHARS, TOOL_OUTPUT_MAX_LINES, type ChatItem,
} from '../core/transcriptChat';

let n = 0;
const uid = (): string => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const ts = '2026-01-01T10:00:00.000Z';
const j = (o: unknown): string => JSON.stringify(o);

const userStr = (text: string, extra: object = {}): string =>
  j({ parentUuid: null, isSidechain: false, type: 'user', uuid: uid(), timestamp: ts, message: { role: 'user', content: text }, ...extra });
const userBlocks = (content: unknown[], extra: object = {}): string =>
  j({ parentUuid: null, isSidechain: false, type: 'user', uuid: uid(), timestamp: ts, message: { role: 'user', content }, ...extra });
const usage = { input_tokens: 3, cache_creation_input_tokens: 100, cache_read_input_tokens: 900, output_tokens: 50 };
const asst = (block: unknown, stop: string | null, extra: object = {}, model = 'model-x'): string =>
  j({ parentUuid: null, isSidechain: false, type: 'assistant', uuid: uid(), timestamp: ts, message: { id: 'msg_1', role: 'assistant', model, stop_reason: stop, content: [block], usage }, ...extra });
const toolUse = (id: string, name: string, input: unknown, stop: string | null = 'tool_use'): string => asst({ type: 'tool_use', id, name, input }, stop);
const toolResult = (id: string, content: string, isError?: boolean): string =>
  userBlocks([{ type: 'tool_result', tool_use_id: id, content, ...(isError === undefined ? {} : { is_error: isError }) }]);
const turnEnd = (): string => j({ parentUuid: null, isSidechain: false, type: 'system', subtype: 'turn_duration', durationMs: 5, uuid: uid(), timestamp: ts });

const feedAll = (lines: string[]) => createTranscriptTracker().feedAll(lines);
const byRole = (items: ChatItem[], role: string): ChatItem[] => items.filter((i) => i.role === role);

test('a plain turn: what the operator typed, the answer, the close of the turn', () => {
  const t = createTranscriptTracker();
  const a = t.feed(userStr('hello there'));
  assert.deepEqual(a.items.map((i) => [i.role, i.text]), [['user', 'hello there']]);
  assert.equal(a.turnOpen, true, 'a typed message opens a turn');

  const b = t.feed(asst({ type: 'thinking', thinking: 'private reasoning' }, 'end_turn'));
  assert.deepEqual(b.items, [], 'thinking is never shown');

  const c = t.feed(asst({ type: 'text', text: 'Hi! **bold** stays raw markdown' }, 'end_turn'));
  assert.equal(c.items.length, 1);
  assert.equal(c.items[0].role, 'assistant');
  assert.equal(c.items[0].text, 'Hi! **bold** stays raw markdown');
  assert.equal(c.turnOpen, false, 'a final text with end_turn closes the turn');

  // negative control: the same text without end_turn leaves the turn open
  const t2 = createTranscriptTracker();
  t2.feed(userStr('hello'));
  const open = t2.feed(asst({ type: 'text', text: 'working on it' }, 'tool_use'));
  assert.equal(open.turnOpen, undefined, 'still open: nothing flipped');
  assert.equal(t2.snapshot().turnOpen, true);
});

test('turn_duration closes the turn even when no end_turn text was seen', () => {
  const t = createTranscriptTracker();
  t.feed(userStr('go'));
  t.feed(toolUse('t1', 'Bash', { command: 'ls' }));
  assert.equal(t.snapshot().turnOpen, true);
  assert.equal(t.feed(turnEnd()).turnOpen, false);
  // control: an unrelated system line does not close it
  const t2 = createTranscriptTracker();
  t2.feed(userStr('go'));
  t2.feed(j({ type: 'system', subtype: 'informational', uuid: uid() }));
  assert.equal(t2.snapshot().turnOpen, true);
});

test('an assistant message split across lines yields one item per text block, in order', () => {
  const items = feedAll([
    userStr('q'),
    asst({ type: 'thinking', thinking: 'x' }, 'tool_use'),
    asst({ type: 'text', text: 'first part' }, 'tool_use'),
    toolUse('t1', 'Read', { file_path: '/p/a.txt' }),
    toolResult('t1', 'contents'),
    asst({ type: 'text', text: 'second part' }, 'end_turn'),
  ]).items;
  assert.deepEqual(items.map((i) => i.role), ['user', 'assistant', 'tool', 'assistant']);
  assert.deepEqual(byRole(items, 'assistant').map((i) => i.text), ['first part', 'second part']);
});

test('tool_use becomes one running line; its tool_result flips the SAME item to ok or error', () => {
  const t = createTranscriptTracker();
  const run = t.feed(toolUse('tool-ok', 'Bash', { command: 'echo   hi\n there' }));
  assert.equal(run.items.length, 1);
  const it = run.items[0];
  assert.equal(it.role, 'tool');
  assert.equal(it.uuid, 'tool-ok', 'the tool id is the item identity, so the result can update it');
  assert.deepEqual(it.tool, { id: 'tool-ok', name: 'Bash', summary: 'echo hi there', status: 'running' });

  const ok = t.feed(toolResult('tool-ok', 'hi', false));
  assert.equal(ok.items.length, 1);
  assert.equal(ok.items[0].uuid, 'tool-ok');
  assert.equal(ok.items[0].tool?.status, 'ok');
  assert.equal(ok.items[0].tool?.summary, 'echo hi there');

  t.feed(toolUse('tool-bad', 'Edit', { file_path: '/p/b.ts' }));
  const bad = t.feed(toolResult('tool-bad', 'nope', true));
  assert.equal(bad.items[0].tool?.status, 'error');

  // is_error missing entirely is a success, not a failure
  t.feed(toolUse('tool-plain', 'Glob', { pattern: '*.md' }));
  assert.equal(t.feed(toolResult('tool-plain', 'a.md')).items[0].tool?.status, 'ok');

  // negative control: a result for a tool we never saw changes nothing
  assert.deepEqual(t.feed(toolResult('never-seen', 'x', true)).items, []);
  // and a second result for an already-finished tool does not flip it back
  assert.deepEqual(t.feed(toolResult('tool-bad', 'again', false)).items, []);
});

test('what the operator typed: plain strings, slash commands, pasted blocks', () => {
  const a = feedAll([userStr('  fix the thing  ')]).items;
  assert.equal(a[0].text, 'fix the thing');

  const cmd = feedAll([userStr('<command-message>x:run</command-message>\n<command-name>/x:run</command-name>\n<command-args>now please</command-args>')]).items;
  assert.equal(cmd[0].role, 'user');
  assert.equal(cmd[0].text, '/x:run now please');
  const bare = feedAll([userStr('<command-message>x:run</command-message>\n<command-name>/x:run</command-name>\n<command-args></command-args>')]).items;
  assert.equal(bare[0].text, '/x:run');

  const blocks = feedAll([userBlocks([{ type: 'text', text: 'look at this' }, { type: 'image', source: {} }])]).items;
  assert.equal(blocks[0].text, 'look at this');
});

test('lines that are not the conversation are ignored (negative control: the same line, not flagged, shows)', () => {
  const lines = (extra: object): string[] => [userStr('visible?', extra)];
  assert.equal(feedAll(lines({})).items.length, 1, 'control: an ordinary user line is shown');
  assert.equal(feedAll(lines({ isMeta: true })).items.length, 0, 'isMeta: injected, not typed');
  assert.equal(feedAll(lines({ isSidechain: true })).items.length, 0, 'sidechain: a subagent');

  const asstLine = (extra: object): string[] => [asst({ type: 'text', text: 'hi' }, 'end_turn', extra)];
  assert.equal(feedAll(asstLine({})).items.length, 1);
  assert.equal(feedAll(asstLine({ isSidechain: true })).items.length, 0);

  // wrappers the operator did not write
  assert.equal(feedAll([userStr('<system-reminder>be careful</system-reminder>')]).items.length, 0);
  assert.equal(feedAll([userStr('<local-command-caveat>Caveat: ...</local-command-caveat>')]).items.length, 0);
  assert.equal(feedAll([userStr('<task-notification><task-id>1</task-id></task-notification>')]).items.length, 0);
  // a reminder glued to real text: the text survives, the reminder does not
  const mixed = feedAll([userStr('<system-reminder>noise</system-reminder>\nreal question')]).items;
  assert.equal(mixed[0].text, 'real question');

  // local command output is a system note, not a bubble from the operator
  const out = feedAll([userStr('<local-command-stdout>Set model to x</local-command-stdout>')]).items;
  assert.deepEqual(out.map((i) => [i.role, i.text]), [['system', 'Set model to x']]);
  assert.equal(feedAll([userStr('<local-command-stdout></local-command-stdout>')]).items.length, 0);
});

test('bookkeeping lines are skipped without being parsed; corrupt and blank lines are tolerated', () => {
  const huge = j({ type: 'api-request-blob', hash: 'h', message: { role: 'user', content: [{ type: 'text', text: 'x'.repeat(50_000) }] } });
  const bookkeeping = [
    huge,
    j({ type: 'attachment', attachment: { type: 'x' } }),
    j({ type: 'last-prompt', lastPrompt: 'p' }),
    j({ type: 'custom-title', customTitle: 't' }),
    j({ type: 'agent-name', agentName: 'a' }),
    j({ type: 'mode', mode: 'm' }),
    j({ type: 'permission-mode', permissionMode: 'default' }),
    j({ type: 'file-history-snapshot', snapshot: {} }),
    j({ type: 'queue-operation', operation: 'enqueue', content: 'later' }),
  ];
  const u = feedAll([...bookkeeping, '', '   ', '{"parentUuid": "x", "type": "user", "mess', 'not json at all', '[1,2,3]', 'null']);
  assert.deepEqual(u.items, []);
  assert.equal(u.turnOpen, undefined);

  // the parser is still alive afterwards, and a half-written line does not poison the next one
  const t = createTranscriptTracker();
  t.feed('{"parentUuid": "x", "type": "user", "mess');
  assert.equal(t.feed(userStr('after the garbage')).items[0].text, 'after the garbage');
});

test('interrupt: the marker closes the turn and fails what was still running', () => {
  const t = createTranscriptTracker();
  t.feed(userStr('do it'));
  t.feed(toolUse('slow', 'Bash', { command: 'sleep 100' }));
  const r = t.feed(userBlocks([{ type: 'text', text: '[Request interrupted by user for tool use]' }]));
  assert.equal(r.turnOpen, false);
  const roles = r.items.map((i) => i.role);
  assert.ok(roles.includes('system'), 'the interruption is shown');
  const tool = r.items.find((i) => i.role === 'tool');
  assert.equal(tool?.tool?.status, 'error', 'a tool that will never answer must not spin forever');

  // control: ordinary text that merely mentions an interruption is NOT one
  const t2 = createTranscriptTracker();
  t2.feed(userStr('go'));
  const c = t2.feed(userBlocks([{ type: 'text', text: 'why did you write [Request interrupted by user] earlier?' }]));
  assert.equal(c.items[0].role, 'user');
  assert.equal(t2.snapshot().turnOpen, true);
});

test('API errors written as synthetic assistant messages are system notes and end the turn', () => {
  const t = createTranscriptTracker();
  t.feed(userStr('go'));
  const r = t.feed(asst({ type: 'text', text: 'API Error: something broke' }, 'stop_sequence', {}, '<synthetic>'));
  assert.deepEqual(r.items.map((i) => [i.role, i.text]), [['system', 'API Error: something broke']]);
  assert.equal(r.turnOpen, false);
  assert.equal(r.usage, undefined, 'a synthetic message carries no real usage');
});

test('usage: context tokens are input + cache of the latest assistant message, with its model', () => {
  const t = createTranscriptTracker();
  const a = t.feed(asst({ type: 'text', text: 'x' }, 'end_turn'));
  assert.deepEqual(a.usage, { contextTokens: 1003, model: 'model-x' });
  // unchanged usage is not re-announced
  assert.equal(t.feed(asst({ type: 'text', text: 'y' }, 'end_turn')).usage, undefined);
  // a later message with a different size is
  const bigger = j({ type: 'assistant', uuid: uid(), isSidechain: false, message: { model: 'model-y', stop_reason: 'end_turn', content: [{ type: 'text', text: 'z' }], usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 4000 } } });
  assert.deepEqual(t.feed(bigger).usage, { contextTokens: 4001, model: 'model-y' });

  // negative control: output-only usage is not "context"; the figure is left alone, never zeroed
  const t2 = createTranscriptTracker();
  const only = j({ type: 'assistant', uuid: uid(), isSidechain: false, message: { model: 'm', stop_reason: 'end_turn', content: [{ type: 'text', text: 'z' }], usage: { output_tokens: 9 } } });
  assert.deepEqual(t2.feed(only).usage, { model: 'm' });
  assert.equal(t2.snapshot().usage.contextTokens, undefined);
});

test('feedAll merges one batch: an item updated inside it keeps its place with its final content', () => {
  const u = feedAll([
    userStr('q'),
    toolUse('a', 'Bash', { command: 'one' }),
    toolUse('b', 'Bash', { command: 'two' }),
    toolResult('a', 'ok'),
    toolResult('b', 'bad', true),
  ]);
  assert.deepEqual(u.items.map((i) => i.uuid).slice(1), ['a', 'b']);
  assert.deepEqual(u.items.slice(1).map((i) => i.tool?.status), ['ok', 'error']);
  assert.equal(u.turnOpen, true);
});

test('reset forgets the turn and the running tools (the file is about to be re-read)', () => {
  const t = createTranscriptTracker();
  t.feed(userStr('q'));
  t.feed(toolUse('x', 'Bash', { command: 'ls' }));
  t.reset();
  assert.deepEqual(t.snapshot(), { turnOpen: false, usage: {}, orphanResults: 0 });
  assert.deepEqual(t.feed(toolResult('x', 'late')).items, []);
  assert.equal(t.snapshot().orphanResults, 1, 'a result whose call was forgotten is counted: it is how the tail knows a window cut a call in two');
  t.reset();
  assert.equal(t.snapshot().orphanResults, 0, 'and reset starts the count over');
});

test('orphanResults counts only results whose call this tracker never saw (control: a paired call counts none)', () => {
  const paired = createTranscriptTracker();
  paired.feedAll([toolUse('p1', 'Bash', { command: 'ls' }), toolResult('p1', 'out')]);
  assert.equal(paired.snapshot().orphanResults, 0);
  const cut = createTranscriptTracker();
  cut.feedAll([toolResult('p2', 'out'), toolResult('p3', 'out')]);
  assert.equal(cut.snapshot().orphanResults, 2);
});

// ── tool result preview (tool.output) ───────────────────────────────────────

const resultBlocks = (id: string, content: unknown, isError?: boolean): string =>
  userBlocks([{ type: 'tool_result', tool_use_id: id, content, ...(isError === undefined ? {} : { is_error: isError }) }]);
/** Run one tool through use + result and hand back the tool the result produced. */
const runTool = (result: (id: string) => string) => {
  const t = createTranscriptTracker();
  t.feed(userStr('q'));
  t.feed(toolUse('p1', 'Bash', { command: 'x' }));
  return t.feed(result('p1')).items[0]?.tool;
};
const ESC = '\x1b';

test('output: a string result fills tool.output, and only once the result arrives', () => {
  const t = createTranscriptTracker();
  const running = t.feed(toolUse('o1', 'Bash', { command: 'echo hi' })).items[0];
  assert.equal(running.tool?.output, undefined, 'a tool still running has no output');
  assert.equal('output' in (running.tool as object), false, 'the key is absent, not undefined');
  const done = t.feed(toolResult('o1', 'line one\nline two\n')).items[0];
  assert.equal(done.tool?.status, 'ok');
  assert.equal(done.tool?.output, 'line one\nline two', 'trailing newline is not content');
  assert.equal(done.tool?.outputTruncated, undefined, 'the flag is absent when nothing was cut');
  assert.equal(done.tool?.summary, running.tool?.summary, 'the rest of the tool is untouched');
  // negative control: an empty result gives no output key at all
  assert.equal('output' in (runTool((id) => toolResult(id, '')) as object), false);
  assert.equal('output' in (runTool((id) => toolResult(id, '  \n ')) as object), false);
});

test('output: an array content keeps text blocks in order and replaces non-text ones with a marker', () => {
  const tool = runTool((id) => resultBlocks(id, [
    { type: 'text', text: 'before' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA'.repeat(500) } },
    { type: 'text', text: 'after' },
    { type: 'something_new', payload: 1 },
  ]));
  assert.equal(tool?.output, 'before\n[image]\nafter\n[other]');
  assert.ok(!tool?.output?.includes('AAAA'), 'base64 never reaches the view');
  // negative control: text-only array has no marker
  assert.equal(runTool((id) => resultBlocks(id, [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]))?.output, 'a\nb');
  // content that is neither string nor array, or an array of junk, yields no output
  assert.equal('output' in (runTool((id) => resultBlocks(id, { type: 'text', text: 'x' })) as object), false);
  assert.equal('output' in (runTool((id) => resultBlocks(id, [null, 3, 'str'])) as object), false);
});

test('output: ANSI sequences and control characters are stripped, newlines and tabs stay', () => {
  const dirty = `${ESC}[31mred${ESC}[0m ${ESC}[1;32;4mgreen${ESC}[0m\n${ESC}]0;window title\x07body\tcol\x00\x07\x08\x7f\n${ESC}]8;;http://x${ESC}\\link${ESC}]8;;${ESC}\\ ${ESC}[2K${ESC}(B`;
  assert.equal(runTool((id) => toolResult(id, dirty))?.output, 'red green\nbody\tcol\nlink');
  // carriage returns: CRLF is a newline, a bare CR (progress redraw) separates frames instead of gluing them
  assert.equal(runTool((id) => toolResult(id, 'a\r\nb\r10%\r100%'))?.output, 'a\nb\n10%\n100%');
  // negative control: plain text with brackets that merely look like an escape is untouched
  assert.equal(runTool((id) => toolResult(id, 'arr[0] = "[31m"'))?.output, 'arr[0] = "[31m"');
  // an unterminated OSC must not swallow the text after it
  assert.equal(runTool((id) => toolResult(id, `${ESC}]0;oops\nkept`))?.output, '0;oops\nkept');
});

test('output: cut by characters, flagged, and never past the cap', () => {
  const long = 'x'.repeat(TOOL_OUTPUT_MAX_CHARS + 500);
  const tool = runTool((id) => toolResult(id, long));
  assert.equal(tool?.output?.length, TOOL_OUTPUT_MAX_CHARS);
  assert.equal(tool?.outputTruncated, true);
  // exactly at the cap is not truncated (negative control for the boundary)
  const exact = runTool((id) => toolResult(id, 'y'.repeat(TOOL_OUTPUT_MAX_CHARS)));
  assert.equal(exact?.output?.length, TOOL_OUTPUT_MAX_CHARS);
  assert.equal(exact?.outputTruncated, undefined);
  // a huge result is bounded and flagged too, without scanning all of it
  const huge = previewToolOutput('z'.repeat(5_000_000));
  assert.equal(huge?.text.length, TOOL_OUTPUT_MAX_CHARS);
  assert.equal(huge?.truncated, true);
  // the cut never leaves half of a surrogate pair
  const emoji = previewToolOutput('a'.repeat(TOOL_OUTPUT_MAX_CHARS - 1) + '\u{1F600}'.repeat(3));
  assert.ok(!/[\ud800-\udbff]$/.test(emoji?.text ?? ''), 'no dangling high surrogate');
});

test('output: cut by lines, flagged; the line cap and the char cap each win when stricter', () => {
  const many = Array.from({ length: TOOL_OUTPUT_MAX_LINES + 40 }, (_, i) => `row ${i}`).join('\n');
  const tool = runTool((id) => toolResult(id, many));
  assert.equal(tool?.output?.split('\n').length, TOOL_OUTPUT_MAX_LINES);
  assert.equal(tool?.output?.split('\n')[TOOL_OUTPUT_MAX_LINES - 1], `row ${TOOL_OUTPUT_MAX_LINES - 1}`);
  assert.equal(tool?.outputTruncated, true);
  // exactly the cap (with a trailing newline, which is not a line) is not truncated
  const exact = Array.from({ length: TOOL_OUTPUT_MAX_LINES }, (_, i) => `row ${i}`).join('\n') + '\n';
  const ok = runTool((id) => toolResult(id, exact));
  assert.equal(ok?.output?.split('\n').length, TOOL_OUTPUT_MAX_LINES);
  assert.equal(ok?.outputTruncated, undefined);
  // few but very long lines are held by the char cap instead
  const wide = runTool((id) => toolResult(id, `${'w'.repeat(3000)}\n${'w'.repeat(3000)}`));
  assert.equal(wide?.output?.length, TOOL_OUTPUT_MAX_CHARS);
  assert.equal(wide?.outputTruncated, true);
});

test('output: an error result keeps its output next to status error', () => {
  const tool = runTool((id) => toolResult(id, `${ESC}[31mError: boom${ESC}[0m\n  at fake (file.js:1:1)`, true));
  assert.equal(tool?.status, 'error');
  assert.equal(tool?.output, 'Error: boom\n  at fake (file.js:1:1)');
  // negative control: same text, no is_error → ok
  assert.equal(runTool((id) => toolResult(id, 'Error: boom'))?.status, 'ok');
});

test('output: a tool that never got a result stays running without output, also after an interrupt', () => {
  const t = createTranscriptTracker();
  t.feed(userStr('q'));
  t.feed(toolUse('r1', 'Bash', { command: 'sleep 1' }));
  t.feed(toolUse('r2', 'Bash', { command: 'sleep 2' }));
  const first = t.feed(toolResult('r1', 'done'));
  assert.equal(first.items[0].tool?.output, 'done');
  const cut = t.feed(userBlocks([{ type: 'text', text: '[Request interrupted by user]' }]));
  const failed = cut.items.find((i) => i.uuid === 'r2');
  assert.equal(failed?.tool?.status, 'error');
  assert.equal('output' in (failed?.tool as object), false, 'an interrupted tool has nothing to preview');
});

test('output: feedAll hands the final item, with its output, in the place the tool_use took', () => {
  const u = feedAll([userStr('q'), toolUse('b1', 'Read', { file_path: '/p/a.md' }), toolResult('b1', '# title')]);
  assert.equal(u.items.length, 2);
  assert.deepEqual(u.items[1].tool, { id: 'b1', name: 'Read', summary: u.items[1].tool?.summary, status: 'ok', output: '# title' });
});
