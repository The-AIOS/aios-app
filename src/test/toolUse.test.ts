/** Skills and agents a session used, from real transcript record shapes. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { usageIn, usageChip } from '../core/toolUse';

const use = (name: string, input: object) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });

test('Skill and Agent tool uses are read; generic workers are not news', () => {
  const tx = [
    use('Skill', { skill: 'deep-research', args: 'x' }),
    use('Agent', { subagent_type: 'general-purpose', prompt: 'p' }),
    use('Agent', { subagent_type: 'Explore', prompt: 'p' }),
    use('Bash', { command: 'ls' }),
    '{torn',
    use('Skill', { skill: 'aios:close-session' }),
    use('Skill', { skill: 'deep-research' }),
  ].join('\n');
  const u = usageIn(tx);
  assert.deepEqual(u.skills, ['aios:close-session', 'deep-research'], 'newest last, no repeats');
  assert.deepEqual(u.agents, ['Explore']);
  assert.equal(usageChip(u), 'deep-research +2');
  assert.equal(usageChip({ skills: [], agents: [] }), '');
});

test('it accumulates across incremental reads (a transcript is read in pieces)', () => {
  const u = usageIn(use('Skill', { skill: 'a' }));
  usageIn(use('Skill', { skill: 'b' }), u);
  assert.deepEqual(u.skills, ['a', 'b']);
});

test('a compaction summary is not a new prompt: the chip survives it, a typed prompt does not', () => {
  const prompt = (extra: object) => JSON.stringify({ type: 'user', message: { role: 'user', content: 'text' }, ...extra });
  const u = usageIn([use('Skill', { skill: 'a' }), prompt({ isCompactSummary: true })].join('\n'));
  assert.deepEqual(u.skills, ['a']);
  const control = usageIn([use('Skill', { skill: 'a' }), prompt({})].join('\n'));
  assert.deepEqual(control.skills, [], 'control: the same line, not flagged, clears it');
});
