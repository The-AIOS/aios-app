/**
 * In chat view, selecting text in the conversation copies it, as the terminal view does.
 *
 * The bug: a drag in terminal view copies on its own, so an operator in chat view selected a
 * passage, pasted, and got whatever was on the clipboard before. These tests EXECUTE the real
 * helpers against a fake selection and a fake glassShell.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';

const app = fs.readFileSync('renderer/app.js', 'utf8');

function grab(re: RegExp, what: string): string {
  const m = re.exec(app);
  if (!m) assert.fail(`${what} must be findable in renderer/app.js`);
  return m[0];
}

type Cfg = { cc: { copyOnSelect: boolean } | null; keys: Record<string, boolean> };

function harness(selText: string, inLog: boolean, cfg: Cfg) {
  const copied: string[] = [];
  const node = {};
  const sel = {
    isCollapsed: !selText, rangeCount: selText ? 1 : 0,
    getRangeAt: () => ({ commonAncestorContainer: node }),
    toString: () => selText,
  };
  const win = {
    getSelection: () => sel,
    glassShell: {
      claudeConfig: async () => { if (!cfg.cc) throw new Error('unreadable'); return cfg.cc; },
      claudeSetKeys: async () => cfg.keys,
      copyText: async (t: string) => { copied.push(t); },
    },
  };
  const src = [
    grab(/function chatSkinLogSelection\([\s\S]*?\n\}/, 'chatSkinLogSelection'),
    grab(/async function chatCopyOnSelectOn\([\s\S]*?\n\}/, 'chatCopyOnSelectOn'),
    grab(/function chatSkinCopySelection\([\s\S]*?\n\}/, 'chatSkinCopySelection'),
  ].join('\n');
  const copy = new Function('window', `${src}; return chatSkinCopySelection;`)(win) as (cs: unknown) => void;
  const cs = { log: { contains: (n: unknown) => inLog && n === node } };
  return { run: async () => { copy(cs); await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); }, copied };
}

test('a selection in the chat log is copied when copyOnSelect is on', async () => {
  const h = harness('un párrafo', true, { cc: { copyOnSelect: true }, keys: { copyOnSelect: true } });
  await h.run();
  assert.deepEqual(h.copied, ['un párrafo']);
});

test('an unset copyOnSelect takes Claude\'s default, which is on', async () => {
  const h = harness('x', true, { cc: { copyOnSelect: false }, keys: { copyOnSelect: false } });
  await h.run();
  assert.deepEqual(h.copied, ['x']);
});

test('copyOnSelect explicitly off copies nothing', async () => {
  const h = harness('x', true, { cc: { copyOnSelect: false }, keys: { copyOnSelect: true } });
  await h.run();
  assert.deepEqual(h.copied, []);
});

test('an empty selection, or one outside this log, copies nothing', async () => {
  const a = harness('', true, { cc: { copyOnSelect: true }, keys: {} });
  await a.run();
  const b = harness('x', false, { cc: { copyOnSelect: true }, keys: {} });
  await b.run();
  assert.deepEqual([...a.copied, ...b.copied], []);
});

test('the chat log listens for the end of a drag', () => {
  assert.match(app, /log\.addEventListener\('mouseup', \(\) => chatSkinCopySelection\(cs\)\);/);
});
