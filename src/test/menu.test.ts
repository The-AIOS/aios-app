/**
 * The native menu — the app's front face, and for a non-technical operator the only
 * complete map of what it can do.
 *
 * The failure this file exists to prevent is an item that LOOKS available and does
 * nothing. Browse Context was exactly that, from every surface, because a payload field
 * named `kind` overwrote the envelope's routing key.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { MAX_CANON, SAFE_LINE, needsSpill } from '../core/ptyLine';

const menu = fs.readFileSync('src/main/menu.ts', 'utf8');
const app = fs.readFileSync('renderer/app.js', 'utf8');
const panel = fs.readFileSync('src/main/panelHost.ts', 'utf8');

/** Every intent the menu can emit. */
const emitted = [...new Set([...menu.matchAll(/intent\('([a-zA-Z]+)'/g)].map((m) => m[1]))];
/** Every intent the renderer routes. */
const routed = new Set([...app.matchAll(/case '([a-zA-Z]+)':/g)].map((m) => m[1]));

test('every menu item routes to something that exists', () => {
  const dead = emitted.filter((i) => !routed.has(i));
  assert.deepEqual(dead, [], `menu offers intents the renderer does not handle: ${dead.join(', ')}`);
  assert.ok(emitted.length >= 20, `expected a full menu, found ${emitted.length} intents`);
});

test('the routing key can never be shadowed by a payload field', () => {
  // `{ kind, ...payload }` let a payload's own `kind` overwrite the envelope: the router
  // matched no case and the item silently did nothing. Spread FIRST, key LAST.
  for (const src of [menu, panel]) {
    assert.match(src, /send\('shell:intent', \{ \.\.\.payload, kind \}\)/);
    assert.doesNotMatch(src, /send\('shell:intent', \{ kind, \.\.\.payload \}\)/);
  }
  // and no sender may use the reserved key at all
  assert.doesNotMatch(menu, /intent\('[a-zA-Z]+', \{ kind:/, 'payloads must not use `kind`');
  assert.doesNotMatch(panel, /intent\('[a-zA-Z]+', \{ kind:/);
  assert.match(menu, /intent\('pickContext', \{ ctxKind: '' \}\)/);
  assert.match(app, /case 'pickContext': void pickContext\(m\.ctxKind\)/);
});

test('no two items claim the same accelerator', () => {
  // `role: 'reload'` carries a DEFAULT ⌘R, which collided with Resume a Session — and a
  // stray reload discards every open pane, so losing that race is expensive.
  const accels = [...menu.matchAll(/accelerator: '([^']+)'/g)].map((m) => m[1]);
  const dupes = [...new Set(accels.filter((a, i) => accels.indexOf(a) !== i))];
  assert.deepEqual(dupes, [], `duplicate accelerators: ${dupes.join(', ')}`);
  assert.match(menu, /\{ role: 'reload', accelerator: 'CmdOrCtrl\+Alt\+R' \}/, 'reload must not keep ⌘R');
  /* ⌘R must be the operator's RESUME action and never `role: 'reload'` — that is the invariant,
     and losing that race discards every open pane. The old form pinned the implementation
     (`term('resume', …)`), which blocked resume being reimplemented at all: it now opens a native
     selector instead of spawning Claude's picker TUI. Assert the PROPERTY — ⌘R resumes — and let
     the mechanism change. */
  const rLine = menu.split('\n').find((l) => l.includes("accelerator: 'CmdOrCtrl+R'")) || '';
  assert.ok(rLine, '⌘R must be bound');
  assert.match(rLine, /term\('resume'|intent\('batchResume'\)/, '⌘R must resume, by either mechanism');
  assert.doesNotMatch(rLine, /reload/, '⌘R must never be reload — it would discard every open pane');
});

test('the accelerator convention holds: ⌘ opens a surface, ⌘⇧ opens a picker', () => {
  const pickers = ['pickFrequent', 'pickAgent', 'pickSkill', 'pickCommand', 'pickSuggestion', 'pickProject', 'pickRunning', 'pickContext'];
  for (const p of pickers) {
    const line = menu.split('\n').find((l) => l.includes(`intent('${p}'`)) || '';
    if (!line.includes('accelerator')) continue;   // not every picker needs a key
    assert.match(line, /CmdOrCtrl\+Shift\+/, `${p} is a picker, so its key must be ⌘⇧`);
  }
  // layouts own ⌘1–4, the terminal dock owns ⌘0
  for (const [n, preset] of [['1', 'Stacked'], ['2', 'Facing'], ['3', 'IDE'], ['4', 'Zen']]) {
    assert.match(menu, new RegExp(`accelerator: 'CmdOrCtrl\\+${n}', click: \\(\\) => intent\\('layout', \\{ preset: '${preset}' \\}\\)`));
  }
  assert.match(menu, /accelerator: 'CmdOrCtrl\+0', click: \(\) => intent\('layout', \{ toggleSplit: true \}\)/);
});

test('menus are grouped by intent, and each label names an outcome', () => {
  for (const key of ['menu.rituals', 'menu.agents', 'menu.go', 'menu.file', 'menu.view', 'menu.help', 'menu.layout', 'menu.developer']) {
    assert.ok(menu.includes(`t('${key}')`), `${key} must be a menu or submenu`);
  }
  // developer tools are fenced behind a label rather than sitting beside Full Screen.
  // Sliced structurally, not by distance — a comment between the two would break a
  // character-window regex without anything actually being wrong.
  const devStart = menu.indexOf("t('menu.developer')");
  const devBlock = menu.slice(devStart, menu.indexOf("windowMenu", devStart));
  assert.ok(devStart > 0, 'a Developer submenu must exist');
  for (const role of ['reload', 'forceReload', 'toggleDevTools']) {
    assert.ok(devBlock.includes(role), `${role} belongs inside Developer`);
  }
  // …and NOT loose in View beside Full Screen
  const viewBlock = menu.slice(menu.indexOf("t('menu.view')"), devStart);
  assert.ok(!viewBlock.includes('toggleDevTools'), 'dev tools must not sit in View directly');
  // the onboarding agent finally has a home, and it is FIRST in Help
  const help = menu.slice(menu.indexOf("role: 'help'"));
  const iGuide = help.indexOf("t('menu.guide')");
  const iShortcuts = help.indexOf("t('menu.shortcuts')");
  assert.ok(iGuide > 0 && iGuide < iShortcuts, 'the walkthrough belongs at the top of Help');
  // it SPAWNS a session named onboarding-aios rather than running a slash command in the
  // primary one: the name is the identity, so the session becomes that agent
  assert.match(menu, /intent\('spawnNamed', \{ name: 'onboarding-aios' \}\)/);
});

test('labels avoid jargon, in every locale', () => {
  for (const loc of ['en', 'es', 'pt-br']) {
    const j = JSON.parse(fs.readFileSync(`src/i18n/locales/${loc}.json`, 'utf8')) as Record<string, string>;
    for (const key of [...new Set([...menu.matchAll(/t\('(menu\.[a-zA-Z]+|layout\.[a-z]+)'\)/g)].map((m) => m[1]))]) {
      assert.ok(j[key], `${loc} is missing ${key}`);
    }
    // "Ingest knowledge" is deliberate — it is the framework's own term, and the operator
    // chose it over "Import a document". Vocabulary the product teaches beats a generic verb.
    assert.match(j['menu.ingest'], /ingest|inger/i, `${loc}: keep the AIOS term`);
    assert.ok(j['menu.guide'] && !/onboarding-aios/.test(j['menu.guide']), `${loc}: the guide must not be named after its agent`);
  }
});

test('first run opens Setup by itself, and only when the app cannot work', () => {
  // Measured with an empty HOME: the app launched fine (pty, workbench, panel, theme all
  // OK) and showed an empty workspace plus "Good afternoon" — with no route to Setup that a
  // newcomer has any reason to click. Every existing route was a control they do not know.
  assert.match(app, /if \(!roots\.framework \|\| !roots\.vault\) openSetupTab\(\);/);
  // it must NOT fire for an operator who already has a framework — verified live: an
  // existing HOME opens no Setup tab
  assert.doesNotMatch(app, /openSetupTab\(\);\s*\n\s*\}\s*catch[\s\S]{0,40}\n\}\);\s*$/, 'must stay conditional');
  assert.match(app, /Deliberately not a once-only flag/, 'and it should say why it repeats');
});

test('a named spawn IS the identity — the session becomes the agent', () => {
  // CLAUDE.md's spawned-worker path globs agents/<bundle>/{name}.md, so --name is what makes
  // a session adopt a bundled agent on turn one. Running a slash command in the primary
  // session tells it ABOUT the agent instead, and cannot be closed independently.
  assert.match(app, /function spawnNamed\(name, task\)/);
  assert.match(app, /CLAUDE \+ ' --name ' \+ handle/);
  assert.match(app, /const hit = byName\(handle\);/, 'reveal an open one rather than duplicating');
  assert.match(app, /case 'spawnNamed':/);
  // the title-bar compass uses the same path as the menu
  assert.match(app, /dragGuide\.addEventListener\('click', \(\) => void spawnNamed\('onboarding-aios'\)\)/);
});

test('frequent tasks can be created and deleted, sharing Glass\'s store', () => {
  const aios = fs.readFileSync('src/main/aios.ts', 'utf8');
  // the SAME two keys the extension uses, so one list serves both surfaces
  assert.match(aios, /setGlassState\('aios\.frequentTasks\.v1', list\)/);
  assert.match(aios, /export function removeFrequentTask/);
  // deleting a DEFAULT must be recorded, or the read-time merge puts it back and the
  // delete looks broken
  assert.match(aios, /setGlassState\('aios\.frequentTasks\.removed\.v1', \[\.\.\.removed, id\]\)/);
  // Glass's id shape, so entries written here are indistinguishable from its own
  assert.match(aios, /`u-\$\{slug\}-\$\{list\.length\}`/);
  // and the picker exposes both, where you actually notice a task is missing or stale
  assert.match(app, /async function addFrequentFlow\(\)/);
  // deletion is a TRASH BUTTON on the row, not a second list that asks which one — the task
  // you want gone is already under the pointer
  assert.doesNotMatch(app, /removeFrequentFlow/, 'the two-step remove flow is retired');
  assert.match(app, /action: \{\n\s*icon: 'trash'/);
  assert.match(app, /window\.glassShell\.addFrequent\(/);
  assert.match(app, /window\.glassShell\.removeFrequent\(item\.value\.id\)/);
});

test('the shipped defaults are generic — no operator\'s personal tasks', () => {
  const aios = fs.readFileSync('src/main/aios.ts', 'utf8');
  const specs = aios.slice(aios.indexOf('DEFAULT_TASK_SPECS'), aios.indexOf('function defaultTasks'));
  // verified live against an empty HOME: a newcomer sees exactly these 8
  const DEFAULT_TASK_TARGETS = ['email-drafter', 'content-writer', 'deck-builder', 'market-researcher',
    'meeting-prepper', 'decision-journaler', 'ingest', 'infographic-builder'];
  for (const target of DEFAULT_TASK_TARGETS) {
    assert.ok(specs.includes(target), `default task ${target} must ship`);
  }
  /* A personal target would leak one operator's setup into everyone's first run. Asserted as a
     WHITELIST rather than a denylist of names: the old version listed real people in order to
     exclude them, which put those names in a repo that is going public — and a denylist only ever
     catches the examples someone happened to think of. Every default must be one of the shipped
     generic tasks, so anything personal fails by construction. */
  const allowed = new Set(DEFAULT_TASK_TARGETS);
  for (const m of specs.matchAll(/target:\s*'([^']+)'/g)) {
    assert.ok(allowed.has(m[1]), `default task "${m[1]}" is not one of the generic shipped tasks`);
  }
});

test('a destructive row action asks first, and the safe choice holds focus', () => {
  // Verified live: clicking trash deletes NOTHING until confirmed; cancel leaves the count
  // unchanged; confirm removes exactly one and the picker stays open with the row gone.
  assert.match(app, /function confirmModal\(title, message, confirmLabel\)/);
  assert.match(app, /cancel\.focus\(\);/, 'an accidental Return must not delete');
  assert.match(app, /if \(e\.key === 'Escape'\)[\s\S]{0,80}done\(false\)/);
  assert.match(app, /const yes = await confirmModal\(/);
  assert.match(app, /if \(!yes\) return false;/, 'a cancelled action must not touch the list');
});

test('a row action does not also trigger the row', () => {
  // without stopPropagation the trash click would delete AND run the task
  const block = app.slice(app.indexOf("b.addEventListener('click', async (ev)"), app.indexOf("r.addEventListener('click', () => done(it.value))"));
  assert.match(block, /ev\.stopPropagation\(\)/);
  // and the picker updates in place instead of reopening
  assert.match(app, /items = items\.filter\(\(x\) => x !== it\);/);
});

test('an action that needs setup routes to Setup instead of failing in a terminal', () => {
  // Observed on the newcomer machine: "Launch AIOS" spawned `claude …` where Claude was not
  // installed, and the operator got `command not found` in a terminal. Any runnable action
  // whose prerequisite is missing must take you somewhere that can fix it.
  assert.match(app, /async function ensureRunnable\(cmd\)/);
  assert.match(app, /if \(!bypassReady && !\(await ensureRunnable\(cmd\)\)\) return null;/);
  // gated at the ONE chokepoint every claude command passes through, so menu, panel,
  // palette, home cards, frequent tasks and the bus are all covered by one check
  const creates = (app.match(/async function createPane\(/g) || []).length;
  assert.equal(creates, 1, 'createPane must remain the single chokepoint');
  // the remedies are exempt, or the operator could never climb out
  // the remedies stay exempt — and there are three of them now, so assert the set, not one line
  assert.match(app, /login\|logout/, '/login and /logout fix the account');
  assert.match(app, /--name\\s\+aios-setup/, 'the setup session IS the remedy');
  assert.match(app, /cold-start-interview/, 'the interview writes the context the gate wants');
  /* Assert the INTENT, not the argument list. The literal-source version of this broke on
     every refactor of the same working behaviour (three times in one session), which trains
     whoever hits it to edit the assertion rather than think — and a suite that gets edited to
     agree with the code cannot contradict it. What must hold: a fix pane is named for the
     check it repairs, is exempt from the readiness gate (it IS the remedy), and its command
     is wrapped so the terminal ends with a verdict the operator can read. */
  const fixPaneSrc = /const fixPane = async \(name, cmd\) => \{[\s\S]{0,500}?\n    \};/.exec(app)?.[0] ?? '';
  assert.ok(fixPaneSrc, 'fixPane must exist');
  assert.match(fixPaneSrc, /name: PANE_NAME\[name\] \|\| name/, 'named for the operator, not the check id');
  assert.match(fixPaneSrc, /bypassReady: true/, 'a remedy cannot be gated on being ready');
  assert.match(fixPaneSrc, /await withDoneBanner\(cmd\)/, 'the run must end with a readable verdict');
  // a plain shell terminal is not gated at all
  assert.match(app, /const needsSetup = \(cmd\) => \{/);
  // it must name WHAT is missing, not just refuse
  for (const k of ['ready.claude', 'ready.framework', 'ready.vault', 'ready.signedIn', 'ready.blocked']) {
    assert.ok(app.includes(`t('${k}'`) || app.includes(`'${k}'`), `${k} must be surfaced`);
  }
});

test('readiness is cheap enough to call before every action', () => {
  const aios = fs.readFileSync('src/main/aios.ts', 'utf8');
  // the full doctor pass is far too heavy for a button click
  assert.match(aios, /export const readiness = ttlMemo\(readinessUncached, 4000\)/);
  /* Probe with the OPERATOR'S shell and a login flag — the same thing pty:spawn launches.
     Measured: a PATH line in ~/.zshrc or ~/.zprofile is INVISIBLE to `/bin/sh -lc` (a login
     sh reads ~/.profile) but visible to `zsh -lc`, and .zshrc is exactly where Claude's own
     installer and our PATH remedy write it. Probing with sh meant the doctor would keep
     reporting "not on PATH" after a fix that had genuinely worked. */
  /* The probe must resolve commands the way a REAL TERMINAL does. Measured: zsh reads ~/.zshrc
     only for INTERACTIVE shells, and .zshrc is exactly where Claude's installer and our own PATH
     remedy write — so a `-lc`-only probe could not see a fix that had genuinely worked. The
     remedy printed "Claude is ready", a new terminal ran claude fine, and Setup went on saying
     "not on PATH" with no way forward. Both forms are required, non-interactive first (faster,
     catches a system-PATH install), interactive second (what the pty actually is). */
  assert.match(aios, /function operatorShell\(\)/);
  /* THREE forms now. Reported twice as "the terminal found claude, Setup still says not on
     PATH" — the worst shape a check can take, since it contradicts what the operator can see and
     offers no way forward. Each form fails differently: -lc never reads ~/.zshrc; -lc with an
     explicit source reads it without needing a tty; -ilc is closest to a real terminal but an
     interactive shell with no tty can exit non-zero, and a throw reads as "not installed". */
  assert.match(aios, /\['-lc', `command -v \$\{cmd\}`\]/);
  assert.match(aios, /\. \$\{rc\} >\/dev\/null 2>&1; command -v \$\{cmd\}/, 'read the rc without needing a tty');
  assert.match(aios, /\['-ilc', `command -v \$\{cmd\}`\]/);
  /* And the fallback that cannot be defeated by a shell's environment: on disk, plus its
     directory named in a startup file, means a NEW TERMINAL WILL RUN IT — which is the only
     thing "on PATH" is meant to promise. */
  assert.match(aios, /for \(const f of \['\.zshrc', '\.zprofile', '\.bash_profile', '\.profile'\]\)/);
  assert.match(aios, /return \{ where: 'path', bin: p \};/);
  // an interactive rc can print banners, so the answer must be picked out, not assumed
  assert.match(aios, /filter\(\(l\) => l\.startsWith\('\/'\)\)\.pop\(\)/);
  assert.match(aios, /return sh && fs\.existsSync\(sh\) \? sh : '\/bin\/zsh';/);
  assert.doesNotMatch(aios, /execFileSync\('\/bin\/sh', \['-lc'/, 'sh cannot see a zsh profile');
  assert.match(aios, /export function claudeLocation\(\)/);
  // vaultRoot() falls back to the framework root, so identity is not enough to prove a vault
  assert.match(aios, /const vault = !!v && v !== r;/);
  /* Installed-but-off-PATH is its own state. The official installer succeeds, drops the
     binary at ~/.local/bin/claude, and asks the operator to add it to PATH themselves — so
     reporting that as "missing" sends someone who just installed Claude to install it again,
     and the only way forward was pasting a shell line. Observed on a real newcomer machine. */
  assert.match(aios, /where: 'path' \| 'disk' \| 'none'/);
  assert.match(aios, /\.local', 'bin', 'claude'/);
  assert.match(aios, /const claude = loc\.where === 'path';/, 'on disk but unreachable is NOT ready');
  assert.match(aios, /repairLabel: t\('setup\.addClaudeToPath'\)/, 'the button must name what it does');
  const app2 = fs.readFileSync('renderer/app.js', 'utf8');
  assert.match(app2, /claude\.repairLabel \|\| t\('setup\.installClaude'\)/);
  assert.match(app2, /r\.claudeWhere === 'disk' \? t\('ready\.claudeOffPath'\)/, 'the gate must say the real problem');
});

test('a terminal never spawns into a directory that does not exist', () => {
  const main = fs.readFileSync('src/main/main.ts', 'utf8');
  // THE newcomer blocker: the fallback cwd was ~/aios unconditionally. node-pty exits
  // immediately (code 1) when cwd is missing, so on any machine without the framework EVERY
  // terminal was born "[session ended]" — including the one that installs Claude.
  assert.match(main, /const usable = \(d: string \| undefined\): boolean =>/);
  assert.match(main, /return fs\.statSync\(d\)\.isDirectory\(\);/);
  assert.match(main, /\[requested, aios\.frameworkRoot\(\), os\.homedir\(\)\]\.find\(usable\)/,
    'first candidate that EXISTS wins, and $HOME always does');
  assert.doesNotMatch(main, /const fallback = path\.join\(os\.homedir\(\), 'aios'\)/, 'the unchecked fallback is gone');
  // the requested cwd is still confined to the allowed roots
  assert.match(main, /const requested = opts\.cwd && inAllowed\(opts\.cwd\) \? opts\.cwd : undefined;/);
});

test('setup is TWO phases, and the second only appears once Claude runs', () => {
  // Phase 1 is mechanical, so the app owns it — there is no Claude session yet to delegate
  // to. Phase 2 is a conversation (ask vs assume, what to defer, show diffs first), so
  // SETUP.md's Claude-facing sequence owns it. The handoff point is exactly "claude runs".
  /* Both actions live INSIDE the step whose checks they satisfy — neither floats above the
     list. The old shape put phase 1 in a box of its own at the top, which left an operator with
     two plausible buttons and no stated relationship between them: is the top one a step or
     not? Guessing is what this screen exists to remove. Phase 1 is now the prereqs box's
     primary action, and the handover is the last box's. */
  const prereqs = /case 'prereqs': \{[\s\S]*?\n        \}/.exec(app)?.[0] ?? '';
  assert.ok(prereqs, "the prereqs step must exist");
  assert.match(prereqs, /mkBtn\(acts, t\('setup\.phase1'\)/, 'phase 1 is the prereqs box primary');
  assert.match(prereqs, /bash \$\{xQuote\(script\)\}/);
  assert.doesNotMatch(app, /const twoPhase/, 'no floating phase box above the steps');
  assert.match(app, /t\('setup\.phase2'\)/);
  assert.match(app, /bypassReady: true/, 'the remedies cannot be gated on being ready');
  // the handoff spawns a NAMED session and tells it not to misroute an app user
  // the handover is now the LAST step rather than a button at the top, and it goes through one
  // launcher so the brief (including "the app is already my execution surface") cannot drift
  /* The handover trusts its directory BEFORE launching. A first-run screen — "Do you trust the
     files in this folder?" — swallows a positional prompt, leaving an idle-looking session with
     the operator's instruction gone. Removing the screen is deterministic; watching the terminal
     for a composer is a regex against another product's UI, and I tried that and threw it away. */
  assert.match(app, /const spawnSetupSession = async \(\) => \{/);
  assert.match(app, /await window\.glassShell\.trustDir\(roots\.framework\)/);
  assert.match(app, /return spawnNamed\('aios-setup',/);
  assert.match(app, /do not send me to install an IDE or the Glass extension/);
  /* And no step COUNT: it said "11-step", canonical grew to 13, and this line in a DIFFERENT repo
     kept claiming 11 until a setup session hit the mismatch and had to pick a side. A number
     repeated across repos drifts; the list counts itself. */
  assert.doesNotMatch(app, /\d+-step sequence/, 'never hardcode canonical\'s step count');
  assert.match(app, /follow the sequence in the "Reading this as Claude\?" block/);
  assert.match(app, /mkBtn\(acts, t\('setup\.phase2'\), \(\) => spawnSetupSession\(\)/);
  assert.match(app, /do not send me to install an IDE or the Glass extension/);
});

test('the Phase 1 script is idempotent, honest, and self-proving', () => {
  const sh = fs.readFileSync('scripts/setup/phase1-prerequisites.sh', 'utf8');
  // a fresh macOS account has NO ~/.zshrc or ~/.zprofile — an append would land nowhere
  assert.match(sh, /for f in "\$ZPROFILE" "\$ZSHRC"; do/);
  // Homebrew does not put itself on PATH; it only prints how
  assert.match(sh, /brew shellenv/);
  assert.match(sh, /if grep -qs 'brew shellenv' "\$ZPROFILE"/, 'and must not append it twice');
  /* Four states, cheapest first. npm is PREFERRED — its prefix is inside the Homebrew tree
     already on PATH, so claude works with no profile edit. The curl installer is the FALLBACK
     for when npm cannot write globally (another user's Homebrew on a shared Mac, or a
     system-managed node), and it is paired with the PATH fix because it installs into the
     operator's home and leaves PATH alone. Order matters, so it is asserted. */
  const iOnPath = sh.indexOf('if command -v claude');
  const iOnDisk = sh.indexOf('.local/bin/claude" ] || [ -x');
  const iNpm = sh.indexOf('npm install -g @anthropic-ai/claude-code');
  const iCurl = sh.indexOf('claude.ai/install.sh');
  assert.ok(iOnPath > 0 && iOnDisk > iOnPath && iNpm > iOnDisk && iCurl > iNpm,
    'order must be: on PATH → on disk → npm → curl fallback');
  // the on-disk state must NOT redownload — it only needs PATH
  assert.match(sh, /fixing that instead of reinstalling/);
  assert.match(sh, /claude_path_fix\(\) \{/);
  /* .zprofile FIRST, and both files. Appending only to .zshrc looks right and fails on a real
     machine: an accumulated .zshrc is often hundreds of lines and ONE bad line kills the rest —
     zsh treats an unmatched glob as fatal, so `.zshrc:485: no matches found: *buddy*` silently
     discarded the PATH export appended at the end of that same file. Observed on the test
     account. .zprofile is read by every login shell, is short, and is where Homebrew's own
     installer writes. Still idempotent, per file. */
  assert.match(sh, /for f in "\$ZPROFILE" "\$ZSHRC"; do/);
  /* IDEMPOTENT ON THE EXPORT, not on the substring. The old check greped for '.local/bin'
     anywhere in the file; on an operator with 485 lines of accumulated config that matched
     something unrelated, so the script announced "PATH line already present", wrote nothing, and
     left claude unreachable — a true sentence and a wrong conclusion. */
  assert.match(sh, /grep -qs 'export PATH=\.\*\\\.local\/bin' "\$f"/, 'match the export, not any mention');
  /* And the whole function is driven by whether a NEW TERMINAL can run claude, before and after —
     the only question that matters. Testing the current shell would always say yes, because the
     in-process export above fixes it regardless of what landed in any file. */
  assert.match(sh, /reachable\(\) \{ zsh -ilc 'command -v claude' >\/dev\/null 2>&1; \}/);
  assert.match(sh, /if reachable; then skip "already reachable from a new terminal"/);
  assert.match(sh, /if reachable; then ok "a new terminal can now run claude"/);
  assert.match(sh, /your shell startup reports/, 'a broken rc must be named, not left as "command not found"');
  // it proves the result with the operator's own login shell, the way the app checks
  assert.match(sh, /LOGIN_SHELL="\$\{SHELL:-\/bin\/zsh\}"/);
  assert.match(sh, /"\$LOGIN_SHELL" -lc "command -v \$tool"/);
  // and it says what is next rather than ending silently
  assert.match(sh, /Sign In to Claude/);
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8')) as { build: { appId: string; files: string[]; mac: { extendInfo: Record<string, string> } } };
  assert.ok(pkg.build.files.includes('scripts/setup/**/*'), 'the script must ship inside the bundle');
  /* Apple sees The-AIOS; a person sees AIOS — but NOT via CFBundleName, which is what this
     assertion originally demanded and thereby locked a fatal bug in place. Electron resolves
     "<CFBundleName> Helper.app" at startup, so naming it The-AIOS made every packaged build
     abort while every source-run test stayed green. The Apple-facing name lives in the bundle
     id (and the App Store Connect listing, which is typed at submission and is not in this
     repo at all). CFBundleDisplayName is what Finder shows, and is free to differ. */
  assert.equal(pkg.build.appId, 'com.the-aios.app', 'the Apple-facing name belongs here');
  assert.equal(pkg.build.mac.extendInfo.CFBundleDisplayName, 'AIOS');
  assert.ok(!('CFBundleName' in pkg.build.mac.extendInfo),
    'never override CFBundleName — see the dedicated test below');
});

test('CFBundleName must equal productName, or the packaged app cannot find its helpers', () => {
  /* This is the check that was missing when a packaged build shipped dead. Electron derives
     the helper-app path from CFBundleName, so overriding it to anything other than
     productName makes every packaged build abort with "Unable to find helper app" — while
     every source-run test stays green, because source runs use node_modules/electron's own
     bundle. An Apple-facing name belongs in the bundle id or the App Store listing.
     `scripts/verify-package.mjs` catches this on the real artifact; this catches it in
     `npm test`, before anyone spends four minutes on a build. */
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8')) as Record<string, never>;
  const info = ((pkg as never as { build: { mac: { extendInfo?: Record<string, string> } } })
    .build.mac.extendInfo) ?? {};
  if ('CFBundleName' in info) {
    assert.equal(info.CFBundleName, (pkg as never as { productName: string }).productName,
      'CFBundleName must equal productName — Electron resolves helper apps through it');
  }
  // and the packaged-artifact gate must stay wired into dist, or it protects nothing
  assert.match(String((pkg as never as { scripts: Record<string, string> }).scripts.dist ?? ''), /verify:package/,
    'dist must end in verify:package');
});

test('a command longer than the tty can accept is written to a file, not typed', () => {
  /* MAX_CANON is 1024 bytes: a longer single line loses its tail silently, and since the tail
     of a generated command is usually quoted text, the shell waits for a quote that never
     closes. It looks exactly like a hang. Measured on a real run — a 1,100-byte wiring chain
     arrived as exactly 1024 bytes, ending mid-string.
     Verified as a rule, plus the wiring of it, because a threshold nobody consults is decoration. */
  assert.equal(MAX_CANON, 1024);
  assert.ok(SAFE_LINE < MAX_CANON, 'the threshold must leave headroom, not sit on the limit');
  assert.equal(needsSpill('echo hi'), false, 'short commands stay visible in the terminal');
  assert.equal(needsSpill('x'.repeat(SAFE_LINE - 2)), false, 'just under stays inline');
  assert.equal(needsSpill('x'.repeat(SAFE_LINE)), true, 'at the threshold it spills');
  assert.equal(needsSpill('x'.repeat(MAX_CANON + 500)), true, 'well over it spills');
  // multi-byte characters count as bytes, not characters — the banner is full of em dashes
  assert.equal(needsSpill('—'.repeat(400)), true, 'byte length, not string length');
  // and the pty write site must actually route through it
  const main = fs.readFileSync('src/main/main.ts', 'utf8');
  // The spill MOVED from pty:spawn to pty:run — the command is now written after the renderer
  // has pushed real geometry (a TUI started at the hardcoded 80×24 then resized was the resume
  // glitch). The invariant is unchanged: every opening command still passes through the spill,
  // and it still lives in MAIN so the renderer cannot bypass the 1024-byte protection.
  assert.match(main, /ipcMain\.handle\('pty:run'/, 'a pty:run chokepoint must exist');
  assert.match(main, /p\.write\(spillLongCommand\(String\(cmd\)\) \+ '\\r'\)/,
    'pty:run is the one chokepoint every opening command passes through');
  assert.doesNotMatch(main, /p\.write\(spillLongCommand\(opts\.cmd\)/,
    'pty:spawn must NOT run the command — geometry is not known yet at spawn');
  assert.match(main, /mode: 0o700/, 'the spilled script is not world-readable');
});

test('the command an operator sees is the command, not a wall of escape codes', () => {
  /* The completion banner was inlined into every command, so a terminal opened with ~700
     characters of `printf '\n\033[32m%s…'` before anything ran. It worked — and the operator's
     word for it was "intimidating", which is the right word for what a newcomer reads while
     deciding whether to trust this. Measured: 1,100 characters became 118, same behaviour.
     It also keeps every command well clear of MAX_CANON, where the tail is dropped silently. */
  const app = fs.readFileSync('renderer/app.js', 'utf8');
  /* Windows split this into two branches (PowerShell treats the POSIX `{ cmd ; };` form as a
     scriptblock LITERAL that never executes — which made every setup button a silent no-op), so the
     single-ternary spelling this used to pin is gone. What must hold is unchanged and is asserted
     directly: BOTH branches emit the real command plus a SHORT tail, and neither inlines a banner. */
  const fn = /async function withDoneBanner\(cmd\) \{[\s\S]*?\n\}/.exec(app);
  assert.ok(fn, 'withDoneBanner must be findable');
  const body = fn![0];
  assert.match(body, /if \(IS_WIN\) return `\$\{cmd\} ; \$\{b\} \$\?`;/, 'win32 runs the two sequentially');
  assert.match(body, /return `\{ \$\{cmd\} ; \}; \$\{xQuote\(b\)\} \$\?`;/, 'POSIX keeps the brace group');
  assert.match(body, /if \(!b\) return cmd;/, 'no helper → run the command plainly rather than not at all');
  // The property the whole test exists for: the tail is short. 1,100 chars became 118; any
  // template here that grew past a line would be the inlined-banner regression coming back.
  for (const t of body.match(/`[^`]*`/g) ?? []) {
    assert.ok(t.length < 60, `an emitted command template grew to ${t.length} chars: ${t.slice(0, 70)}`);
  }
  assert.doesNotMatch(app, /printf '\\\\n\\\\033\[32m/, 'no inlined ANSI banner in the renderer');
  // and if the helper cannot be written, the command must still run
  const aios = fs.readFileSync('src/main/aios.ts', 'utf8');
  assert.match(aios, /export function bannerScript\(/);
  assert.match(aios, /mode: 0o700/);
});

test('returning to the Setup tab re-verifies it', () => {
  /* The re-verify meant to follow a setup command hooks the pane's EXIT — and these panes do not
     exit: the script finishes, prints its verdict, and the shell stays open at a prompt. So the
     only thing advancing the stepper was a 5s poll, itself paused whenever the window is not
     visible. An operator who installs, watches the terminal, switches away and clicks back to
     Setup could land on a screen that had not re-checked since before the install — with the step
     they just completed still glaring at them. Returning to the tab IS the question "did that
     work?", so it must answer it. Verified live: the repaint fires on return. */
  assert.match(app, /if \(p\.path === '::setup' && typeof onboardingRepaint === 'function'\) void onboardingRepaint\(\);/);
  // and it must live in setActive — the one place every tab switch passes through
  const setActiveSrc = /function setActive\(id\) \{[\s\S]*?\n\}/.exec(app)?.[0] ?? '';
  assert.match(setActiveSrc, /onboardingRepaint\(\)/, 'hook the chokepoint, not each caller');
});

test('a ritual launches as a named SESSION, never an anonymous terminal', () => {
  /* `claude '/aios:update'` with no --name: termEnv() derives CLAUDE_AGENT_NAME from the command's
     own --name, so without it the session skips CLAUDE.md's identity ritual and never registers in
     ~/.claude/sessions. The operator gets an unnamed terminal they cannot resume and cannot find in
     Running — reported on the update pill as "a session that is not recognised as a session".
     The pane always had a name for its tab; it just never reached Claude. */
  assert.match(app, /const ritual = \(name, slash\) => \(\{ name, cmd: CLAUDE \+ ' --name ' \+ name \+ ' ' \+ shq\(slash\) \}\)/,
    'one builder emits the tab name and the session name from the same string');
  // no ritual may be launched the old way — a bare slash command with no --name
  const orphans = [...app.matchAll(/cmd: CLAUDE \+ " '\/[a-z:-]+'"/g)].map((m) => m[0]);
  assert.deepEqual(orphans, [], `these launch a ritual without --name: ${orphans.join(', ')}`);
  for (const r of ['today', 'close-day', 'update', 'cold-start', 'goal', 'schedule', 'perms']) {
    assert.ok(app.includes(`ritual('${r}'`), `${r} must go through the builder`);
  }
  const panel = fs.readFileSync('src/main/panelHost.ts', 'utf8');
  assert.match(panel, /--name update '\/aios:update'/, 'the update pill launches a named session');
});

test('no stray keyword was left dangling by an edit', () => {
  /* `node --check` passes on `async` followed by a newline and a comment: ASI makes it a bare
     expression statement, which is syntactically fine and throws "async is not defined" at module
     load, killing every function after it. That happened — a replacement matched
     `function spawnNamed(` on a file that read `async function spawnNamed(`, so the insertion
     landed between the two words. Unit tests still passed, because they read source text; only
     the smoke gate, which actually boots the renderer, caught it. */
  assert.doesNotMatch(app, /\basync\s*(\/\*|\/\/|\n)/, 'a dangling `async` is a load-time crash');
  for (const kw of ['await', 'return', 'const', 'let']) {
    assert.doesNotMatch(app, new RegExp(`\\b${kw}\\s*\\n\\s*/\\*`), `dangling \`${kw}\` before a comment`);
  }
});

test('INVARIANT: a pane\'s opening command runs only after real geometry is pushed', () => {
  /* A full-screen TUI started at the placeholder 80×24 and then resized underneath is what
     garbled `claude --resume`: xterm reflowed a half-drawn interface. The ordering below is
     the fix, so it is asserted rather than trusted — fit → ensureTermRoom → pushPtyGeom → run. */
  const app = fs.readFileSync('renderer/app.js', 'utf8');
  const seq = /fit\.fit\(\);\s*\n\s*ensureTermRoom\(id, p\);\s*\n\s*pushPtyGeom\(id, p\);[\s\S]{0,600}?ptyRun\(id, cmd\)/;
  assert.match(app, seq, 'ptyRun must come after fit + ensureTermRoom + pushPtyGeom');
  const runIdx = app.indexOf('ptyRun(id, cmd)');
  const geomIdx = app.indexOf('pushPtyGeom(id, p);');
  assert.ok(geomIdx > 0 && runIdx > geomIdx, 'the command must not be issued before the resize');
});
