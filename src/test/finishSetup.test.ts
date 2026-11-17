/**
 * Finish setup — the App wires skills, plugin, spawn and hooks itself, so a setup session that auto
 * mode refused never ends in `!` lines for the operator to paste.
 *
 * The orchestration is pure (core/finishSetup.ts) and tested with fabricated checks and a fake
 * repair; the doctor rows it drives are tested against a fixture in doctor.test.ts; the renderer
 * and the handover prompt are source invariants, like the rest of this suite.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  FINISH_SETUP_IDS, needsFinishSetup, runFinishSetup, pluginRepairArgv, missingHooks, hookCommands, oneLine,
  type FinishCheckLike,
} from '../core/finishSetup';
import { ONBOARDING_STEPS } from '../core/onboarding';

const APP = (): string => fs.readFileSync(path.join(__dirname, '../../renderer/app.js'), 'utf8');
const LOCALES = ['en', 'es', 'pt-br'];
const locale = (l: string): Record<string, string> =>
  JSON.parse(fs.readFileSync(path.join(__dirname, '../../src/i18n/locales', `${l}.json`), 'utf8'));

const chk = (id: string, status: FinishCheckLike['status'], extra: Partial<FinishCheckLike> = {}): FinishCheckLike =>
  ({ id, status, label: id, message: `${id} ${status}`, canRepair: status !== 'pass', ...extra });
const wired = (): FinishCheckLike[] => [chk('framework', 'pass'), ...FINISH_SETUP_IDS.map((id) => chk(id, 'pass'))];

test('the order is skills → plugin → spawn → hooks', () => {
  assert.deepEqual([...FINISH_SETUP_IDS], ['skills', 'plugin', 'spawn', 'hooks']);
});

test('offered only when the framework exists AND something is amber — a wired machine never sees it', () => {
  assert.equal(needsFinishSetup(wired()), false, 'everything green: no button');
  const amber = wired().map((c) => (c.id === 'hooks' ? chk('hooks', 'warn') : c));
  assert.equal(needsFinishSetup(amber), true, 'one amber row: offer it');
  /* Every installer lives inside the framework checkout, so before the setup session has cloned
     it there is nothing to run — the button would be a promise the App cannot keep. */
  const noFw = amber.map((c) => (c.id === 'framework' ? chk('framework', 'fail') : c));
  assert.equal(needsFinishSetup(noFw), false, 'no framework yet: no button');
  assert.equal(needsFinishSetup([]), false, 'no evidence is not a reason to offer anything');
});

test('runs the repairs IN ORDER, re-checks each, and skips what already passes', async () => {
  const calls: string[] = [];
  const current = [chk('framework', 'pass'), chk('skills', 'warn'), chk('plugin', 'pass'), chk('spawn', 'warn'), chk('hooks', 'warn')];
  const out = await runFinishSetup(current, async (id) => { calls.push(id); return chk(id, 'pass'); });
  assert.deepEqual(calls, ['skills', 'spawn', 'hooks'], 'a passing row is never re-run');
  assert.equal(out.ok, true);
  assert.equal(out.stoppedAt, undefined);
  assert.deepEqual(out.results.map((r) => [r.id, r.status]), [['skills', 'pass'], ['plugin', 'pass'], ['spawn', 'pass'], ['hooks', 'pass']]);
});

test('STOPS at the first repair that does not come back green, and says why', async () => {
  const calls: string[] = [];
  const current = [chk('framework', 'pass'), ...FINISH_SETUP_IDS.map((id) => chk(id, 'warn'))];
  const out = await runFinishSetup(current, async (id) => {
    calls.push(id);
    return id === 'plugin' ? chk('plugin', 'warn', { message: 'marketplace unreachable' }) : chk(id, 'pass');
  });
  assert.deepEqual(calls, ['skills', 'plugin'], 'nothing after the failure is attempted');
  assert.equal(out.ok, false);
  assert.equal(out.stoppedAt, 'plugin');
  assert.equal(out.reason, 'marketplace unreachable', 'the re-checked message is the reason');
  // what was not attempted is still reported, as it was — the screen keeps saying what is left
  assert.deepEqual(out.results.map((r) => [r.id, r.status]), [['skills', 'pass'], ['plugin', 'warn'], ['spawn', 'warn'], ['hooks', 'warn']]);
});

