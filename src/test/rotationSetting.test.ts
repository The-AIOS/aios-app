/**
 * #430: where the watcher rotates (5-hour and weekly limits) and whether it rotates on its own are ONE setting,
 * owned by the framework, which Settings shows and edits. The App reads it from `--availability`
 * (`rotation_setting`) and changes it only through `claude-identity.sh rotation --set`: it writes no file and
 * keeps no number. A framework that does not send the setting has no such command, so nothing is drawn.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readRotationSetting, readRotationAnswer, rotationSetArgs, readSwapRule } from '../main/swapOffer';

const ROOT = path.join(__dirname, '..', '..');
const SETTING = (over: Record<string, unknown> = {}) => ({
  five_hour: { value: 90, source: 'file' }, seven_day: { value: 98, source: 'default' },
  enabled: { value: true, source: 'default' }, min: 50, max: 98, ignored: [], ...over,
});
const NONE = Symbol('no rotation_setting');   // an older framework's row
const row = (email: string, setting: unknown = SETTING()) => ({
  email, state: 'available', rotate_at: { five_hour: 90, seven_day: 98 }, swap_offer_at: { five_hour: 87, seven_day: 95 },
  rotation_paused_until: null, ...(setting === NONE ? {} : { rotation_setting: setting }),
});

test('the setting is read from the framework answer, with where each value comes from', () => {
  const s = readRotationSetting(JSON.stringify([row('a@toy.test'), row('b@toy.test')]));
  assert.deepEqual(s, {
    fiveHour: { value: 90, source: 'file' }, sevenDay: { value: 98, source: 'default' },
    enabled: { value: true, source: 'default' }, min: 50, max: 98, ignored: [],
  });
  assert.deepEqual(readSwapRule(JSON.stringify([row('a@toy.test')])), { offerFiveHour: 87, offerSevenDay: 95, pausedUntil: null }, 'the swap rule still reads the same answer');
  assert.equal(readRotationSetting(JSON.stringify([row('a@toy.test', NONE)])), null, 'an older framework: no setting, so no editor');
  assert.equal(readRotationSetting(JSON.stringify([row('a', SETTING()), row('b', SETTING({ min: 60 }))])), null, 'rows that disagree are not a setting');
  assert.equal(readRotationSetting(JSON.stringify([row('a', SETTING()), row('b', NONE)])), null, 'a row without it is not a setting');
  for (const bad of [
    SETTING({ five_hour: { value: '90', source: 'file' } }), SETTING({ five_hour: { value: 90.5, source: 'file' } }),
    SETTING({ five_hour: { value: 0, source: 'file' } }), SETTING({ five_hour: { value: 90, source: 'plist' } }),
    SETTING({ enabled: { value: 'false', source: 'file' } }), SETTING({ min: 99, max: 98 }), SETTING({ max: null }), 'on', null,
  ]) assert.equal(readRotationSetting(JSON.stringify([row('a', bad)])), null, JSON.stringify(bad));
  for (const bad of ['', 'not json', '{}', '[]']) assert.equal(readRotationSetting(bad), null, JSON.stringify(bad));
  assert.equal(readRotationSetting(JSON.stringify([row('a', SETTING({ five_hour: { value: 20, source: 'environment' } }))]))?.fiveHour.value, 20,
    'a value from the environment keeps its own range (1-100), outside the stored 50-98');
  assert.deepEqual(readRotationSetting(JSON.stringify([row('a', SETTING({ ignored: ['x', 3] }))]))?.ignored, ['x'], 'only words are kept');
  assert.equal(readRotationAnswer(JSON.stringify(SETTING({ enabled: { value: false, source: 'file' } })))?.enabled.value, false, 'the answer of rotation --set is the setting itself');
  assert.equal(readRotationAnswer('[]'), null);
});

test('what is sent to the framework: only values it accepts, in its own words', () => {
  const s = readRotationSetting(JSON.stringify([row('a')]));
  assert.deepEqual(rotationSetArgs({ fiveHour: 90, sevenDay: 95 }, s), { args: ['5h=90', '7d=95'] });
  assert.deepEqual(rotationSetArgs({ enabled: false }, s), { args: ['off'] });
  assert.deepEqual(rotationSetArgs({ enabled: true }, s), { args: ['on'] });
  for (const bad of [{ fiveHour: 99 }, { fiveHour: 49 }, { sevenDay: 90.5 }, { fiveHour: NaN }, { fiveHour: Infinity }, {}, { enabled: 'off' as unknown as boolean }]) {
    assert.ok('error' in rotationSetArgs(bad, s), JSON.stringify(bad));
  }
  assert.ok('error' in rotationSetArgs({ fiveHour: 90 }, null), 'no setting from the framework: nothing is sent (an older script would not know the command)');
});

test('main changes it only through the framework command, and writes nothing itself', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'main', 'aios.ts'), 'utf8');
  const fn = src.slice(src.indexOf('export async function setRotation('), src.indexOf('export async function anthropicAccounts('));
  assert.match(fn, /rotationSetArgs\(change, rotationCache\)/, 'checked against what the framework reported');
  assert.match(fn, /runIdentity\(\['rotation', '--set', \.\.\.built\.args\]\)/, 'the framework\'s own command');
  assert.match(fn, /swapTriedAt = 0;/, 'the swap button follows the new numbers at once');
  assert.doesNotMatch(fn, /fs\.|writeFile|quota-rotation/, 'the App never writes the file');
  assert.match(src, /rotationCache = readRotationSetting\(ans\.out\);/, 'read from the same answer as the rows');
  const main = fs.readFileSync(path.join(ROOT, 'src', 'main', 'main.ts'), 'utf8');
  assert.match(main, /ipcMain\.handle\('rotation:get', \(\) => aios\.rotationSetting\(\)\);/);
  assert.match(main, /ipcMain\.handle\('rotation:set',/);
  const pre = fs.readFileSync(path.join(ROOT, 'src', 'preload', 'preload.ts'), 'utf8');
  assert.match(pre, /rotationGet: .*ipcRenderer\.invoke\('rotation:get'\)/);
  assert.match(pre, /rotationSet: .*ipcRenderer\.invoke\('rotation:set', change\)/);
});

/* A DOM just large enough for settingsRotationRows and row(), so the real functions run. */
class Node_ {
  children: Node_[] = []; hidden = false; className = ''; textContent = ''; type = ''; value = ''; min = ''; max = ''; step = '';
  checked = false; disabled = false; attrs: Record<string, string> = {}; handlers: Record<string, (() => void)[]> = {};
  constructor(public tag: string) {}
  append(...n: Node_[]) { this.children.push(...n); }
  appendChild(n: Node_) { this.children.push(n); return n; }
  replaceChildren() { this.children = []; }
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  addEventListener(ev: string, f: () => void) { (this.handlers[ev] ||= []).push(f); }
  fire(ev: string) { for (const f of this.handlers[ev] || []) f(); }
  all(): Node_[] { return this.children.flatMap((c) => [c, ...c.all()]); }
  querySelector(sel: string): Node_ | null { const cls = sel.replace(/^\./, ''); return this.all().find((n) => n.className.split(' ').includes(cls)) || null; }
}
async function mount(setting: unknown, setAnswer: (c: unknown) => unknown = () => ({ ok: true, setting })) {
  const app = fs.readFileSync(path.join(ROOT, 'renderer', 'app.js'), 'utf8');
  const grab = (name: string): string => app.slice(app.indexOf('function ' + name + '('), app.indexOf('\n}\n', app.indexOf('function ' + name + '(')) + 2);
  const sent: unknown[] = [], toasts: string[] = [];
  const document: { createElement: (tag: string) => Node_; activeElement: Node_ | null } = { createElement: (tag: string) => new Node_(tag), activeElement: null };
  const el = (tag: string, cls?: string, text?: string) => { const n = new Node_(tag); n.className = cls || ''; n.textContent = text || ''; return n; };
  const t = (k: string, p?: Record<string, unknown>) => (p ? `${k} ${JSON.stringify(p)}` : k);
  const window = { glassShell: { rotationGet: async () => setting, rotationSet: async (c: unknown) => { sent.push(c); return setAnswer(c); } } };
  const fn = new Function('document', 'el', 't', 'toast', 'window', grab('row') + '\n' + grab('settingsRotationRows') + '; return settingsRotationRows;')(
    document, el, t, (m: string) => toasts.push(m), window);
  const wrap = new Node_('div');
  fn(wrap);
  await new Promise((r) => setTimeout(r, 0));
  const box = wrap.children[0];
  const inputs = box.all().filter((n) => n.tag === 'input');
  return { box, inputs, sent, toasts, document, flush: () => new Promise((r) => setTimeout(r, 0)) };
}
const UI = (over: Record<string, unknown> = {}) => ({
  fiveHour: { value: 90, source: 'file' }, sevenDay: { value: 98, source: 'default' },
  enabled: { value: true, source: 'default' }, min: 50, max: 98, ignored: [], ...over,
});

