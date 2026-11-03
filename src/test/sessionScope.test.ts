/** Only the operator's sessions reach the panel and the notifications. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inScope, within, busNamesFrom, type SessionScope } from '../core/sessionScope';

const base: SessionScope = {
  paneSessionIds: new Set(['pane-1']), primaries: new Set(['buddai']), busNames: new Set(['deck-amplify']),
  roots: ['/Users/x/aios', '/Users/x/code/acme'], caseInsensitive: true,
};

test('the measured incident: probes in ~/code with their own names are NOT the operator\'s', () => {
  for (const name of ['osc-live', 'title-probe', 'code-f2']) {
    assert.equal(inScope({ sessionId: 's-' + name, name, cwd: '/Users/x/code' }, base), false, name);
  }
});

test('each of the four ways a session is the operator\'s', () => {
  assert.ok(inScope({ sessionId: 'pane-1', name: 'osc-live', cwd: '/tmp' }, base), 'open in an App pane, wherever it runs');
  assert.ok(inScope({ sessionId: 's', name: 'Buddai', cwd: '/elsewhere' }, base), 'a USER.md primary (case aside)');
  assert.ok(inScope({ sessionId: 's', name: 'deck-amplify', cwd: '/elsewhere' }, base), 'a session the inbox delivered to');
  assert.ok(inScope({ sessionId: 's', name: '', cwd: '/Users/x/aios/vault' }, base), 'inside the framework');
  assert.ok(inScope({ sessionId: 's', name: 'w', cwd: '/users/X/code/acme' }, base), 'inside a workspace folder, case-insensitive on macOS');
});

test('a sibling folder is not "inside" by prefix', () => {
  assert.equal(within('/Users/x/aios-old', '/Users/x/aios', false), false);
  assert.equal(within('/Users/x/aios', '/Users/x/aios/', false), true);
});

test('bus names come from the provenance log, recent ones only', () => {
  const now = 2_000_000_000;
  const log = [JSON.stringify({ at: now - 60, to: 'Worker-A' }), JSON.stringify({ at: now - 20 * 86400, to: 'old' }), '{torn'].join('\n');
  assert.deepEqual([...busNamesFrom(log, now)], ['worker-a']);
});

import { primaryNamesIn } from '../main/aios';
test('review 13: primaries are found by the table, not only by the heading above it', () => {
  const table = '| Name | Role | Greeting style |\n|------|------|----------------|\n| `ana` | primary | warm |\n| `ops` | coordinator | brief |\n';
  assert.deepEqual([...primaryNamesIn(`## Identity\n\n> note\n\n${table}\n## Settings\n`)], ['ana', 'ops'], 'the usual shape');
  assert.deepEqual([...primaryNamesIn(`## Who I am\n\n${table}\n## Settings\n`)], ['ana', 'ops'], 'heading renamed: still found by its header row');
  assert.deepEqual([...primaryNamesIn('## Identity\n\nnothing here\n## Settings\n')], [], 'genuinely absent');
});
