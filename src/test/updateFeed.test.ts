/**
 * The update feed must be USABLE, not merely present.
 *
 * v0.7.0 was signed, notarized, published, and verified — and could not update anybody.
 * electron-updater's MacUpdater calls `findFile(files, "zip", ["pkg", "dmg"])`: it requires a
 * ZIP and explicitly EXCLUDES the dmg. The release carried only a .dmg, so the manifest parsed,
 * `update-available` fired, and the download died with ERR_UPDATER_ZIP_FILE_NOT_FOUND. Nothing
 * surfaced, because the in-app pill only appears once a download COMPLETES.
 *
 * The CI gate that was supposed to catch this asserted `test -f dist/latest-mac.yml` — the file
 * existed. Checking for presence when the requirement is usability is the same mistake as a
 * test that passes on a truncated message.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const targets: Array<{ target: string; arch?: string[] }> = pkg.build?.mac?.target ?? [];
const names = targets.map((t) => t.target);

test('macOS builds a ZIP — without it auto-update cannot work at all', () => {
  assert.ok(names.includes('zip'),
    `MacUpdater refuses a dmg; build.mac.target must include "zip". Found: ${names.join(', ')}`);
});

test('macOS still builds the DMG — it is what a human downloads', () => {
  assert.ok(names.includes('dmg'), `first-install path must stay a dmg. Found: ${names.join(', ')}`);
});

test('the zip covers every arch the dmg does, or those users silently never update', () => {
  const arch = (n: string) => (targets.find((t) => t.target === n)?.arch ?? []).slice().sort();
  assert.deepEqual(arch('zip'), arch('dmg'),
    'an arch that ships a dmg but no zip installs fine and then never updates — the worst combination');
});

test('the release workflow asserts the manifest is usable, not just present', () => {
  const wf = fs.readFileSync('.github/workflows/release.yml', 'utf8');
  assert.match(wf, /latest-mac\.yml missing/, 'presence check stays');
  assert.match(wf, /grep -q '\\\.zip' dist\/latest-mac\.yml/,
    'and the feed must be asserted to reference a zip — presence alone shipped a dead updater');
});

test('electron-updater still requires a zip — pinned to the installed dependency', () => {
  /* If a future electron-updater learns to update from a dmg, this fails and the rule above
     can be revisited deliberately, rather than being carried forever as folklore. */
  const p = 'node_modules/electron-updater/out/MacUpdater.js';
  if (!fs.existsSync(p)) return;   // dependency-free checkouts still run the rest
  const src = fs.readFileSync(p, 'utf8');
  assert.match(src, /findFile\)?\(files, "zip", \["pkg", "dmg"\]\)/,
    'the zip requirement is no longer stated this way — re-verify what MacUpdater accepts');
});
