/** #190: a spawn or resume naming a new group can choose its colour. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import { parseGroupColor, GROUP_COLORS, parseRequest } from '../core/commandBus';

test('a known colour is taken, any case; red reads as coral', () => {
  assert.deepEqual(parseGroupColor('Blue'), { color: 'blue' });
  assert.deepEqual(parseGroupColor('red'), { color: 'coral' });
  assert.deepEqual(parseGroupColor(undefined), {});
});

test('an unknown colour is dropped with a note, never a refusal', () => {
  const r = parseGroupColor('magenta');
  assert.equal(r.color, undefined);
  assert.match(String(r.note), /color ignored/);
  assert.equal(parseGroupColor(7).color, undefined);
});

test('a request carries the colour only with a group', () => {
  const withGroup = parseRequest(JSON.stringify({ name: 'w', task: 't', group: 'Release', color: 'green' }));
  assert.equal(withGroup && withGroup.groupColor, 'green');
  const noGroup = parseRequest(JSON.stringify({ name: 'w', task: 't', color: 'green' }));
  assert.equal(noGroup && noGroup.groupColor, undefined);
});

test('the App and the bus list the same colours, in the same order', () => {
  const app = fs.readFileSync('renderer/app.js', 'utf8');
  const m = /const TG_COLORS = (\[[^\]]*\]);/.exec(app);
  assert.ok(m);
  assert.deepEqual(JSON.parse(m![1].replace(/'/g, '"')), [...GROUP_COLORS]);
});

test('wiring: the colour reaches the tab group, used only when the group is new', () => {
  const app = fs.readFileSync('renderer/app.js', 'utf8');
  const bus = fs.readFileSync('src/main/commandBus.ts', 'utf8');
  assert.equal((bus.match(/group: req\.group, color: req\.groupColor/g) || []).length, 2, 'spawn and resume');
  assert.match(app, /tgJoinByName\(id, m\.group, typeof m\.color === 'string'/);
  const join = app.slice(app.indexOf('function tgJoinByName('), app.indexOf('function tgJoinByName(') + 1200);
  assert.ok(join.indexOf('TG_COLORS.includes(asked)') > join.indexOf('if (!gid)'), 'the colour is chosen only inside the new-group branch');
});
