/**
 * The Ask panel's destination (0.15.0 test round): a new session by default, or a live session, or an agent,
 * through the same inbox request the floating quick bar writes. These run the real functions out of
 * renderer/app.js and src/main/quickBar.ts.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const app = fs.readFileSync('renderer/app.js', 'utf8');
const fn = (src: string, name: string): string => {
  const head = src.indexOf('function ' + name + '(');
  assert.ok(head >= 0, `${name} must be findable in renderer/app.js`);
  const start = src.lastIndexOf('\n', head) + 1;
  return src.slice(start, src.indexOf('\n}\n', head) + 2);
};

/* The shared picker (renderer/askdest.js) run for real in a tiny fake page: the module only needs `window`. */
const askdest = fs.readFileSync('renderer/askdest.js', 'utf8');
const loadAskDest = (src: string): { buildRows: (q: string, d: unknown, S: unknown) => Array<Record<string, unknown>> } => {
  const win: Record<string, unknown> = {};
  new Function('window', src)(win);
  return win.AskDest as never;
};
const S = { newSession: 'New session', sessions: 'Live sessions', agents: 'Agents' };
const DATA = { sessions: [{ name: 'warm-puma', waiting: true }, { name: 'bold-orca' }], agents: [{ name: 'lawyer', desc: 'contracts' }, { name: 'accountant', desc: 'books' }] };

test('0.15.0 round 2: one picker for both doors, New session first, then Live sessions, then Agents, filtered', () => {
  const { buildRows } = loadAskDest(askdest);
  const all = buildRows('', DATA, S);
  assert.deepEqual(all[0], { kind: 'new', name: '', label: 'New session' }, 'New session first: today\'s behaviour is the default');
  assert.deepEqual(all.map((r) => r.group || r.name), ['', 'Live sessions', 'warm-puma', 'bold-orca', 'Agents', 'lawyer', 'accountant']);
  assert.equal(all.find((r) => r.name === 'warm-puma')!.waiting, true, 'a session waiting on you is marked');
  const f = buildRows('contr', DATA, S);
  assert.deepEqual(f.map((r) => r.group || r.name), ['', 'Agents', 'lawyer'], 'the filter matches an agent by its description; empty sections disappear; New session stays');
  /* Negative control: a picker that ignores the filter shows everything. */
  const loose = loadAskDest(askdest.replace("const hit = (s) => !f || String(s || '').toLowerCase().includes(f);", 'const hit = () => true;'));
  assert.notDeepEqual(loose.buildRows('contr', DATA, S).length, f.length, 'control: without the filter every row shows');
});

