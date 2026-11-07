/**
 * The Health card's rows scroll in their own resizable box, and the rows that need attention come first.
 *
 * The bug: on a machine with many scheduled jobs (60+ status files) the card grew past the screen.
 * The buttons below the rows ("Let Claude help with these") were out of reach, and the red rows sat
 * in alphabetical order among dozens of green ones, so a failing job read as just another line.
 *
 * These tests EXECUTE the renderer's own functions (extracted from renderer/app.js) rather than
 * matching how the code looks: what must hold is the ORDER a person sees and the HEIGHT the box
 * keeps across a re-check, because the card is rebuilt from scratch on every ↻.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';

const app = fs.readFileSync('renderer/app.js', 'utf8');

function grab(re: RegExp, what: string): string {
  const m = app.match(re);
  assert.ok(m, `renderer/app.js no longer has ${what}`);
  return m![0];
}

const src = [
  grab(/function healthRank\([\s\S]*?\n\}/, 'healthRank'),
  grab(/const HEALTH_LIST_KEY = [^\n]*/, 'HEALTH_LIST_KEY'),
  grab(/const HEALTH_LIST_DEFAULT = [^\n]*/, 'HEALTH_LIST_DEFAULT'),
  grab(/let healthListObserver = [^\n]*/, 'healthListObserver'),
  grab(/function sizeHealthList\([\s\S]*?\n\}/, 'sizeHealthList'),
].join('\n');

type List = { style: { height: string }; dataset: Record<string, string>; scrollHeight: number };

function load(store: Map<string, string>) {
  const observers: Array<() => void> = [];
  class FakeRO { constructor(fn: () => void) { observers.push(fn); } observe() { /* */ } disconnect() { /* */ } }
  const localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, v); },
  };
  const fns = new Function('localStorage', 'ResizeObserver', `${src}\nreturn { healthRank, sizeHealthList };`)(
    localStorage, FakeRO,
  ) as { healthRank: (k: string, s: string) => number; sizeHealthList: (l: List) => void };
  return { ...fns, fire: () => observers.at(-1)!() };
}

const list = (scrollHeight: number): List => ({ style: { height: '' }, dataset: {}, scrollHeight });

test('red first, then amber, then waiting, then green — the colours the dots already have', () => {
  const { healthRank } = load(new Map());
  const rows: Array<[string, string, string]> = [
    ['check', 'pass', 'Vault'], ['check', 'warn', 'Hooks'],
    ['job', 'ok', 'a-ok'], ['job', 'waiting', 'b-wait'], ['job', 'fail', 'c-fail'],
    ['job', 'warn', 'd-warn'], ['job', 'overdue', 'e-late'], ['job', 'unreadable', 'f-bad'],
  ];
  const order = rows
    .map(([k, s, n]) => ({ rank: healthRank(k, s), n }))
    .sort((a, b) => a.rank - b.rank)
    .map((x) => x.n);
  assert.deepEqual(order, ['c-fail', 'Hooks', 'd-warn', 'e-late', 'f-bad', 'b-wait', 'Vault', 'a-ok']);
});

test('a short list keeps its natural height; a long one gets the default box', () => {
  const { sizeHealthList } = load(new Map());
  const short = list(120); sizeHealthList(short);
  assert.equal(short.style.height, '', 'no empty box under a few rows');
  const long = list(1500); sizeHealthList(long);
  assert.equal(long.style.height, '300px');
});

test('the height dragged from the corner survives the next re-check', () => {
  const store = new Map<string, string>();
  const first = load(store);
  const l = list(1500); first.sizeHealthList(l);
  first.fire();
  assert.equal(store.size, 0, 'our own default is not a choice the operator made');
  l.style.height = '512px';   // the corner drag sets the inline height
  first.fire();
  assert.equal(store.get('healthListH'), '512');
  const again = load(store);   // ↻ rebuilds the card from scratch
  const l2 = list(1500); again.sizeHealthList(l2);
  assert.equal(l2.style.height, '512px');
});

test('refreshHealth puts the rows in the scrolling list, and the buttons outside it', () => {
  const body = grab(/async function refreshHealth\(\) \{[\s\S]*?\n\}/, 'refreshHealth');
  assert.ok(!/H\.appendChild\(r\)/.test(body), 'a row appended to the card itself would sit outside the scroll box');
  assert.match(body, /list\.appendChild\(x\.node\)/);
  assert.match(body, /H\.appendChild\(help\)/, '"Let Claude help" stays on the card, outside the list');
});
