/**
 * The release-asset gate, proven against the two failures it exists for.
 *
 * v0.7.0 and v0.7.1 both shipped a manifest that named a file the release did not carry. The
 * checks in place at the time passed. So the first duty of these tests is not to show the
 * validator works on a good release — it is to show it FAILS on those exact two, reconstructed
 * from what was actually published.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { assertReleaseAssets, parseManifest, FEEDS } from '../core/releaseAssets';

/** A real latest-mac.yml, shaped exactly as electron-builder writes it. */
const macManifest = (version: string, target: string, files: string[]) =>
  `version: ${version}\nfiles:\n`
  + files.map((f) => `  - url: ${f}\n    sha512: BASE64==\n    size: 123\n`).join('')
  + `path: ${target}\nsha512: BASE64==\nreleaseDate: '2026-08-12T00:00:00.000Z'\n`;

const linuxManifest = (version: string, target: string, files: string[]) =>
  `version: ${version}\nfiles:\n`
  + files.map((f) => `  - url: ${f}\n    sha512: BASE64==\n    size: 123\n`).join('')
  + `path: ${target}\nsha512: BASE64==\nreleaseDate: '2026-08-12T00:00:00.000Z'\n`;

test('a healthy macOS release passes, and says what it measured', () => {
  const r = assertReleaseAssets({
    platform: 'darwin', tag: 'v0.8.1', pkgVersion: '0.8.1',
    manifestText: macManifest('0.8.1', 'AIOS-arm64.zip', ['AIOS-arm64.zip', 'AIOS-arm64.dmg']),
    assets: ['AIOS-arm64.dmg', 'AIOS-arm64.dmg.blockmap', 'AIOS-arm64.zip', 'latest-mac.yml'],
  });
  assert.deepEqual(r.errors, []);
  assert.ok(r.ok);
  // A gate that prints "OK" teaches nobody anything. It has to show its work.
  assert.ok(r.checks.some((c) => c.includes('AIOS-arm64.zip') && c.includes('attached')));
  assert.ok(r.checks.some((c) => c.includes('MacUpdater')));
});

test('v0.7.0 REPRODUCED: only a dmg was built, so the manifest target is a format MacUpdater refuses', () => {
  /* The actual v0.7.0 release: no .zip existed at all. MacUpdater calls
     findFile(files, 'zip', ['pkg','dmg']) — the dmg is explicitly excluded, so this dies with
     ERR_UPDATER_ZIP_FILE_NOT_FOUND after the pill never appears. */
  const r = assertReleaseAssets({
    platform: 'darwin', tag: 'v0.7.0', pkgVersion: '0.7.0',
    manifestText: macManifest('0.7.0', 'AIOS-arm64.dmg', ['AIOS-arm64.dmg']),
    assets: ['AIOS-arm64.dmg', 'AIOS-arm64.dmg.blockmap', 'latest-mac.yml'],
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /will not download|install-only/.test(e)),
    `expected a format rejection, got: ${r.errors.join(' | ')}`);
});

test('v0.7.1 REPRODUCED: the manifest advertised a zip that was never uploaded', () => {
  /* v0.7.1's first cut. The publish step listed only dmg/blockmap/yml, so latest-mac.yml pointed
     at AIOS-arm64.zip and every updating client got a 404. Asserting "the manifest exists" and
     "some installer is attached" both PASSED on this release. */
  const r = assertReleaseAssets({
    platform: 'darwin', tag: 'v0.7.1', pkgVersion: '0.7.1',
    manifestText: macManifest('0.7.1', 'AIOS-arm64.zip', ['AIOS-arm64.zip', 'AIOS-arm64.dmg']),
    assets: ['AIOS-arm64.dmg', 'AIOS-arm64.dmg.blockmap', 'latest-mac.yml'],   // ← no zip
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('AIOS-arm64.zip') && e.includes('404')),
    `expected the 404 warning, got: ${r.errors.join(' | ')}`);
});

test('a healthy Linux release passes with the AppImage as the update target', () => {
  const r = assertReleaseAssets({
    platform: 'linux', tag: 'v0.9.0', pkgVersion: '0.9.0',
    manifestText: linuxManifest('0.9.0', 'AIOS-x86_64.AppImage', ['AIOS-x86_64.AppImage']),
    assets: ['AIOS-x86_64.AppImage', 'AIOS-amd64.deb', 'latest-linux.yml'],
  });
  assert.deepEqual(r.errors, []);
  assert.ok(r.ok);
});

