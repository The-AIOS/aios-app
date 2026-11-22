/** A nudge's "Run /…" label keeps the agent (or other plain-name argument) it is about. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nudgeShort } from '../core/nudgeCommand';

test('an agent nudge keeps the agent name (it used to read "Run /agent")', () => {
  assert.equal(nudgeShort('/aios:agent explainer'), 'agent explainer');
  assert.equal(nudgeShort('/agent accountant-q1'), 'agent accountant-q1');
});

test('a bare command stays bare; the prefix goes', () => {
  assert.equal(nudgeShort('/aios:7plan'), '7plan');
  assert.equal(nudgeShort('/7plan'), '7plan');
  assert.equal(nudgeShort('/vault-commands:today'), 'today');
});

test('a URL or free text is not put in the label', () => {
  assert.equal(nudgeShort('/aios:ingest https://example.com/talk'), 'ingest');
  assert.equal(nudgeShort('/aios:ghost "how would I answer"'), 'ghost');
  assert.equal(nudgeShort(''), '');
});
