#!/usr/bin/env node
/**
 * assert-release-assets — is the update feed on the published Release actually usable?
 *
 * This replaces an inline grep in release.yml that was correct and macOS-shaped:
 *
 *     echo "$ASSETS" | grep -q 'latest-mac.yml' || exit 1
 *     echo "$ASSETS" | grep -qE '\.dmg$'        || exit 1
 *     WANT=$(grep -m1 '^path:' dist/latest-mac.yml | awk '{print $2}')
 *     echo "$ASSETS" | grep -qx "$WANT"         || exit 1
 *
 * That block caught v0.7.1's phantom zip and is the reason this repo ships updates at all. It
 * is also unusable the moment a second platform exists: run it on Linux and it fails a correct
 * release (there is no latest-mac.yml, no .dmg); teach it to shrug and it guards nothing. And
 * the rule it cannot express is the one v0.7.0 actually broke — that the file the manifest
 * names must be a format THIS platform's updater will accept.
 *
 * All of that judgement lives in src/core/releaseAssets.ts, under test, with v0.7.0 and v0.7.1
 * reproduced as failing cases. This file is only IO: read the manifest, ask GitHub what is
 * attached, print what was measured.
 *
 * Usage:  node scripts/assert-release-assets.mjs --tag v0.8.1 [--platform darwin|linux|win32]
 *         (platform defaults to the host, which is what a per-platform release job wants)
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const tag = arg('tag', process.env.RELEASE_TAG || '');
const platform = arg('platform', process.platform);

if (!tag) {
  console.error('assert-release-assets: ✗ no tag given (--tag v0.0.0 or $RELEASE_TAG)');
  process.exit(1);
}

/* The validator is compiled TypeScript. If out/ is missing, say so — an import failure here
   would otherwise read like a broken script rather than a missing build step. */
const mod = path.resolve('out/core/releaseAssets.js');
if (!fs.existsSync(mod)) {
  console.error('assert-release-assets: ✗ out/core/releaseAssets.js not found — run `npm run compile` first');
  process.exit(1);
}
const { assertReleaseAssets, FEEDS } = await import(`file://${mod}`);

const feed = FEEDS[platform];
if (!feed) {
  console.error(`assert-release-assets: ✗ no feed definition for platform "${platform}" — `
    + 'refusing to report a pass it did not measure');
  process.exit(1);
}

const manifestPath = path.join('dist', feed.manifest);
if (!fs.existsSync(manifestPath)) {
  console.error(`assert-release-assets: ✗ ${manifestPath} was not produced by the build — `
    + `${feed.updater} would have no feed to read`);
  process.exit(1);
}

/* Two modes, same rules.
     --local  validate what the BUILD produced, before anything is published. Failing here means
              a broken release is never created in the first place, which beats deleting one.
     default  validate what is actually ATTACHED to the Release. This is the only mode that can
              catch v0.7.1 — the build produced a correct zip, and the publish step simply did
              not upload it. A local check cannot see that, and a remote check cannot run early.
              Both are needed; neither is redundant. */
const local = process.argv.includes('--local');
let assets;
if (local) {
  assets = fs.readdirSync('dist').filter((f) => fs.statSync(path.join('dist', f)).isFile());
} else {
  try {
    assets = execFileSync('gh', ['release', 'view', tag, '--json', 'assets', '--jq', '.assets[].name'],
      { encoding: 'utf8' }).split('\n').map((s) => s.trim()).filter(Boolean);
  } catch (e) {
    console.error(`assert-release-assets: ✗ could not read release ${tag} — ${e.message}`);
    process.exit(1);
  }
}

const pkgVersion = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
const result = assertReleaseAssets({
  platform, tag, pkgVersion,
  manifestText: fs.readFileSync(manifestPath, 'utf8'),
  assets,
  where: local ? 'present in dist/' : 'attached to the release',
});

console.log(`assert-release-assets: ${platform} · ${tag} · ${feed.updater} · `
  + `${assets.length} ${local ? 'files in dist/ (pre-publish)' : 'assets attached to the Release'}`);
for (const c of result.checks) console.log(`  ✓ ${c}`);
for (const e of result.errors) console.error(`::error::${e}`);

if (!result.ok) {
  console.error(`assert-release-assets: FAILED — ${result.errors.length} problem(s). Do not announce this release.`);
  process.exit(1);
}
console.log('assert-release-assets: the feed on this release is usable');
