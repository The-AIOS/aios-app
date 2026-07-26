/**
 * Starter-pack tests — persona → preseeded Home. The pack seeds
 * `.glass/state.json` (frequent tasks + suggested agents + the applied marker)
 * and the `starter` doctor check flips from warn to pass, which unlocks the
 * Onboarding step. Fixture framework, same seams as shell.test.
 */
import { test, before } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as aios from '../main/aios';

let root = '';

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-starter-fixture-'));
  const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-starter-home-'));
  process.env.GLASS_FRAMEWORK_PATH = root;
  process.env.GLASS_CLAUDE_HOME = claudeHome;
  process.env.GLASS_CLAUDE_JSON = path.join(claudeHome, 'claude.json');
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# Test framework\n');
  fs.mkdirSync(path.join(root, 'vault', '00 - notes'), { recursive: true });
  fs.writeFileSync(path.join(claudeHome, 'claude.json'), JSON.stringify({}));
});

test('starterPacks: two personas, each with tasks + 2-3 suggested agents', () => {
  const packs = aios.starterPacks();
  assert.deepEqual(packs.map((p) => p.id).sort(), ['founder-operator', 'personal-family']);
  for (const p of packs) {
    assert.ok(p.tasks.length >= 4, `${p.id} preselects a real set of tasks`);
    assert.ok(p.agents.length >= 2 && p.agents.length <= 3, `${p.id} suggests 2-3 agents`);
  }
});

test('starter check: warn on a fresh vault (nothing chosen, nothing curated)', async () => {
  const starter = (await aios.setupChecks()).find((c) => c.id === 'starter');
  assert.ok(starter, 'check present');
  assert.equal(starter!.status, 'warn');
});

test('applyStarterPack: seeds state.json so a fresh Home shows the persona buttons', () => {
  const r = aios.applyStarterPack('founder-operator');
  assert.ok(r, 'known persona applies');
  assert.equal(r!.id, 'founder-operator');
  assert.ok(r!.tasks >= 4, 'tasks seeded');
  assert.deepEqual(r!.agents, ['market-researcher', 'deck-builder', 'email-drafter']);
  // Home reads frequentTasks() from the same state — persona order, persona set
  const tasks = aios.frequentTasks();
  assert.equal(tasks[0].id, 'deck', 'pack order is the Home order');
  assert.ok(tasks.every((t2) => t2.label && t2.hint), 'labels stay localized via freq.*');
  assert.ok(!tasks.some((t2) => t2.id === 'ingest'), 'defaults outside the pack are removed, not re-merged');
  const st = JSON.parse(fs.readFileSync(path.join(root, '.glass', 'state.json'), 'utf8'));
  assert.equal(st['aios.starterPack.v1'].id, 'founder-operator');
  assert.equal(aios.frequentTaskCount(), tasks.length, 'the Home badge agrees');
});

test('starter check passes after applying; unknown persona is rejected', async () => {
  const starter = (await aios.setupChecks()).find((c) => c.id === 'starter');
  assert.equal(starter!.status, 'pass');
  assert.match(starter!.message, /founder-operator/);
  assert.equal(aios.applyStarterPack('astronaut'), null);
});

test('skip records the choice without seeding tasks', () => {
  const r = aios.applyStarterPack('skip');
  assert.equal(r!.id, 'skipped');
  const st = JSON.parse(fs.readFileSync(path.join(root, '.glass', 'state.json'), 'utf8'));
  assert.equal(st['aios.starterPack.v1'].id, 'skipped');
});
