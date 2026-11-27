/** Review nit — a superseded message leaves a record the sender can find, never a silent deletion. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { supersededName, supersededBody, SUPERSEDED_KEEP_MS } from '../src/supersede';

test('the archived record keeps the request and names what replaced it', () => {
  assert.equal(supersededName('buddai-brief.json.holding'), 'buddai-brief.json.superseded');
  const b = supersededBody({ action: 'send', name: 'w', prompt: 'old draft', from: 'buddai' }, 'buddai-brief-2.json.holding', 'glass', 1000);
  assert.equal(b.prompt, 'old draft', 'the text is kept, so the sender can see exactly what was dropped');
  assert.deepEqual((b._superseded as { by: string }).by, 'buddai-brief-2.json.holding');
  assert.ok(SUPERSEDED_KEEP_MS >= 24 * 60 * 60 * 1000, 'kept long enough to be looked at');
});
