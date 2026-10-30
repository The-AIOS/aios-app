/**
 * Chat skin — following a transcript file live (main/transcriptTail), plus the invariants that keep
 * its wiring in main/preload honest. The tail imports nothing from electron, so these tests run it
 * for real against a temp folder: files that appear late, lines written in two halves, truncation,
 * and a watcher that must stop the moment it is told to.
 *
 * Fixtures are hand-written and neutral. Each behaviour has a NEGATIVE CONTROL beside it (the
 * half-line that must NOT be emitted yet, the unwatched pane that must stay silent).
 */
import { test, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as ts from 'typescript';
import { createTranscriptTail, locateTranscript, isSessionId, TAIL_LINES, TAIL_MAX_BYTES, type TailEvent } from '../main/transcriptTail';
import { createTranscriptTracker, isConversationLine } from '../core/transcriptChat';
import { normalizeClaudeView, shellSettings, setShellSetting } from '../main/aios';
import type { ChatItem } from '../core/transcriptChat';

type Ev = { paneId: number } & TailEvent;
const SID = '11111111-2222-4333-8444-555555555555';
const SID2 = '66666666-7777-4888-8999-aaaaaaaaaaaa';

const line = (o: object): string => JSON.stringify(o) + '\n';
let n = 0;
const user = (text: string): string => line({ parentUuid: null, isSidechain: false, type: 'user', uuid: `u-${++n}`, message: { role: 'user', content: text } });
const answer = (text: string, stop = 'end_turn'): string =>
  line({ parentUuid: null, isSidechain: false, type: 'assistant', uuid: `a-${++n}`, message: { model: 'm', stop_reason: stop, content: [{ type: 'text', text }], usage: { input_tokens: 1, cache_read_input_tokens: 10 } } });

function sandbox(): { base: string; dir: string; file: (sid?: string) => string; done: () => void } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-tail-'));
  const dir = path.join(base, '-some-project-slug');
  fs.mkdirSync(dir);
  return { base, dir, file: (sid = SID) => path.join(dir, `${sid}.jsonl`), done: () => fs.rmSync(base, { recursive: true, force: true }) };
}

async function waitFor(cond: () => boolean, ms = 3000, what = 'condition'): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
/** Every tail a test makes is closed at the end even if the test threw, or a failure would leave an
 *  fs.watch handle open and the whole run would hang instead of reporting it. */
const made: Array<ReturnType<typeof createTranscriptTail>> = [];
const mkTail = (o: Parameters<typeof createTranscriptTail>[0]): ReturnType<typeof createTranscriptTail> => { const t = createTranscriptTail(o); made.push(t); return t; };
after(() => { for (const t of made) t.unwatchAll(); });
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const textsOf = (evs: Ev[]): string[] => evs.flatMap((e) => (e.type === 'items' ? e.items.map((i: ChatItem) => i.text ?? '') : []));

test('one pane, two sessions (/clear, resume): the tail follows the id it was given last, and nothing from the one it left is emitted after the switch', async () => {
  const sb = sandbox();
  fs.writeFileSync(sb.file(SID), user('old question') + answer('old answer'));
  const evs: Ev[] = [];
  const tail = mkTail({ projectsDir: () => sb.base, pollMs: 20 });
  const emit = (e: Ev): void => { evs.push(e); };
  assert.equal((await tail.watch(7, SID, emit)).ok, true);
  await waitFor(() => evs.some((e) => e.type === 'turn'), 3000, 'the first backfill');
  assert.deepEqual(tail.current(7), { sessionId: SID, file: sb.file(SID) });

  // /clear: the pane now follows an id whose transcript does not exist yet — "missing", and NO reset (the view must empty itself)
  const mark = evs.length;
  assert.deepEqual(await tail.watch(7, SID2, emit), { ok: false, error: 'not-found' });
  assert.deepEqual(tail.current(7), { sessionId: SID2 }, 'the watcher moved to the new id, with no file yet');
  fs.appendFileSync(sb.file(SID), user('late line of the old session'));   // the old file keeps growing; nobody follows it any more
  await sleep(150);
  const quiet = evs.slice(mark);
  assert.ok(quiet.some((e) => e.type === 'missing'), 'the new id is announced as missing');
  assert.ok(!quiet.some((e) => e.type === 'reset'), 'a missing file emits no reset: the renderer has to empty the old session itself');
  assert.deepEqual(textsOf(quiet), [], 'nothing of the old session (not even its late line) is emitted once the pane moved on');

  // the new transcript appears: reset first, then only ITS lines
  fs.writeFileSync(sb.file(SID2), user('new question') + answer('new answer'));
  await waitFor(() => evs.slice(mark).some((e) => e.type === 'reset'), 3000, 'the reset for the new file');
  await waitFor(() => textsOf(evs.slice(mark)).includes('new answer'), 3000, 'the new backfill');
  const fresh = evs.slice(mark);
  assert.deepEqual(textsOf(fresh), ['new question', 'new answer']);
  assert.deepEqual(tail.current(7), { sessionId: SID2, file: sb.file(SID2) });

  // resume to the ORIGINAL transcript: reset, then everything once — including the line it gained while it was not followed
  const mark2 = evs.length;
  assert.equal((await tail.watch(7, SID, emit)).ok, true);
  await waitFor(() => textsOf(evs.slice(mark2)).includes('late line of the old session'), 3000, 'the resumed backfill');
  const back = evs.slice(mark2);
  assert.equal(back[0].type, 'reset', 'the first thing is a reset');
  assert.deepEqual(textsOf(back), ['old question', 'old answer', 'late line of the old session'], 'each line once, none of the other session');
  assert.deepEqual(tail.current(7), { sessionId: SID, file: sb.file(SID) });
  fs.appendFileSync(sb.file(SID2), user('late line of the cleared session'));
  await sleep(150);
  assert.ok(!textsOf(evs.slice(mark2)).includes('late line of the cleared session'), 'the session left behind stays silent');
  tail.unwatch(7);
  assert.equal(tail.current(7), undefined, 'unwatched: nothing is followed');
  sb.done();
});

