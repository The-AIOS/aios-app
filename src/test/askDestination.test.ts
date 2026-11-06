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

const destOf = (src: string): ((v: string) => { kind: string; name?: string }) =>
  new Function(fn(src, 'askDestOf') + 'return askDestOf;')();

test('the picker defaults to a new session, and reads a live session or an agent', () => {
  const askDestOf = destOf(app);
  assert.deepEqual(askDestOf('new:'), { kind: 'new' }, 'the first option: a new session, today\'s behaviour');
  assert.deepEqual(askDestOf(''), { kind: 'new' });
  assert.deepEqual(askDestOf('session:warm-puma'), { kind: 'session', name: 'warm-puma' });
  assert.deepEqual(askDestOf('agent:lawyer'), { kind: 'agent', name: 'lawyer' });
  assert.deepEqual(askDestOf('agent:'), { kind: 'new' }, 'no name, no destination');
  assert.deepEqual(askDestOf('shell:rm'), { kind: 'new' }, 'an unknown kind never becomes a send');
  /* Negative control: a parser that trusts any kind lets an unknown one through. */
  const loose = destOf(app.replace("return (kind === 'session' || kind === 'agent') && name ? { kind, name } : { kind: 'new' };", 'return { kind, name };'));
  assert.notDeepEqual(loose('shell:rm'), { kind: 'new' }, 'control: without the check the unknown kind leaks through');
  assert.match(app, /destSel\.appendChild\(new Option\(t\('ask\.destNew'\), 'new:'\)\);/, 'New session is the first option, so it is selected by default');
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
