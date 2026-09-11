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
  /* And its Windows sibling. The doctor refuses to run a `.sh` through bash on win32 — that
     fails in a way that reads like the repair ran — so it offers a repair there ONLY when the
     framework ships a `.ps1` next to the `.sh`. A fixture with just the `.sh` would therefore
     be testing the degraded path on Windows and the real one everywhere else; shipping both
     keeps ONE set of assertions exercising the same behaviour on every platform. */
  w('skills/setup.ps1',
    '$d = Join-Path $env:GLASS_CLAUDE_HOME "skills"\n'
    + 'New-Item -ItemType Directory -Path $d -Force | Out-Null\n'
    + 'New-Item -ItemType File -Path (Join-Path $d "test-skill") -Force | Out-Null\n');
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
  /* ASKS THE CHECK, NOT THE BATTERY. These assertions are about the account check's own verdict —
     whether a bare directory reads as signed-in, and which login command it chooses. The battery
     layers policy on top that reads OTHER checks (it withholds a remedy naming a missing tool,
     and downgrades a pass it cannot vouch for), so going through setupChecks() made every one of
     these depend on whether Claude happens to be installed on the machine running the test. It
     does not exist on the CI runners, which is why this passed on macOS and failed on Linux and
     Windows. The battery's own behaviour is asserted separately, below. */
  const account = async () => (await aios.rawCheck('account'))!;

  // fixture: claude home dir exists, claude.json exists, but NO oauthAccount
  let a = await account();
  assert.ok(a, 'account check present');
  assert.equal(a.status, 'fail', 'dir-exists must no longer read as signed-in');
  /* A FIRST RUN gets plain `claude`, not `claude /login`. The slash command on a machine that has
     never been set up asks for the login twice: it runs the browser round trip, then Claude's own
     first-run sequence begins with its login screen again. The operator authorises, immediately
     sees the same question, and reasonably doubts it worked — reported from a real run. `/login`
     is right only where onboarding is done and they are genuinely switching accounts. */
  assert.ok(a.repairCmd, 'offers a fix');
  assert.doesNotMatch(a.repairCmd!, /\/login/, 'a first run must not use the slash command');

  /* An account on file is NOT a finished first run. Claude Code records those separately, and an
     operator who authorises in the browser then closes the terminal leaves onboarding incomplete —
     so the NEXT session opens on the onboarding screen again. Observed exactly that: login,
     GitHub, then the setup session asking to log in a second time, which reads as the app
     forgetting what it just did. Signed-in-but-unfinished must therefore still hold the step. */
  fs.writeFileSync(claudeJson, JSON.stringify({ oauthAccount: { emailAddress: 'op@example.com' } }));
  a = await account();
  assert.equal(a.status, 'fail', 'signed in, but the first run is unfinished');
  assert.match(a.message, /op@example\.com/, 'and it says who is signed in, so the state is legible');

  /* Onboarded but signed OUT is the account-switch case, and THERE /login is correct. */
  fs.writeFileSync(claudeJson, JSON.stringify({ hasCompletedOnboarding: true }));
  a = await account();
  assert.equal(a.status, 'fail');
  assert.match(a.repairCmd!, /\/login/, 'switching accounts DOES use /login');

  // first run genuinely complete → the check itself passes
  fs.writeFileSync(claudeJson, JSON.stringify({ oauthAccount: { emailAddress: 'op@example.com' }, hasCompletedOnboarding: true }));
  a = await account();
  assert.equal(a.status, 'pass');
  assert.equal(a.message, 'op@example.com');
});

test('the BATTERY then applies what no single check can see', async () => {
  /* The other half of the split above. A complete credential file makes the account check pass,
     but the battery may still hold it back — because that check answers from the file alone and
     cannot vouch for a machine where Claude does not run. Whichever machine this runs on, one of
     the two states must hold, and a warn must name its reason. */
  fs.writeFileSync(claudeJson, JSON.stringify({ oauthAccount: { emailAddress: 'op@example.com' }, hasCompletedOnboarding: true }));
  const all = await aios.setupChecks();
  const acct = all.find((c) => c.id === 'account')!;
  const claude = all.find((c) => c.id === 'claude')!;
  assert.equal((await aios.rawCheck('account'))!.status, 'pass', 'the check itself is satisfied');
  if (claude.status === 'fail') {
    assert.equal(acct.status, 'warn', 'a pass the battery cannot vouch for must stop being a pass');
    assert.equal(acct.blockedBy, 'claude', 'and must name what is in the way');
    assert.equal(acct.repairCmd, undefined, 'its remedy would invoke the very tool that is missing');
  } else {
    assert.equal(acct.status, 'pass', 'with Claude working, nothing holds it back');
  }
});