test('Settings: an older framework draws nothing', async () => {
  const m = await mount(null);
  assert.equal(m.box.hidden, true);
  assert.equal(m.box.children.length, 0);
});

test('Settings: the switch and both limits, saved through the framework', async () => {
  const m = await mount(UI());
  assert.equal(m.box.hidden, false);
  const [tog, five, seven] = m.inputs;
  assert.equal(tog.type, 'checkbox'); assert.equal(tog.checked, true); assert.equal(tog.disabled, false);
  assert.equal(five.value, '90'); assert.equal(seven.value, '98'); assert.equal(five.min, '50'); assert.equal(five.max, '98');
  five.value = '99'; five.fire('change');
  assert.deepEqual(m.sent, [], 'out of range: nothing sent');
  assert.equal(five.value, '90', 'and the field goes back to the value in force');
  assert.match(m.toasts.at(-1) || '', /settings\.rotationRange/);
  five.value = ''; five.fire('change');
  assert.deepEqual(m.sent, [], 'an emptied field is not 0: nothing sent');
  assert.equal(five.value, '90');
  /* Tab from the 5-hour field into the weekly one and start typing while the save is on its way. */
  five.value = '85'; five.fire('change');
  m.document.activeElement = seven; seven.value = '9';
  await m.flush();
  assert.deepEqual(m.sent, [{ fiveHour: 85 }]);
  assert.match(m.toasts.at(-1) || '', /settings\.rotationSaved/);
  const after = m.box.all().filter((n) => n.tag === 'input');
  assert.ok(after[1] === five && after[2] === seven, 'the rows are updated in place, never rebuilt: the field the operator moved into stays in the page');
  assert.equal(seven.value, '9', 'and keeps what they are typing');
  m.document.activeElement = null;
  const m2 = await mount(UI());
  m2.inputs[0].checked = false; m2.inputs[0].fire('change'); await m2.flush();
  assert.deepEqual(m2.sent, [{ enabled: false }], 'the switch: off');
});