test('a .deb can ship, but pointing the feed at one is caught — there is no deb updater', () => {
  /* The Linux equivalent of the v0.7.0 bug, and the reason it deserves its own assertion:
     electron-updater has AppImageUpdater and NsisUpdater and no deb updater at all. A release
     whose manifest names the .deb installs fine and then never updates — and says nothing. */
  const r = assertReleaseAssets({
    platform: 'linux', tag: 'v0.9.0', pkgVersion: '0.9.0',
    manifestText: linuxManifest('0.9.0', 'AIOS-amd64.deb', ['AIOS-amd64.deb']),
    assets: ['AIOS-amd64.deb', 'AIOS-x86_64.AppImage', 'latest-linux.yml'],
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('AppImageUpdater') && /will not download|install-only/.test(e)),
    `expected the deb to be rejected as an update channel, got: ${r.errors.join(' | ')}`);
});

test('a tag that disagrees with the built version is caught — the release would advertise a version nobody is on', () => {
  const r = assertReleaseAssets({
    platform: 'darwin', tag: 'v0.8.2', pkgVersion: '0.8.1',
    manifestText: macManifest('0.8.1', 'AIOS-arm64.zip', ['AIOS-arm64.zip', 'AIOS-arm64.dmg']),
    assets: ['AIOS-arm64.dmg', 'AIOS-arm64.zip', 'latest-mac.yml'],
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('v0.8.2') && e.includes('0.8.1')));
});

test('a stale manifest left in dist/ is caught', () => {
  const r = assertReleaseAssets({
    platform: 'darwin', tag: 'v0.8.2', pkgVersion: '0.8.2',
    manifestText: macManifest('0.8.1', 'AIOS-arm64.zip', ['AIOS-arm64.zip', 'AIOS-arm64.dmg']),
    assets: ['AIOS-arm64.dmg', 'AIOS-arm64.zip', 'latest-mac.yml'],
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('stale manifest')));
});

test('a release that can update everyone but install nobody is caught', () => {
  /* Fails quietly in the worst way: every person who could test it already has the app. */
  const r = assertReleaseAssets({
    platform: 'darwin', tag: 'v0.8.1', pkgVersion: '0.8.1',
    manifestText: macManifest('0.8.1', 'AIOS-arm64.zip', ['AIOS-arm64.zip']),
    assets: ['AIOS-arm64.zip', 'latest-mac.yml'],   // ← no dmg
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('nobody new could install')));
});

test('a missing manifest is reported as missing, not as a pass', () => {
  const r = assertReleaseAssets({
    platform: 'darwin', tag: 'v0.8.1', pkgVersion: '0.8.1',
    manifestText: macManifest('0.8.1', 'AIOS-arm64.zip', ['AIOS-arm64.zip', 'AIOS-arm64.dmg']),
    assets: ['AIOS-arm64.dmg', 'AIOS-arm64.zip'],   // ← no latest-mac.yml
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('has no feed to read')));
});

test('an unparseable manifest fails loudly instead of asserting against nothing', () => {
  const r = assertReleaseAssets({
    platform: 'darwin', tag: 'v0.8.1', pkgVersion: '0.8.1',
    manifestText: 'this is not the manifest you are looking for\n',
    assets: ['AIOS-arm64.dmg', 'AIOS-arm64.zip', 'latest-mac.yml'],
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('did not parse')));
});

test('an unknown platform refuses rather than reporting a pass it did not measure', () => {
  const r = assertReleaseAssets({
    // deliberately outside the union — this is what a future `freebsd` target would look like
    platform: 'sunos' as unknown as 'linux', tag: 'v1.0.0', pkgVersion: '1.0.0',
    manifestText: macManifest('1.0.0', 'x.zip', ['x.zip']), assets: ['x.zip'],
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('refusing to report a pass')));
});

test('parseManifest reads only top-level path/version, and decodes percent-encoded urls', () => {
  /* `files[].url` is indented and must not be mistaken for the top-level `path:`; and a
     productName that ever gains a space arrives here as %20, so comparing raw against the
     GitHub asset name would fail on a correct release. */
  const m = parseManifest(macManifest('0.8.1', 'My%20App-arm64.zip', ['My%20App-arm64.zip', 'My%20App-arm64.dmg']));
  assert.equal(m.version, '0.8.1');
  assert.equal(m.path, 'My App-arm64.zip');
  assert.deepEqual(m.urls, ['My App-arm64.zip', 'My App-arm64.dmg']);
});

test('every platform feed names a real updater class and cannot list a format as both updatable and install-only', () => {
  /* The table is the whole gate. A format in both lists would make the two branches contradict
     each other, and whichever ran first would decide — the kind of bug that reads as correct. */
  for (const [platform, feed] of Object.entries(FEEDS)) {
    assert.ok(feed.manifest.endsWith('.yml'), `${platform}: manifest must be a .yml`);
    assert.ok(feed.updatable.length, `${platform}: must declare at least one updatable format`);
    assert.ok(/Updater$/.test(feed.updater), `${platform}: name the electron-updater class`);
    for (const u of feed.updatable) {
      assert.ok(!feed.installOnly.includes(u), `${platform}: ${u} is listed as both updatable and install-only`);
    }
  }
});
