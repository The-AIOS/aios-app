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

test('the release workflow validates the feed BEFORE publishing and AFTER attaching', () => {
  /* These two assertions used to pin the inline greps that implemented the check
     (`latest-mac.yml missing`, `grep -q '\.zip' dist/latest-mac.yml`, `grep -m1 '^path:'`).
     They were right about the requirement and wrong to name the mechanism: the rules moved into
     src/core/releaseAssets.ts so a Linux/Windows job could reuse them, and a test pinned to the
     old spelling fails a refactor that strengthens exactly what it was protecting.

     So assert the GUARANTEE instead — both halves must run, because they catch different
     failures and neither substitutes for the other:
       --local   what the BUILD produced   → v0.7.0 (no zip was ever built)
       remote    what was ATTACHED         → v0.7.1 (a correct zip was built, never uploaded)
     The rules themselves are proven in releaseAssets.test.ts, with both releases reproduced. */
  const wf = fs.readFileSync('.github/workflows/release.yml', 'utf8');
  const calls = [...wf.matchAll(/node scripts\/assert-release-assets\.mjs[^\n]*/g)].map((m) => m[0]);
  assert.equal(calls.length, 2,
    `the release path must validate the feed twice (pre-publish + post-publish). Found ${calls.length}`);
  assert.ok(calls.some((c) => c.includes('--local')),
    'one call must run --local, before anything is published — a release never created beats one deleted');
  assert.ok(calls.some((c) => !c.includes('--local')),
    'one call must run against the published Release — only that can see an upload that dropped a file');
  for (const c of calls) {
    assert.match(c, /--platform \w+/, `each call must name its platform explicitly: ${c}`);
    assert.match(c, /--tag "\$RELEASE_TAG"/, `each call must pass the tag being released: ${c}`);
  }
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

test('the release workflow uploads the zip it advertises', () => {
  /* v0.7.1 published a manifest naming AIOS-arm64.zip and never attached it — the third
     variant of one mistake in one evening: the check and the requirement were not the same
     thing. The manifest existed, a .dmg was attached, both gates passed, and every updating
     client would have got a 404. */
  const wf = fs.readFileSync('.github/workflows/release.yml', 'utf8');
  const uploads = [...wf.matchAll(/dist\/\*\.dmg dist\/\*\.dmg\.blockmap dist\/\*\.zip dist\/latest-mac\.yml/g)];
  assert.equal(uploads.length, 2, 'both the create and the fallback upload must include the zip');
  /* The post-publish half — "read the file the MANIFEST names, not a hardcoded extension" — is
     now asserted by the test above and implemented in src/core/releaseAssets.ts, where it is
     proven against the real v0.7.1 asset list rather than against a grep's spelling. */
});
