import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { mentionAt, rankMentions } from '../core/fileMention';

test('mentionAt: the @word the caret is in, only at a word start, never across a space or quote', () => {
  assert.deepEqual(mentionAt('look at @src/co'), { start: 8, query: 'src/co' });
  assert.deepEqual(mentionAt('@'), { start: 0, query: '' });
  assert.equal(mentionAt('mail me at j@sovra.io'), null, 'an address is not a mention');
  assert.equal(mentionAt('@src/core done'), null, 'the caret has left the word');
  assert.equal(mentionAt('no at sign'), null);
});

test('rankMentions: name-starts, then name-contains, then path; folders offered with their slash; empty query lists the top level', () => {
  const files = ['src/core/tuiPrompt.ts', 'src/core/fileMention.ts', 'renderer/app.js', 'README.md', 'src/test/tuiPrompt.test.ts'];
  const r = rankMentions(files, 'tui').map((x) => x.path);
  assert.deepEqual(r.slice(0, 2), ['src/core/tuiPrompt.ts', 'src/test/tuiPrompt.test.ts']);
  assert.ok(rankMentions(files, 'cor').some((x) => x.path === 'src/core/' && x.dir), 'a folder is offered');
  assert.deepEqual(rankMentions(files, '').map((x) => x.path), ['renderer/', 'src/', 'README.md']);
  assert.equal(rankMentions(files, 'zzz').length, 0);
  assert.ok(rankMentions(Array.from({ length: 500 }, (_, i) => `f${i}.ts`), 'f').length <= 30, 'bounded');
});
