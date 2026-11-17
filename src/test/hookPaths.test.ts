/**
 * Canonical v0.8.19 moved hooks into folders (aios#309). The App looks in the new folder first and falls back to the
 * old flat place, so a vault not yet updated keeps working.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import { hookCandidates, findHook } from '../core/hookPaths';
import { missingHooks, FRAMEWORK_HOOKS } from '../core/finishSetup';

test('each moved hook is looked for in its new folder first, then the old place', () => {
  assert.deepEqual(hookCandidates('resolve-tier'), ['hooks/pipeline/resolve-tier', 'hooks/resolve-tier']);
  assert.deepEqual(hookCandidates('install-settings.py'), ['hooks/install/install-settings.py', 'hooks/install-settings.py']);
  assert.deepEqual(hookCandidates('issue-scrub.py'), ['hooks/security/issue-scrub.py', 'hooks/issue-scrub.py']);
  assert.deepEqual(hookCandidates('aios-health.py'), ['hooks/pipeline/aios-health.py', 'hooks/aios-health.py']);
  for (const f of ['inject-datetime.sh', 'provenance.py', 'bus_log.py', 'floor-at-start.py']) assert.equal(hookCandidates(f)[0], `hooks/context/${f}`);
  assert.equal(hookCandidates('model-switch-log.py')[0], 'hooks/pipeline/model-switch-log.py');
  assert.equal(hookCandidates('suggest-agent-hint.py')[0], 'hooks/agents/suggest-agent-hint.py');
  assert.deepEqual(hookCandidates('unknown.py'), ['hooks/unknown.py'], 'a hook that never moved stays where it was');
});

test('findHook: a new vault finds the new place, an old vault the old one, and the new place wins when both exist', () => {
  assert.equal(findHook('resolve-tier', (r) => r === 'hooks/pipeline/resolve-tier'), 'hooks/pipeline/resolve-tier');
  assert.equal(findHook('resolve-tier', (r) => r === 'hooks/resolve-tier'), 'hooks/resolve-tier');
  assert.equal(findHook('resolve-tier', () => true), 'hooks/pipeline/resolve-tier', 'the forwarding file at the old path is not preferred');
  assert.equal(findHook('resolve-tier', () => false), undefined);
});

test('the Setup hooks row finds hooks in their folders, and knows Hook G', () => {
  assert.ok(FRAMEWORK_HOOKS.some((h) => h.sig === 'suggest-agent-hint.py'), 'Hook G is checked');
  const newVault = (rel: string) => /^hooks\/(context|pipeline|agents)\//.test(rel);
  const all = missingHooks({}, newVault);
  for (const sig of ['inject-datetime', 'provenance.py', 'bus_log.py', 'floor-at-start.py', 'model-switch-log.py', 'suggest-agent-hint.py']) {
    assert.ok(all.includes(sig), `${sig}: shipped in its new folder, so missing from an empty settings.json`);
  }
  const wired = { hooks: { UserPromptSubmit: [{ hooks: [{ command: 'python3 ~/aios/hooks/agents/suggest-agent-hint.py' }] }] } };
  assert.ok(!missingHooks(wired, newVault).includes('suggest-agent-hint.py'), 'a wired hook at its new path is not missing');
  assert.deepEqual(missingHooks({}, () => false), [], 'nothing shipped, nothing missing');
  const oldVault = (rel: string) => rel === 'hooks/provenance.py';
  assert.deepEqual(missingHooks({}, oldVault), ['provenance.py'], 'an old flat vault still counts');
});

test('wiring: the App runs resolve-tier and install-settings.py from the new place first', () => {
  const bus = fs.readFileSync('src/main/commandBus.ts', 'utf8');
  const aios = fs.readFileSync('src/main/aios.ts', 'utf8');
  assert.match(bus, /findHook\('resolve-tier'/);
  assert.doesNotMatch(bus, /path\.join\(root, 'hooks', 'resolve-tier'\)/, 'no hardcoded old path');
  assert.equal((aios.match(/const script = installSettingsScript\(\);/g) || []).length, 2, 'the check and the repair both');
  assert.doesNotMatch(aios, /scriptIf\(path\.join\('hooks', 'install-settings\.py'\)\)/);
});

test('review: a settings.json still running the OLD path is not wired once the hook ships in its new folder', () => {
  const newVault = (rel: string) => rel === 'hooks/context/provenance.py' || rel === 'hooks/provenance.py';   // v0.8.19: new file plus the forwarding stub
  const old = { hooks: { PostToolUse: [{ hooks: [{ command: 'python3 ~/aios/hooks/provenance.py' }] }] } };
  const fresh = { hooks: { PostToolUse: [{ hooks: [{ command: 'python3 ~/aios/hooks/context/provenance.py' }] }] } };
  const win = { hooks: { PostToolUse: [{ hooks: [{ command: 'python C:\\Users\\x\\aios\\hooks\\context\\provenance.py' }] }] } };
  assert.ok(missingHooks(old, newVault).includes('provenance.py'), 'old path: Repair is offered');
  assert.ok(!missingHooks(fresh, newVault).includes('provenance.py'), 'new path: wired');
  assert.ok(!missingHooks(win, newVault).includes('provenance.py'), 'new path with Windows backslashes: wired');
  const oldVault = (rel: string) => rel === 'hooks/provenance.py';
  assert.ok(!missingHooks(old, oldVault).includes('provenance.py'), 'an old framework with the old path: still wired');
});
