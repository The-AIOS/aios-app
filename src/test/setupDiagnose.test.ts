/**
 * The red-state rule, generalized from the first external setup fix (#18).
 *
 * That fix removed ONE command offered for a missing tool. These tests make it a rule: the same
 * mistake in any other check now fails here instead of on someone's first morning.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as cp from 'child_process';
import * as aios from '../main/aios';
import { deriveOnboarding } from '../core/onboarding';
import {
  toolsInvoked, isRunnable, parsePlan, firstAvailable, triage, diagnosticsReport,
  unverifiable, CHECK_NEEDS, TOOL_CHECK, type DiagCheck,
} from '../core/setupDiagnose';

/* WHY EVERY RED STATE HERE IS FABRICATED, and must be.
   The doctor probes through a LOGIN shell (`zsh -lc` / a PowerShell with the user's profile), so
   it sees what a real terminal sees — which is the whole point, and also means a red state CANNOT
   be produced by manipulating PATH or the environment of the test process: the login shell
   re-sources the profile and restores the real PATH. Measured: hiding `gh` and `claude` from PATH
   and re-running the real battery still reports every check passing.
   So the split is deliberate. These tests fabricate CheckResults and pin the DECISIONS; a faithful
   end-to-end red state needs a second real account (this Mac has a non-admin `aiostest` whose
   Homebrew is owned by another user — the exact machine shape behind #18). Do not "fix" this by
   reaching for env stubs; they will report green and prove nothing. */
const chk = (id: string, status: DiagCheck['status'], over: Partial<DiagCheck> = {}): DiagCheck =>
  ({ id, status, ...over });

test('a command invokes the tool at the COMMAND position, not one merely mentioned', () => {
  assert.deepEqual(toolsInvoked('gh auth login --web'), ['gh']);
  assert.deepEqual(toolsInvoked('claude /login'), ['claude']);
  assert.deepEqual(toolsInvoked('git config --global x y'), ['git']);
  // chained statements each count
  assert.deepEqual(toolsInvoked('claude /logout && claude /login').sort(), ['claude']);
  assert.deepEqual(toolsInvoked('git init ; gh repo create').sort(), ['gh', 'git']);
  // a tool named inside an ARGUMENT is not invoked
  assert.deepEqual(toolsInvoked("echo 'run gh auth login yourself'"), []);
  // an absolute path still resolves to the tool
  assert.deepEqual(toolsInvoked('/opt/homebrew/bin/gh auth status'), ['gh']);
  assert.deepEqual(toolsInvoked(`'C:\\Program Files\\GitHub CLI\\gh.exe' auth status`), ['gh'],
    'a quoted command path is the real Windows shape — an unquoted one with spaces would not run either');
});

test('the installer LADDER is always runnable — it exists because the tool is missing', () => {
  /* The one command that must never be refused for naming a missing tool: refusing it would
     block the only thing that fixes the problem. The follow-up rides inside --then, which the
     ladder runs itself once PATH has been re-read. */
  const ladder = "bash '/x/scripts/setup/install-tool.sh' gh --then 'gh auth login --web'";
  assert.deepEqual(toolsInvoked(ladder), []);
  assert.deepEqual(isRunnable(ladder, [chk('gh', 'fail')]), { ok: true });
  const ps = "powershell -File 'C:\\x\\install-tool.ps1' -Tool gh -Then 'gh auth login'";
  assert.deepEqual(isRunnable(ps, [chk('gh', 'fail')]), { ok: true });
});

