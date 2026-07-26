/**
 * Doctor-engine tests — the repairable-checks loop against a REAL fixture:
 * a framework root (GLASS_FRAMEWORK_PATH) plus a fixture Claude home
 * (GLASS_CLAUDE_HOME / GLASS_CLAUDE_JSON), so the account/skills/plugin/MCP
 * checks read fixture state, not this machine's. Exec-backed checks (git,
 * node, claude, gh, spawn) run for real — assertions on those stay
 * machine-independent (shape + enum only).
 */
import { test, before } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as aios from '../main/aios';

let root = '';
let claudeHome = '';
let claudeJson = '';

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-doctor-fw-'));
  claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-doctor-home-'));
  claudeJson = path.join(claudeHome, 'claude.json'); // stands in for ~/.claude.json
  process.env.GLASS_FRAMEWORK_PATH = root;
  process.env.GLASS_CLAUDE_HOME = claudeHome;
  process.env.GLASS_CLAUDE_JSON = claudeJson;
  const w = (rel: string, content: string, mode?: number) => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, mode !== undefined ? { mode } : {});
  };
  w('CLAUDE.md', '# Test framework\n');
  /* Long enough to clear isWritten()'s floor and free of `{{placeholders}}` — the two things
     that separate a written vault from the shipped template. Kept deliberately plain: the point
     is that a real person wrote something, not that they wrote a lot. */
  w('vault/00 - notes/context/declared/about_me.md',
    'My name is Tester. I build small tools and care about the ones that stay simple.\n\n'
    + 'I work in short focused blocks, prefer reading code to reading about code, and would\n'
    + 'rather ship something honest than something impressive.\n');
  // and USER.md names a primary session, so the app knows who to greet
  w('USER.md', '# USER\n\n## Identity\n\n| Name | Style |\n| --- | --- |\n| tester | plain |\n');
  // the skills repair target: an idempotent installer that registers ONE skill
  // into the (fixture) Claude home — exactly what the real setup.sh does.
  w('skills/setup.sh', '#!/bin/sh\nmkdir -p "$GLASS_CLAUDE_HOME/skills"\ntouch "$GLASS_CLAUDE_HOME/skills/test-skill"\n', 0o755);
  // a Claude home that EXISTS but has no signed-in account — the old check's
  // false-positive shape (dir present ≠ signed in).
  fs.writeFileSync(claudeJson, JSON.stringify({}));
});

test('every check reports the CheckResult shape with a valid status', async () => {
  const checks = await aios.setupChecks();
  assert.ok(checks.length >= 11, `expected the full battery, got ${checks.length}`);
  for (const c of checks) {
    assert.ok(c.id && c.label, `check has id+label: ${JSON.stringify(c)}`);
    assert.ok(['pass', 'warn', 'fail'].includes(c.status), `${c.id} status valid`);
    assert.equal(typeof c.message, 'string');
    assert.equal(typeof c.canRepair, 'boolean');
  }
  const ids = checks.map((c) => c.id);
  for (const want of ['git', 'node', 'claude', 'framework', 'vault', 'account', 'skills', 'plugin', 'spawn', 'mcpObsidian', 'personalized', 'gh']) {
    assert.ok(ids.includes(want), `check ${want} present`);
  }
});

test('account: an existing ~/.claude is NOT signed-in — only oauthAccount is (the false-positive fix)', async () => {
  // fixture: claude home dir exists, claude.json exists, but NO oauthAccount
  let checks = await aios.setupChecks();
  let account = checks.find((c) => c.id === 'account');
  assert.ok(account, 'account check present');
  assert.equal(account!.status, 'fail', 'dir-exists must no longer read as signed-in');
  /* A FIRST RUN gets plain `claude`, not `claude /login`. The slash command on a machine that has
     never been set up asks for the login twice: it runs the browser round trip, then Claude's own
     first-run sequence begins with its login screen again. The operator authorises, immediately
     sees the same question, and reasonably doubts it worked — reported from a real run. `/login`
     is right only where onboarding is done and they are genuinely switching accounts. */
  assert.ok(account!.repairCmd, 'offers a fix');
  assert.doesNotMatch(account!.repairCmd!, /\/login/, 'a first run must not use the slash command');
  /* An account on file is NOT a finished first run. Claude Code records those separately, and an
     operator who authorises in the browser then closes the terminal leaves onboarding incomplete —
     so the NEXT session opens on the onboarding screen again. Observed exactly that: login,
     GitHub, then the setup session asking to log in a second time, which reads as the app
     forgetting what it just did. Signed-in-but-unfinished must therefore still hold the step. */
  fs.writeFileSync(claudeJson, JSON.stringify({ oauthAccount: { emailAddress: 'op@example.com' } }));
  checks = await aios.setupChecks();
  account = checks.find((c) => c.id === 'account');
  assert.equal(account!.status, 'fail', 'signed in, but the first run is unfinished');
  assert.match(account!.message, /op@example\.com/, 'and it says who is signed in, so the state is legible');

  /* Onboarded but signed OUT is the account-switch case, and THERE /login is correct. */
  fs.writeFileSync(claudeJson, JSON.stringify({ hasCompletedOnboarding: true }));
  checks = await aios.setupChecks();
  account = checks.find((c) => c.id === 'account');
  assert.equal(account!.status, 'fail');
  assert.match(account!.repairCmd!, /\/login/, 'switching accounts DOES use /login');

  // first run genuinely complete → passes
  fs.writeFileSync(claudeJson, JSON.stringify({ oauthAccount: { emailAddress: 'op@example.com' }, hasCompletedOnboarding: true }));
  checks = await aios.setupChecks();
  account = checks.find((c) => c.id === 'account');
  assert.equal(account!.status, 'pass');
  assert.equal(account!.message, 'op@example.com');
});