test('a file that already exists is backfilled in one pass, then the end state is announced', async () => {
  const sb = sandbox();
  fs.writeFileSync(sb.file(), user('first question') + answer('first answer'));
  const evs: Ev[] = [];
  const tail = mkTail({ projectsDir: () => sb.base, pollMs: 25 });
  const r = await tail.watch(7, SID, (e) => evs.push(e));
  assert.deepEqual(r, { ok: true, file: sb.file() });
  await waitFor(() => evs.some((e) => e.type === 'turn'), 3000, 'the backfill to finish');
  assert.equal(evs[0].type, 'reset', 'the view is emptied before anything arrives');
  assert.deepEqual(textsOf(evs), ['first question', 'first answer']);
  const turn = evs.find((e) => e.type === 'turn');
  assert.deepEqual(turn && 'open' in turn ? turn.open : undefined, false);
  assert.ok(evs.every((e) => e.paneId === 7), 'every event carries the pane id');
  const usage = evs.find((e) => e.type === 'usage');
  assert.ok(usage && 'contextTokens' in usage && usage.contextTokens === 11);
  tail.unwatchAll(); sb.done();
});

test('a transcript that does not exist yet: not-found, a missing event, then it appears and streams', async () => {
  const sb = sandbox();
  const evs: Ev[] = [];
  const tail = mkTail({ projectsDir: () => sb.base, pollMs: 25 });
  const r = await tail.watch(1, SID, (e) => evs.push(e));
  assert.deepEqual(r, { ok: false, error: 'not-found' });
  assert.equal(evs.filter((e) => e.type === 'missing').length, 1, 'told once, not on every retry');
  await sleep(120);
  assert.equal(evs.filter((e) => e.type === 'missing').length, 1);
  assert.deepEqual(textsOf(evs), [], 'control: nothing to show while the file is absent');
  assert.deepEqual(tail.active(), [1], 'it keeps looking');

  fs.writeFileSync(sb.file(), user('hello from a new session'));
  await waitFor(() => textsOf(evs).includes('hello from a new session'), 3000, 'the late file');
  assert.ok(evs.some((e) => e.type === 'reset'), 'the arrival resets the view before streaming');
  tail.unwatchAll(); sb.done();
});

test('a line written in two halves is held back until its newline, and nothing is lost or duplicated', async () => {
  const sb = sandbox();
  fs.writeFileSync(sb.file(), user('before'));
  const evs: Ev[] = [];
  const tail = mkTail({ projectsDir: () => sb.base, pollMs: 20 });
  await tail.watch(2, SID, (e) => evs.push(e));
  await waitFor(() => evs.some((e) => e.type === 'turn'));

  const whole = answer('a long answer with ünïcode and 日本語 inside');
  const cut = Math.floor(whole.length / 2);
  fs.appendFileSync(sb.file(), whole.slice(0, cut));
  await sleep(150);
  assert.deepEqual(textsOf(evs), ['before'], 'control: half a line is NOT emitted');
  assert.ok(!evs.some((e) => e.type === 'error'), 'and a half line is not an error');

  fs.appendFileSync(sb.file(), whole.slice(cut));
  await waitFor(() => textsOf(evs).length === 2, 3000, 'the second half');
  assert.deepEqual(textsOf(evs), ['before', 'a long answer with ünïcode and 日本語 inside']);
  await sleep(100);
  assert.equal(textsOf(evs).length, 2, 'no duplicate from later polls');
  tail.unwatchAll(); sb.done();
});

test('a multi-byte character split across two reads is decoded whole', async () => {
  const sb = sandbox();
  const reply = answer('日本語日本語日本語日本語');
  const CHUNK = 4096;   // the module's floor for a read
  // pad the first line until the first 3-byte character straddles the end of the first read
  let prefix = '';
  for (let k = 100; k < 2 * CHUNK; k++) {
    const p = user('x'.repeat(k));
    const at = Buffer.byteLength(p) + Buffer.byteLength(reply.slice(0, reply.indexOf('日')));
    if (at % CHUNK === CHUNK - 1) { prefix = p; break; }
  }
  assert.ok(prefix, 'found an alignment that splits a character');
  fs.writeFileSync(sb.file(), prefix + reply);
  const evs: Ev[] = [];
  const tail = mkTail({ projectsDir: () => sb.base, pollMs: 20, chunkBytes: CHUNK });
  await tail.watch(3, SID, (e) => evs.push(e));
  await waitFor(() => textsOf(evs).length === 2);
  assert.equal(textsOf(evs)[1], '日本語日本語日本語日本語');
  assert.ok(!textsOf(evs).join('').includes('\ufffd'), 'no replacement characters');
  tail.unwatchAll(); sb.done();
});

