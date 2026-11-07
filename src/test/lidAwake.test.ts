/**
 * Awake with the lid closed (macOS).
 *
 * What these tests care about, in order: (1) the machine is never left unable to sleep — the
 * guard releases when the App's pid dies, on `release`, on the battery floor, and at boot;
 * (2) when the work ends with the lid closed, the Mac actually sleeps; (3) the root surface is
 * exactly two verbs and nothing else; (4) a one-tick idle blip cannot sleep a closed lid mid-work.
 *
 * The guard is RUN, not read: its PATH and pidfile are pointed at a temp dir holding fake `pmset`
 * and `ioreg` that log what they were asked. Everything else in the script is the shipped bytes.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import {
  desiredLidHold, lidModeOf, type LidMode, guardScript, sudoersRule, daemonPlist, installCommand, uninstallCommand,
  parseSleepDisabled, LID_GRACE_MS, LID_BATTERY_FLOOR, GUARD_PATH, SUDOERS_PATH, DAEMON_PATH,
} from '../core/lidAwake';

const base = { platform: 'darwin', mode: 'always' as LidMode, onBattery: false, installed: true, blockerWanted: false, lastWantedAt: 0, now: 1_000_000 };

test('the lid hold follows the keep-awake decision', () => {
  assert.equal(desiredLidHold({ ...base, blockerWanted: true }), true);
  assert.equal(desiredLidHold({ ...base }), false, 'never wanted this run → nothing to hold');
});

test('it is off unless it is macOS, enabled AND installed', () => {
  assert.equal(desiredLidHold({ ...base, blockerWanted: true, platform: 'linux' }), false);
  assert.equal(desiredLidHold({ ...base, blockerWanted: true, platform: 'win32' }), false);
  assert.equal(desiredLidHold({ ...base, blockerWanted: true, mode: 'off' }), false);
  assert.equal(desiredLidHold({ ...base, blockerWanted: true, installed: false }), false,
    'without the guard there is nothing to run — and sudo -n must never be tried blind');
});

test('a short idle blip does not let go — releasing with the lid closed means sleeping NOW', () => {
  const t0 = base.now;
  assert.equal(desiredLidHold({ ...base, lastWantedAt: t0 - 2_000 }), true, 'one 2s tick of idle must not sleep a closed lid');
  assert.equal(desiredLidHold({ ...base, lastWantedAt: t0 - 4_000 }), true, 'nor two');
  assert.equal(desiredLidHold({ ...base, lastWantedAt: t0 - (LID_GRACE_MS - 1) }), true);
  assert.equal(desiredLidHold({ ...base, lastWantedAt: t0 - LID_GRACE_MS }), false, 'after the grace it lets go');
  /* At least two 2s ticks, so one stale read cannot release; at most 30s, because after the
     work ends the operator expects the Mac to sleep, not to idle on battery in a bag. */
  assert.ok(LID_GRACE_MS >= 4_000 && LID_GRACE_MS <= 30_000, 'a margin of a few ticks, not a wait');
});

test('the sudoers rule grants exactly hold and release on the guard, to one user', () => {
  const r = sudoersRule('operator');
  const grant = r.split('\n').filter((l) => l && !l.startsWith('#'));
  assert.equal(grant.length, 1, 'one rule line');
  assert.equal(grant[0], `operator ALL=(root) NOPASSWD: ${GUARD_PATH} hold *, ${GUARD_PATH} release`);
  assert.doesNotMatch(r, /%admin|ALL\s*$|NOPASSWD:\s*ALL/, 'never a broad grant');
  assert.throws(() => sudoersRule('a b'), 'a name that could smuggle syntax into sudoers is refused');
  assert.throws(() => sudoersRule('x, ALL'));
  assert.ok(!path.basename(SUDOERS_PATH).includes('.'), 'sudo silently skips sudoers.d files whose name contains a dot');
});

