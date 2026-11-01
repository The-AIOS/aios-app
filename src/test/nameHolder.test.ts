import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nameStartedBy, heldElsewhere, type NameEntry } from '../core/nameHolder';

test('the name a command starts a session under', () => {
  assert.equal(nameStartedBy(`claude --remote-control --name AIOS-Main-Session 'Start session'`), 'AIOS-Main-Session');
  assert.equal(nameStartedBy(`claude --name 'warm fox' 'Start session'`), 'warm fox');
  assert.equal(nameStartedBy(`claude --name 'it'\\''s' 'go'`), "it's", 'POSIX quoting');
  assert.equal(nameStartedBy(`claude --name 'it''s' 'go'`), "it's", 'PowerShell quoting');
  assert.equal(nameStartedBy(`claude --name=aios 'go'`), 'aios');
  assert.equal(nameStartedBy(`claude 'Start session'`), '', 'no --name, no name');
  assert.equal(nameStartedBy(`claude --resume 0d3c --name aios`), '', 'a resume reopens; it starts nothing');
  assert.equal(nameStartedBy(''), '');
});

const live: NameEntry[] = [
  { pid: 4100, name: 'AIOS-Main-Session', sessionId: 'outside' },
  { pid: 4200, name: 'ingest', sessionId: 'in-pane' },
];

test('a name held by a live session outside the App is reported, with its pid', () => {
  assert.equal(heldElsewhere('AIOS-Main-Session', live, new Set(['in-pane']))?.pid, 4100);
  assert.equal(heldElsewhere('  aios-main-session ', live, new Set())?.pid, 4100, 'trimmed, case-insensitive');
});

test('a name held only inside the App, or by nobody, is not', () => {
  assert.equal(heldElsewhere('ingest', live, new Set(['in-pane'])), undefined, 'the App reveals its own tab instead');
  assert.equal(heldElsewhere('nobody', live, new Set()), undefined);
  assert.equal(heldElsewhere('', live, new Set()), undefined);
});
