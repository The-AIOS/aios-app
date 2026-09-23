/**
 * The PowerShell script policy on Windows — reported 2026-09-22 from a machine whose every
 * terminal opened on "running scripts is disabled on this system".
 *
 * The wrapper installer writes `spawn` into the operator's $PROFILE. Windows PowerShell 5.1 on a
 * client defaults to `Restricted`, so that profile can never load — and every probe this app ran
 * passed `-ExecutionPolicy Bypass`, so the doctor measured a machine that does not exist and
 * reported spawn as wired. These run on any platform: the DECISION is pure, and the calls around
 * it are what a Windows pass verifies.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { psPolicyVerdict, PS_POLICY_FIX } from '../main/aios';
import { deriveOnboarding } from '../core/onboarding';

test('the verdict: which policies refuse an unsigned local profile', () => {
  assert.equal(psPolicyVerdict('Restricted', false), 'blocked', 'the client default — the reported machine');
  assert.equal(psPolicyVerdict('AllSigned', false), 'blocked', 'an unsigned profile fails AllSigned too');
  assert.equal(psPolicyVerdict('Undefined', false), 'blocked', 'no scope set one → Restricted on a client');
  assert.equal(psPolicyVerdict('', false), 'blocked', 'unreadable is not permission');
  for (const ok of ['RemoteSigned', 'Unrestricted', 'Bypass', 'remotesigned']) {
    assert.equal(psPolicyVerdict(ok, false), 'ok', `${ok} runs a local unsigned profile`);
  }
});

test('a group-policy-pinned value gets words, never a repair button that cannot work', () => {
  /* MachinePolicy / UserPolicy override CurrentUser, so the per-user fix would run, succeed, and
     change nothing — a button the operator presses and watches fail is worse than an explanation. */
  assert.equal(psPolicyVerdict('Restricted', true), 'managed');
  assert.equal(psPolicyVerdict('RemoteSigned', true), 'ok', 'managed but permissive is simply fine');
});

test('the repair is per-user, needs no admin, and is never a blanket Unrestricted', () => {
  assert.match(PS_POLICY_FIX, /-Scope CurrentUser/, 'per user — no elevation prompt');
  assert.match(PS_POLICY_FIX, /RemoteSigned/, 'still refuses unsigned DOWNLOADED scripts');
  assert.doesNotMatch(PS_POLICY_FIX, /Unrestricted|Bypass/, 'never weaken it further than needed');
  assert.match(PS_POLICY_FIX, /-NoProfile/, 'the repair must not first trip over the profile it is fixing');
});

test('CANNOT TRAP ANYONE: a blocked policy alone never blocks a setup step', () => {
  /* "It has worked for most users, so handle with care." On a machine where setup works, the
     policy is permissive and this row passes silently. Where it is blocked, it is OPTIONAL — so
     it can surface, but never hold step 1 closed on its own. That matters most on a managed
     machine, where no repair exists: a required row there would be a permanent dead end. */
  const pass = (id: string) => ({ id, status: 'pass' as const });
  const st = deriveOnboarding([
    pass('git'), pass('claude'), pass('node'), { id: 'psPolicy', status: 'warn' as const },
    pass('account'), pass('gh'), { id: 'personalized', status: 'warn' as const },
  ]);
  const prereqs = st.steps.find((s) => s.id === 'prereqs');
  assert.equal(prereqs?.done, true, 'prereqs stays done with the policy row warning');
  assert.ok(prereqs?.checks.some((c) => c.id === 'psPolicy'), 'but the row is there to be seen');

  /* And on macOS / Linux the check simply does not exist — an absent OPTIONAL check is skipped,
     where an absent REQUIRED one would have locked every non-Windows machine out of step 1. */
  const mac = deriveOnboarding([pass('git'), pass('claude'), pass('node'), pass('account'), pass('gh'), pass('personalized')]);
  assert.equal(mac.steps.find((s) => s.id === 'prereqs')?.done, true);
});

const AIOS = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main', 'aios.ts'), 'utf8');
const body = (name: string): string => {
  const i = AIOS.indexOf(`function ${name}(`);
  assert.notEqual(i, -1, `${name} must exist`);
  return AIOS.slice(i, AIOS.indexOf('\n}\n', i));
};

test('the probes measure the policy the operator\'s terminal actually runs under', () => {
  /* The original defect: Bypass applies to the profile a probe loads, so the spawn probe loaded a
     profile the real terminal refuses and reported spawn present. */
  /* The ARGUMENT, quoted as it appears in an execFile array — not the word. Matching the word
     fired on the comment inside psProfileOnce that explains why Bypass was removed: a guard
     sensitive to its own documentation, the same mistake as the MY_SURFACE pin a week earlier. */
  for (const fn of ['psProfileOnce', 'psPolicyProbe']) {
    assert.doesNotMatch(body(fn), /'-ExecutionPolicy'/, `${fn} must not override the policy it is measuring`);
  }
  assert.match(body('psPolicyProbe'), /'-NoProfile'/,
    'the policy probe must not load the profile — it would be broken by the thing it diagnoses');
});

test('the spawn check no longer passes on a function PowerShell will not load', () => {
  const i = AIOS.indexOf("id: 'spawn', severity: 'warn'");
  const spawnCheck = AIOS.slice(i, AIOS.indexOf("id: 'spawn', label: t('setupCheck.spawn'), status: 'pass'", i) + 200);
  assert.match(spawnCheck, /const written = psProfileFiles\(\)/, 'reading the file is kept…');
  assert.match(spawnCheck, /psPolicyVerdict\([\s\S]{0,80}?\)[\s\S]{0,60}?if \(v !== 'ok'\)/,
    '…but a written function only counts once the policy lets PowerShell load it');
  assert.doesNotMatch(spawnCheck, /ok = psProfileFiles\(\)\.some/,
    'the old unconditional file-read pass must be gone');
});

test('the claude check fails where Claude genuinely cannot start — a blocked .ps1 shim', () => {
  const i = AIOS.indexOf("id: 'claude', severity: 'fail'");
  const claudeCheck = AIOS.slice(i, i + 4000);
  assert.match(claudeCheck, /\/externalscript\/i\.test\(pp\.claudeType\) && verdict !== 'ok'/,
    'an npm install resolves to ExternalScript; the native installer is an Application and is unaffected');
});
