/**
 * The Home's frequent-task count and the picker read ONE list. The count used a list of 16
 * (the App's 8 defaults plus Glass's 8 "about me" prompts, which the App has no text for)
 * while the picker showed the App's 8, so a fresh vault's Home said 16 above a picker of 8.
 */
import { test, before } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as aios from '../main/aios';

let root = '';
const state = (): Record<string, unknown> => JSON.parse(fs.readFileSync(path.join(root, '.glass', 'state.json'), 'utf8'));
const writeState = (s: Record<string, unknown>): void => {
  fs.mkdirSync(path.join(root, '.glass'), { recursive: true });
  fs.writeFileSync(path.join(root, '.glass', 'state.json'), JSON.stringify(s));
};

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-freq-fixture-'));
  const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-freq-home-'));
  process.env.GLASS_FRAMEWORK_PATH = root;
  process.env.GLASS_CLAUDE_HOME = claudeHome;
  process.env.GLASS_CLAUDE_JSON = path.join(claudeHome, 'claude.json');
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# Test framework\n');
  fs.mkdirSync(path.join(root, 'vault', '00 - notes'), { recursive: true });
  fs.writeFileSync(path.join(claudeHome, 'claude.json'), JSON.stringify({}));
});

test('a fresh vault: the Home count is the number of tasks the picker shows', () => {
  const tasks = aios.frequentTasks();
  assert.equal(tasks.length, 8, 'the App ships 8 defaults');
  assert.equal(aios.frequentTaskCount(), tasks.length);
});

test('a saved list with defaults removed and a custom task: the count still follows the picker', () => {
  writeState({
    'aios.frequentTasks.v1': [{ id: 'u-1', label: 'Mine', kind: 'prompt', target: 'do it', hint: '' }, { id: 'deck', label: 'Deck', kind: 'agent', target: 'deck-builder', hint: '' }],
    'aios.frequentTasks.removed.v1': ['email', 'post', 'values'],
  });
  const tasks = aios.frequentTasks();
  assert.equal(aios.frequentTaskCount(), tasks.length);
  assert.deepEqual(tasks.map((t) => t.id), ['u-1', 'deck', 'research', 'meeting', 'clarity', 'ingest', 'infographic']);
});

test('a persona still removes the defaults Glass adds, so Glass shows the same set from the shared file', () => {
  aios.applyStarterPack('founder-operator');
  const removed = state()['aios.frequentTasks.removed.v1'] as string[];
  for (const id of ['bio-event', 'infographic-me', 'infographic-become', 'who-for-audience', 'elevator-pitch', 'whats-changed', 'podcast-intro', 'values']) {
    assert.ok(removed.includes(id), `${id} is recorded as removed`);
  }
  assert.ok(removed.includes('ingest') && !removed.includes('deck'), 'the App defaults outside the pack are removed, the pack ones kept');
  assert.equal(aios.frequentTaskCount(), aios.frequentTasks().length);
});
