#!/usr/bin/env node
/**
 * Is the tarball the thing we mean to publish? Runs on every pull request, so the artifact is
 * proven long before a version tag exists.
 *
 *   1. `npm pack` (which builds first, through `prepack`) into a temp folder.
 *   2. The file list is EXACTLY: one .js, .d.ts and .js.map per module in src/, every file the
 *      cases lock names, and package.json, README.md, LICENSE, cases.lock.json. A module that did
 *      not compile, a cases file that was not synced, and a stray test or source file are all the
 *      same failure: the list is not the list.
 *   3. Unpacked the way a consumer would have it (node_modules/@the-aios/core), every module loads
 *      by the name a surface imports it by, and every cases file resolves.
 *
 * Prints the tarball path last, so a surface can be tried against it before anything is published:
 *   node scripts/pack-check.mjs --keep     →  …/the-aios-core-<version>.tgz
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const KEEP = process.argv.includes('--keep');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(readFileSync(join(root, 'cases.lock.json'), 'utf8'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const fail = (msg) => { console.error(`pack-check ✗ ${msg}`); process.exit(1); };

/* realpath: on macOS the temp folder is reached through a symlink, and node resolves modules to
   their real path, so the comparison below has to be made on the real one. */
const out = realpathSync(mkdtempSync(join(tmpdir(), 'aios-core-pack-')));
const packed = JSON.parse(execFileSync(npm, ['pack', '--json', '--pack-destination', out], { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' }));
const tgz = join(out, packed[0].filename);
const got = packed[0].files.map((f) => f.path).sort();

const modules = readdirSync(join(root, 'src')).filter((f) => f.endsWith('.ts')).map((f) => f.slice(0, -3)).sort();
if (!modules.length) fail('no modules in src/');
const want = [
  'LICENSE', 'README.md', 'cases.lock.json', 'package.json',
  ...lock.files.map((f) => `cases/${f.to}`),
  ...modules.flatMap((m) => [`dist/${m}.js`, `dist/${m}.d.ts`, `dist/${m}.js.map`]),
].sort();

const missing = want.filter((f) => !got.includes(f));
const extra = got.filter((f) => !want.includes(f));
if (missing.length || extra.length) {
  fail(`the tarball is not what the package declares.\n  missing: ${missing.join(', ') || '(none)'}\n  not expected: ${extra.join(', ') || '(none)'}`);
}

/* Load it as a consumer does. A separate folder with its own node_modules, so nothing resolves to
   the working tree by accident. */
const home = join(out, 'consumer');
const dest = join(home, 'node_modules', ...pkg.name.split('/'));
mkdirSync(dest, { recursive: true });
execFileSync('tar', ['-xzf', tgz, '-C', dest, '--strip-components=1']);
writeFileSync(join(home, 'package.json'), '{"name":"consumer","private":true}\n');
const req = createRequire(join(home, 'index.js'));
for (const m of modules) {
  let mod;
  try { mod = req(`${pkg.name}/${m}`); } catch (e) { fail(`${pkg.name}/${m} does not load from the tarball: ${e.message}`); }
  if (!req.resolve(`${pkg.name}/${m}`).startsWith(dest)) fail(`${pkg.name}/${m} resolved outside the unpacked tarball`);
  if (!mod || typeof mod !== 'object') fail(`${pkg.name}/${m} exports nothing`);
  if (!existsSync(join(dest, 'dist', `${m}.d.ts`))) fail(`${m} has no type declarations`);
}
for (const f of lock.files) {
  try { JSON.parse(readFileSync(req.resolve(`${pkg.name}/cases/${f.to}`), 'utf8')); }
  catch (e) { fail(`${pkg.name}/cases/${f.to} does not resolve from the tarball: ${e.message}`); }
}
if (req(`${pkg.name}/package.json`).version !== pkg.version) fail('the tarball carries a different version than package.json');

console.log(`pack-check ✓ ${pkg.name}@${pkg.version}: ${got.length} files, ${modules.length} modules load, ${lock.files.length} cases file(s) resolve`);
if (KEEP) console.log(tgz);
else rmSync(out, { recursive: true, force: true });