test('skills: the repair loop — warn → run fix → the SAME check re-runs and proves it', async () => {
  const beforeFix = (await aios.setupChecks()).find((c) => c.id === 'skills');
  assert.ok(beforeFix, 'skills check present');
  assert.equal(beforeFix!.status, 'warn', 'no skills registered yet');
  assert.equal(beforeFix!.canRepair, true, 'the installer exists → doctor can repair headless');
  /* The hint names the launcher the repair will REALLY use — bash for a .sh, PowerShell for the
     .ps1 sibling on Windows. A tooltip that promises bash on a machine with no bash is the same
     class of lie as offering `brew install` on a Mac where brew cannot write. */
  assert.match(beforeFix!.repairHint!, process.platform === 'win32' ? /^powershell .*-File '.*setup\.ps1'$/ : /^bash '.*setup\.sh'$/);
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
  const handed = aios.phase1Script();
  /* Windows hands out a ready-to-run PowerShell INVOCATION rather than a bare path: there is no
     `bash` for the caller to prefix it with, and a bare .ps1 path is not universally runnable
     under the default execution policy. The invariant underneath is identical on both — whatever
     is handed out has to point at a REAL file on disk, never one inside the archive. */
  const p = process.platform === 'win32'
    ? (/-File '(.+)'$/.exec(handed)?.[1] ?? '')
    : handed;
  if (process.platform === 'win32') {
    assert.match(handed, /^powershell -NoProfile -ExecutionPolicy Bypass -File '.*phase1-prerequisites\.ps1'$/, `unusable invocation: ${handed}`);
  }
  assert.ok(p && !p.includes('app.asar' + require('path').sep), `unusable script path: ${p}`);
  assert.ok(fs.statSync(p).isFile());
});

test('win32 done.ps1 reads PowerShell\'s $? — "True" is the ONLY success', { skip: process.platform !== 'win32' }, () => {
  /* A CONTRACT ACROSS TWO OWNERS, which is exactly the kind that breaks silently. The renderer
     emits `<cmd> ; <banner invocation> $?` on win32, and PowerShell's `$?` is a BOOLEAN — the
     first positional argument arrives as 'True'/'False', never as an exit code. So '0' is not
     success here, and the failure that matters is the false green: a step that failed announcing
     that everything worked. Asserted by RUNNING the generated script, because the way this would
     actually regress is argument binding (someone reading $args, which a param block leaves
     empty) — which no amount of reading the source would reveal. */
  const invocation = aios.bannerScript('IT WORKED', 'ok sub', 'IT FAILED', 'fail sub');
  const script = /-File '(.+)'$/.exec(invocation)?.[1] ?? '';
  assert.ok(fs.statSync(script).isFile(), `banner script not written: ${invocation}`);
  const run = (arg: string): string => require('child_process')
    .execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, arg], { encoding: 'utf8', timeout: 20000 });

  assert.match(run('True'), /IT WORKED/, "PowerShell's $? spelling of success");
  assert.doesNotMatch(run('True'), /IT FAILED/);
  assert.match(run('False'), /IT FAILED/, 'and its spelling of failure');
  /* Everything that is not 'True' is a failure — including the POSIX spelling of success. A
     banner that reads '0' as a win, on a channel that never sends '0', would only ever fire on
     a malformed argument, and a false green is the one verdict worse than none. */
  assert.match(run('0'), /IT FAILED/, "'0' is the POSIX contract, not this one");
  assert.match(run(''), /IT FAILED/, 'a missing verdict fails safe');
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
  // two in the prereqs checks' hints, one in installToolCmd
  assert.equal((src.match(/bash \$\{shq\(script\)\}/g) || []).length, 3);
  /* The Windows launcher is the same audit in another dialect: `-File C:\Users\Jane Doe\aios\…`
     breaks exactly where `bash /Users/Jane Doe/aios/…` breaks, and a framework under a OneDrive
     or "My Documents" path is the common case there rather than the exotic one.
     It must quote with psq, NOT shq — reaching for the POSIX helper here produces a string that
     looks quoted and is not: PowerShell escapes with a backtick, so shq's `'\''` idiom emits a
     stray backslash and leaves the quote unbalanced (C:\Users\O'Brien\aios is enough to break
     it). PowerShell doubles the quote instead. */
  assert.match(src, /-File \$\{psq\(script\)\}/, 'the PowerShell launcher quotes its path too');
  assert.match(src, /function psq\(s: string\): string/);
  const psq = (s: string): string => `'${String(s).replace(/'/g, "''")}'`;
  assert.equal(psq("C:\\Users\\O'Brien\\aios\\x.ps1"), "'C:\\Users\\O''Brien\\aios\\x.ps1'");
  assert.doesNotMatch(src, /\$\{shq\((?:ok|okSub|fail|failSub|bar)\)\}/, 'PowerShell strings never use the POSIX quoter');
  // the helper itself must survive a quote in the path
  const shq = (p: string): string => `'${String(p).replace(/'/g, `'\\''`)}'`;
  assert.equal(shq("/tmp/it's here/x.sh"), `'/tmp/it'\\''s here/x.sh'`);
});

