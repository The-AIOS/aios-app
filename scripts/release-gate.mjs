#!/usr/bin/env node
/**
 * release-gate — publish the draft Release only when all three platform feeds are attached.
 * Run as the LAST step of every release lane; whichever lane completes the set publishes.
 * The decision is src/core/releaseGate.ts (tested); this only reads the Release and acts.
 *
 * Usage: node scripts/release-gate.mjs --tag v0.11.0      (needs `npm run compile` and GH_TOKEN)
 * Exit 0 = published, already public, or waiting for another lane · 1 = could not read/publish.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';

const i = process.argv.indexOf('--tag');
const tag = (i !== -1 && process.argv[i + 1]) || process.env.RELEASE_TAG || '';
if (!tag) { console.error('release-gate: ✗ no tag (--tag or $RELEASE_TAG)'); process.exit(1); }
const { gateDecision, publishedByAnotherLane } = createRequire(import.meta.url)(path.resolve('out/core/releaseGate.js'));

const read = () => JSON.parse(execFileSync('gh', ['release', 'view', tag, '--json', 'isDraft,assets'], { encoding: 'utf8' }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/* #194: a failure may be the other lane publishing in the same second. Read again a few times; if the release is now public
   with every manifest, the other lane published it, and this lane succeeded. */
async function failUnlessPublishedElsewhere(message) {
  for (let i = 0; i < 4; i++) {
    await sleep(5000);
    let rel = null;
    try { rel = read(); } catch { /* still not readable */ }
    if (publishedByAnotherLane(rel ? { isDraft: !!rel.isDraft, assets: (rel.assets || []).map((a) => a.name) } : null)) {
      console.log(`release-gate: ${tag} was published by another lane while this one checked — nothing to do`);
      process.exit(0);
    }
  }
  console.error(message); process.exit(1);
}

let rel;
try {
  rel = read();
} catch (e) {
  await failUnlessPublishedElsewhere(`release-gate: ✗ cannot read release ${tag}: ${e.message}`);
}
const d = gateDecision({ isDraft: !!rel.isDraft, assets: (rel.assets || []).map((a) => a.name) });
if (d.do === 'already-public') { console.log(`release-gate: ${tag} is already public — nothing to do`); process.exit(0); }
if (d.do === 'wait') {
  console.log(`release-gate: ${tag} stays a DRAFT — still missing ${d.missing.join(', ')} (another lane may still be running; nobody's updater sees a draft)`);
  process.exit(0);
}
/* PRESENT IS NOT USABLE (0.11.0 review blocker). A lane can upload its files and THEN fail its own
   "feed is usable" check — and the next lane would see three manifests and publish a release whose
   Windows or Linux feed breaks every updater on that platform. So before anything goes public,
   every platform's feed is checked against the draft with the same rules each lane uses. */
for (const platform of ['darwin', 'win32', 'linux']) {
  try {
    execFileSync('node', ['scripts/assert-release-assets.mjs', '--tag', tag, '--platform', platform], { stdio: 'inherit' });
  } catch {
    await failUnlessPublishedElsewhere(`release-gate: ✗ ${tag} stays a DRAFT — the ${platform} feed on it is not usable; fix and re-run that lane`);
  }
}
try {
  execFileSync('gh', ['release', 'edit', tag, '--draft=false', '--latest'], { stdio: 'inherit' });
} catch {
  await failUnlessPublishedElsewhere(`release-gate: ✗ could not publish ${tag}`);
}
console.log(`release-gate: ✓ ${tag} published — all three platform feeds are attached and usable`);
