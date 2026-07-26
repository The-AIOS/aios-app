#!/usr/bin/env node
// verify-signing.mjs — the verify-BEFORE-publish gate.
//
// Adopted from Block's Buzz release pipeline (github.com/block/buzz, port #3):
// electron-builder
// signs + notarizes, but it will happily publish a build whose signature is
// subtly broken. This asserts the three things that actually matter to a
// non-technical user's first launch, and exits non-zero if any fails — so a
// broken build never reaches a GitHub Release.
//
//   1. codesign --verify --deep --strict  → the signature is valid & complete
//   2. hardened runtime is ON             → notarization prerequisite
//   3. spctl --assess --type execute      → Gatekeeper WILL admit it
//
// Usage:  node scripts/verify-signing.mjs [path/to/AIOS.app]
// With no arg it auto-locates the .app under dist/ (electron-builder output).
// macOS-only (uses codesign/spctl); it is a release tool, not part of the app.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { platform } from 'node:os';

if (platform() !== 'darwin') {
  console.error('verify-signing: macOS only (needs codesign/spctl).');
  process.exit(1);
}

function locateApp() {
  const arg = process.argv[2];
  if (arg) return arg;
  const dist = 'dist';
  if (!existsSync(dist)) fail(`no dist/ — run electron-builder first`);
  // electron-builder emits per-arch dirs: dist/mac-arm64/, dist/mac/, dist/mac-universal/
  const candidates = readdirSync(dist)
    .filter((d) => d === 'mac' || d.startsWith('mac-'))
    .map((d) => join(dist, d, 'AIOS.app'))
    .filter((p) => existsSync(p));
  if (candidates.length === 0) fail(`no AIOS.app found under dist/mac*/`);
  /* AMBIGUITY IS LOUD, never resolved by guessing. `candidates[0]` picked dist/mac/ — a stale
     UNSIGNED x86_64 bundle from an earlier run — while the freshly signed arm64 build sat in
     dist/mac-arm64/. It reported FAILED on a perfectly good release. The mirror case is the
     dangerous one: had the stale bundle been the signed one and the new build broken, this would
     have reported PASSED and cleared a broken artifact for publication. A release gate must never
     choose which artifact to judge. */
  if (candidates.length > 1) {
    fail(`more than one AIOS.app under dist/ — refusing to guess which one you are shipping:\n`
      + candidates.map((c) => `     ${c}`).join('\n')
      + `\n\n   Either pass the one you mean:  node scripts/verify-signing.mjs <path-to-.app>`
      + `\n   or clear the stale ones:        rm -rf dist/mac dist/mac-* && npm run dist`);
  }
  return candidates[0];
}

function run(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * Combined stdout + stderr, whatever the exit code.
 *
 * `codesign -dv` prints its report to STDERR, and execFileSync returns stdout only — so the
 * hardened-runtime check read an empty string on every SUCCESSFUL codesign and dutifully reported
 * "hardened runtime NOT set". It could only pass when codesign FAILED, because the catch branch
 * was the sole place stderr got read. Latent since the day it was written, and invisible until
 * tonight, because it had never once run against a genuinely signed build: the first real
 * signature in this project's life is what exposed it.
 */
function runBoth(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  return (r.stdout || '') + (r.stderr || '');
}

function fail(msg) {
  console.error(`\n❌ verify-signing FAILED: ${msg}\n`);
  process.exit(1);
}

const appPath = locateApp();
console.log(`verify-signing: ${appPath}\n`);

// 1 — signature valid, deep (every nested binary), strict.
try {
  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);
  console.log('✓ codesign --verify --deep --strict');
} catch (e) {
  fail(`codesign --verify: ${e.stderr || e.message}`);
}

// 2 — hardened runtime present (the notarization prerequisite). `codesign -dv`
// prints `flags=0x10000(runtime)` when the hardened runtime is on.
try {
  const info = runBoth('codesign', ['-dv', '--verbose=4', appPath]);
  if (!/runtime/.test(info)) fail('hardened runtime NOT set (no `runtime` flag) — notarization will be rejected');
  console.log('✓ hardened runtime enabled');
} catch (e) {
  fail(`hardened-runtime check: ${e.message}`);
}

// 3 — Gatekeeper assessment: the real "will a downloaded copy open?" test.
try {
  run('spctl', ['--assess', '--type', 'execute', '--verbose=2', appPath]);
  console.log('✓ spctl --assess (Gatekeeper accepts)');
} catch (e) {
  fail(`spctl --assess: ${e.stderr || e.message}\n   (an un-notarized or unsigned app fails here — the Gatekeeper wall a downloaded copy hits.)`);
}

/* 4 — the notarization ticket is STAPLED into the app.
   spctl passes without a staple, because Gatekeeper will ask Apple directly when it can reach
   the network — so an unstapled build looks perfect on the machine that built it and fails for
   the operator opening it on a plane, behind a corporate proxy, or during an Apple outage. The
   staple is what makes the verdict offline-durable, and it is a separate step from notarizing.
   Confirmed against Block's Buzz — the closest precedent in our category, and installed on this
   machine: Developer ID Application, hardened runtime, notarized AND stapled. That is the
   complete shape we are aiming at, so it is the shape we verify. */
try {
  run('xcrun', ['stapler', 'validate', appPath]);
  console.log('✓ notarization ticket stapled (opens offline, first try)');
} catch (e) {
  fail(`stapler validate: ${e.stderr || e.message}\n   (notarized but NOT stapled — Gatekeeper would have to reach Apple on first launch, so this fails offline.)`);
}

console.log('\n✅ verify-signing PASSED — safe to publish.\n');