test('THE RULE: never offer a command for a tool the doctor found missing', () => {
  // the exact shape of the incident: Connect GitHub running `gh auth login` with no gh
  assert.deepEqual(isRunnable('gh auth login --web', [chk('gh', 'fail')]), { ok: false, missing: 'gh' });
  // and its siblings, which were never reported but are the same mistake
  assert.deepEqual(isRunnable('claude /login', [chk('claude', 'fail')]), { ok: false, missing: 'claude' });
  // `missing` names the tool the OPERATOR would type; `node` is merely the check that proves it
  assert.deepEqual(isRunnable('npm i -g x', [chk('node', 'fail')]), { ok: false, missing: 'npm' });
  // a WARN is degraded, not absent — the command still runs
  assert.deepEqual(isRunnable('gh auth login', [chk('gh', 'warn')]), { ok: true });
  assert.deepEqual(isRunnable('gh auth login', [chk('gh', 'pass')]), { ok: true });
  // no check ran → allowed. Absence of evidence is not evidence of absence, and refusing here
  // would disable working remedies on a machine whose battery ran short.
  assert.deepEqual(isRunnable('gh auth login', []), { ok: true });
  assert.deepEqual(isRunnable(undefined, [chk('gh', 'fail')]), { ok: true });
});

test('every tool the guard knows maps to a check the doctor actually runs', async () => {
  /* A tool mapped to a check id nothing produces can never be proven missing, so the guard would
     silently pass everything for it — the failure mode that looks like success.
     Asserted against the ids the battery really emits, never against source text: `git` is built
     through a `whichCheck(...)` helper and the string `id: 'git'` appears nowhere. */
  const ids = new Set((await aios.setupChecks()).map((c) => c.id));
  for (const [tool, checkId] of Object.entries(TOOL_CHECK)) {
    assert.ok(ids.has(checkId), `${tool} → '${checkId}', which the doctor never produces`);
  }
});

test('--plan output parses into rungs, and the usable one is named', () => {
  const out = [
    'tool: gh · os: darwin · arch: arm64',
    '  1. brew — Homebrew (already installed and writable) (available here)',
    '  2. macports — MacPorts (not available here)',
    '  3. homebrew — install Homebrew, then use it (needs an admin account) (not available here)',
    '  4. release — the official download, checksum-verified, into your home folder (no admin) (available here)',
    '  page: https://cli.github.com/',
  ].join('\n');
  const plan = parsePlan('gh', out);
  assert.equal(plan.rungs.length, 4);
  assert.equal(plan.page, 'https://cli.github.com/');
  assert.deepEqual(plan.rungs.map((r) => r.available), [true, false, false, true]);
  assert.equal(firstAvailable(plan)?.id, 'brew');
  // a machine where nothing works still parses, and says so
  const none = parsePlan('gh', out.replace(/\(available here\)/g, '(not available here)'));
  assert.equal(firstAvailable(none), undefined);
  assert.equal(none.page, 'https://cli.github.com/', 'the page survives — it is the last resort');
});

test('triage resolves each red check to ONE action, failures before warnings', () => {
  const checks = [
    chk('skills', 'warn', { repairCmd: 'bash setup.sh' }),
    chk('claude', 'fail', { repairCmd: "bash '/x/install-tool.sh' claude" }),
  ];
  const t = triage(checks);
  assert.equal(t.items.length, 2);
  assert.equal(t.items[0].checkId, 'claude', 'a fail outranks a warn — repairing a degraded skill count while Claude is missing answers the wrong question');
  assert.equal(t.items[0].kind, 'run');
  assert.equal(t.supportOnly, false);
});

test('triage falls back to the vendor page, and to support only when nothing else is left', () => {
  // a command that would run a missing tool is NOT offered; the page is
  const withPage = triage([chk('gh', 'fail', { repairCmd: 'gh auth login' })],
    { gh: parsePlan('gh', '  1. brew — Homebrew (not available here)\n  page: https://cli.github.com/') });
  assert.equal(withPage.items[0].kind, 'open');
  assert.equal(withPage.items[0].url, 'https://cli.github.com/');
  // a repairHint that is itself a URL is the same lane
  assert.equal(triage([chk('gh', 'fail', { repairHint: 'https://cli.github.com/' })]).items[0].kind, 'open');
  // nothing runnable and nowhere to send them → support, and the flag says so
  const stuck = triage([chk('vault', 'fail', { message: 'no vault' })]);
  assert.equal(stuck.items[0].kind, 'support');
  assert.equal(stuck.supportOnly, true);
  // an all-green machine has nothing to triage and is NOT support-only
  assert.deepEqual(triage([chk('gh', 'pass')]), { items: [], supportOnly: false });
});