/* ── a missing tool: every way in, on every platform ───────────────────────── */

/* DERIVED, never restated. This was a hardcoded list, and when `claude` joined the ladder the
   list did not — so every test below silently stopped covering the one tool AIOS cannot run
   without, while still reporting green. The app's own `InstallableTool` is the single statement of
   what it can install, so reading it means a tool added there cannot skip these tests. */
const LADDER_TOOLS: string[] = (() => {
  const src = fs.readFileSync('src/main/aios.ts', 'utf8');
  const m = /export type InstallableTool =([^;]+);/.exec(src);
  assert.ok(m, 'InstallableTool must exist — this list is derived from it');
  const tools = [...m[1].matchAll(/'([a-z0-9-]+)'/g)].map((x) => x[1]);
  assert.ok(tools.length >= 6, `expected the full tool set, parsed ${tools.join(',')}`);
  return tools;
})();
// Rungs that need neither a package manager nor administrator rights. Every tool needs at least one
// on every platform, or some real machine ends at a dead end: the two reports behind this were a Mac
// with no Homebrew and a Windows PC where winget's install never reached the terminal.
const NO_ADMIN = ['release', 'official', 'uvpython', 'flatpak', 'anthropic'];

const shLadders = (): Record<string, string[]> => {
  const sh = fs.readFileSync('scripts/setup/install-tool.sh', 'utf8');
  const out: Record<string, string[]> = {};
  for (const m of sh.matchAll(/^\s+(darwin|linux):(\w+)\)\s+echo "([^"]*)" ;;/gm)) out[`${m[1]}:${m[2]}`] = m[3].split(/\s+/).filter(Boolean);
  return out;
};
const psLadders = (): Record<string, string[]> => {
  const ps = fs.readFileSync('scripts/setup/install-tool.ps1', 'utf8');
  const out: Record<string, string[]> = {};
  const start = ps.indexOf('$Ladders = @{');
  const block = ps.slice(start, ps.indexOf('\n}', start));
  for (const m of block.matchAll(/^\s+(\w+)\s+=\s+@\(([^)]*)\)/gm)) out[`win32:${m[1]}`] = [...m[2].matchAll(/'(\w+)'/g)].map((x) => x[1]);
  return out;
};

test('every tool has several ways in on every OS, and at least one needs no admin and no package manager', () => {
  const ladders = { ...shLadders(), ...psLadders() };
  for (const os of ['darwin', 'linux', 'win32']) {
    for (const tool of LADDER_TOOLS) {
      const rungs = ladders[`${os}:${tool}`];
      assert.ok(rungs, `${os}/${tool}: no ladder at all`);
      assert.ok(rungs.length >= 2, `${os}/${tool}: one way in is a dead end on the machines that lack it (${rungs.join(',')})`);
      /* git on macOS and Linux has no official user-level binary to download, so its floor is a
         system tool (the Command Line Tools / the distribution's package manager). Every other tool
         must have a way in that asks nobody for permission. */
      if (tool === 'git' && os !== 'win32') continue;
      assert.ok(rungs.some((r) => NO_ADMIN.includes(r)), `${os}/${tool}: every rung needs admin or a package manager (${rungs.join(',')})`);
    }
  }
});

