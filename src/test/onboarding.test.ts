/**
 * Onboarding-flow tests — the pure gating model (deriveOnboarding over fabricated
 * CheckResults) plus the fs-backed onboardingState() over the doctor fixture.
 * Exec-backed checks (git, claude, gh, spawn) run for real inside onboardingState,
 * so assertions there stay machine-independent (shape + enum only).
 */
import { test, before } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { deriveOnboarding, ONBOARDING_STEPS, type OnboardingCheckLike } from '../core/onboarding';
import * as aios from '../main/aios';

/* No 'identity': its check passed on the shipped template (`My name is {{full name}}.`
   satisfied "contains 'my name is'"), so the step went green on a vault nobody had touched.
   The final step's 'personalized' check verifies the RESULT instead — see core/personalized.ts. */
const ALL_IDS = ['git', 'node', 'claude', 'framework', 'vault', 'account', 'skills', 'plugin', 'spawn', 'mcpObsidian', 'starter', 'gh', 'personalized'];
const battery = (pass: string[], warnOnly: string[] = []): OnboardingCheckLike[] =>
  ALL_IDS.map((id) => ({ id, status: pass.includes(id) ? 'pass' : warnOnly.includes(id) ? 'warn' : 'fail' }));

test('deriveOnboarding: nothing works → step 1 active, everything after locked', () => {
  const { steps, current } = deriveOnboarding(battery([]));
  assert.equal(current, 0);
  assert.equal(steps[0].state, 'active');
  for (const s of steps.slice(1)) assert.equal(s.state, 'locked');
});

test('deriveOnboarding: node is optional — prereqs completes on git+claude alone (node still warn)', () => {
  const { steps, current } = deriveOnboarding(battery(['git', 'claude'], ['node']));
  assert.equal(steps[0].done, true, 'prereqs done without node');
  assert.equal(current, 1, 'login is next');
  assert.equal(steps[1].state, 'active');
  // the optional check still SHOWS on the step (surface, don't gate)
  assert.ok(steps[0].checks.some((c) => c.id === 'node'));
});

test('the setup step SHOWS the downstream checks but gates only on personalization', () => {
  /* The flow went from seven steps to four: the app owns install / sign-in / authorize, and
     everything after that belongs to the setup session. The vault, wiring and starter checks
     still hang off the final step as `optional` — visible, so a half-finished session is legible
     — but they must NEVER gate it, or the last box locks while the session it describes is in
     the middle of satisfying it. This is the assertion that stops someone quietly moving one
     back into `required`. */
  const spec = ONBOARDING_STEPS.find((x) => x.id === 'firstrun')!;
  assert.deepEqual(spec.required, ['personalized'], 'one gate: evidence the vault became someone\'s');
  for (const id of ['framework', 'vault', 'skills', 'mcpObsidian', 'spawn', 'plugin', 'starter']) {
    assert.ok(spec.optional?.includes(id), `${id} must be surfaced on the setup step`);
    assert.ok(!spec.required.includes(id), `${id} must not gate the setup step`);
  }
  // and with every downstream check failing, the step is still reachable and still not done
  const d = deriveOnboarding(battery(['git', 'claude', 'account', 'gh'], ['personalized', 'vault', 'skills']));
  const i = d.steps.findIndex((x) => x.id === 'firstrun');
  assert.equal(d.current, i, 'the handover is the active step once the mechanics pass');
  assert.equal(d.steps[i].done, false);
  assert.ok(d.steps[i].checks.some((c) => c.id === 'vault'), 'its checks are visible');
});

test('deriveOnboarding: everything passes → all done, current past the end', () => {
  const { steps, current } = deriveOnboarding(battery(ALL_IDS));
  assert.equal(current, ONBOARDING_STEPS.length);
  for (const s of steps) assert.equal(s.state, 'done');
});

