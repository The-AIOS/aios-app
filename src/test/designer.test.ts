/**
 * Designer tests — the app composes a BRIEF for `aios-builder`; it no longer writes
 * framework infra itself. So what's worth testing is the brief: does it name the right
 * kind, the right destination, and the boundaries the builder must not cross?
 * (The previous suite tested file/frontmatter composition, which the app deliberately no
 * longer does — a valid shape was never the hard part; a USEFUL unit is.)
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { slugify, designerHome, composeBuilderBrief, DESIGNER_HOMES, DESIGNER_ABOUT } from '../core/designer';

const FIELDS = {
  name: 'Deal Scout',
  description: 'Hunts qualified deals; it is picky',
  keywords: 'deals, pipeline, prospect',
  tier: 'judgment' as const,
  body: 'Watch the pipeline and tell me which deals are real.',
};

test('slugify: display names become spawn-safe handles', () => {
  assert.equal(slugify('Deal Scout'), 'deal-scout');
  assert.equal(slugify('  ¡Órale!  QA/Bot  '), 'rale-qa-bot');
  assert.equal(slugify('---'), '');
});

test('every kind has a home under custom/ and operator-facing copy', () => {
  for (const kind of ['agent', 'skill', 'command'] as const) {
    assert.match(DESIGNER_HOMES[kind], /custom/, `${kind} must live under custom/`);
    assert.ok(DESIGNER_ABOUT[kind].length > 40, `${kind} needs an explanation`);
  }
  assert.equal(designerHome('agent', 'deal-scout'), 'agents/custom/deal-scout.md');
  assert.equal(designerHome('skill', 'deal-scout'), 'skills/custom/deal-scout/SKILL.md');
  assert.match(designerHome('command', 'deal-scout'), /plugins\/custom\/.*\/commands\/deal-scout\.md/);
});

test('create brief: names the kind, the destination, and the operator intent', () => {
  const b = composeBuilderBrief('agent', FIELDS, { mode: 'create' });
  assert.match(b, /Create a new custom AIOS agent/);
  assert.match(b, /agents\/custom\/deal-scout\.md/);
  assert.match(b, /Watch the pipeline/);          // the intent survives verbatim
  assert.match(b, /deals, pipeline, prospect/);   // keywords carried
  assert.match(b, /judgment/);                    // tier carried for agents
  assert.match(b, /_index\.md/);                  // registry upkeep demanded
  assert.match(b, /never a bundled/);             // the boundary is stated
});

test('a task-less brief asks rather than inventing', () => {
  const b = composeBuilderBrief('skill', { ...FIELDS, body: '' }, { mode: 'create' });
  assert.match(b, /ask me/i);
  assert.match(b, /skills\/custom\/deal-scout\/SKILL\.md/);
});

test('no usable name → no brief (callers refuse early)', () => {
  assert.equal(composeBuilderBrief('agent', { ...FIELDS, name: '---' }, { mode: 'create' }), '');
  assert.equal(composeBuilderBrief('agent', { ...FIELDS, name: '' }, { mode: 'create' }), '');
});

test('template reference is READ-ONLY and explicitly so', () => {
  const b = composeBuilderBrief('agent', FIELDS, { mode: 'create', templatePath: 'agents/aios/sales/deal-scout.md' });
  assert.match(b, /agents\/aios\/sales\/deal-scout\.md/);
  assert.match(b, /never modify it/i);
});

test('update mode scopes the edit to the operator’s OWN file', () => {
  const b = composeBuilderBrief('skill', FIELDS, { mode: 'update', targetPath: 'skills/custom/deal-scout/SKILL.md' });
  assert.match(b, /Update my existing custom AIOS skill/);
  assert.match(b, /Edit ONLY `skills\/custom\/deal-scout\/SKILL\.md`/);
  assert.doesNotMatch(b, /Create a new/);
});

test('a command joins an EXISTING custom plugin rather than minting another', () => {
  const b = composeBuilderBrief('command', FIELDS, { mode: 'create', plugins: ['acme'] });
  assert.match(b, /plugins\/custom\/acme\/commands\/deal-scout\.md/);
  assert.match(b, /\/acme:deal-scout/);
  assert.match(b, /Don't create another plugin/);
  assert.doesNotMatch(b, /model tier/); // tier is an agent-only field
});

test('with several plugins it ASKS; with none it creates one', () => {
  const many = composeBuilderBrief('command', FIELDS, { mode: 'create', plugins: ['acme', 'work'] });
  assert.match(many, /ask me which/);
  const none = composeBuilderBrief('command', FIELDS, { mode: 'create', plugins: [], suggestedHandle: 'ada' });
  assert.match(none, /no custom plugin yet/);
  assert.match(none, /plugins\/custom\/ada\//);      // a concrete proposal, not "<handle>"
  assert.match(none, /\/ada:deal-scout/);
  assert.match(none, /Confirm that handle/);           // proposed, not imposed
  assert.match(none, /marketplace\.json/);
});

test('with no plugin AND no name to derive from, it degrades to a placeholder', () => {
  const b = composeBuilderBrief('command', FIELDS, { mode: 'create', plugins: [] });
  assert.match(b, /<handle>/);                         // never a broken path
});