test('every download is checksum-verified before it is used, on both installers', () => {
  /* A download rung trades a package manager's signature for our own check, so each fetch must be
     followed by a verify that FAILS the rung on a mismatch. Verified by hand on both scripts with a
     corrupted digest: the rung refused, the ladder ended at the download page, nothing was written. */
  const sh = fs.readFileSync('scripts/setup/install-tool.sh', 'utf8');
  const i = sh.indexOf('run_release() {');
  const rel = sh.slice(i, sh.indexOf('\n}\n', i));
  const shFetches = (rel.match(/fetch "\$url" "\$f"|fetch "https:\/\/nodejs\.org\/dist\/\$ver\/\$name" "\$f"/g) || []).length;
  assert.ok(shFetches >= 4, `expected the four download sites in run_release, found ${shFetches}`);
  assert.equal((rel.match(/&& verify "\$f" "\$sum" \|\| return 1/g) || []).length, shFetches, 'a download in install-tool.sh skips verify');
  assert.match(sh, /verify\(\) \{[\s\S]*?return 1; \}/, 'verify must be able to fail the rung');

  const ps = fs.readFileSync('scripts/setup/install-tool.ps1', 'utf8');
  const psRel = ps.slice(ps.indexOf('function Run-Release {'), ps.indexOf('# Ordered least invasive first'));
  const psFetches = (psRel.match(/Fetch (?:\$\S+|"[^"]+") \$f/g) || []).length;
  assert.ok(psFetches >= 4, `expected four download sites in Run-Release, found ${psFetches}`);
  assert.equal((psRel.match(/if \(-not \(Verify \$f \$\S+\)\) \{ return \$false \}/g) || []).length, psFetches, 'a download in install-tool.ps1 skips Verify');
});

test('the doctor offers the ladder for gh, git and node on every platform, never a single-method command', () => {
  const raw = fs.readFileSync('src/main/aios.ts', 'utf8');
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  // gh, both lanes: the installer runs the login itself, where PATH already includes the new gh
  const posixGh = code.slice(code.indexOf("id: 'gh', severity"), code.indexOf("id: 'personalized'"));
  assert.match(posixGh, /installToolCmd\('gh', loginCmd\)/);
  const winGh = code.slice(code.indexOf('async function ghCheckWin'), code.indexOf('function doctorChecks'));
  assert.match(winGh, /installToolCmd\('gh', loginCmd\)/);
  // the one-method commands behind the two reports are gone from the gh lanes
  assert.doesNotMatch(winGh, /winget install --id GitHub\.cli/, 'winget-then-login in one pane is the Windows report');
  assert.doesNotMatch(posixGh, /brew install gh/, 'brew-or-nothing is the Mac report');
  assert.doesNotMatch(code, /setupCheck\.ghNoBrew/);
  // git and node try the ladder before their old single commands
  for (const [fn, tool] of [['installGitCmd', 'git'], ['installNodeCmd', 'node']]) {
    const j = code.indexOf(`function ${fn}(`);
    const body = code.slice(j, code.indexOf('\n}', j));
    const iLadder = body.indexOf(`installToolCmd('${tool}')`);
    assert.ok(iLadder > 0 && iLadder < body.indexOf('darwin'), `${fn}: the ladder must come first`);
  }
  // and the follow-up command travels INTO the installer, quoted for the shell that receives it
  assert.match(code, /` -Then \$\{psq\(then\)\}`/);
  assert.match(code, /` --then \$\{shq\(then\)\}`/);
});

test('installToolCmd hands out a runnable invocation of a real script on this machine', () => {
  const cmd = aios.installToolCmd('gh', 'gh auth login --web --git-protocol https');
  assert.ok(cmd, 'the dev tree carries the installer, so there must be a command');
  if (process.platform === 'win32') {
    assert.match(cmd!, /^powershell -NoProfile -ExecutionPolicy Bypass -File '.*install-tool\.ps1' -Tool gh -Then 'gh auth login --web --git-protocol https'$/);
  } else {
    assert.match(cmd!, /^bash '.*install-tool\.sh' gh --then 'gh auth login --web --git-protocol https'$/);
  }
});

test('both provisioners fall back to the ladder instead of stopping', () => {
  const sh = fs.readFileSync('scripts/setup/phase1-prerequisites.sh', 'utf8');
  assert.doesNotMatch(sh, /die "Homebrew install failed/, 'no Homebrew must not end Phase 1: accounts without admin have other ways in');
  assert.match(sh, /else install_any "\$pkg"/, 'a tool brew could not install goes to install-tool.sh');
  assert.match(sh, /install_any obsidian/);
  assert.match(sh, /bash "\$HERE\/install-tool\.sh" "\$1"/);
  const ps = fs.readFileSync('scripts/setup/phase1-prerequisites.ps1', 'utf8');
  assert.doesNotMatch(ps, /missing - needs winget"; return/, 'no winget must not end the tool: it has other ways in');
  assert.match(ps, /Install-Any \$Label/);
  assert.match(ps, /Install-Any 'obsidian'/);
  assert.match(ps, /Join-Path \$PSScriptRoot 'install-tool\.ps1'/);
});

test('the provisioners can find the installer beside them even when copied out of app.asar', () => {
  const raw = fs.readFileSync('src/main/aios.ts', 'utf8');
  const fn = raw.slice(raw.indexOf('function setupScriptPath('), raw.indexOf('export function phase1Script('));
  assert.match(fn, /fs\.readdirSync\(path\.dirname\(packaged\)\)/, 'siblings must be materialised with the script');
});

test('install-tool.sh parses and plans every tool', { skip: process.platform === 'win32' }, () => {
  const cp = require('child_process');
  cp.execFileSync('bash', ['-n', 'scripts/setup/install-tool.sh']);
  for (const tool of LADDER_TOOLS) {
    const out: string = cp.execFileSync('bash', ['scripts/setup/install-tool.sh', tool, '--plan'], { encoding: 'utf8', timeout: 20000 });
    assert.match(out, /^\s+1\. \w+ — /m, `${tool}: no rungs listed`);
    assert.match(out, /^\s+page: https:\/\//m, `${tool}: no download page to end on`);
  }
});

test('install-tool.ps1 parses and plans every tool', { skip: process.platform !== 'win32' }, () => {
  const cp = require('child_process');
  const parse: string = cp.execFileSync('powershell.exe', ['-NoProfile', '-Command',
    "$e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('scripts/setup/install-tool.ps1',[ref]$null,[ref]$e); if($e){'ERR'}else{'OK'}"], { encoding: 'utf8' });
  assert.match(parse, /OK/);
  for (const tool of LADDER_TOOLS) {
    const out: string = cp.execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'scripts/setup/install-tool.ps1', '-Tool', tool, '-Plan'], { encoding: 'utf8', timeout: 60000 });
    assert.match(out, /^\s+1\. \w+ - /m, `${tool}: no rungs listed`);
    assert.match(out, /^\s+page: https:\/\//m, `${tool}: no download page to end on`);
  }
});


test('Connect GitHub never runs `gh auth login` when the check found gh absent with no command', () => {
  /* The fallback `repairCmd || 'gh auth login …'` exists for a gh that is installed but signed
     out. When the check returned NO repairCmd because gh is absent and nothing here can install
     it, the fallback ran anyway — straight into "command not found: gh". It must open the URL
     the check handed out instead. */
  const app = fs.readFileSync('renderer/app.js', 'utf8');
  const i = app.indexOf("case 'github': {");
  const block = app.slice(i, app.indexOf("case 'firstrun': {", i));
  assert.ok(block.includes("const ghUrl = gh && gh.status !== 'pass' && !gh.repairCmd"), 'the URL lane must key off a missing repairCmd');
  assert.ok(block.includes('if (ghUrl) { void window.glassShell.openExternal(ghUrl); return; }'), 'and open the URL instead of running login');
});

test('the gh messages exist in every locale and name no tool the operator never types', () => {
  for (const l of ['en', 'es', 'pt-br']) {
    const d = JSON.parse(fs.readFileSync(`src/i18n/locales/${l}.json`, 'utf8'));
    for (const k of ['setupCheck.ghNeedsSetup', 'setupCheck.ghMissing']) {
      assert.ok(d[k] && String(d[k]).trim(), `${l}: ${k} missing`);
      assert.ok(!String(d[k]).includes('Homebrew'), `${l}: ${k} names Homebrew`);
    }
  }
});