test('0.15.0 round 2: the Ask panel uses the shared picker, never a native <select>, and Tab opens it', () => {
  const modal = app.slice(app.indexOf('/* opts.destField'), app.indexOf('/* opts.hint'));
  assert.doesNotMatch(modal, /createElement\('select'\)|new Option\(/, 'no native select: it read as foreign to the App');
  assert.match(modal, /window\.AskDest\.mount\(chipHost, listHost, \{/);
  assert.match(modal, /if \(e\.key === 'Tab' && !e\.shiftKey\) \{ e\.preventDefault\(\); destPick\.open\(\); \}/);
  assert.match(app, /if \(destPick\) out\.dest = destPick\.dest\.kind === 'new' \? \{ kind: 'new' \} : \{ kind: destPick\.dest\.kind, name: destPick\.dest\.name \};/);
  assert.match(fs.readFileSync('renderer/index.html', 'utf8'), /<script src="askdest\.js"><\/script>\s*<script src="app\.js"><\/script>/, 'loaded before the App');
  assert.match(app, /case 'ask': void onIntentAsk\(\); return;/, 'the menu bar and the bus open the same Ask, destinations included');
});

test('0.15.0 round 2: the floating Ask is the same Ask: same picker, same words', () => {
  const html = fs.readFileSync('renderer/quickbar.html', 'utf8');
  assert.match(html, /<script src="askdest\.js"><\/script>\s*<script src="quickbar\.js"><\/script>/);
  assert.doesNotMatch(html, /<ul id="items">/, 'no list of its own');
  assert.match(fs.readFileSync('renderer/quickbar.js', 'utf8'), /picker = window\.AskDest\.mount\(\$\('dest'\), \$\('list'\), \{/);
  const qb = fs.readFileSync('src/main/quickBar.ts', 'utf8');
  for (const k of ['ask.title', 'ask.placeholder', 'ask.destNew', 'ask.destSessions', 'ask.destAgents']) assert.match(qb, new RegExp(`t\\('${k.replace('.', '\\.')}'\\)`), k);
  const css = fs.readFileSync('renderer/theme.css', 'utf8');
  assert.match(css, /\.adest-chip \{/, 'one look, in theme.css, for both pages');
});

test('each destination takes its own path: a new session launches as before, the others go to the inbox', async () => {
  const run = async (dest: unknown) => {
    const calls: string[] = [];
    const onIntentAsk = new Function('askWithChips', 'launchAsk', 'sendAskTo', fn(app, 'onIntentAsk') + 'return onIntentAsk;')(
      async () => ({ intent: 'review the contract', name: 'n', dest }),
      async () => { calls.push('launchAsk'); },
      async (d: { kind: string; name: string }, text: string) => { calls.push(`send:${d.kind}:${d.name}:${text}`); },
    ) as () => Promise<void>;
    await onIntentAsk();
    return calls;
  };
  assert.deepEqual(await run({ kind: 'new' }), ['launchAsk']);
  assert.deepEqual(await run(undefined), ['launchAsk'], 'no destination at all is a new session');
  assert.deepEqual(await run({ kind: 'session', name: 'warm-puma' }), ['send:session:warm-puma:review the contract']);
  assert.deepEqual(await run({ kind: 'agent', name: 'lawyer' }), ['send:agent:lawyer:review the contract']);
});

test('a send goes through askSend and says where it went, or that nothing was written', async () => {
  const run = async (reply: unknown, dest: { kind: string; name: string }) => {
    const sent: unknown[] = [];
    const toasts: string[] = [];
    const sendAskTo = new Function('window', 'toast', 't', fn(app, 'sendAskTo') + 'return sendAskTo;')(
      { glassShell: { askSend: async (d: unknown, text: string) => { sent.push([d, text]); return reply; } } },
      (m: string) => toasts.push(m),
      (k: string, v?: { name: string }) => (v ? `${k}:${v.name}` : k),
    ) as (d: unknown, text: string) => Promise<void>;
    await sendAskTo(dest, 'hello');
    return { sent, toasts };
  };
  const a = await run({ ok: true, name: 'lawyer-2' }, { kind: 'agent', name: 'lawyer' });
  assert.deepEqual(a.sent, [[{ kind: 'agent', name: 'lawyer' }, 'hello']]);
  assert.deepEqual(a.toasts, ['ask.sentAgent:lawyer-2'], 'the session it really went to (a running agent gets a fresh copy)');
  const s = await run({ ok: true, name: 'warm-puma' }, { kind: 'session', name: 'warm-puma' });
  assert.deepEqual(s.toasts, ['ask.sentSession:warm-puma']);
  const f = await run({ ok: false, reason: 'write' }, { kind: 'session', name: 'x' });
  assert.deepEqual(f.toasts, ['ask.sendFailed']);
});

test('the request the panel writes is the quick bar\'s: a running agent becomes a fresh copy, a live session gets a send', () => {
  const Module = require('module') as { _load: (req: string, parent: unknown, isMain: boolean) => unknown };
  const orig = Module._load;
  Module._load = (req, parent, isMain) => (req === 'electron' ? {} : orig(req, parent, isMain));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-dest-'));
  try {
    const { writeAskRequest } = require('../main/quickBar') as typeof import('../main/quickBar');
    const deps = { inboxDir: () => dir, takenNames: () => ['lawyer', 'warm-puma'], log: () => {} };
    const ag = writeAskRequest({ kind: 'agent', name: 'lawyer' }, 'review it', deps);
    assert.deepEqual(ag, { ok: true, name: 'lawyer-2' }, 'a running lawyer is not revealed and the text dropped');
    const se = writeAskRequest({ kind: 'session', name: 'warm-puma' }, 'and this', deps);
    assert.deepEqual(se, { ok: true, name: 'warm-puma' });
    const bodies = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
    assert.ok(bodies.some((b) => b.name === 'lawyer-2' && /^\/aios:agent lawyer — review it$/.test(b.task) && b.surface === 'app'));
    assert.ok(bodies.some((b) => b.action === 'send' && b.name === 'warm-puma' && b.prompt === 'and this'));
    assert.equal(fs.readdirSync(dir).filter((f) => f.startsWith('.')).length, 0, 'no half-written file is left behind');
    assert.deepEqual(writeAskRequest({ kind: 'session', name: 'warm-puma' }, '  ', deps), { ok: false, reason: 'empty' }, 'nothing to say to a live session is not a send');
  } finally { Module._load = orig; fs.rmSync(dir, { recursive: true, force: true }); }
});

test('main serves the destinations and the send on every platform; the preload exposes both', () => {
  const main = fs.readFileSync('src/main/main.ts', 'utf8');
  assert.match(main, /ipcMain\.handle\('ask:destinations'/);
  assert.match(main, /ipcMain\.handle\('ask:send', \(_e, dest: QuickBarDestination, text: unknown\) => writeAskRequest\(/);
  const before = main.slice(0, main.indexOf("ipcMain.handle('ask:send'"));
  assert.doesNotMatch(before.slice(before.lastIndexOf('\n\n')), /QUICK_BAR_ALLOWED/, 'not behind the macOS-only quick bar gate');
  const pre = fs.readFileSync('src/preload/preload.ts', 'utf8');
  assert.match(pre, /askDestinations: \(\) => ipcRenderer\.invoke\('ask:destinations'\)/);
  assert.match(pre, /askSend: \(dest: \{ kind: string; name: string \}, text: string\) => ipcRenderer\.invoke\('ask:send', dest, text\)/);
});

test('the destination strings exist in every locale', () => {
  for (const l of ['en', 'es', 'pt-br', 'el']) {
    const j = JSON.parse(fs.readFileSync(`src/i18n/locales/${l}.json`, 'utf8')) as Record<string, string>;
    for (const k of ['ask.destLabel', 'ask.destNew', 'ask.destSessions', 'ask.destAgents', 'ask.sentSession', 'ask.sentAgent', 'ask.sendFailed']) assert.ok(j[k], `${l} ${k}`);
    assert.match(j['ask.sentAgent'], /\{name\}/, `${l}: says which session`);
  }
});

/* A tiny fake page, enough for AskDest.mount: elements with children, listeners, classList, hidden, focus. */
type FakeEl = {
  tag: string; className: string; hidden: boolean; textContent: string; value: string; children: FakeEl[]; type?: string;
  placeholder?: string; title?: string; spellcheck?: boolean; autocomplete?: string; focused?: boolean;
  classList: { add: (c: string) => void; remove: (c: string) => void };
  listeners: Record<string, Array<(e: unknown) => void>>;
  appendChild: (c: FakeEl) => FakeEl; append: (...c: FakeEl[]) => void; setAttribute: () => void;
  addEventListener: (t: string, f: (e: unknown) => void) => void; focus: () => void; scrollIntoView: () => void;
  fire: (t: string) => { defaultPrevented: boolean };
};
function fakeDocument(): { createElement: (t: string) => FakeEl } {
  const make = (tag: string): FakeEl => {
    const e: FakeEl = {
      tag, className: '', hidden: false, value: '', children: [], listeners: {},
      get textContent() { return this._t || ''; }, set textContent(v: string) { this._t = v; if (v === '') this.children = []; },
      classList: { add: () => {}, remove: () => {} },
      appendChild(c) { this.children.push(c); return c; }, append(...c) { this.children.push(...c); }, setAttribute() {},
      addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }, focus() { this.focused = true; }, scrollIntoView() {},
      fire(t) { const ev = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, key: '' }; for (const f of this.listeners[t] || []) f(ev); return ev; },
    } as FakeEl & { _t?: string };
    return e;
  };
  return { createElement: make };
}
const optionsOf = (list: FakeEl): FakeEl[] => list.children[1].children.filter((li) => li.className.startsWith('adest-it'));
function mountPicker(src: string) {
  const win: Record<string, unknown> = {};
  const doc = fakeDocument();
  new Function('window', 'document', src)(win, doc);
  const chipHost = doc.createElement('span'), listHost = doc.createElement('div'), input = doc.createElement('input');
  const changes: unknown[] = [];
  const picker = (win.AskDest as { mount: (...a: unknown[]) => { dest: { kind: string; name: string }; open: () => void; isOpen: () => boolean } })
    .mount(chipHost, listHost, { strings: { ...S, filter: 'f', waiting: 'w', agentTag: 'agent', sessionTag: 'session' }, load: () => ({ ...DATA }), returnFocus: input, onChange: (d: unknown) => changes.push(d) });
  return { picker, list: listHost.children[0], input, changes };
}

test('0.15.0 round 3: choosing a destination on mousedown would close the list under the pointer; it is chosen on click', async () => {
  const { picker, list, input, changes } = mountPicker(askdest);
  picker.open();
  await Promise.resolve(); await Promise.resolve();
  const opt = optionsOf(list).find((li) => li.children[0].textContent === 'lawyer') ?? optionsOf(list)[optionsOf(list).length - 1];
  const down = opt.fire('mousedown');
  assert.equal(down.defaultPrevented, true, 'mousedown keeps the focus where it is');
  assert.equal(picker.isOpen(), true, 'and does NOT close the list: the dialog must not shrink before the click lands');
  opt.fire('click');
  assert.equal(picker.isOpen(), false, 'the click chooses and closes the list');
  assert.equal(changes.length, 1);
  assert.equal(input.focused, true, 'focus goes back to the text field');
  /* Control: the round-2 picker, which chose on mousedown, closes the list on the press itself. */
  const old = askdest.replace(/li\.addEventListener\('mousedown', \(e\) => \{ e\.preventDefault\(\); \}\);\n\s*li\.addEventListener\('click', \(e\) => \{ e\.preventDefault\(\); e\.stopPropagation\(\); choose\(r\); \}\);/, "li.addEventListener('mousedown', (e) => { e.preventDefault(); choose(r); });");
  assert.notEqual(old, askdest, 'control applied');
  const r2 = mountPicker(old);
  r2.picker.open();
  await Promise.resolve(); await Promise.resolve();
  optionsOf(r2.list)[0].fire('mousedown');
  assert.equal(r2.picker.isOpen(), false, 'control: the old picker closed on mousedown, which is what let the click fall onto the backdrop');
});

test('0.15.0 round 3: the Ask dialog\'s backdrop cancels only a click that also started on it', () => {
  const body = fn(app, 'inputModal');
  assert.match(body, /wrap\.addEventListener\('mousedown', \(e\) => \{ downOnBackdrop = e\.target === wrap; \}\);/);
  assert.match(body, /wrap\.addEventListener\('click', \(e\) => \{ if \(e\.target === wrap && downOnBackdrop\) done\(null\);/);
  assert.doesNotMatch(body, /wrap\.addEventListener\('click', \(e\) => \{ if \(e\.target === wrap\) done\(null\); \}\);/);
});
