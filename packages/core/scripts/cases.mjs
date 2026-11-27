#!/usr/bin/env node
/**
 * The framework's cases files, as this package carries them.
 *
 * The framework (The-AIOS/aios) owns the files: the spawn-inbox conformance cases, and whatever
 * else it publishes for its surfaces to agree on. Its own tests are bash and Python and read them
 * in place. This package ships a copy so the App and Glass read the same bytes — and a copy that
 * a person edits is the drift this package exists to end. So nobody edits one:
 *
 *   cases.lock.json   names a commit of the framework, and for each file its path there, its name
 *                     here, and its sha256
 *   cases/            holds exactly those files, written by `sync` and by nothing else
 *
 *   node scripts/cases.mjs sync     fetch every locked file at the locked commit, verify, write
 *   node scripts/cases.mjs check    fetch again and compare with what is on disk; write nothing
 *
 * `check` runs in CI. It fails on a file that differs from the framework's at the locked commit,
 * on a locked file that is missing, and on a file in cases/ the lock does not name — an extra file
 * would ship in the tarball without anything saying where it came from.
 *
 * To move to a newer framework commit: change `commit` (and the sha256 of each file that changed,
 * which `sync --print` reports), run `sync`, and bump the package version. It is a deliberate
 * change with a diff a reviewer can read, never a side effect.
 *
 * AIOS_FRAMEWORK_SRC=<a checkout of the framework> reads the commit from that clone with
 * `git show` instead of the network, for working offline. The commit must exist there.
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const casesDir = join(root, 'cases');
const mode = process.argv[2];
const PRINT = process.argv.includes('--print');

if (mode !== 'sync' && mode !== 'check') {
  console.error('usage: node scripts/cases.mjs sync [--print] | check');
  process.exit(2);
}

const lock = JSON.parse(readFileSync(join(root, 'cases.lock.json'), 'utf8'));
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function problem(msg) { console.error(`  ✗ ${msg}`); process.exitCode = 1; }

/* The lock is hand-written, so read it defensively: a `to` that walks out of cases/ would let a
   sync write anywhere, and a commit that is not a full sha would resolve to a moving branch. */
function validLock() {
  let ok = true;
  const bad = (m) => { problem(`cases.lock.json: ${m}`); ok = false; };
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(lock.repo))) bad('`repo` must be owner/name');
  if (!/^[0-9a-f]{40}$/.test(String(lock.commit))) bad('`commit` must be a full 40-character sha, never a branch or a tag');
  if (!Array.isArray(lock.files)) { bad('`files` must be a list'); return false; }
  const seen = new Set();
  for (const f of lock.files) {
    if (!f || typeof f.from !== 'string' || typeof f.to !== 'string' || typeof f.sha256 !== 'string') { bad('each file needs `from`, `to` and `sha256`'); continue; }
    if (!/^[A-Za-z0-9_.-]+$/.test(f.to) || f.to.startsWith('.')) bad(`\`to\` must be a plain file name: ${f.to}`);
    if (f.from.startsWith('/') || f.from.split('/').includes('..')) bad(`\`from\` must be a path inside the framework: ${f.from}`);
    if (!/^[0-9a-f]{64}$/.test(f.sha256)) bad(`\`sha256\` of ${f.to} must be 64 hex characters`);
    if (seen.has(f.to)) bad(`two files are written as ${f.to}`);
    seen.add(f.to);
  }
  return ok;
}

async function fetchFile(from) {
  const local = process.env.AIOS_FRAMEWORK_SRC;
  if (local) return execFileSync('git', ['-C', local, 'show', `${lock.commit}:${from}`], { maxBuffer: 64 * 1024 * 1024 });
  const url = `https://raw.githubusercontent.com/${lock.repo}/${lock.commit}/${from.split('/').map(encodeURIComponent).join('/')}`;
  const res = await fetch(url, { redirect: 'error' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

if (!validLock()) process.exit(1);

console.log(`cases: ${lock.repo} @ ${lock.commit.slice(0, 12)}${process.env.AIOS_FRAMEWORK_SRC ? ' (from AIOS_FRAMEWORK_SRC)' : ''}`);
if (mode === 'sync') mkdirSync(casesDir, { recursive: true });

for (const f of lock.files) {
  let buf;
  try { buf = await fetchFile(f.from); }
  catch (e) { problem(`${f.to}: could not read ${f.from} at the locked commit (${String(e.message || e).split('\n')[0]})`); continue; }
  const got = sha256(buf);
  if (PRINT) console.log(`  ${f.to}  sha256 ${got}`);
  if (got !== f.sha256) {
    problem(`${f.to}: the framework's file at the locked commit is ${got.slice(0, 12)}…, the lock says ${f.sha256.slice(0, 12)}…`);
    continue;
  }
  const dst = join(casesDir, f.to);
  if (mode === 'sync') {
    writeFileSync(dst, buf);
    console.log(`  ✓ ${f.to} written`);
  } else if (!existsSync(dst)) {
    problem(`${f.to}: locked, but not in cases/ — run \`npm run cases:sync\``);
  } else if (sha256(readFileSync(dst)) !== f.sha256) {
    problem(`${f.to}: cases/${f.to} differs from the framework's file. It is never edited by hand — run \`npm run cases:sync\`, or change the lock`);
  } else {
    console.log(`  ✓ ${f.to} matches`);
  }
}

const named = new Set(lock.files.map((f) => f.to));
for (const name of existsSync(casesDir) ? readdirSync(casesDir) : []) {
  if (!named.has(name)) problem(`cases/${name} is not named in cases.lock.json — everything in cases/ ships, so everything in it has to say where it came from`);
}

if (process.exitCode) { console.error(`\ncases:${mode} failed`); }
else console.log(`cases:${mode} ✓ ${lock.files.length} file(s)`);
