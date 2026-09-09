#!/usr/bin/env node
/**
 * The what's-new copy must describe THIS release.
 *
 * WHY A SEPARATE CHECK AND NOT JUST THE UNIT TEST. The suite already asserts that
 * `whatsnew.for` equals package.json's version, and that runs on every PR and on every tag —
 * so a version bump cannot ship without SOMEONE editing the locale files. But that proves a
 * stamp was bumped, not that the prose was rewritten, and the failure mode this guards is
 * precisely a confident lie: 0.9.4 shipping 0.9.3's notes is worse than shipping no notes,
 * because the operator reads it and believes it.
 *
 * The only machine-checkable version of "the notes were rewritten" is that they DIFFER from the
 * ones the previous release shipped. That needs git history, which a unit test has no business
 * reading — hence a script, run in CI where the history is there.
 *
 * WHAT IT CANNOT DO, stated so nobody trusts it further than it goes: it cannot tell whether the
 * new prose is ACCURATE. It only refuses a release whose notes are byte-identical to the last
 * one's. Judgement stays with the person cutting; this removes the case where nobody looked.
 *
 * Usage: node scripts/check-whatsnew.mjs [--against <git-ref>]
 * Exit 0 = fine · 1 = the release would carry stale or mismatched notes.
 *
 * `--against` overrides which ref counts as "the previous release". CI does not need it — the
 * newest tag is the right answer there — but it is what makes the stale-prose branch TESTABLE
 * before the release that first exercises it. Without it, the interesting half of this script
 * would sit unproven until the second release after it was written, which is how a check that
 * cannot fail gets shipped believing it works.
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const LOCALES = ['en', 'es', 'pt-br'];
const BODY_KEYS = ['whatsnew.sub', 'whatsnew.h1', 'whatsnew.b1', 'whatsnew.h2', 'whatsnew.b2',
  'whatsnew.h3', 'whatsnew.b3'];
const fail = (m) => { console.error('check:whatsnew ✗ ' + m); process.exit(1); };
const ok = (m) => console.log('check:whatsnew ✓ ' + m);

const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const localePath = (l) => `src/i18n/locales/${l}.json`;
const current = Object.fromEntries(LOCALES.map((l) => [l, JSON.parse(readFileSync(localePath(l), 'utf8'))]));

/* 1 · The stamp has to name this version, in every language. Duplicated from the unit suite on
   purpose: this script is what the RELEASE path runs, and a gate that depends on another gate
   having been wired is one indirection away from not existing. */
for (const l of LOCALES) {
  const got = current[l]['whatsnew.for'];
  if (!got) fail(`${l}: no whatsnew.for — the copy does not say which release it describes`);
  if (got !== version) {
    fail(`${l}: the copy is written for ${got} but package.json says ${version}.\n`
      + `    Rewrite the what's-new copy for ${version} and set whatsnew.for to match.`);
  }
}

/* 2 · Find what the PREVIOUS release shipped. No tags at all means this is the first release and
   there is nothing to be stale against. */
let prevTag = '';
const argAt = process.argv.indexOf('--against');
if (argAt > 0 && process.argv[argAt + 1]) prevTag = process.argv[argAt + 1];
try {
  if (prevTag) throw new Error('explicit ref given');
  const tags = execFileSync('git', ['tag', '--sort=-v:refname'], { encoding: 'utf8' })
    .split('\n').map((t) => t.trim()).filter(Boolean)
    .filter((t) => t !== `v${version}`);
  prevTag = tags[0] || '';
} catch { /* no git, or no tags — fall through to the pass below */ }
if (!prevTag) { ok(`no previous tag to compare against — copy is stamped for ${version}`); process.exit(0); }

let prev = null;
try {
  prev = JSON.parse(execFileSync('git', ['show', `${prevTag}:${localePath('en')}`], { encoding: 'utf8' }));
} catch {
  /* The file did not exist at that tag (this feature is newer than the previous release). Nothing
     to compare, and that is the normal case for exactly one release. */
  ok(`${prevTag} shipped before the what's-new copy existed — nothing to compare`);
  process.exit(0);
}

/* 3 · Identical prose across a version bump is the failure. Compared on English only: it is the
   source language every translation is written from, so if it moved, the notes were revisited. */
const unchanged = BODY_KEYS.every((k) => (prev[k] ?? null) === (current.en[k] ?? null));
const hadCopy = BODY_KEYS.some((k) => prev[k]);
if (hadCopy && unchanged) {
  fail(`the what's-new copy is byte-identical to ${prevTag}'s, but this is ${version}.\n`
    + `    whatsnew.for was bumped without the notes being rewritten — which ships ${prevTag}'s\n`
    + `    news under a new version number. Rewrite ${BODY_KEYS.join(', ')} in all three locales.`);
}
ok(hadCopy
  ? `copy is stamped for ${version} and differs from ${prevTag}'s`
  : `copy is stamped for ${version}; ${prevTag} shipped no what's-new copy, so nothing to be stale against`);
