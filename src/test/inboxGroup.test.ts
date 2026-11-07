/**
 * `group` on a spawn-inbox request: a session asks for a worker inside a tab group by name.
 *
 * App only and advisory. Main reads it leniently (core/commandBus parseGroup) and never refuses a
 * request over it; the renderer joins the group with that name or creates it (tgJoinByName).
 * These tests run the real parser and the real renderer function, sliced out of app.js.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { parseRequest, parseGroup, fallbackSpawnRequest, GROUP_MAX } from '../core/commandBus';
import { buildInboxReadme } from '../core/inboxReadme';

const req = (o: Record<string, unknown>) => parseRequest(JSON.stringify({ name: 'builder', task: 't', ...o }))!;

test('spawn and resume carry a cleaned group name; other verbs ignore it', () => {
  assert.equal(req({ group: 'Release' }).group, 'Release');
  assert.equal(req({ group: '  Release   0.15 ' }).group, 'Release 0.15', 'trimmed, runs of space collapsed');
  assert.equal(req({ group: 'Re\nlease\u0007' }).group, 'Re lease', 'control characters become spaces, never reach the tab');
  assert.equal(req({ action: 'resume', prompt: 'p', group: 'Release' }).group, 'Release');
  assert.equal(req({ action: 'send', prompt: 'p', group: 'Release' }).group, undefined, 'send names a live session: no group');
  assert.equal(req({ action: 'kill', group: 'Release' }).group, undefined);
  assert.equal(req({}).group, undefined, 'absent stays absent');
  assert.equal(req({}).groupNote, undefined, 'and says nothing');
});

test('a group that cannot be used is dropped with a note, never a refusal of the request', () => {
  for (const bad of [42, ['Release'], { name: 'Release' }, true, '', '   ']) {
    const r = req({ group: bad });
    assert.ok(r, `${JSON.stringify(bad)}: the request still parses`);
    assert.equal(r.group, undefined, `${JSON.stringify(bad)}: dropped`);
    assert.match(r.groupNote || '', /^group ignored/, `${JSON.stringify(bad)}: and noted for the log`);
    assert.equal(r.fieldError, undefined, 'never a dead letter');
  }
  const long = req({ group: 'x'.repeat(GROUP_MAX + 25) });
  assert.equal(long.group?.length, GROUP_MAX, 'cut to the group editor\'s own limit');
  assert.match(long.groupNote || '', /cut to 40/);
  assert.deepEqual(parseGroup(undefined), {});
  assert.deepEqual(parseGroup(null), {});
});

test('a resume that falls back to a spawn keeps its group', () => {
  const r = req({ action: 'resume', prompt: 'p', fallback: 'spawn', group: 'Release' });
  assert.equal(fallbackSpawnRequest(r).group, 'Release');
});

test('main hands the group to the renderer on both launch paths, and says when it did not apply', () => {
  const src = fs.readFileSync('src/main/commandBus.ts', 'utf8');
  const emits = src.match(/emit\(win\(\), 'terminal', \{ name: req\.name, cmd, background: true, \.\.\.where, group: req\.group \}\);/g) || [];
  assert.equal(emits.length, 2, 'spawn and resume both pass it');
  assert.match(src, /group '\$\{req\.group\}' NOT applied: a running session keeps its tab where it is/);
  assert.match(src, /if \(req\.groupNote\) log\(`spawn/);
});

/* The renderer half, run for real: slice tgJoinByName out of app.js and drive it with a fake tab-group model. */
const app = fs.readFileSync('renderer/app.js', 'utf8');
const fnSrc = (src: string, name: string): string => src.slice(src.indexOf('function ' + name + '('), src.indexOf('\n}\n', src.indexOf('function ' + name + '(')) + 2);
function harness(src: string) {
  const panes = new Map<string, { group?: string }>([['p1', {}], ['p2', {}], ['p3', {}]]);
  const tabGroups = new Map<string, { name: string; color: string; collapsed: boolean }>([['g0', { name: 'Release', color: 'grey', collapsed: false }]]);
  let seq = 0;
  const added: [string, string][] = [];
  const join = new Function('panes', 'tabGroups', 'TG_COLORS', 'tgNewId', 'tgAdd',
    fnSrc(src, 'tgJoinByName') + 'return tgJoinByName;')(
    panes, tabGroups, ['grey', 'blue', 'indigo'], () => 'gN' + (++seq),
    (id: string, gid: string) => { added.push([id, gid]); panes.get(id)!.group = gid; }) as (id: string, name: string) => string;
  return { join, panes, tabGroups, added };
}

test('the renderer joins the group with that name, whatever its case, or creates it with the next free colour', () => {
  const h = harness(app);
  assert.equal(h.join('p1', 'release'), 'g0', 'an existing group, matched without regard to case');
  assert.equal(h.join('p2', 'Docs'), 'gN1', 'no such group: a new one');
  assert.deepEqual(h.tabGroups.get('gN1'), { name: 'Docs', color: 'blue', collapsed: false }, 'named as asked, with the first colour no group uses');
  assert.equal(h.join('p3', 'docs'), 'gN1', 'and the next request with that name joins it rather than making a second');
  assert.deepEqual(h.added, [['p1', 'g0'], ['p2', 'gN1'], ['p3', 'gN1']]);
  assert.equal(h.join('nope', 'Release'), '', 'a pane that is gone joins nothing');
  assert.equal(h.join('p1', '   '), '', 'nor does an empty name');
  /* Control: a version that compares names exactly makes a second "Release" group for "release". */
  const exact = harness(app.replace("(v.name || '').trim().toLocaleLowerCase() === key", "(v.name || '').trim() === want"));
  assert.notEqual(exact.join('p1', 'release'), 'g0', 'control: an exact-case match does not find the existing group');
});

test('the bus terminal handler puts a launched pane into the requested group', () => {
  assert.match(app, /const id = await createPane\(\{ name: m\.name \|\| 'terminal'[^\n]*\n[^\n]*\n\s*if \(id && typeof m\.group === 'string' && m\.group\) tgJoinByName\(id, m\.group\);/);
});

test('the inbox README documents group as an App-only, advisory field, and how Glass treats it', () => {
  const doc = buildInboxReadme('0.15.0');
  assert.match(doc, /`group` — optional, \*\*App only\*\*/);
  assert.match(doc, /ignored and logged, never refused/);
  assert.match(doc, /Glass hands a request carrying `group` to the App/);
});
