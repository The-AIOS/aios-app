/** #194: on v0.17.0 the Linux lane reached the gate in the same second the Windows lane published, read "release not found",
 *  and failed its run on a good release. A lane whose read or check fails now looks again, and a release that is public with
 *  every manifest is success. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import { publishedByAnotherLane, REQUIRED_MANIFESTS } from '../core/releaseGate';

const all = [...REQUIRED_MANIFESTS, 'AIOS-arm64.dmg'];

test('public with every manifest: another lane published it, success', () => {
  assert.equal(publishedByAnotherLane({ isDraft: false, assets: all }), true);
});

test('still a draft, missing a manifest, or unreadable: a real failure', () => {
  assert.equal(publishedByAnotherLane({ isDraft: true, assets: all }), false);
  assert.equal(publishedByAnotherLane({ isDraft: false, assets: ['latest-mac.yml', 'latest.yml'] }), false);
  assert.equal(publishedByAnotherLane(null), false);
});

test('wiring: every failure path in the gate looks again before failing the run', () => {
  const src = fs.readFileSync('scripts/release-gate.mjs', 'utf8');
  assert.equal((src.match(/await failUnlessPublishedElsewhere\(/g) || []).length, 3, 'reading, the feed check, and publishing');
  assert.doesNotMatch(src, /process\.exit\(1\);\n\s*\}\n\}\nexecFileSync\('gh', \['release', 'edit'/, 'negative control: the old immediate exit is gone');
});
