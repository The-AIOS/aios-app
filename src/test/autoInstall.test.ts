/**
 * Unattended install — a downloaded update restarts the app on its own, but only on a machine
 * nobody is using and only when nothing is in flight. The policy is pure (src/core/autoInstall.ts);
 * the driver's wiring is guarded by reading the sources, as closeHides.test.ts does, because the
 * part that must not drift is WHICH path installs and WHO turns it on.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {
  quietBlocker, installStep, mayAutoInstall, QUIET_MS, IDLE_MIN_S, SAMPLE_MS, type QuietInputs,
} from '../core/autoInstall';

const quiet: QuietInputs = { busy: false, statuses: ['idle', 'shell', 'idle'], heldSends: 0, idleSec: IDLE_MIN_S };

test('quiet only when every condition holds', () => {
  assert.equal(quietBlocker(quiet), null);
  assert.equal(quietBlocker({ ...quiet, busy: true }), 'busy');
  assert.equal(quietBlocker({ ...quiet, statuses: ['idle', 'waiting'] }), 'waiting', 'a pending prompt is work the restart would lose');
  assert.equal(quietBlocker({ ...quiet, statuses: ['WAITING'] }), 'waiting', 'case does not matter');
  assert.equal(quietBlocker({ ...quiet, heldSends: 1 }), 'delivering');
  assert.equal(quietBlocker({ ...quiet, idleSec: IDLE_MIN_S - 1 }), 'person', 'someone at the keyboard (or over screen sharing) blocks it');
  assert.equal(quietBlocker({ ...quiet, idleSec: Number.NaN }), 'person', 'an unreadable idle time is not proof of absence');
  assert.equal(quietBlocker({ ...quiet, statuses: [] }), null, 'no sessions at all is quiet');
});

test('the restart waits for an unbroken quiet streak', () => {
  let prev = { quietSince: 0, lastSampleAt: 0 };
  let now = 1_000_000;
  const step = (i: QuietInputs) => {
    const s = installStep(i, prev, now);
    prev = { quietSince: s.quietSince, lastSampleAt: now };
    now += SAMPLE_MS;
    return s;
  };
  const first = step(quiet);
  assert.equal(first.install, false, 'one quiet sample is not a quiet machine');
  assert.equal(first.quietSince, 1_000_000);
  // a bus-driven session goes busy for a moment: the streak starts over
  for (let i = 0; i < 3; i++) step(quiet);
  assert.equal(step({ ...quiet, busy: true }).quietSince, 0);
  let s = step(quiet);
  const restart = s.quietSince;
  while (!s.install) {
    assert.ok(now - restart <= QUIET_MS + 2 * SAMPLE_MS, 'it must install once the streak is long enough');
    s = step(quiet);
  }
  assert.ok(now - SAMPLE_MS - restart >= QUIET_MS, 'never before QUIET_MS of unbroken quiet');
});

test('a gap between samples (sleep, suspension) restarts the streak', () => {
  const t0 = 5_000_000;
  const a = installStep(quiet, { quietSince: 0, lastSampleAt: 0 }, t0);
  const late = t0 + QUIET_MS + 3 * SAMPLE_MS;   // one sample, long after: nothing is known about the gap
  const b = installStep(quiet, { quietSince: a.quietSince, lastSampleAt: t0 }, late);
  assert.equal(b.quietSince, late);
  assert.equal(b.install, false);
});

test('never the same version twice — a failed install cannot loop', () => {
  assert.equal(mayAutoInstall('0.14.2', ''), true);
  assert.equal(mayAutoInstall('0.14.2', '0.14.1'), true);
  assert.equal(mayAutoInstall('0.14.2', '0.14.2'), false);
  assert.equal(mayAutoInstall('', ''), false);
});

const src = (p: string): string => fs.readFileSync(p, 'utf8');

test('the unattended path installs through the SAME handler as the pill, and records the attempt first', () => {
  const upd = src('src/main/updater.ts');
  assert.match(upd, /const install = \(\): void => \{ markQuitting\(\); autoUpdater\.quitAndInstall\(\); \};/);
  assert.match(upd, /ipcMain\.handle\('updater:quitAndInstall', install\)/, 'the pill and the driver share one install');
  const body = upd.slice(upd.indexOf('function sampleUnattended'));
  const rec = body.indexOf('writeFileSync(attemptFile()');
  const go = body.indexOf('unattended.install?.()');
  assert.ok(rec > 0 && go > rec, 'the attempt is recorded before the restart');
  assert.match(body, /could not record the attempt — not installing/, 'no record, no install');
  assert.match(upd, /if \(!app\.isPackaged \|\| !unattended\.wanted \|\| !v \|\| !unattended\.install\) \{ stopUnattended\(\); return; \}/,
    'nothing runs unless packaged, the mode is on and an update is downloaded');
  assert.ok(upd.indexOf("ipcMain.handle('updater:unattended'") < upd.indexOf('if (!app.isPackaged) return;'),
    'the handle exists in dev too, so the renderer\'s invoke never rejects');
});

test('the renderer turns it on only from the unattended setting, at launch and on change', () => {
  const app = src('renderer/app.js');
  assert.match(app, /window\.glassShell\.updaterUnattended\?\.\(UNATTENDED !== 'off'\)/);
  const launch = app.indexOf('tellUpdaterUnattended();');
  assert.ok(launch > app.indexOf('let UNATTENDED ='), 'told at launch, after the mode is read');
  assert.match(app, /localStorage\.setItem\(UNATTENDED_KEY, UNATTENDED\);[^\n]*\n\s*tellUpdaterUnattended\(\);/, 'and on every change');
  assert.equal((app.match(/updaterUnattended/g) || []).length, 1, 'no other caller');
  assert.match(app, /showUpdatePill\(\(payload \|\| \{\}\)\.version, 'ready'\);[\s\S]{0,300}tellUpdaterUnattended\(\);/,
    'told again on ready: the launch report may precede the updater and fail silently');
  assert.match(src('src/preload/preload.ts'), /updaterUnattended: \(on: boolean\)[^\n]*invoke\('updater:unattended', on\)/);
});

test('every locale says that unattended mode now installs updates', () => {
  for (const loc of ['en', 'es', 'pt-br', 'el']) {
    const h = JSON.parse(src(`src/i18n/locales/${loc}.json`))['settings.unattendedHint'] as string;
    assert.ok(h.includes(String(IDLE_MIN_S / 60)), `${loc}: the idle threshold (${IDLE_MIN_S / 60} min) is stated`);
  }
});
