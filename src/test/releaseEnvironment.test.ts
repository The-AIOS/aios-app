/**
 * The signing and publish secrets live in the `release` environment, never as repository secrets (RELEASING.md,
 * "Why an environment"). Anyone with write access can push a branch, and a workflow on that branch can read every
 * repository secret; an environment secret reaches only a job that names the environment, which admits main and v*
 * tags after the owner approves the run. These tests keep every job that reads a secret inside it, including a job
 * added later, and keep the four release lanes inside it whether or not they read one today.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const DIR = '.github/workflows';

/** Each job's text, keyed `<file>:<job>`: from its `  <id>:` line under `jobs:` to the next one. */
function jobs(): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of fs.readdirSync(DIR).filter((n) => /\.ya?ml$/.test(n))) {
    const text = fs.readFileSync(path.join(DIR, f), 'utf8');
    const body = text.slice(text.indexOf('\njobs:\n') + 1);
    const heads = [...body.matchAll(/^ {2}([A-Za-z0-9_-]+):\s*$/gm)];
    heads.forEach((m, i) => out.set(`${f}:${m[1]}`, body.slice(m.index, heads[i + 1]?.index ?? body.length)));
  }
  return out;
}

const inRelease = (job: string): boolean => /^ {4}environment: release\s*$/m.test(job);

test('the job splitter finds every job, so the rule below cannot pass by reading nothing', () => {
  const all = jobs();
  for (const k of ['release.yml:release', 'release-linux.yml:linux', 'release-windows.yml:windows', 'canary.yml:canary', 'ci.yml:unit']) {
    assert.ok(all.has(k), `${k} is found`);
  }
  assert.ok(/secrets\.MAC_CSC_LINK/.test(all.get('release.yml:release') ?? ''), 'and a job\'s text includes its steps');
});

test('every job that reads a secret runs in the release environment', () => {
  const readers = [...jobs()].filter(([, j]) => /secrets\.(?!GITHUB_TOKEN\b)[A-Z_]+/.test(j));
  assert.ok(readers.length >= 3, 'the signing lanes read secrets');
  for (const [k, j] of readers) assert.ok(inRelease(j), `${k} reads a secret outside the release environment`);
});

test('the four release lanes run in the release environment, Linux included, so no lane publishes unapproved', () => {
  const all = jobs();
  for (const k of ['release.yml:release', 'release-linux.yml:linux', 'release-windows.yml:windows', 'canary.yml:canary']) {
    assert.ok(inRelease(all.get(k) ?? ''), `${k} names environment: release`);
  }
});

test('the rule fails a job that reads a secret without the environment (control)', () => {
  const bare = '  sneaky:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo "$X"\n        env:\n          X: ${{ secrets.APPLE_ID }}\n';
  assert.ok(/secrets\.(?!GITHUB_TOKEN\b)[A-Z_]+/.test(bare) && !inRelease(bare));
  assert.ok(inRelease(bare.replace('    runs-on:', '    environment: release\n    runs-on:')));
});