test('skills: the repair loop — warn → run fix → the SAME check re-runs and proves it', async () => {
  const beforeFix = (await aios.setupChecks()).find((c) => c.id === 'skills');
  assert.ok(beforeFix, 'skills check present');
  assert.equal(beforeFix!.status, 'warn', 'no skills registered yet');
  assert.equal(beforeFix!.canRepair, true, 'setup.sh exists → doctor can repair headless');
  const proved = await aios.repairCheck('skills');
  assert.ok(proved, 'repair returns the re-checked result');
  assert.equal(proved!.status, 'pass', 'the re-run proves the fix');
  assert.match(proved!.message, /1/, 'counts the registered skill');
});

test('mcpObsidian: reads Claude Code\'s own registry (global + per-project)', async () => {
  let mcp = (await aios.setupChecks()).find((c) => c.id === 'mcpObsidian');
  assert.equal(mcp!.status, 'warn', 'not registered yet');
  fs.writeFileSync(claudeJson, JSON.stringify({
    oauthAccount: { emailAddress: 'op@example.com' },
    mcpServers: { obsidian: { command: 'node' } },
  }));
  mcp = (await aios.setupChecks()).find((c) => c.id === 'mcpObsidian');
  assert.equal(mcp!.status, 'pass');
});

test('framework, vault, personalization pass on a complete fixture', async () => {
  const checks = await aios.setupChecks();
  const by = (id: string) => checks.find((c) => c.id === id)!;
  assert.equal(by('framework').status, 'pass');
  assert.equal(by('vault').status, 'pass');
  /* The fixture has to be a WRITTEN about_me, not merely a present one: a file full of
     `{{placeholders}}` is the template, and treating it as identity is exactly the bug this
     check replaced. */
  assert.equal(by('personalized').status, 'pass');
});

test('computeHealth: the six Health rows, in display order', async () => {
  const rows = await aios.computeHealth();
  assert.deepEqual(rows.map((r) => r.id), ['framework', 'vault', 'account', 'skills', 'claude', 'gh']);
  for (const r of rows) assert.ok(['pass', 'warn', 'fail'].includes(r.status));
});

test('repairCheck: unknown id → null; un-repairable id → honest re-run, no crash', async () => {
  assert.equal(await aios.repairCheck('nope'), null);
  const rerun = await aios.repairCheck('personalized'); // no headless repair — just re-runs
  assert.ok(rerun);
  assert.equal(rerun!.id, 'personalized');
});

test('the phase 1 script is handed out as a REAL path, never one inside app.asar', () => {
  /* app.asar is an archive. Node's fs is shimmed to read inside it, so statSync happily
     confirmed the script existed and the path looked fine — but handed to a real `bash` the OS
     answered "Not a directory" and the one button a newcomer must be able to press did nothing.
     Reading from asar works; executing does not. So it is materialised to disk first. */
  const src = fs.readFileSync('src/main/aios.ts', 'utf8');
  assert.match(src, /app\.asar\.unpacked/, 'prefer a genuinely unpacked copy when present');
  assert.match(src, /fs\.readFileSync\(packaged, 'utf8'\)/, 'otherwise read it out of the archive');
  assert.match(src, /mode: 0o700/);
  assert.match(src, /!p\.includes\('app\.asar' \+ path\.sep\)/, 'never return an in-archive path');
  // and the returned path, in dev, must be executable by bash right now
  const p = aios.phase1Script();
  assert.ok(p && !p.includes('app.asar' + require('path').sep), `unusable script path: ${p}`);
  assert.ok(fs.statSync(p).isFile());
});

test('every path in a command is shell-quoted', () => {
  /* Found by auditing for siblings of the app.asar bug — same family: a string that reads as
     correct until a real shell touches it. `bash ${script}` works on every path on the machine
     that wrote it and breaks the moment a framework lives at "/Users/Jane Doe/aios" or under a
     Drive mount, which is precisely the newcomer this product exists for. Demonstrated: unquoted
     dies with "…/My: No such file or directory"; quoted runs.
     Single quotes, not JSON.stringify — double quotes still expand `$`, so a path containing one
     would be rewritten by the shell rather than read. */
  const raw = fs.readFileSync('src/main/aios.ts', 'utf8');
  /* Strip comments before looking for the bug pattern. The first version of this assertion
     matched the doc comment that DESCRIBES the bug and failed on a correct file — a check that
     cannot tell code from prose about code reports noise, and noise is how a suite loses its
     authority. */
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.match(src, /function shq\(p: string\): string/);
  assert.doesNotMatch(src, /`bash \$\{script\}`/, 'a bare interpolated path is the bug');
  assert.doesNotMatch(src, /JSON\.stringify\(v\)/, 'double quotes still expand $');
  assert.equal((src.match(/bash \$\{shq\(script\)\}/g) || []).length, 2);
  // the helper itself must survive a quote in the path
  const shq = (p: string): string => `'${String(p).replace(/'/g, `'\\''`)}'`;
  assert.equal(shq("/tmp/it's here/x.sh"), `'/tmp/it'\\''s here/x.sh'`);
});
