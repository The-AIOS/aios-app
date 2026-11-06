/**
 * The quick bar (docs/rfcs/menu-bar.md) — what it writes to the inbox, how it takes over *Launch agent*,
 * and the wiring promises that keep it from typing into a pane or fighting the menu for a keystroke.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { quickBarRequest, agentTask } from '../core/quickBar';

const ROOT = path.join(__dirname, '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const NOW = 1793800000000;

test('a message to a live session is an ordinary send, addressed to this surface', () => {
  const r = quickBarRequest({ kind: 'session', name: 'fama' }, '  ¿cómo vamos?  ', NOW);
  assert.deepEqual(r, { ok: true, file: `quick-bar-fama-${NOW}.json`, body: { action: 'send', name: 'fama', prompt: '¿cómo vamos?', surface: 'app' } });
});

test('a message to a live session must say something', () => {
  assert.deepEqual(quickBarRequest({ kind: 'session', name: 'fama' }, '   ', NOW), { ok: false, reason: 'empty' });
});

test('a new session is a spawn, with the text as its task — or none', () => {
  assert.deepEqual(quickBarRequest({ kind: 'new', name: 'Revisar PR' }, 'mirá el #12', NOW),
    { ok: true, file: `quick-bar-revisar-pr-${NOW}.json`, body: { name: 'revisar-pr', task: 'mirá el #12', surface: 'app' } });
  assert.deepEqual(quickBarRequest({ kind: 'new', name: 'vacia' }, '', NOW),
    { ok: true, file: `quick-bar-vacia-${NOW}.json`, body: { name: 'vacia', surface: 'app' } });
});

test('an agent starts with the same first prompt Launch agent sends', () => {
  const r = quickBarRequest({ kind: 'agent', name: 'lawyer' }, 'revisá este contrato', NOW);
  assert.ok(r.ok);
  assert.equal(r.body.task, '/aios:agent lawyer — revisá este contrato');
  assert.equal(agentTask('lawyer', ''), '/aios:agent lawyer');
  /* Pinned to the renderer's pickAgent(), which builds the same string for the in-App picker. */
  assert.match(read('renderer/app.js'), /const arg = task \? a\.name \+ ' — ' \+ task : a\.name;\s*\n\s*void runWhere\('\/aios:agent ' \+ arg, a\.name\);/);
});

test('an agent that is already running starts a second session under its own name, so the text is never dropped', () => {
  /* The bus only REVEALS a spawn whose name is running, and deletes the request: the operator's text would be lost. */
  const r = quickBarRequest({ kind: 'agent', name: 'lawyer', session: 'lawyer-2' }, 'revisá este contrato', NOW);
  assert.ok(r.ok);
  assert.equal(r.body.name, 'lawyer-2', 'the session takes the free name');
  assert.equal(r.body.task, '/aios:agent lawyer — revisá este contrato', 'the agent is still lawyer');
  assert.equal(r.file, `quick-bar-lawyer-2-${NOW}.json`);
  assert.deepEqual(quickBarRequest({ kind: 'agent', name: 'lawyer', session: '!!!' }, 'x', NOW), { ok: false, reason: 'name' });
  /* The main process is what picks the free name: pinned, because without it the core function above is never asked. */
  assert.match(read('src/main/quickBar.ts'), /kind: 'agent', name: String\(dest\.name \?\? ''\), session: uniqueName\(String\(dest\.name \?\? ''\), deps\.takenNames\(\)\)/);
});

test('no global shortcut until the operator picks one: a global key is taken from every other app', () => {
  const src = read('src/main/aios.ts');
  assert.match(src, /quickBarShortcut: typeof raw\.quickBarShortcut === 'string' \? raw\.quickBarShortcut\.trim\(\) : '',/);
  assert.doesNotMatch(src, /quickBarShortcut:[^\n]*Shift\+A/, 'no ⇧⌘A default: it is Slack\'s All unreads and Finder\'s Applications');
});

test('names are the bus’s own kebab handles, and a name that sanitises to nothing is refused', () => {
  assert.deepEqual(quickBarRequest({ kind: 'session', name: '!!!' }, 'hola', NOW), { ok: false, reason: 'name' });
  const r = quickBarRequest({ kind: 'new', name: '  Mi Sesión ' }, 'x', NOW);
  assert.ok(r.ok && r.body.name === 'mi-sesin');
});

