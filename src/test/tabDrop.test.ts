/** 0.17: drop a file onto a Running tab, or hold it there to switch to that session. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';

const app = fs.readFileSync('renderer/app.js', 'utf8');

test('a session tab is a drop target that types the path into THAT session', () => {
  assert.match(app, /attachDropZone\(p\.tab, \(paths\) => \{ if \(panes\.get\(id\) === p && !p\.exited\) \{ dropPathsInto\(id, p, paths\); setActive\(id\); \} \}\);/);
  assert.match(app, /attachTabDragDwell\(p\.tab, id\);/);
});

test('holding a FILE over a tab switches to it; a tab or card reorder never does', () => {
  const fn = /function isFileDrag\(ev\) \{[\s\S]*?\n\}/.exec(app);
  assert.ok(fn);
  const isFileDrag = new Function(`${fn![0]}; return isFileDrag;`)() as (ev: unknown) => boolean;
  const ev = (types: string[]) => ({ dataTransfer: { types } });
  assert.equal(isFileDrag(ev(['Files'])), true, 'a file from Finder');
  assert.equal(isFileDrag(ev(['application/x-aios-path', 'text/plain'])), true, 'a file from the explorer');
  assert.equal(isFileDrag(ev(['application/x-aios-tab'])), false, 'a tab being reordered');
  assert.equal(isFileDrag(ev(['application/x-aios-card'])), false, 'a panel card being reordered');
  assert.equal(isFileDrag(ev(['text/plain'])), false, 'plain text is not a file');
});