test('the install validates sudoers before it can land, and writes no swappable temp file outside root', () => {
  const cmd = installCommand('operator');
  const visudo = cmd.indexOf(`visudo -cf '${SUDOERS_PATH}.tmp'`);
  const move = cmd.indexOf(`mv -f '${SUDOERS_PATH}.tmp' '${SUDOERS_PATH}'`);
  assert.ok(visudo > 0 && move > visudo, 'a malformed sudoers file breaks sudo machine-wide — it is checked first');
  assert.ok(cmd.split(' && ').length > 5, 'steps are chained with && so one failure stops the rest');
  assert.doesNotMatch(cmd, /\/tmp\/|TMPDIR/, 'contents travel inside the command, never via a user-writable file');
  for (const p of [GUARD_PATH, SUDOERS_PATH, DAEMON_PATH]) assert.ok(cmd.includes(`'${p}'`), `installs ${p}`);
  const un = uninstallCommand();
  assert.ok(un.indexOf('boot') < un.indexOf('rm -f'), 'remove puts sleep back BEFORE deleting the guard that can');
  for (const p of [GUARD_PATH, SUDOERS_PATH, DAEMON_PATH]) assert.ok(un.includes(p), `removes ${p}`);
});

test('the boot daemon puts sleep back at every boot', () => {
  const p = daemonPlist();
  assert.match(p, /<key>RunAtLoad<\/key><true\/>/);
  assert.ok(p.includes(`<string>${GUARD_PATH}</string><string>boot</string>`));
});

test('SleepDisabled parsing — absent means off', () => {
  assert.equal(parseSleepDisabled(' sleep 1\n SleepDisabled\t\t1\n'), true);
  assert.equal(parseSleepDisabled(' sleep 1\n displaysleep 3\n'), false);
  assert.equal(parseSleepDisabled(' SleepDisabled\t\t0\n'), false);
});

/* ── the guard, run for real against fakes ── */