test('appended lines stream incrementally with turn and usage updates', async () => {
  const sb = sandbox();
  fs.writeFileSync(sb.file(), '');
  const evs: Ev[] = [];
  const tail = mkTail({ projectsDir: () => sb.base, pollMs: 20 });
  await tail.watch(4, SID, (e) => evs.push(e));
  await waitFor(() => evs.some((e) => e.type === 'turn'));
  const before = evs.length;
  fs.appendFileSync(sb.file(), user('live question'));
  await waitFor(() => evs.slice(before).some((e) => e.type === 'turn' && e.open === true), 3000, 'turn open');
  fs.appendFileSync(sb.file(), answer('live answer'));
  await waitFor(() => evs.slice(before).some((e) => e.type === 'turn' && e.open === false), 3000, 'turn closed');
  assert.deepEqual(textsOf(evs.slice(before)), ['live question', 'live answer']);
  assert.ok(evs.slice(before).some((e) => e.type === 'usage'));
  tail.unwatchAll(); sb.done();
});

test('unwatch stops emitting and leaves no watcher behind', async () => {
  const sb = sandbox();
  fs.writeFileSync(sb.file(), user('one'));
  const evs: Ev[] = [];
  const tail = mkTail({ projectsDir: () => sb.base, pollMs: 20 });
  await tail.watch(5, SID, (e) => evs.push(e));
  await waitFor(() => evs.some((e) => e.type === 'turn'));
  assert.deepEqual(tail.active(), [5]);

  tail.unwatch(5);
  assert.deepEqual(tail.active(), []);
  const count = evs.length;
  fs.appendFileSync(sb.file(), answer('after unwatch'));
  await sleep(200);
  assert.equal(evs.length, count, 'silent after unwatch');

  // control: the same append IS seen while watching
  const seen: Ev[] = [];
  await tail.watch(5, SID, (e) => seen.push(e));
  await waitFor(() => textsOf(seen).includes('after unwatch'));
  // unwatching a pane that was never watched is harmless
  tail.unwatch(999);
  tail.unwatchAll();
  assert.deepEqual(tail.active(), []);
  sb.done();
});

test('unwatch while the file is still missing stops the search', async () => {
  const sb = sandbox();
  const evs: Ev[] = [];
  const tail = mkTail({ projectsDir: () => sb.base, pollMs: 20 });
  await tail.watch(6, SID, (e) => evs.push(e));
  tail.unwatch(6);
  fs.writeFileSync(sb.file(), user('too late'));
  await sleep(150);
  assert.deepEqual(textsOf(evs), []);
  assert.deepEqual(tail.active(), []);
  sb.done();
});

test('changing the session id on a pane drops the old watch and starts the new one', async () => {
  const sb = sandbox();
  fs.writeFileSync(sb.file(SID), user('old session'));
  fs.writeFileSync(sb.file(SID2), user('new session'));
  const evs: Ev[] = [];
  const tail = mkTail({ projectsDir: () => sb.base, pollMs: 20 });
  await tail.watch(8, SID, (e) => evs.push(e));
  await waitFor(() => textsOf(evs).includes('old session'));
  const r = await tail.watch(8, SID2, (e) => evs.push(e));
  assert.deepEqual(r, { ok: true, file: sb.file(SID2) });
  await waitFor(() => textsOf(evs).includes('new session'));
  assert.deepEqual(tail.active(), [8], 'one watcher per pane');

  const count = evs.length;
  fs.appendFileSync(sb.file(SID), answer('old file still growing'));
  await sleep(150);
  assert.equal(evs.length, count, 'the old file no longer reaches the pane');
  fs.appendFileSync(sb.file(SID2), answer('new file growing'));
  await waitFor(() => textsOf(evs).includes('new file growing'));
  tail.unwatchAll(); sb.done();
});

test('truncation or replacement resets the view and re-reads from the top', async () => {
  const sb = sandbox();
  fs.writeFileSync(sb.file(), user('a long original line number one') + answer('a long original answer'));
  const evs: Ev[] = [];
  const tail = mkTail({ projectsDir: () => sb.base, pollMs: 20 });
  await tail.watch(9, SID, (e) => evs.push(e));
  await waitFor(() => textsOf(evs).length === 2);
  const resets = evs.filter((e) => e.type === 'reset').length;

  fs.writeFileSync(sb.file(), user('new'));   // shorter than what was read: a truncate/replace
  await waitFor(() => textsOf(evs).includes('new'), 3000, 'the re-read');
  assert.equal(evs.filter((e) => e.type === 'reset').length, resets + 1);
  tail.unwatchAll(); sb.done();
});

test('finish takes a last pass before stopping (the closing lines land as the session exits)', async () => {
  const sb = sandbox();
  fs.writeFileSync(sb.file(), user('q'));
  const evs: Ev[] = [];
  // a poll so slow it cannot be what picks the last line up
  const tail = mkTail({ projectsDir: () => sb.base, pollMs: 60_000 });
  await tail.watch(10, SID, (e) => evs.push(e));
  await waitFor(() => evs.some((e) => e.type === 'turn'));
  fs.appendFileSync(sb.file(), answer('the very last answer'));
  await tail.finish(10);
  assert.ok(textsOf(evs).includes('the very last answer'));
  assert.deepEqual(tail.active(), []);
  sb.done();
});

test('ids that are not id-shaped never touch the filesystem', async () => {
  const sb = sandbox();
  const tail = mkTail({ projectsDir: () => sb.base, pollMs: 20 });
  for (const bad of ['', '..', '../../etc/passwd', 'short', 'a/b/cccccccc', 'ok-but with space', 'x'.repeat(8) + '/..']) {
    assert.deepEqual(await tail.watch(11, bad, () => {}), { ok: false, error: 'bad-id' }, JSON.stringify(bad));
  }
  assert.deepEqual(tail.active(), []);
  assert.equal(isSessionId(SID), true, 'control: a real id is accepted');
  assert.equal(await locateTranscript(sb.base, '../' + SID), undefined);
  sb.done();
});