test('Settings: a value set outside the App is shown, not editable; a refused save says why', async () => {
  const m = await mount(UI({ sevenDay: { value: 20, source: 'environment' }, ignored: ['five_hour=120 … ignored'] }));
  const [, five, seven] = m.inputs;
  assert.equal(seven.disabled, true); assert.equal(seven.value, '20'); assert.equal(five.disabled, false);
  const texts = m.box.all().map((n) => n.textContent).join('\n');
  assert.match(texts, /settings\.rotationElsewhere/);
  assert.match(texts, /settings\.rotationIgnored/, 'an ignored stored value is said, in plain words');
  assert.doesNotMatch(texts, /five_hour=120|quota-rotation|CLAUDE_QUOTA/, 'the screen names no file, variable or key');
  const bad = await mount(UI(), () => ({ ok: false, setting: UI(), message: 'could not write /home/x/.claude/quota-rotation.json' }));
  bad.inputs[1].value = '80'; bad.inputs[1].fire('change'); await bad.flush();
  assert.equal(bad.toasts.at(-1), 'settings.rotationFailed', 'a refused save says so, without the script\'s words (they name files)');
  assert.equal(bad.inputs[1].value, '90', 'and the field shows the value in force again');
  const thrown = await mount(UI(), () => { throw new Error('ipc gone'); });
  thrown.inputs[1].value = '80'; thrown.inputs[1].fire('change'); await thrown.flush();
  assert.equal(thrown.box.hidden, false, 'a call that throws keeps the editor, with the last setting');
  assert.equal(thrown.inputs[1].value, '90');
});