test('deriveOnboarding: a missing required check can never read as done', () => {
  const noFirstrun = battery(ALL_IDS).filter((c) => c.id !== 'personalized');
  const { steps, current } = deriveOnboarding(noFirstrun);
  const i = steps.findIndex((s) => s.id === 'firstrun');
  assert.equal(steps[i].done, false, 'absent evidence is not pass');
  assert.equal(current, i, 'the flow stops on the step whose evidence is missing');
});

test('there are exactly four steps, in the order an operator can follow', () => {
  /* Seven boxes asked seven decisions of someone with no basis for making them. "Starter pack"
     was the proof: the operator read it, clicked it, and still could not say what it did — and if
     the person who commissioned the feature cannot explain it at the moment of use, a newcomer
     cannot either. Four steps, each one thing, the last one a conversation. */
  assert.deepEqual(ONBOARDING_STEPS.map((x) => x.id), ['prereqs', 'login', 'github', 'firstrun']);
  for (const dead of ['vault', 'wiring', 'starter', 'identity']) {
    assert.ok(!ONBOARDING_STEPS.some((x) => x.id === dead), `${dead} is no longer a step`);
  }
});

test('deriveOnboarding: an earlier regression pulls the active step back (idempotent re-verify)', () => {
  // the Claude account fell out AFTER GitHub was connected — the flow re-activates login,
  // and GitHub stays done. Re-verify, never re-do.
  const d = deriveOnboarding(battery(['git', 'claude', 'gh'], ['account']));
  const iLogin = d.steps.findIndex((x) => x.id === 'login');
  assert.equal(d.current, iLogin, 'login is the first not-done step again');
  assert.equal(d.steps.find((x) => x.id === 'github')!.state, 'done', 'GitHub stays done');
});

test('storeGitHubPat: rejects empty and whitespace-carrying tokens without touching git', () => {
  assert.equal(aios.storeGitHubPat(''), false);
  assert.equal(aios.storeGitHubPat('   '), false);
  assert.equal(aios.storeGitHubPat('ghp abc'), false);
});

// ── fs-backed: onboardingState over a fixture framework (same seams as doctor.test) ──

before(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-onboarding-fw-'));
  const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-onboarding-home-'));
  process.env.GLASS_FRAMEWORK_PATH = root;
  process.env.GLASS_CLAUDE_HOME = claudeHome;
  process.env.GLASS_CLAUDE_JSON = path.join(claudeHome, 'claude.json');
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# Test framework\n');
  fs.mkdirSync(path.join(root, 'vault', '00 - notes'), { recursive: true });
  fs.writeFileSync(path.join(claudeHome, 'claude.json'), JSON.stringify({}));
});

test('onboardingState: every step in flow order, real CheckResults behind each', async () => {
  const st = await aios.onboardingState();
  assert.equal(st.steps.length, ONBOARDING_STEPS.length);
  assert.deepEqual(st.steps.map((s) => s.id), ONBOARDING_STEPS.map((s) => s.id));
  assert.ok(st.current >= 0 && st.current <= st.steps.length);
  for (const s of st.steps) {
    assert.ok(['done', 'active', 'locked'].includes(s.state));
    for (const c of s.checks) {
      assert.ok(c.id && c.label, `check carries id+label (${s.id})`);
      assert.ok(['pass', 'warn', 'fail'].includes(c.status));
    }
  }
  // no daily note in the fixture vault → the finale is honest about it
  const firstrun = st.steps.find((s) => s.id === 'firstrun')!.checks.find((c) => c.id === 'personalized');
  assert.ok(firstrun);
  assert.equal(firstrun!.status, 'warn');
  /* No repairCmd, deliberately. The old finale ran `/aios:today` — which a TEMPLATE vault can
     satisfy: it plans a day for a person it knows nothing about, writes the note, and turns the
     step green. The handover is a session an operator talks to, not a command to fire, so the
     action lives in the UI (asserted in menu.test.ts) and this check only reports the truth. */
  assert.equal(firstrun!.repairCmd, undefined, 'the finale is a conversation, not a command');
  assert.match(firstrun!.message, /.+/, 'and it must say WHY it is not done yet');
});
