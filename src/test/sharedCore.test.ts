/**
 * The App runs the shared package from this repository, at the version this repository holds.
 *
 * `@the-aios/core` is a workspace (packages/core) and a dependency at an exact version. npm links
 * the workspace only while that version is the workspace's own. Bump packages/core and forget the
 * dependency, and once the older version is on the registry npm can install THAT in its place:
 * the package's tests then pass against the new source while the App runs, and ships, the
 * published old one. Nothing else would say so, because both have a dist/.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.join(__dirname, '..', '..');
const json = (rel: string) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

test('the App depends on exactly the version of the shared package this repository holds', () => {
  const app = json('package.json');
  const core = json('packages/core/package.json');
  assert.equal(core.name, '@the-aios/core');
  assert.deepEqual(app.workspaces, ['packages/core']);
  assert.match(core.version, /^\d+\.\d+\.\d+$/, 'a plain version');
  assert.equal(app.dependencies['@the-aios/core'], core.version,
    'bump the dependency with the package, and run npm install so the lockfile follows');
});

test('the lockfile links the workspace, and never a copy from the registry', () => {
  const lock = json('package-lock.json');
  const core = json('packages/core/package.json');
  const linked = lock.packages['node_modules/@the-aios/core'];
  assert.ok(linked, 'the lockfile must know the package');
  assert.equal(linked.link, true, 'it must be a link to the workspace');
  assert.equal(linked.resolved, 'packages/core');
  assert.equal(lock.packages['packages/core'].version, core.version, 'the lockfile is stale: run npm install');
  assert.equal(lock.packages[''].dependencies['@the-aios/core'], core.version);
});