test('a row the App cannot repair stops the run with ITS reason — nothing runs behind it', async () => {
  const calls: string[] = [];
  const current = [chk('framework', 'pass'), chk('skills', 'warn', { canRepair: false, blockedBy: 'claude' }), chk('plugin', 'warn')];
  const out = await runFinishSetup(current, async (id) => { calls.push(id); return chk(id, 'pass'); });
  assert.deepEqual(calls, [], 'never attempted');
  assert.equal(out.stoppedAt, 'skills');
  assert.match(out.reason!, /claude/, 'names what is in the way');
});

test('a repair that throws reads as "still amber", never as success', async () => {
  const current = [chk('framework', 'pass'), chk('skills', 'warn')];
  const out = await runFinishSetup(current, async () => { throw new Error('boom'); });
  assert.equal(out.ok, false);
  assert.equal(out.stoppedAt, 'skills');
});

test('the plugin repair is two argv calls — no `&&`, no shell quoting, marketplace only when unknown', () => {
  const src = "C:\\Users\\O'Brien Doe\\aios";
  assert.deepEqual(pluginRepairArgv(src, false), [
    ['plugin', 'marketplace', 'add', src],
    ['plugin', 'install', 'aios@the-aios'],
  ], 'the path is one argument, apostrophe and space included');
  assert.deepEqual(pluginRepairArgv(src, true), [['plugin', 'install', 'aios@the-aios']],
    '`marketplace add` on a known name errors, and that would read as the repair failing');
  for (const argv of pluginRepairArgv(src, false)) assert.ok(!argv.includes('&&'));
});

test('hooks: required only when the framework SHIPS the script, matched however the command is spelled', () => {
  const ships = (files: string[]) => (rel: string) => files.some((f) => rel === `hooks/${f}`);   // a framework before v0.8.19: the flat layout these commands use (the folders are tested in hookPaths.test)
  assert.deepEqual(missingHooks({}, ships(['floor-at-start.py', 'inject-datetime.ps1'])).sort(), ['floor-at-start.py', 'inject-datetime']);
  const winStyle = {
    hooks: {
      UserPromptSubmit: [{ hooks: [{ command: 'powershell -NoProfile -ExecutionPolicy Bypass -File "C:\\Users\\x\\aios\\hooks\\inject-datetime.ps1"' }] }],
      SessionStart: [{ hooks: [{ command: '[ ! -f "C:/Users/x/aios/hooks/floor-at-start.py" ] || python "C:/Users/x/aios/hooks/floor-at-start.py"' }] }],
    },
  };
  assert.deepEqual(missingHooks(winStyle, ships(['floor-at-start.py', 'inject-datetime.ps1'])), [], 'Windows paths and the missing-file guard both count');
  assert.deepEqual(missingHooks({}, ships([])), [], 'a framework shipping none owes none');
  // a malformed file contributes nothing rather than throwing — the installer is what refuses it
  assert.deepEqual(hookCommands({ hooks: { X: 'nope', Y: [null, { hooks: 3 }] } }), []);
  assert.deepEqual(hookCommands(null), []);
});

test('oneLine: one physical line, never `!`-prefixed — the two ways a pasted command broke', () => {
  assert.equal(oneLine("! powershell -NoProfile -File 'C:\\Users\\x\\a.ps1'"), "powershell -NoProfile -File 'C:\\Users\\x\\a.ps1'");
  // separate STATEMENTS on separate lines become one line joined by `;` (PowerShell 5.1 and POSIX agree)
  assert.equal(oneLine('claude plugin marketplace add x\n  claude plugin install aios@the-aios'), 'claude plugin marketplace add x; claude plugin install aios@the-aios');
  assert.doesNotMatch(oneLine('a\r\nb\n\n'), /[\r\n]/);
  assert.equal(oneLine(''), '');
});