test('the request carries no `from` and no field the fulfillers own', () => {
  /* `from` would let a newer message from the "same sender" supersede an older queued one: two things the
     operator typed must both arrive. `_`-prefixed fields are the fulfillers' bookkeeping. */
  for (const dest of [{ kind: 'new', name: 'a' }, { kind: 'agent', name: 'a' }, { kind: 'session', name: 'a' }] as const) {
    const r = quickBarRequest(dest, 'x', NOW);
    assert.ok(r.ok);
    assert.equal('from' in r.body, false);
    assert.equal(Object.keys(r.body).some((k) => k.startsWith('_')), false);
    assert.equal(r.body.surface, 'app', 'addressed to this surface, so another surface never races for it');
    assert.match(r.file, /\.json$/, 'the bus only reads *.json');
  }
});

test('two sends to one session a moment apart are two files', () => {
  const a = quickBarRequest({ kind: 'session', name: 'x' }, 'uno', NOW);
  const b = quickBarRequest({ kind: 'session', name: 'x' }, 'dos', NOW + 1);
  assert.ok(a.ok && b.ok && a.file !== b.file);
});

test('⇧⌘A stays Launch agent: the in-app agent picker, never the floating bar (0.15.0 test round)', async () => {
  /* Imported lazily with electron stubbed: menu.ts imports electron at the top. */
  const Module = require('module') as { _load: (req: string, parent: unknown, isMain: boolean) => unknown };
  const orig = Module._load;
  Module._load = (req, parent, isMain) => (req === 'electron' ? {} : orig(req, parent, isMain));
  try {
    const { launchAgentItem, LAUNCH_AGENT_ACCEL } = require('../main/menu') as typeof import('../main/menu');
    let legacy = 0;
    const item = launchAgentItem('L', () => { legacy++; });
    assert.equal(item.accelerator, 'CmdOrCtrl+Shift+A');
    assert.equal(LAUNCH_AGENT_ACCEL, 'CmdOrCtrl+Shift+A');
    assert.notEqual(item.registerAccelerator, false, 'registered: the menu owns ⇧⌘A inside the App');
    (item.click as () => void)();
    assert.equal(legacy, 1, 'it opens the agent picker');
  } finally { Module._load = orig; }
  const main = read('src/main/main.ts');
  assert.match(main, /installMenu\(\(\) => mainWin\);/, 'the menu no longer hands ⇧⌘A to the quick bar');
});

test('main: the bar exists only on macOS, outside test runs, and the main window is never "the first window"', () => {
  const main = read('src/main/main.ts');
  assert.match(main, /const QUICK_BAR_ALLOWED = \(\): boolean => process\.platform === 'darwin' && !SMOKE && !SHOT && !EVAL && !CHAT_SHOT;/);
  assert.doesNotMatch(main, /getAllWindows\(\)\[0\]/, 'with a second window, the first in the list is not a contract');
  assert.match(main, /if \(key === 'quickBarShortcut'\) applyQuickBar\(\);/, 'a new shortcut takes effect at once');
  assert.match(main, /quickBar\?\.dispose\(\)/, 'the global shortcut is released on quit');
});

test('the bar’s page only calls what its narrow preload exposes', () => {
  const preload = read('src/preload/quickBarPreload.ts');
  const exposed = new Set([...preload.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]));
  const used = new Set([...read('renderer/quickbar.js').matchAll(/api\.(\w+)\(/g)].map((m) => m[1]));
  for (const u of used) assert.ok(exposed.has(u), `quickbar.js calls api.${u}(), which the preload does not expose`);
  assert.doesNotMatch(preload, /pty|fs:|shell:setSetting/, 'the bar has no terminal, file or settings access');
  const qb = read('src/main/quickBar.ts');
  assert.match(qb, /quickBarPreload\.js/);
  assert.match(qb, /renameSync/, 'the request is written whole, then renamed into place');
});

test('the renderer scripts parse — a stray brace blanks the whole window, and nothing else here would say so', () => {
  for (const f of ['renderer/app.js', 'renderer/quickbar.js']) {
    assert.doesNotThrow(() => new vm.Script(read(f), { filename: f }), `${f} has a syntax error`);
  }
});
