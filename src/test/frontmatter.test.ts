/* The frontmatter reader undoes YAML's quote escapes (#109: an agent's purpose showed "ingest''s" on its card). */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { parseFrontmatter } from '../core/frontmatter';

test('a single-quoted value turns a doubled quote back into one; a double-quoted one undoes \\"; plain values are untouched', () => {
  const fm = (v: string) => parseFrontmatter(`---\nname: x\ndescription: ${v}\n---\nbody`).description;
  assert.equal(fm("'an ingest''s argument'"), "an ingest's argument");
  assert.equal(fm('"say \\"hi\\""'), 'say "hi"');
  assert.equal(fm('plain words'), 'plain words');
  assert.equal(fm("it's fine"), "it's fine", 'an apostrophe in a plain value stays');
});