test('triage names the rung this machine will actually use', () => {
  const plan = parsePlan('gh', '  1. brew — Homebrew (already installed and writable) (available here)');
  const t = triage([chk('gh', 'fail', { repairCmd: "bash '/x/install-tool.sh' gh" })], { gh: plan });
  assert.equal(t.items[0].via, 'Homebrew (already installed and writable)',
    'a red state that names its route reads as a described path, not as a fault');
});

test('the diagnostics report carries the checks and the routes, and no account identifiers', () => {
  const checks = [chk('gh', 'fail', { message: 'not installed' }), chk('vault', 'pass', { message: '/Users/someone/aios' })];
  const r = diagnosticsReport(checks, { gh: parsePlan('gh', '  1. brew — Homebrew (not available here)') },
    { app: '0.9.5', platform: 'darwin', arch: 'arm64' });
  assert.match(r, /\[FAIL\] gh — not installed/);
  assert.match(r, /--- brew/, 'an unusable rung is what a maintainer needs to see');
  assert.match(r, /0\.9\.5 · darwin\/arm64/);
  // it reports what the checks said and invents nothing
  assert.doesNotMatch(r, /token|password|@/i);
  /* ONE LINE PER CHECK, always — found by running it: the claude probe echoes its version twice,
     so an un-flattened message silently turned one row into two and made the rows uncountable. */
  const multi = diagnosticsReport([{ id: 'claude', status: 'pass', message: '2.1.0 (Claude Code)\n2.1.0 (Claude Code)' }],
    {}, { app: '1', platform: 'darwin', arch: 'arm64' });
  assert.equal(multi.split('\n').filter((l) => l.startsWith('[')).length, 1);
  assert.match(multi, /\[PASS\] claude — 2\.1\.0 \(Claude Code\) 2\.1\.0 \(Claude Code\)/);
});

test('the ladder really does plan every tool on this machine (no fixture)', { skip: process.platform === 'win32' }, () => {
  /* The parser above reads a fixture; this proves the fixture still matches the real script.
     A parser that drifts from its input silently reports "no routes" — which triage would then
     turn into a support ticket for a machine that could have installed the tool itself. */
  const script = 'scripts/setup/install-tool.sh';
  assert.ok(fs.existsSync(script), 'the dev tree must carry the installer');
  for (const tool of ['gh', 'git', 'node']) {
    const out = cp.execFileSync('bash', [script, tool, '--plan'], { encoding: 'utf8' });
    const plan = parsePlan(tool, out);
    assert.ok(plan.rungs.length >= 2, `${tool}: expected several rungs, parsed ${plan.rungs.length}`);
    assert.ok(plan.page, `${tool}: a download page is the last resort and must always be named`);
    assert.ok(plan.rungs.some((r) => r.available), `${tool}: this machine must have at least one way in`);
  }
});

test('the DOCTOR withholds an unrunnable remedy — the rule is enforced once, for every surface', () => {
  /* Enforcing this in the battery rather than at each button is the load-bearing choice: every
     surface reads these results, so a command withheld here cannot be offered by any of them,
     and a surface added later inherits the rule instead of having to remember it. */
  const raw = fs.readFileSync('src/main/aios.ts', 'utf8');
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /generalized form of the first external/, 'the comment stripper did not strip');
  const i = code.indexOf('export async function setupChecks');
  assert.ok(i > 0, 'setupChecks must exist');
  const body = code.slice(i, code.indexOf('\n}', i));
  assert.match(body, /isRunnable\(c\.repairCmd, all\)/, 'the battery must apply the rule to its own remedies');
  assert.match(body, /c\.repairCmd = undefined/, 'a withheld remedy must be REMOVED, not merely flagged');
  assert.match(body, /c\.blockedBy = verdict\.missing/, 'and the row must name the tool in the way');
  /* The hint is rendered as the tooltip AND as a `$ …` line, so leaving it would keep telling the
     operator to type the command we just decided must not run — but a URL hint is the vendor
     download page, which is exactly what they DO need. */
  assert.match(body, /repairHint = undefined/);
  assert.match(body, /https/, 'a URL hint must survive — it is the remaining route');
});

