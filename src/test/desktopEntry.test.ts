/**
 * Linux window association: three names must agree, or the app gets a generic icon and no grouping.
 *
 * Electron lowercases the app name for `WM_CLASS` at runtime. electron-builder, when `desktopName`
 * is absent, derives `StartupWMClass` from `productName` — so the shipped entry said
 * `StartupWMClass=AIOS` while the running window reported `WM_CLASS = "aios"`, measured with
 * `xprop`. They never matched, and the desktop environment refused to link the two. The first fix
 * overrode `StartupWMClass` by hand, which corrected the symptom; setting `desktopName` corrects
 * the cause, because electron-builder derives BOTH the .desktop filename and StartupWMClass from
 * it, and Electron derives its runtime app_id from it too.
 *
 * The failure mode this guards is silent and cosmetic — nothing crashes, the icon is just wrong —
 * which is exactly the kind of thing that regresses unnoticed. And it is unverifiable from CI: a
 * headless xvfb run has no desktop environment to do the association, so the invariant has to be
 * asserted on the CONFIG rather than observed on a running window.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const linux = pkg.build?.linux ?? {};

test('desktopName is set — without it StartupWMClass silently derives from productName', () => {
  /* This is the whole bug in one assertion. `wmClass = desktopName ?? appInfo.productName`, and
     productName is "AIOS" while the runtime WM_CLASS is "aios". */
  assert.ok(typeof pkg.desktopName === 'string' && pkg.desktopName.trim().length > 0,
    'package.json must declare a top-level desktopName (electron-builder reads it from metadata, '
    + 'NOT from build.linux); without it StartupWMClass becomes productName and never matches');
  assert.match(pkg.desktopName, /\.desktop$/, 'desktopName should carry the .desktop suffix');
});

test('desktopName is lowercase — Electron lowercases WM_CLASS, so anything else cannot match', () => {
  const base = String(pkg.desktopName).replace(/\.desktop$/, '');
  assert.equal(base, base.toLowerCase(),
    `desktopName "${base}" is not lowercase; Electron lowercases the app name for WM_CLASS, so a `
    + 'mixed-case value produces exactly the mismatch this file exists to prevent');
  assert.doesNotMatch(base, /[/\\\s]/, 'desktopName flows into filesystem paths — no separators or spaces');
});

test('syncDesktopName is on, or desktopName does not reach the .desktop filename', () => {
  /* getDesktopFileName() returns executableName unless syncDesktopName is true. With it off,
     desktopName still fixes StartupWMClass but the FILE stays aios-app.desktop — and some desktop
     environments associate by the entry's basename, not by StartupWMClass. Half a fix. */
  assert.equal(linux.syncDesktopName, true,
    'linux.syncDesktopName must be true so the .desktop filename matches desktopName; some desktop '
    + 'environments key association on the filename rather than StartupWMClass');
});

test('the explicit StartupWMClass override agrees with desktopName', () => {
  /* The override is kept deliberately: it records the value measured with xprop, and it keeps the
     entry correct even if desktopName is later removed. But an override that DISAGREES with the
     derived value is worse than none, because deepAssign lets it win silently. */
  const derived = String(pkg.desktopName).replace(/\.desktop$/, '');
  const explicit = linux.desktop?.entry?.StartupWMClass;
  if (explicit === undefined) return;   // deriving it is legitimate; disagreeing is not
  assert.equal(explicit, derived,
    `linux.desktop.entry.StartupWMClass ("${explicit}") disagrees with desktopName ("${derived}"). `
    + 'The override wins via deepAssign, so a mismatch here ships whatever the override says.');
});