test('Settings: two edits in a row are both sent, in order', async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => { release = r; });
  const m = await mount(UI(), async (c) => { await gate; return { ok: true, setting: UI() }; });
  m.inputs[1].value = '85'; m.inputs[1].fire('change');
  m.inputs[2].value = '95'; m.inputs[2].fire('change');
  m.inputs[1].value = '90'; m.inputs[1].fire('change');   // back to the value in force while 85 is on its way
  release(); await m.flush(); await m.flush(); await m.flush(); await m.flush();
  assert.deepEqual(m.sent, [{ fiveHour: 85 }, { sevenDay: 95 }, { fiveHour: 90 }], 'changing a field back while its save is in flight is sent too');
});

test('Settings: a repaint that throws does not stop later saves', async () => {
  const m = await mount(UI(), () => ({ ok: true, setting: { broken: true } }));
  m.inputs[1].value = '85'; m.inputs[1].fire('change'); await m.flush(); await m.flush();
  m.inputs[2].value = '95'; m.inputs[2].fire('change'); await m.flush(); await m.flush();
  assert.deepEqual(m.sent, [{ fiveHour: 85 }, { sevenDay: 95 }]);
});

test('main: an account answer started before a save does not put the old numbers back', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'main', 'aios.ts'), 'utf8');
  assert.match(src, /const epoch = rotationEpoch;\s*const ans = await runIdentity\(\['switch', '--availability'\]\);/);
  assert.match(src, /else if \(epoch === rotationEpoch\) \{ swapCache = /);
  const fn = src.slice(src.indexOf('export async function setRotation('), src.indexOf('export async function anthropicAccounts('));
  assert.match(fn, /rotationEpoch\+\+;/);
});

test('Settings: the rows sit in the Account section, and their words exist in every locale', () => {
  const app = fs.readFileSync(path.join(ROOT, 'renderer', 'app.js'), 'utf8');
  const acct = app.slice(app.indexOf("h3.textContent = t('settings.account')"), app.indexOf("h4.type = 'button';"));
  assert.match(acct, /settingsRotationRows\(wrap\);/);
  const keys = ['rotationAuto', 'rotationAutoHint', 'rotationFiveHour', 'rotationSevenDay', 'rotationAtHint', 'rotationElsewhere', 'rotationIgnored', 'rotationSaved', 'rotationFailed', 'rotationRange'];
  for (const loc of ['en', 'es', 'pt-br', 'fr', 'el']) {
    const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'i18n', 'locales', `${loc}.json`), 'utf8'));
    for (const k of keys) {
      const v = m[`settings.${k}`];
      assert.ok(typeof v === 'string' && v.trim(), `${loc}: settings.${k}`);
      assert.doesNotMatch(v, /quota-rotation|CLAUDE_QUOTA|watcher|vigía|json/i, `${loc}: settings.${k} names no mechanism`);
    }
    assert.match(m['settings.rotationAtHint'], /\{min\}.*\{max\}/, `${loc}: the range is shown`);
  }
});
