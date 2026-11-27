/**
 * The daily note's `## Agents can handle` section, run against the framework's shared cases.
 *
 * `/today` writes the section; this App and Glass parse it. The two parsers were the same text
 * and agreed with each other, and neither was ever run against the line `/today` is told to
 * write: every parser test used a bold label, the template has none. So the template line never
 * matched its own task checked in another section, and a project wikilink in the task text was
 * dispatched as the agent.
 *
 * The fixture is a byte-identical copy of the framework's
 * `tests/fixtures/agents-can-handle.cases.json`, pinned to the hash the framework pins too. The
 * copy and the pin are a stopgap: the cases file moves into the surfaces' shared package when
 * that exists, and both go away then. Until then, a change to the cases lands in the framework
 * first, and this copy and PIN move with it.
 *
 * Set AIOS_FRAMEWORK_SRC to a framework checkout to also compare the copy against the original.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as aios from '../main/aios';

const REPO = path.join(__dirname, '..', '..');
const FIX = path.join(REPO, 'src', 'test', 'fixtures', 'agents-can-handle.cases.json');
const PIN = '1fab9364afa50166a71f4d2eb5d5c98acde903970fcbc8576e55eecbf3b8cbf0';

interface Expected { task: string; agents: string[]; command?: string; arg?: string }
interface Case { case: string; note: string[]; expect: { count: number; suggestions: Expected[] } }

const raw = fs.readFileSync(FIX, 'utf8').replace(/\r\n/g, '\n');
const fx = JSON.parse(raw) as { cases: Case[] };

test('the cases file is the framework\'s, unedited', () => {
  assert.equal(crypto.createHash('sha256').update(raw).digest('hex'), PIN,
    'src/test/fixtures/agents-can-handle.cases.json differs from the pinned copy: change it in the framework first, then copy it here and move PIN');
  assert.ok(fx.cases.length >= 30);
});

test('the copy matches a framework checkout, when one is named', (t) => {
  const src = process.env.AIOS_FRAMEWORK_SRC;
  if (!src) { t.skip('AIOS_FRAMEWORK_SRC not set'); return; }
  const theirs = fs.readFileSync(path.join(src, 'tests', 'fixtures', 'agents-can-handle.cases.json'), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(raw, theirs, 'the framework\'s cases file moved: copy it here and move PIN');
});

for (const c of fx.cases) {
  test(`agents can handle: ${c.case}`, () => {
    const got = aios.parseAgentSection(c.note.join('\n')).map((s) => {
      const o: Expected = { task: s.task, agents: s.agents };
      if (s.command !== undefined) o.command = s.command;
      if (s.arg !== undefined) o.arg = s.arg;
      return o;
    });
    assert.deepEqual(got, c.expect.suggestions);
    assert.equal(got.length, c.expect.count);
  });
}

// ── dispatching a suggestion stamps its line ────────────────────────────────
//
// Glass stamps 🚀 on each line it hands to an agent, so the count drops and the line cannot be
// handed out twice. The App typed the command into a session and stamped nothing.

const ROCKET = '\u{1F680}';
const stamp = aios.stampAgentLine;

const NOTE = [
  '## Today I ship',
  '- [ ] Draft the deck',
  '- 🤖 Draft the deck _(→ agent: [[deck-builder]])_',
  '',
  '## Agents can handle',
  '- 🤖 Draft the deck _(→ agent: [[deck-builder]])_',
  '- 🤖 Ingest the keynote _(→ command: `/aios:ingest`)_',
  '',
  '## Radar',
].join('\n');

test('stampAgentLine: stamps the line inside the section and nothing else', () => {
  const line = '- 🤖 Draft the deck _(→ agent: [[deck-builder]])_';
  const out = stamp(NOTE, line);
  assert.ok(out, 'a line in the section is stamped');
  const lines = out!.split('\n');
  assert.equal(lines[5], line + ' ' + ROCKET, 'the section line carries the stamp');
  assert.equal(lines[2], line, 'the same text outside the section is left alone');
  assert.equal(out!.split(ROCKET).length - 1, 1, 'exactly one stamp');
  assert.deepEqual(aios.parseAgentSection(out!).map((s) => s.task), ['Ingest the keynote']);
});

test('stampAgentLine: a line already stamped, or not in the section, changes nothing', () => {
  const line = '- 🤖 Draft the deck _(→ agent: [[deck-builder]])_';
  const once = stamp(NOTE, line)!;
  assert.equal(stamp(once, line), null, 'the line is gone from the open set: no second stamp');
  assert.equal(stamp(NOTE, '- 🤖 Not there _(→ agent: [[x]])_'), null);
  assert.equal(stamp(NOTE, '- [ ] Draft the deck'), null, 'a task outside the section is never stamped');
});

test('stampAgentLine: keeps the note\'s line endings', () => {
  const crlf = NOTE.replace(/\n/g, '\r\n');
  const out = stamp(crlf, '- 🤖 Ingest the keynote _(→ command: `/aios:ingest`)_')!;
  assert.ok(out.includes('`/aios:ingest`)_ ' + ROCKET + '\r\n'));
  assert.equal(out.replace(' ' + ROCKET, ''), crlf, 'nothing else moved');
});

let root = '';
let notePath = '';
before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-app-stamp-'));
  const d = new Date();
  const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  notePath = path.join(root, 'vault', '01 - calendar', iso.slice(0, 7), `${iso}.md`);
  fs.mkdirSync(path.dirname(notePath), { recursive: true });
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# Test framework\n');
});

test('stampAgentSuggestion: the dispatched line leaves the list and the count', () => {
  const prev = process.env.GLASS_FRAMEWORK_PATH;
  process.env.GLASS_FRAMEWORK_PATH = root;
  try {
    fs.writeFileSync(notePath, NOTE);
    const open = aios.listAgentSuggestions();
    assert.equal(open.length, 2);
    const fn = aios.stampAgentSuggestion;
    assert.equal(fn(open[0].raw), true);
    assert.equal(aios.countAgentSuggestions(), 1);
    assert.deepEqual(aios.listAgentSuggestions().map((s) => s.task), ['Ingest the keynote']);
    assert.equal(fn(open[0].raw), false, 'dispatching it again finds nothing to stamp');
    assert.equal(fs.readFileSync(notePath, 'utf8').split(ROCKET).length - 1, 1);
  } finally {
    if (prev === undefined) delete process.env.GLASS_FRAMEWORK_PATH; else process.env.GLASS_FRAMEWORK_PATH = prev;
  }
});

// The picker lives in the renderer; these EXECUTE the real function out of renderer/app.js.
const app = fs.readFileSync(path.join(REPO, 'renderer', 'app.js'), 'utf8');
function pickerHarness(pick: unknown, dispatched: boolean) {
  const m = /async function pickSuggestion\(\) \{[\s\S]*?\n\}/.exec(app);
  if (!m) assert.fail('pickSuggestion must be findable in renderer/app.js');
  const ran: string[] = [];
  const stamped: string[] = [];
  const window = { glassShell: {
    aiosLists: async () => ({ suggestions: [pick] }),
    aiosStampSuggestion: async (r: string) => { stamped.push(r); return true; },
  } };
  const run = new Function('window', 'toast', 't', 'listModal', 'runWhere', m[0] + '\nreturn pickSuggestion;')(
    window, () => undefined, (k: string) => k, async () => pick,
    async (slash: string) => { ran.push(slash); return dispatched; },
  ) as () => Promise<void>;
  return { run, ran, stamped };
}

test('picker: a dispatched agent suggestion is stamped', async () => {
  const h = pickerHarness({ task: 'Draft the deck', agent: 'deck-builder', raw: '- 🤖 Draft the deck _(→ agent: [[deck-builder]])_' }, true);
  await h.run();
  assert.deepEqual(h.ran, ['/aios:agent deck-builder — Draft the deck']);
  assert.deepEqual(h.stamped, ['- 🤖 Draft the deck _(→ agent: [[deck-builder]])_']);
});

test('picker: a dispatched command suggestion is stamped', async () => {
  const h = pickerHarness({ task: 'Ingest the keynote', command: '/aios:ingest', url: 'https://example.com/talk', raw: 'RAW' }, true);
  await h.run();
  assert.deepEqual(h.ran, ['/aios:ingest https://example.com/talk']);
  assert.deepEqual(h.stamped, ['RAW']);
});

test('picker: backing out of "run where?" stamps nothing', async () => {
  const h = pickerHarness({ task: 'Draft the deck', agent: 'deck-builder', raw: 'RAW' }, false);
  await h.run();
  assert.equal(h.ran.length, 1);
  assert.deepEqual(h.stamped, [], 'nothing was handed to an agent, so the line stays open');
});

test('the stamp is wired end to end: one channel name, and the badge is re-posted', () => {
  const main = fs.readFileSync(path.join(REPO, 'src', 'main', 'main.ts'), 'utf8');
  const preload = fs.readFileSync(path.join(REPO, 'src', 'preload', 'preload.ts'), 'utf8');
  const handler = /ipcMain\.handle\('aios:stampSuggestion',[^\n]*/.exec(main);
  assert.ok(handler, 'main.ts handles aios:stampSuggestion');
  assert.match(handler![0], /aios\.stampAgentSuggestion\(/);
  assert.match(handler![0], /; if \(r\) host\?\.postState\(\); return r; \}\);$/, 'the count is displayed state: re-post it when a line was stamped');
  assert.match(preload, /aiosStampSuggestion: \(raw: string\)[^\n]*ipcRenderer\.invoke\('aios:stampSuggestion', raw\)/);
  assert.match(app, /window\.glassShell\.aiosStampSuggestion\(v\.raw\)/);
});