test('locateTranscript searches every project folder and honours the injected base', async () => {
  const sb = sandbox();
  fs.mkdirSync(path.join(sb.base, '-other-slug'));
  fs.writeFileSync(path.join(sb.base, '-other-slug', `${SID2}.jsonl`), '');
  assert.equal(await locateTranscript(sb.base, SID2), path.join(sb.base, '-other-slug', `${SID2}.jsonl`));
  assert.equal(await locateTranscript(sb.base, SID), undefined, 'control: absent stays absent');
  assert.equal(await locateTranscript(path.join(sb.base, 'nope'), SID2), undefined, 'a missing base is not an error');
  sb.done();
});

// ── wiring invariants (source) ──────────────────────────────────────────────

const read = (f: string): string => fs.readFileSync(f, 'utf8');
const main = read('src/main/main.ts');
const preload = read('src/preload/preload.ts');
const aios = read('src/main/aios.ts');

test('main and preload agree on every chatSkin channel, and the SDK is gone', () => {
  const invoked = new Set([...preload.matchAll(/ipcRenderer\.invoke\('(chatSkin:[a-zA-Z]+|chat:[a-zA-Z]+)'/g)].map((m) => m[1]));
  const handled = new Set([...main.matchAll(/ipcMain\.handle\('(chatSkin:[a-zA-Z]+|chat:[a-zA-Z]+)'/g)].map((m) => m[1]));
  assert.deepEqual([...invoked].sort(), ['chat:status', 'chatSkin:earlier', 'chatSkin:unwatch', 'chatSkin:watch']);
  assert.deepEqual([...handled].sort(), [...invoked].sort(), 'a channel with only one side is a button that does nothing');
  assert.match(preload, /ipcRenderer\.on\('chatSkin:event'/);
  assert.match(main, /sender\.send\('chatSkin:event', ev\)/);
  for (const gone of ['chatStart', 'chatSend', 'chatInterrupt', 'chatPermission', 'chatClose', 'onChatEvent']) {
    assert.doesNotMatch(preload, new RegExp(`\\b${gone}\\b`), `${gone} belonged to the SDK chat`);
  }
  for (const gone of ["'chat:start'", "'chat:send'", "'chat:interrupt'", "'chat:permission'", "'chat:close'"]) {
    assert.ok(!main.includes(gone), `${gone} belonged to the SDK chat`);
  }
  assert.doesNotMatch(main, /chatSession|createChatManager|claude-agent-sdk/);
  assert.equal(fs.existsSync('src/main/chatSession.ts'), false);
  assert.doesNotMatch(read('package.json'), /claude-agent-sdk/);
});

test('the preload exposes exactly the contract the renderer programs against', () => {
  assert.match(preload, /chatSkinWatch: \(paneId: number, sessionId: string \| null\): Promise<\{ ok: true; file: string \} \| \{ ok: false; error: string \}>/);
  assert.match(preload, /chatSkinUnwatch: \(paneId: number\): Promise<void>/);
  assert.match(preload, /onChatSkinEvent: \(cb: \(ev: ChatSkinEvent\) => void\)/);
  assert.match(preload, /chatStatus: \(sessionId: string \| null\): Promise<ChatStatus> => ipcRenderer\.invoke\('chat:status', sessionId\)/);
  for (const t of ['reset', 'items', 'turn', 'usage', 'prompt', 'missing', 'error']) {
    assert.match(preload, new RegExp(`type: '${t}'`), `event type ${t} is part of the contract`);
  }
});

test('the watch is tied to the pty: fed by its output, ended by its exit, kill, and the window', () => {
  assert.match(main, /sk\.monitor\.push\(data\)/, 'pty output feeds the dialog detector (until the renderer sends real screens)');
  assert.match(main, /p\.onExit\([^\n]*endSkin\(id, true\)/, 'pty exit ends the watch (after a last pass)');
  assert.match(main, /ipcMain\.on\('pty:kill'[^\n]*endSkin\(id, false\)/, 'a killed pane ends the watch');
  assert.match(main, /sender\.once\('destroyed', onGone\)/, 'a destroyed window ends the watch');
  assert.match(main, /removeListener\('destroyed', k\.onGone\)/, 'and the listener does not pile up');
  assert.match(main, /win\.on\('closed', \(\) => \{ tail\.unwatchAll\(\)/);
  assert.match(main, /app\.on\('before-quit', \(\) => \{ tail\.unwatchAll\(\)/);
  // the pane id is the pty id: the id pty:spawn hands out is the one the skin map is keyed by
  assert.match(main, /const id = nextId\+\+;\n\s+ptys\.set\(id, p\);/);
  assert.match(main, /k = \{ sender, monitor, onGone, screenFed: false, stream: createStreamTracker\(\), following: false, send \};\n\s+skins\.set\(id, k\)/);
});

test('a dialog is cleared only by proof from the transcript, not by assistant text', () => {
  const m = /monitor\.clear\(\);/.exec(main);
  assert.ok(m, 'the monitor is cleared somewhere');
  assert.match(main, /it\.role === 'user' \|\| \(it\.tool && it\.tool\.status !== 'running'\)/);
});

/** The migration function, compiled from aios.ts as written (optionally mutated first), so a control can break the SOURCE and watch the behaviour change. */
function compileNormalizer(mutate: (src: string) => string = (x) => x): (raw: Record<string, unknown>) => string {
  const m = /export function normalizeClaudeView[\s\S]*?\n\}\n/.exec(aios);
  assert.ok(m, 'normalizeClaudeView is in aios.ts');
  const src = mutate(m[0]);
  const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const exp: Record<string, unknown> = {};
  new Function('exports', js)(exp);
  return exp.normalizeClaudeView as (raw: Record<string, unknown>) => string;
}
/** What every stored shape must become: the migration table of the setting. */
const MIGRATION: Array<[string, Record<string, unknown>, string]> = [
  ['old checkbox ticked -> chat', { chatViewDefault: true }, 'chat'],
  ['old checkbox unticked -> terminal', { chatViewDefault: false }, 'terminal'],
  ['nothing stored -> terminal', {}, 'terminal'],
  ['only a literal true counts (a hand-edit "true")', { chatViewDefault: 'true' }, 'terminal'],
  ['only a literal true counts (1)', { chatViewDefault: 1 }, 'terminal'],
  ['explicit terminal beats a ticked old box', { claudeView: 'terminal', chatViewDefault: true }, 'terminal'],
  ['explicit chat beats an unticked old box', { claudeView: 'chat', chatViewDefault: false }, 'chat'],
  ['explicit chat with no old key', { claudeView: 'chat' }, 'chat'],
  ['an unknown stored value falls back to the old key (true)', { claudeView: 'both', chatViewDefault: true }, 'chat'],
  ['an unknown stored value falls back to the old key (absent)', { claudeView: 7 }, 'terminal'],
];
test('claudeView migrates from chatViewDefault: true -> chat, false or absent -> terminal, and an explicit value wins', () => {
  for (const [name, raw, want] of MIGRATION) {
    assert.equal(normalizeClaudeView(raw), want, name);
    assert.equal(compileNormalizer()(raw), want, `${name} (the compiled source agrees with the import)`);
  }
});
test('claudeView migration: negative controls — a source that forgets the old key, or lets it beat the new one, fails the table', () => {
  const fails = (mutate: (x: string) => string): boolean => {
    const f = compileNormalizer(mutate);
    return MIGRATION.some(([, raw, want]) => f(raw) !== want);
  };
  assert.ok(fails((x) => x.replace("raw.chatViewDefault === true ? 'chat' : 'terminal'", "'terminal'")), 'control: the old checkbox is ignored');
  assert.ok(fails((x) => x.replace("raw.chatViewDefault === true ? 'chat' : 'terminal'", "raw.chatViewDefault ? 'chat' : 'terminal'")), 'control: any truthy old value counts');
  assert.ok(fails((x) => x.replace("  if (raw.claudeView === 'chat' || raw.claudeView === 'terminal') return raw.claudeView;\n", '')), 'control: the explicit value no longer wins');
  assert.ok(fails((x) => x.replace("return raw.chatViewDefault === true ? 'chat' : 'terminal';", "return raw.chatViewDefault === false ? 'terminal' : 'chat';")), 'control: absent means chat');
});
test('shellSettings reads claudeView from the stored file, migrating the old key, and the shell:setSetting door validates it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-claudeview-'));
  const home = path.join(root, 'home');
  const fw = path.join(root, 'fw');
  fs.mkdirSync(path.join(fw, '.glass'), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const saved = { h: process.env.HOME, u: process.env.USERPROFILE, f: process.env.GLASS_FRAMEWORK_PATH };
  process.env.HOME = home; process.env.USERPROFILE = home; process.env.GLASS_FRAMEWORK_PATH = fw;   // ~/.aios/app.json must not point elsewhere
  try {
    const viewFor = (stored: object | null): string => {
      if (stored) fs.writeFileSync(path.join(fw, '.glass', 'shell.json'), JSON.stringify(stored)); else fs.rmSync(path.join(fw, '.glass', 'shell.json'), { force: true });
      return shellSettings().claudeView;
    };
    assert.equal(viewFor(null), 'terminal');
    assert.equal(viewFor({ chatViewDefault: true }), 'chat');
    assert.equal(viewFor({ chatViewDefault: false }), 'terminal');
    assert.equal(viewFor({ claudeView: 'terminal', chatViewDefault: true }), 'terminal');
    assert.equal(viewFor({ claudeView: 'chat' }), 'chat');
    setShellSetting('claudeView', 'terminal');   // the first save supersedes the old key, which stays in the file for an older app
    assert.equal(shellSettings().claudeView, 'terminal');
  } finally {
    for (const [k, v] of [['HOME', saved.h], ['USERPROFILE', saved.u], ['GLASS_FRAMEWORK_PATH', saved.f]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(root, { recursive: true, force: true });
  }
  // the door: only the two values are stored, and the old key is no longer writable from the renderer
  const door = /ipcMain\.handle\('shell:setSetting'[\s\S]*?\n\}\);/.exec(main)?.[0] ?? '';
  assert.match(door, /'lidAsked' \| 'claudeView', value: unknown\)/);
  assert.doesNotMatch(door.split('=> {')[0], /chatViewDefault/);
  assert.match(door, /if \(key === 'claudeView' && value !== 'chat' && value !== 'terminal'\) return aios\.shellSettings\(\);\n\s+aios\.setShellSetting\(key, value\);/);
  assert.match(aios, /claudeView: ClaudeView;/);
  assert.match(aios, /claudeView: normalizeClaudeView\(raw\)/);
  const guard = /if \(key === 'claudeView' && value !== 'chat' && value !== 'terminal'\) return aios\.shellSettings\(\);\n\s+aios\.setShellSetting\(key, value\);/;
  assert.doesNotMatch(door.replace("if (key === 'claudeView' && value !== 'chat' && value !== 'terminal') return aios.shellSettings();\n", ''), guard, 'control: without the guard line the check fails');
});

test('chat:status reads the global statusline payload without the SDK', () => {
  assert.match(main, /ipcMain\.handle\('chat:status', async \(_e, sessionId: unknown\) => \{/);
  assert.match(main, /statusline-payload\.json/);
  // the payload is global: it must pass through the per-session filter before anything reaches the renderer
  assert.match(main, /mergeStatus\(undefined, scopeStatusToSession\(parseStatuslinePayload\(/);
  assert.match(main, /isSessionId\(sessionId\) \? sessionId : null/);
  assert.doesNotMatch(main, /mergeStatus\(undefined, parseStatuslinePayload\(/, 'an unscoped merge would hand back another session\'s model and context');
});


// ── a long transcript is read as a TAIL, and what is above it on request ─────
//
// The view keeps every row it is sent, so sending a whole history made its size, memory and per-line cost grow with the file
// (scripts/chat-bench.mjs: 160k DOM nodes / 1.3 GB at 50k lines vs 15k / 270 MB at 5k). These run the real tail on real files.

const tool = (id: string, name: string): string => line({ parentUuid: null, isSidechain: false, type: 'assistant', uuid: `t-${++n}`, message: { model: 'm', stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input: { command: 'ls' } }] } });
const toolDone = (id: string, out: string): string => line({ parentUuid: null, isSidechain: false, type: 'user', uuid: `r-${++n}`, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: out }] } });
const bookkeeping = (bytes: number): string => line({ type: 'api-request-blob', data: 'x'.repeat(bytes) });
/** `pairs` question/answer pairs: texts q0,a0,q1,a1…, each long enough that a few thousand bytes hold only a few of them. */
const longChat = (pairs: number): string => Array.from({ length: pairs }, (_, i) => user(`q${i} ${'.'.repeat(60)}`) + answer(`a${i} ${'.'.repeat(60)}`)).join('');
const allTexts = (pairs: number): string[] => Array.from({ length: pairs }, (_, i) => [`q${i} ${'.'.repeat(60)}`, `a${i} ${'.'.repeat(60)}`]).flat();
const SMALL = { chunkBytes: 4096, tailLines: 40, tailMaxBytes: 1024 * 1024 };

async function loadAll(tail: ReturnType<typeof createTranscriptTail>, evs: Ev[], pane: number): Promise<{ batches: string[][]; more: boolean[] }> {
  const batches: string[][] = []; const more: boolean[] = [];
  for (let i = 0; i < 200; i++) {
    const seen = evs.filter((e) => e.type === 'earlier').length;
    assert.equal(await tail.loadEarlier(pane), true);
    await waitFor(() => evs.filter((e) => e.type === 'earlier').length > seen, 3000, 'the earlier window');
    const e = evs.filter((x) => x.type === 'earlier')[seen];
    if (e.type !== 'earlier') throw new Error('unreachable');
    batches.push(e.items.map((it) => it.text ?? '')); more.push(e.more);
    if (!e.more) break;
  }
  return { batches, more };
}

test('the window is a tail: a long file delivers about the same number of items however long it is, and says there is more above', async () => {
  const delivered = async (pairs: number, opts: Parameters<typeof createTranscriptTail>[0]): Promise<{ texts: string[]; span: Ev | undefined; evs: Ev[] }> => {
    const sb = sandbox();
    fs.writeFileSync(sb.file(), longChat(pairs));
    const evs: Ev[] = [];
    const tail = mkTail({ ...opts, projectsDir: () => sb.base, pollMs: 25 });
    await tail.watch(7, SID, (e) => evs.push(e));
    await waitFor(() => evs.some((e) => e.type === 'turn'), 5000, 'the backfill to finish');
    tail.unwatchAll(); sb.done();
    return { texts: textsOf(evs), span: evs.find((e) => e.type === 'span'), evs };
  };
  const small = await delivered(300, SMALL);
  const big = await delivered(3000, SMALL);
  assert.ok(small.texts.length >= 40 && small.texts.length < 120, `a window of ~40 lines, not the file (got ${small.texts.length})`);
  assert.ok(big.texts.length < small.texts.length + 20, `ten times the file, the same window (${small.texts.length} vs ${big.texts.length})`);
  assert.deepEqual(big.texts.slice(-4), allTexts(3000).slice(-4), 'it is the END of the file');
  assert.ok(!big.texts.includes(allTexts(3000)[0]), 'the start of the file is not sent');
  assert.deepEqual(big.span, { paneId: 7, type: 'span', earlier: true });
  assert.deepEqual(big.evs.slice(0, 2).map((e) => e.type), ['reset', 'span'], 'the view is emptied, then told whether there is more above');
  const idx = big.evs.findIndex((e) => e.type === 'items');
  assert.ok(idx > 1 && big.evs.findIndex((e) => e.type === 'turn') > idx, 'items, then the end state');
  // the shipped defaults, no options: a file of 4000 lines (~760 KB) is still not delivered whole
  const shipped = await delivered(2000, {});
  assert.ok(shipped.texts.length >= 300 && shipped.texts.length < 2500, `the default window is a tail too (got ${shipped.texts.length} of 4000)`);
  assert.equal(shipped.span?.type === 'span' && shipped.span.earlier, true);
  // NEGATIVE CONTROL: with a window as big as the file everything is delivered and nothing is "above" — the cap is what bounds it
  const whole = await delivered(300, { ...SMALL, tailLines: 100000 });
  assert.equal(whole.texts.length, 600);
  assert.deepEqual(whole.span, { paneId: 7, type: 'span', earlier: false });
});

test('the byte cap bounds a file whose lines are huge, however many lines it has', async () => {
  const sb = sandbox();
  // 60 conversation lines, each followed by 40 KB of bookkeeping: 300 lines would be ~2 MB, the cap is 64 KB
  fs.writeFileSync(sb.file(), Array.from({ length: 60 }, (_, i) => user(`row ${i}`) + bookkeeping(40000)).join(''));
  const evs: Ev[] = [];
  const tail = mkTail({ projectsDir: () => sb.base, pollMs: 25, chunkBytes: 4096, tailLines: 300, tailMaxBytes: 64 * 1024 });
  await tail.watch(7, SID, (e) => evs.push(e));
  await waitFor(() => evs.some((e) => e.type === 'turn'), 5000, 'the backfill to finish');
  const got = textsOf(evs);
  assert.ok(got.length >= 1 && got.length <= 3, `read ~64 KB, not 2 MB (got ${got.length} rows)`);
  assert.equal(got[got.length - 1], 'row 59');
  // control: lift the cap and every row arrives
  const evs2: Ev[] = [];
  const t2 = mkTail({ projectsDir: () => sb.base, pollMs: 25, chunkBytes: 4096, tailLines: 300, tailMaxBytes: 64 * 1024 * 1024 });
  await t2.watch(8, SID, (e) => evs2.push(e));
  await waitFor(() => evs2.some((e) => e.type === 'turn'), 5000, 'the uncapped backfill');
  assert.equal(textsOf(evs2).length, 60);
  assert.equal(TAIL_LINES, 300); assert.ok(TAIL_MAX_BYTES >= 1024 * 1024 && TAIL_MAX_BYTES <= 64 * 1024 * 1024, 'the shipped caps are bounded constants');
  tail.unwatchAll(); t2.unwatchAll(); sb.done();
});

test('loadEarlier walks back window by window: every line once, in order, nothing from below it repeated, and it ends', async () => {
  const sb = sandbox();
  fs.writeFileSync(sb.file(), longChat(300));
  const evs: Ev[] = [];
  const tail = mkTail({ projectsDir: () => sb.base, pollMs: 25, ...SMALL });
  await tail.watch(7, SID, (e) => evs.push(e));
  await waitFor(() => evs.some((e) => e.type === 'turn'), 5000, 'the backfill to finish');
  const first = textsOf(evs);
  const { batches, more } = await loadAll(tail, evs, 7);
  assert.ok(batches.length >= 3, 'several windows');
  assert.equal(more[more.length - 1], false); assert.ok(more.slice(0, -1).every(Boolean), 'more:true until the top');
  const stitched = [...batches.reverse().flat(), ...first];   // newest window last in the file, so the last batch received is the oldest
  assert.deepEqual(stitched, allTexts(300), 'oldest first, each line exactly once, no gap');
  // asking again at the top: an empty, final answer rather than silence
  const seen = evs.filter((e) => e.type === 'earlier').length;
  assert.equal(await tail.loadEarlier(7), true);
  await waitFor(() => evs.filter((e) => e.type === 'earlier').length > seen, 3000, 'the answer at the top');
  const last = evs.filter((e) => e.type === 'earlier')[seen];
  assert.deepEqual(last.type === 'earlier' ? [last.items.length, last.more] : null, [0, false]);
  // control: with nothing watched, or not yet located, there is nothing to answer with
  assert.equal(await tail.loadEarlier(99), false);
  tail.unwatchAll(); sb.done();
});

test('a window never cuts a tool call in two: the call and its result arrive together, and a call from an earlier window is never left running', async () => {
  const sb = sandbox();
  // the result is in the last 4 KB chunk, its call is ~6 KB before it (behind one long operator message)
  fs.writeFileSync(sb.file(), longChat(10) + tool('toolu_seam', 'Bash') + user('x'.repeat(6000)) + toolDone('toolu_seam', 'ok output') + answer('the end'));
  const run = async (extraChunks: boolean): Promise<ChatItem[]> => {
    const evs: Ev[] = [];
    const tail = mkTail({ projectsDir: () => sb.base, pollMs: 25, chunkBytes: 4096, tailLines: 1, tailMaxBytes: 1024 * 1024 });
    await tail.watch(7, SID, (e) => evs.push(e));
    await waitFor(() => evs.some((e) => e.type === 'turn'), 5000, 'the backfill');
    if (extraChunks) await loadAll(tail, evs, 7);
    tail.unwatchAll();
    return evs.flatMap((e) => (e.type === 'items' || e.type === 'earlier' ? e.items : []));
  };
  const items = await run(true);
  const calls = items.filter((i) => i.uuid === 'toolu_seam');
  assert.equal(new Set(calls.map((c) => c.uuid)).size, 1);
  assert.ok(calls.length >= 1 && calls.every((c) => c.tool?.status === 'ok' && c.tool.output === 'ok output'), 'the call carries its result wherever the window began');
  assert.ok(!items.some((i) => i.tool?.status === 'running'), 'no call is left spinning at a seam');
  // the same file as ONE pass over a tracker that starts at the result: that is the half-call the extension exists to avoid
  const lines = (fs.readFileSync(sb.file(), 'utf8')).split('\n').filter(Boolean);
  const cut = createTranscriptTracker(); cut.feedAll(lines.slice(lines.findIndex((l) => l.includes('toolu_seam') && l.includes('tool_result'))));
  assert.equal(cut.snapshot().orphanResults, 1, 'control: a window that starts at the result does see an orphan');
  const whole = createTranscriptTracker(); whole.feedAll(lines);
  assert.equal(whole.snapshot().orphanResults, 0, 'control: the whole file has none');
  sb.done();
});

test('a line no window can hold is stepped over: the view reaches what is above it instead of asking for the same window forever', async () => {
  const sb = sandbox();
  const huge = user('x'.repeat(2 * 1024 * 1024));
  fs.writeFileSync(sb.file(), user('above the line') + huge + user('below 1') + user('below 2'));
  const evs: Ev[] = [];
  const tail = mkTail({ projectsDir: () => sb.base, pollMs: 25, chunkBytes: 4096, tailLines: 2, tailMaxBytes: 1024 * 1024 });
  await tail.watch(7, SID, (e) => evs.push(e));
  await waitFor(() => evs.some((e) => e.type === 'turn'), 5000, 'the backfill');
  assert.deepEqual(textsOf(evs), ['below 1', 'below 2'], 'control: the window stops at the line it cannot hold');
  assert.equal(await tail.loadEarlier(7), true);
  const answer1 = evs.filter((e) => e.type === 'earlier').at(-1) as Extract<Ev, { type: 'earlier' }>;
  assert.deepEqual(answer1.items.map((i) => i.text), ['above the line'], 'the first answer already moved past the line');
  assert.equal(answer1.more, false, 'and the top of the file ends the paging');
  tail.unwatchAll();
  // the same line at the very END of the file: the first window must not come up empty
  fs.writeFileSync(sb.file(), user('before the end') + huge);
  const evs2: Ev[] = [];
  const t2 = mkTail({ projectsDir: () => sb.base, pollMs: 25, chunkBytes: 4096, tailLines: 2, tailMaxBytes: 1024 * 1024 });
  await t2.watch(8, SID, (e) => evs2.push(e));
  await waitFor(() => evs2.some((e) => e.type === 'turn'), 5000, 'the backfill of the second file');
  assert.deepEqual(textsOf(evs2), ['before the end']);
  t2.unwatchAll();
  sb.done();
});

test('what is above belongs to the transcript that is watched: a replaced file or a pane that moved on never answers with the old one', async () => {
  const sb = sandbox();
  fs.writeFileSync(sb.file(SID), longChat(200));
  fs.writeFileSync(sb.file(SID2), Array.from({ length: 200 }, (_, i) => user(`other ${i} ${'.'.repeat(60)}`)).join(''));
  const evs: Ev[] = [];
  const tail = mkTail({ projectsDir: () => sb.base, pollMs: 20, ...SMALL });
  await tail.watch(7, SID, (e) => evs.push(e));
  await waitFor(() => evs.some((e) => e.type === 'turn'), 5000, 'the first backfill');
  // a request in flight while the pane moves to another session: its answer is never delivered
  const mark = evs.length;
  const pending = tail.loadEarlier(7);
  const evs2: Ev[] = [];
  await tail.watch(7, SID2, (e) => evs2.push(e));
  await pending;
  await waitFor(() => evs2.some((e) => e.type === 'turn'), 5000, 'the second backfill');
  await sleep(100);
  assert.ok(!evs.slice(mark).some((e) => e.type === 'earlier'), 'the old session never gets (or sends) the window it asked for');
  const { batches } = await loadAll(tail, evs2, 7);
  assert.ok(batches.flat().every((t) => t.startsWith('other ')), 'every earlier line is from the session now watched');
  // the file is replaced under a live watcher: re-windowed from its own end, and "above" is the new file's
  const evs3: Ev[] = [];
  const t3 = mkTail({ projectsDir: () => sb.base, pollMs: 20, ...SMALL });
  await t3.watch(8, SID, (e) => evs3.push(e));
  await waitFor(() => evs3.some((e) => e.type === 'turn'), 5000, 'backfill 3');
  fs.rmSync(sb.file(SID)); fs.writeFileSync(sb.file(SID), Array.from({ length: 150 }, (_, i) => user(`fresh ${i} ${'.'.repeat(60)}`)).join(''));
  await waitFor(() => evs3.filter((e) => e.type === 'span').length >= 2, 5000, 'the re-window');
  await waitFor(() => textsOf(evs3).some((x) => x.startsWith('fresh 149')), 5000, 'the new file');
  const { batches: b3 } = await loadAll(t3, evs3, 8);
  assert.ok(b3.flat().length > 0 && b3.flat().every((t) => t.startsWith('fresh ')), 'above the replaced file is the replaced file');
  tail.unwatchAll(); t3.unwatchAll(); sb.done();
});

test('lines written after the window are streamed as before, exactly once, even while the window is being read', async () => {
  const sb = sandbox();
  fs.writeFileSync(sb.file(), longChat(200));
  const evs: Ev[] = [];
  const tail = mkTail({ projectsDir: () => sb.base, pollMs: 20, ...SMALL });
  await tail.watch(7, SID, (e) => evs.push(e));
  fs.appendFileSync(sb.file(), user('written during the load'));
  await waitFor(() => evs.some((e) => e.type === 'turn'), 5000, 'the backfill');
  fs.appendFileSync(sb.file(), answer('written after the load'));
  await waitFor(() => textsOf(evs).includes('written after the load'), 3000, 'the live line');
  const all = textsOf(evs);
  assert.equal(all.filter((t) => t === 'written during the load').length, 1);
  assert.equal(all.filter((t) => t === 'written after the load').length, 1);
  assert.equal(all.length, new Set(all).size, 'no line twice');
  tail.unwatchAll(); sb.done();
});

test('isConversationLine: bookkeeping lines (led by their type) are not conversation; user, assistant and system are', () => {
  assert.equal(isConversationLine('{"type":"api-request-blob","data":"x"}'), false);
  assert.equal(isConversationLine('{"type":"attachment"}'), false);
  assert.equal(isConversationLine('{"parentUuid":null,"type":"user","uuid":"u"}'), true);
  assert.equal(isConversationLine('{"type":"system","subtype":"turn_duration"}'), true);
  assert.equal(isConversationLine('   '), false);
});
