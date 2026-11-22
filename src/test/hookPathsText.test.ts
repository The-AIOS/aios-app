/** aios#330: canonical v0.8.21 removes the forwarding files at the old flat hook paths. Text the App writes for agents
 *  to act on (the spawn-inbox README) must name each hook in its folder, or an agent following it runs a missing file. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOOK_FOLDER } from '../core/hookPaths';
import { buildInboxReadme } from '../core/inboxReadme';

const flat = (text: string): string[] =>
  Object.keys(HOOK_FOLDER).filter((f) => new RegExp(`hooks/${f.replace(/[.]/g, '\\.')}(?![\\w.-])`).test(text));

test('the inbox README names every moved hook in its folder', () => {
  const readme = buildInboxReadme('0.0.0');
  assert.deepEqual(flat(readme), []);
  assert.match(readme, /hooks\/pipeline\/resolve-tier --list/);
});

test('negative control: the old flat path is caught', () => {
  assert.deepEqual(flat('run ~/aios/hooks/resolve-tier --list'), ['resolve-tier']);
  assert.deepEqual(flat('run ~/aios/hooks/pipeline/resolve-tier --list'), []);
});