test('the setup step surfaces the hooks row beside the other wiring', () => {
  const spec = ONBOARDING_STEPS.find((s) => s.id === 'firstrun')!;
  for (const id of FINISH_SETUP_IDS) assert.ok(spec.optional?.includes(id), `${id} hangs off the setup step`);
  assert.ok(!spec.required.includes('hooks'), 'never a gate — the session is still mid-flight');
});

test('the handover prompt tells the session the wiring is the App\'s, and to point at Finish setup', () => {
  const app = APP();
  assert.match(app, /'The App wires the skills, the plugin, the spawn wrapper and the hooks itself\. If any of those is refused here, do not hand me commands to paste; tell me to press Finish setup in the App\. '/);
  // still inside the one launcher, still auto mode
  const start = app.indexOf('const spawnSetupSession = async (model) => {');
  const end = app.indexOf('\n    };', start);
  assert.match(app.slice(start, end), /Finish setup in the App/);
  assert.match(app.slice(start, end), /cwd, 'auto', model\)/);
});

test('the renderer offers Finish setup only from main\'s verdict, and names every change first', () => {
  const app = APP();
  assert.match(app, /if \(s\.id === 'firstrun' && finishPending\.length\) bd\.appendChild\(finishSetupEl\(finishPending\)\)/);
  assert.match(app, /if \(finishPending\.length\) d\.appendChild\(finishSetupEl\(finishPending\)\)/, 'the done screen offers it too');
  assert.match(app, /finishPending = Array\.isArray\(st\.finishPending\) \? st\.finishPending : \[\]/, 'no second list of ids in the renderer');
  assert.match(app, /t\('finish\.change\.' \+ id\)/, 'each pending change is named before the click');
  assert.match(app, /window\.glassShell\.finishSetup\(\)/);
  assert.match(app, /out\.setAttribute\('aria-live', 'polite'\)/, 'the outcome is announced');
});

test('Next steps opens on the transition to done — once, never for an AIOS finished earlier', () => {
  const app = APP();
  assert.match(app, /const justFinished = prevCurrent !== null && prevCurrent < st\.steps\.length && st\.current >= st\.steps\.length;/);
  assert.match(app, /if \(justFinished\) openNextStepsTab\(\);/);
  assert.match(app, /function openNextStepsTab\(\) \{\s*openToolTab\('::nextsteps'/);
  // the fallback commands come from the doctor, already one line each, with a Copy button
  const i = app.indexOf('function openNextStepsTab()');
  const body = app.slice(i, app.indexOf('\n}\n', i));
  assert.match(body, /window\.glassShell\.wiringLeft\(\)/);
  assert.match(body, /window\.glassShell\.copyText\(w\.cmd\)/);
  assert.match(body, /IS_WIN \? t\('nextSteps\.leftHowWin'\) : t\('nextSteps\.leftHowPosix'\)/);
  const css = fs.readFileSync(path.join(__dirname, '../../renderer/theme.css'), 'utf8');
  assert.match(css, /\.ns-cmd \{[^}]*white-space: pre;/, 'what is SHOWN is one line too');
});

test('every new string exists in every locale', () => {
  const keys = Object.keys(locale('en')).filter((k) => /^(finish\.|nextSteps\.|setupCheck\.hooks)/.test(k));
  assert.ok(keys.length >= 30, `expected the finish / next-steps strings, found ${keys.length}`);
  for (const l of LOCALES) {
    const j = locale(l);
    for (const k of keys) assert.ok(typeof j[k] === 'string' && j[k].trim(), `${l} is missing ${k}`);
    for (const id of FINISH_SETUP_IDS) assert.ok(j[`finish.change.${id}`], `${l}: the consent line for ${id}`);
  }
});