function sandbox(opts: { lidClosed: boolean; battery?: string }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lid-guard-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const logf = path.join(dir, 'pmset.log');
  const batt = opts.battery ?? "Now drawing from 'AC Power'\n -InternalBattery-0 80%; charging";
  fs.writeFileSync(path.join(bin, 'pmset'),
    `#!/bin/sh\nif [ "$1" = "-g" ] && [ "$2" = "batt" ]; then printf '%s\\n' "${batt.replace(/"/g, '\\"')}"; exit 0; fi\necho "$*" >> '${logf}'\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'ioreg'),
    `#!/bin/sh\necho '  |   "AppleClamshellState" = ${opts.lidClosed ? 'Yes' : 'No'}'\n`, { mode: 0o755 });
  const script = guardScript()
    .replace('PATH=/usr/bin:/bin:/usr/sbin:/sbin', `PATH=${bin}:/usr/bin:/bin:/usr/sbin:/sbin`)
    .replace('PIDFILE=/var/run/com.the-aios.lid-guard.pid', `PIDFILE=${dir}/guard.pid`);
  assert.notEqual(script, guardScript(), 'the sandbox must actually redirect PATH and the pidfile');
  const guard = path.join(dir, 'guard');
  fs.writeFileSync(guard, script, { mode: 0o755 });
  const calls = (): string[] => (fs.existsSync(logf) ? fs.readFileSync(logf, 'utf8').trim().split('\n').filter(Boolean) : []);
  return { dir, guard, calls };
}

function waitFor(cond: () => boolean, ms = 15_000): Promise<void> {
  const t0 = Date.now();
  return new Promise((res, rej) => {
    const tick = () => (cond() ? res() : Date.now() - t0 > ms ? rej(new Error('timed out')) : setTimeout(tick, 50));
    tick();
  });
}

const skipOffPosix = process.platform === 'win32' ? 'POSIX shell' : false;
/* The guard now holds only for a pid the sudo caller owns (review nit, #54). sudo sets SUDO_UID; these
   tests run the guard directly, as the same user, so they set it to what sudo would. */
if (process.getuid) process.env.SUDO_UID = String(process.getuid());

test('the guard parses as sh', { skip: skipOffPosix }, () => {
  const r = spawnSync('/bin/sh', ['-n'], { input: guardScript() });
  assert.equal(r.status, 0, String(r.stderr));
});

test('the guard releases on its own when the App dies — and sleeps a closed lid', { skip: skipOffPosix }, async () => {
  const s = sandbox({ lidClosed: true });
  const app = spawn('/bin/sleep', ['60']);                      // stands in for the App's pid
  const g = spawn(s.guard, ['hold', String(app.pid)]);
  let out = '';
  g.stdout.on('data', (d) => { out += d; });
  await waitFor(() => out.includes('held'));
  assert.deepEqual(s.calls(), ['-a disablesleep 1']);
  app.kill('SIGKILL');                                           // a crash, not a polite quit
  await new Promise((r) => g.on('exit', r));
  assert.deepEqual(s.calls(), ['-a disablesleep 1', '-a disablesleep 0', 'sleepnow'],
    'a dead App must never leave sleep disabled; with the lid closed the work is over, so sleep');
  assert.ok(!fs.existsSync(path.join(s.dir, 'guard.pid')));
});

test('release from the App stops the holder; an open lid is NOT put to sleep', { skip: skipOffPosix }, async () => {
  const s = sandbox({ lidClosed: false });
  const app = spawn('/bin/sleep', ['60']);
  const g = spawn(s.guard, ['hold', String(app.pid)]);
  let out = '';
  g.stdout.on('data', (d) => { out += d; });
  await waitFor(() => out.includes('held'));
  const r = spawnSync(s.guard, ['release']);
  assert.equal(r.status, 0);
  await new Promise((res) => g.on('exit', res));
  app.kill();
  assert.deepEqual(s.calls(), ['-a disablesleep 1', '-a disablesleep 0'], 'operator is at the keyboard — no surprise sleep');
});

test('the battery floor releases even while the App is alive', { skip: skipOffPosix }, async () => {
  const s = sandbox({ lidClosed: true, battery: `Now drawing from 'Battery Power'\n -InternalBattery-0 ${LID_BATTERY_FLOOR}%; discharging` });
  const app = spawn('/bin/sleep', ['60']);
  const g = spawn(s.guard, ['hold', String(app.pid)]);
  await new Promise((res) => g.on('exit', res));
  app.kill();
  assert.deepEqual(s.calls(), ['-a disablesleep 1', '-a disablesleep 0', 'sleepnow']);
});

test('a restarted App takes over the hold without a sleep in between', { skip: skipOffPosix }, async () => {
  const s = sandbox({ lidClosed: true });
  const app1 = spawn('/bin/sleep', ['60']);
  const g1 = spawn(s.guard, ['hold', String(app1.pid)]);
  /* Subscribed up front: g1 exits during g2's start-up, before the line that awaits it runs, and
     an 'exit' listener attached after the fact never fires. */
  const g1Exit = new Promise((res) => g1.on('exit', res));
  let o1 = '';
  g1.stdout.on('data', (d) => { o1 += d; });
  await waitFor(() => o1.includes('held'));
  const app2 = spawn('/bin/sleep', ['60']);
  const g2 = spawn(s.guard, ['hold', String(app2.pid)]);
  let o2 = '';
  g2.stdout.on('data', (d) => { o2 += d; });
  await waitFor(() => o2.includes('held'));
  await g1Exit;
  assert.ok(!s.calls().includes('sleepnow'), 'handover must not sleep a closed lid');
  spawnSync(s.guard, ['release']);
  await new Promise((res) => g2.on('exit', res));
  app1.kill(); app2.kill();
  assert.equal(s.calls().at(-1), 'sleepnow', 'the final release still sleeps it');
});

test('the guard refuses anything but its verbs', { skip: skipOffPosix }, () => {
  const s = sandbox({ lidClosed: false });
  assert.equal(spawnSync(s.guard, ['hold']).status, 2, 'hold without a pid');
  assert.equal(spawnSync(s.guard, ['hold', '1; rm -rf /']).status, 2, 'a pid that is not digits');
  assert.equal(spawnSync(s.guard, ['whatever']).status, 2);
  assert.deepEqual(s.calls(), [], 'and touched nothing');
});

test('boot puts sleep back without sleeping', { skip: skipOffPosix }, () => {
  const s = sandbox({ lidClosed: true });
  assert.equal(spawnSync(s.guard, ['boot']).status, 0);
  assert.deepEqual(s.calls(), ['-a disablesleep 0']);
});

test('the lid word fits the title-bar tooltip in every locale', () => {
  for (const loc of ['en', 'es', 'pt-br']) {
    const d = JSON.parse(fs.readFileSync(`src/i18n/locales/${loc}.json`, 'utf8')) as Record<string, string>;
    for (const k of ['caffeinate.lidHolding', 'settings.lidAwake', 'settings.lidAwakeHint', 'caffeinate.lidOn', 'caffeinate.lidOff',
                     'caffeinate.lidRemove', 'caffeinate.lidFailed', 'caffeinate.lidPrompt', 'caffeinate.lidPromptRemove']) {
      assert.ok(d[k], `${loc}: missing ${k}`);
    }
    const status = [d['caffeinate.modeAutoShort'], d['caffeinate.modeManualShort'], d['caffeinate.statusOverride']]
      .reduce((a, b) => (a.length >= b.length ? a : b));
    const worst = `${d['caffeinate.title']}: ${status} · ${d['caffeinate.lidHolding']}`;
    assert.ok(worst.length <= 64, `${loc}: "${worst}" is ${worst.length} chars`);
  }
});

test('a stale pidfile never makes root signal a process that is not the guard', { skip: skipOffPosix }, async () => {
  /* The pidfile outlives a guard killed with SIGKILL (no trap runs), and pids are reused. Before
     0.11.0, `release` ran `kill $(cat pidfile)` and `hold` sent USR1 to it, as root, without
     checking what now owns that pid. USR1's default action terminates a process. */
  const s = sandbox({ lidClosed: false });
  const bystander = spawn('/bin/sleep', ['60']);
  const died = new Promise((res) => bystander.on('exit', res));
  let alive = true;
  bystander.on('exit', () => { alive = false; });
  fs.writeFileSync(path.join(s.dir, 'guard.pid'), String(bystander.pid));
  assert.equal(spawnSync(s.guard, ['release']).status, 0);
  assert.ok(alive, 'release must not kill an unrelated process named by a stale pidfile');
  assert.deepEqual(s.calls(), ['-a disablesleep 0'], 'it still puts sleep back');
  fs.writeFileSync(path.join(s.dir, 'guard.pid'), String(bystander.pid));
  const app = spawn('/bin/sleep', ['60']);
  const g = spawn(s.guard, ['hold', String(app.pid)]);
  let out = '';
  g.stdout.on('data', (d) => { out += d; });
  await waitFor(() => out.includes('held'));
  assert.ok(alive, 'hold must not USR1 an unrelated process either');
  spawnSync(s.guard, ['release']);
  await new Promise((res) => g.on('exit', res));
  app.kill(); bystander.kill(); await died;
});

test('review nit (#54): the guard holds only for ONE pid that the sudo caller owns', { skip: process.platform === 'win32' }, () => {
  const cp = require('node:child_process') as typeof import('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-guard-'));
  const g = path.join(dir, 'guard.sh');
  fs.writeFileSync(g, guardScript(), { mode: 0o755 });
  const run = (args: string[], uid: string) => cp.spawnSync('/bin/sh', [g, ...args], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin:/usr/sbin', SUDO_UID: uid } });
  const me = String(process.getuid?.() ?? '');
  let r = run(['hold', '1'], me);
  assert.equal(r.status, 2, 'launchd (pid 1, root) is not the caller\'s process'); assert.match(r.stderr, /not the caller's process/);
  r = run(['hold', String(process.pid)], String(Number(me) + 1));
  assert.equal(r.status, 2, 'a pid owned by someone other than the sudo caller is refused');
  r = run(['hold', String(process.pid), 'extra'], me);
  assert.equal(r.status, 2, 'one pid, nothing more'); assert.match(r.stderr, /exactly one pid/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('0.15.0: three modes — Always holds on battery or AC, While plugged in only on AC, Off never', () => {
  for (const onBattery of [false, true]) {
    assert.equal(desiredLidHold({ ...base, blockerWanted: true, mode: 'always', onBattery }), true, `always, battery=${onBattery}`);
    assert.equal(desiredLidHold({ ...base, blockerWanted: true, mode: 'off', onBattery }), false, `off, battery=${onBattery}`);
    assert.equal(desiredLidHold({ ...base, blockerWanted: true, mode: 'plugged', onBattery, installed: false }), false, 'never without the guard');
    assert.equal(desiredLidHold({ ...base, blockerWanted: true, mode: 'plugged', onBattery, platform: 'win32' }), false, 'macOS only');
  }
  assert.equal(desiredLidHold({ ...base, blockerWanted: true, mode: 'plugged', onBattery: false }), true, 'plugged in: holds');
  assert.equal(desiredLidHold({ ...base, blockerWanted: true, mode: 'plugged', onBattery: true }), false, 'unplugged: lets go');
  assert.equal(desiredLidHold({ ...base, mode: 'plugged', onBattery: true, lastWantedAt: base.now - 2_000 }), false, 'unplugged lets go even inside the grace');
  /* Control: the rule without its battery check would hold on battery — the assertion above can fail. */
  const noBatteryCheck = (i: Parameters<typeof desiredLidHold>[0]) => desiredLidHold({ ...i, onBattery: false });
  assert.notEqual(noBatteryCheck({ ...base, blockerWanted: true, mode: 'plugged', onBattery: true }),
    desiredLidHold({ ...base, blockerWanted: true, mode: 'plugged', onBattery: true }), 'control: ignoring the battery changes the answer');
});

test('0.15.0: the stored value — new strings, an old boolean, and the default', () => {
  assert.equal(lidModeOf('always'), 'always');
  assert.equal(lidModeOf('plugged'), 'plugged');
  assert.equal(lidModeOf('off'), 'off');
  assert.equal(lidModeOf(true), 'always', 'an older build\'s yes');
  assert.equal(lidModeOf(false), 'off', 'an older build\'s explicit no stays no');
  assert.equal(lidModeOf(undefined), 'always', 'the default (inert until the helper is installed)');
  assert.equal(lidModeOf('sometimes'), 'always', 'garbage reads as the default, never as a third state');
});

test('0.15.0: the driver passes the power source and re-applies when it changes; Settings offers three modes', () => {
  const c = fs.readFileSync('src/main/caffeinate.ts', 'utf8');
  assert.match(c, /mode: aios\.shellSettings\(\)\.lidAwake, onBattery: onBattery\(\)/);
  assert.match(c, /powerMonitor\.on\('on-ac', onPower\); powerMonitor\.on\('on-battery', onPower\);/);
  assert.match(c, /export async function lidEnable\(mode: LidMode, prompt: string\)/);
  const app = fs.readFileSync('renderer/app.js', 'utf8');
  assert.match(app, /\[t\('caffeinate\.lidOn'\), 'always'\], \[t\('caffeinate\.lidPlugged'\), 'plugged'\], \[t\('caffeinate\.lidOff'\), 'off'\]/);
  assert.match(app, /caffeinateLid\('always', t\('caffeinate\.lidPrompt'\)\)/, 'the ask-once Yes means Always');
  for (const l of ['en', 'es', 'pt-br', 'el']) {
    const j = JSON.parse(fs.readFileSync(`src/i18n/locales/${l}.json`, 'utf8')) as Record<string, string>;
    assert.ok(j['caffeinate.lidPlugged'], `${l}: While plugged in`);
  }
});