// runWhere tells the picker whether anything was handed over. EXECUTED, path by path: a regex
// over its source cannot tell `return true` from a path that falls off the end.
function runWhereHarness(mode: string, live: string[], choice: string | null, openPane: string | null) {
  const m = /async function runWhere\(slash, name\) \{[\s\S]*?\n\}/.exec(app);
  if (!m) assert.fail('runWhere must be findable in renderer/app.js');
  const did: string[] = [];
  const panes = new Map<string, { exited: boolean }>();
  if (openPane) panes.set('p1', { exited: false });
  const run = new Function(
    'window', 'pulse', 'runInPrimary', 't', 'statusInfo', 'listModal', 'createPane', 'CLAUDE', 'shq', 'byName', 'panes', 'submitToPty', 'setActive',
    m[0] + '\nreturn runWhere;',
  )(
    { glassShell: { shellConfig: async () => ({ terminalMode: mode }) } },
    { lastRunning: { running: live.map((name) => ({ name, status: 'idle' })) } },
    async () => { did.push('primary'); },
    (k: string) => k, () => ({ label: '' }), async () => choice,
    () => { did.push('pane'); }, 'claude', (x: string) => x,
    (n: string) => (openPane === n ? ['p1'] : null), panes,
    () => { did.push('typed'); }, () => undefined,
  ) as (slash: string, name: string) => Promise<unknown>;
  return { run, did };
}

for (const [what, mode, live, choice, open, want, did] of [
  ['no live session: runs in the primary', 'ask', [], null, null, true, ['primary']],
  ['terminal mode is not "ask": runs in the primary', 'primary', ['a'], null, null, true, ['primary']],
  ['picker dismissed', 'ask', ['a'], null, null, false, []],
  ['"new terminal" picked', 'ask', ['a'], '__new', null, true, ['pane']],
  ['a live session picked', 'ask', ['a'], 'a', 'a', true, ['typed']],
  ['a session picked that has no open pane', 'ask', ['a'], 'a', null, true, ['pane']],
] as [string, string, string[], string | null, string | null, boolean, string[]][]) {
  test(`runWhere reports a dispatch — ${what}`, async () => {
    const h = runWhereHarness(mode, live, choice, open);
    assert.equal(await h.run('/aios:today', 'today'), want);
    assert.deepEqual(h.did, did);
  });
}