test('withholding keeps the diagnosis and removes only the dead end', () => {
  // What the operator is left with: the same red row, the same message, no button that lies.
  const checks: DiagCheck[] = [
    { id: 'claude', status: 'fail', message: 'not installed' },
    { id: 'account', status: 'fail', message: 'not signed in', repairCmd: 'claude /login', canRepair: false },
  ];
  const verdict = isRunnable(checks[1].repairCmd, checks);
  assert.deepEqual(verdict, { ok: false, missing: 'claude' },
    'signing in needs Claude — offering the login while Claude is missing is the #18 bug one step along');
  // and triage agrees: no runnable action, so it does not invent one
  assert.equal(triage(checks).items.find((i) => i.checkId === 'account')?.kind, 'support');
});

/* ── the surface ─────────────────────────────────────────────────────────────────────────── */

const RENDERER = (): string => fs.readFileSync('renderer/app.js', 'utf8');
/* Code only. The comment beside the dead gate NAMES it — explaining why it is not resurrected —
   so a raw grep finds the very string the test forbids and fails on the explanation. */
const RENDERER_CODE = (): string => RENDERER()
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

test('NO STEP-GATED BRANCH NAMES A STEP THAT DOES NOT EXIST', () => {
  /* The bug that started this pass: the per-row Fix button was gated on `s.id === 'wiring'`, a
     step id that stopped existing when the seven-step flow collapsed to four. It could never
     render, so every red check row was inert — and nothing failed, because a branch that is
     never taken looks exactly like a branch that is never needed. */
  const steps = [...fs.readFileSync('src/core/onboarding.ts', 'utf8')
    .matchAll(/\{\s*id:\s*'([a-z]+)'/g)].map((m) => m[1]);
  assert.ok(steps.length >= 4, `expected the step list, parsed ${steps.join(',')}`);
  const code = RENDERER_CODE();
  assert.doesNotMatch(code, /a step id that stopped existing/, 'the comment stripper did not strip');
  assert.match(code, /function stepEl/, 'the comment stripper ate the code');
  for (const m of code.matchAll(/s\.id === '([a-z]+)'/g)) {
    assert.ok(steps.includes(m[1]),
      `renderer gates on step '${m[1]}', which ONBOARDING_STEPS does not define — dead branch`);
  }
});

test('the setup screen says WHY it exists, once, before anything can go wrong', () => {
  const app = RENDERER();
  for (const k of ['setup.whyTitle', 'setup.whyBody']) assert.ok(app.includes(k), k);
  const i = app.indexOf("t('setup.whyBody')");
  const j = app.indexOf("const list = el('div', 'steps')");
  assert.ok(i > 0 && j > 0 && i < j, 'the explanation must come BEFORE the steps it explains');
});

test('emphasis is authored as plain text and BUILT, never shipped as markup', () => {
  /* Prose like this gets translated. A `<strong>` inside the string puts a tag in a translator's
     hands, where it can come back dropped, unbalanced, or around the wrong words — rendering as
     raw markup or swallowing the sentence. A missing `**` pair degrades to literal asterisks. */
  const app = RENDERER();
  const i = app.indexOf('function emphasized(');
  assert.ok(i > 0, 'the builder must exist');
  const body = app.slice(i, app.indexOf('\nfunction ', i + 10));
  assert.match(body, /createTextNode/, 'plain runs must be text nodes');
  assert.match(body, /createElement\('strong'\)/);
  assert.match(body, /\.textContent = /, 'the emphasised run must be set as TEXT, not markup');
  assert.doesNotMatch(body, /innerHTML/, 'prose must never reach innerHTML');
  for (const loc of ['en', 'es', 'pt-br']) {
    const d = JSON.parse(fs.readFileSync(`src/i18n/locales/${loc}.json`, 'utf8'));
    for (const k of ['setup.whyTitle', 'setup.whyBody']) {
      assert.ok(d[k] && String(d[k]).trim(), `${loc}: ${k} missing`);
      assert.doesNotMatch(String(d[k]), /<[a-z/]/i, `${loc}: ${k} carries markup — author emphasis as **bold**`);
    }
    /* Balanced, and the SAME count everywhere: a translation that drops a pair loses the
       ownership beat the sentence exists for, and nothing else would report it. */
    const marks = (String(d['setup.whyBody']).match(/\*\*/g) || []).length;
    assert.equal(marks % 2, 0, `${loc}: unbalanced ** in setup.whyBody`);
    assert.equal(marks, 6, `${loc}: expected 3 emphasised runs, found ${marks / 2}`);
  }
});

test('the triage entry takes ONE action and never renders a findings list', () => {
  const app = RENDERER();
  const i = app.indexOf('function troubleEl()');
  assert.ok(i > 0, 'the entry must exist');
  const body = app.slice(i, app.indexOf('function onboardingDoneEl()'));
  assert.match(body, /doctorTriage\(\)/, 'it must run the real triage, not re-read the rendered rows');
  assert.match(body, /tri\.items\[0\]/, 'it acts on the FIRST blocker');
  assert.doesNotMatch(body, /items\.map|items\.forEach/,
    'handing back a list is the triage work this button exists to do');
  // all three outcomes are wired, and the last one is honest rather than a retry
  assert.match(body, /'run'/); assert.match(body, /'open'/);
  assert.match(body, /copyText\(tri\.report\)/, 'the support lane must hand over something sendable');
});

test('the entry appears while setup is UNFINISHED, not after', () => {
  const app = RENDERER();
  assert.match(app, /if \(st\.current >= st\.steps\.length\) list\.appendChild\(onboardingDoneEl\(\)\);\s*\n\s*else list\.appendChild\(troubleEl\(\)\);/,
    'a finished setup has nothing to triage; an unfinished one is exactly when someone is stuck');
});

test('every new setup string exists in all three locales', () => {
  const app = RENDERER();
  const keys = [...app.matchAll(/t\('(setup\.(?:why|trouble|blockedBy)[A-Za-z]*)'/g)].map((m) => m[1]);
  assert.ok(keys.length >= 8, `expected the new keys to be used, found ${keys.length}`);
  for (const loc of ['en', 'es', 'pt-br']) {
    const d = JSON.parse(fs.readFileSync(`src/i18n/locales/${loc}.json`, 'utf8'));
    for (const k of keys) assert.ok(d[k] && String(d[k]).trim(), `${loc}: ${k} missing`);
  }
});

test('the disclaimer explains the trade without blaming the operator or the app', () => {
  /* Its whole job is to convert "this app is broken" into "it is adopting my machine". Copy that
     apologises, or that calls a red box an error, does the opposite. */
  for (const loc of ['en', 'es', 'pt-br']) {
    const d = JSON.parse(fs.readFileSync(`src/i18n/locales/${loc}.json`, 'utf8'));
    const body = String(d['setup.whyBody']);
    assert.ok(body.length > 120, `${loc}: too short to actually explain the trade`);
    assert.doesNotMatch(body, /sorry|lo sentimos|desculpe/i, `${loc}: apologising frames the design as a fault`);
    assert.doesNotMatch(body, /\berror\b|\bfail(ed|ure)?\b/i, `${loc}: a red box here is a not-found, not an error`);
  }
});

test('A PASS THAT CANNOT BE TRUSTED IS NOT A PASS — the false green', () => {
  /* Measured on a real machine (aiostest, 2026-09-11): with `claude` moved aside, the `account`
     check still reported PASS — it answers from ~/.claude.json alone and never touches the
     binary — so the stepper drew a green tick reading "Log in to Claude · you@example.com" while
     nothing on that machine could run. Worse than a red row, which at least sends you somewhere.
     Off-PATH is the case that makes it a rule rather than a one-off: the credential file is
     perfectly intact exactly then, so the check passes with full confidence on a dead machine. */
  const withClaude = (st: DiagCheck['status']): DiagCheck[] => [
    { id: 'claude', status: st },
    { id: 'account', status: 'pass', message: 'you@example.com' },
  ];
  assert.deepEqual(unverifiable(withClaude('fail')), [{ id: 'account', needs: 'claude' }]);
  // a WORKING claude leaves it alone — this must not fire in the normal case
  assert.deepEqual(unverifiable(withClaude('pass')), []);
  // and a DEGRADED claude is not an absent one
  assert.deepEqual(unverifiable(withClaude('warn')), []);
  // a check that is already telling the truth is never touched
  assert.deepEqual(unverifiable([{ id: 'claude', status: 'fail' }, { id: 'account', status: 'fail' }]), []);
  // no claude result at all → nothing is proven, so nothing is downgraded
  assert.deepEqual(unverifiable([{ id: 'account', status: 'pass' }]), []);
});

test('every dependency names a check the doctor really produces', async () => {
  /* A dependency pointing at an id nothing emits can never fire — it would look like the rule is
     working while silently protecting nothing. Same trap the tool map has. */
  const ids = new Set((await aios.setupChecks()).map((c) => c.id));
  for (const [id, needs] of Object.entries(CHECK_NEEDS)) {
    assert.ok(ids.has(id), `CHECK_NEEDS names '${id}', which the doctor never produces`);
    assert.ok(ids.has(needs), `'${id}' depends on '${needs}', which the doctor never produces`);
  }
});

test('the doctor downgrades an untrustworthy pass BEFORE anything reads it', () => {
  const raw = fs.readFileSync('src/main/aios.ts', 'utf8');
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const i = code.indexOf('export async function setupChecks');
  const body = code.slice(i, code.indexOf('\n}', i));
  assert.match(body, /unverifiable\(all\)/, 'the battery must apply the rule');
  assert.match(body, /c\.status = 'warn'/, "a pass it cannot vouch for must stop being a pass");
  assert.match(body, /c\.blockedBy = needs/, 'and must name what is in the way');
  /* Order matters: the downgrade has to run BEFORE the remedy guard, or the guard judges a
     status that is about to change underneath it. */
  assert.ok(body.indexOf('unverifiable(all)') < body.indexOf('isRunnable(c.repairCmd'),
    'downgrade first, then withhold remedies');
});

test('the why-note is ONE paragraph — the closer was cut for length', () => {
  /* Read in place, the two-paragraph version was too long for the top of a screen someone wants
     to get past. The operational half is not lost: a red row explains itself where it appears. */
  const app = RENDERER();
  assert.doesNotMatch(app, /setup\.whyClose/, 'the closer is retired, not orphaned in the renderer');
  for (const loc of ['en', 'es', 'pt-br']) {
    const d = JSON.parse(fs.readFileSync(`src/i18n/locales/${loc}.json`, 'utf8'));
    assert.equal(d['setup.whyClose'], undefined, `${loc}: dead string left behind`);
  }
});

test('the false green actually un-ticks the step — the consequence, not just the flag', () => {
  /* The rule is only worth having if it changes what the operator SEES. Measured on aiostest:
     with claude hidden, "Log in to Claude" rendered a green tick and the account email. The
     downgrade turns that step from done → locked, which is the truthful state: you cannot sign
     in to something that is not installed. */
  const mk = (o: Record<string, 'pass' | 'warn' | 'fail'>) =>
    Object.entries(o).map(([id, status]) => ({ id, status }));
  const base = { git: 'pass', node: 'pass', gh: 'pass', personalized: 'pass' } as const;
  const stepOf = (checks: Record<string, 'pass' | 'warn' | 'fail'>, id: string) =>
    deriveOnboarding(mk(checks) as never).steps.find((s) => s.id === id)!;

  const before = stepOf({ ...base, claude: 'fail', account: 'pass' }, 'login');
  assert.equal(before.done, true, 'the bug: a credential file alone marked the step done');

  const after = stepOf({ ...base, claude: 'fail', account: 'warn' }, 'login');
  assert.equal(after.done, false, 'a sign-in that cannot be used is not a completed step');
  assert.equal(after.state, 'locked', 'and it waits behind the step that installs Claude');

  // the normal path is untouched: a working Claude still completes the step
  assert.equal(stepOf({ ...base, claude: 'pass', account: 'pass' }, 'login').done, true);
});
