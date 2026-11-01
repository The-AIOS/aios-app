/**
 * Issue 93: the Linux build must load on Ubuntu 24.04 and older. The packaged gate reads the glibc versions a native
 * module references; these tests prove the reader and the ceiling, and that both Linux build jobs use the old image.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as cp from 'node:child_process';

const probe = (js: string): string =>
  cp.execFileSync(process.execPath, ['--input-type=module', '-e', `import * as g from './scripts/glibc.mjs'; ${js}`], { encoding: 'utf8' }).trim();

test('the reader finds the newest GLIBC_ version a binary references, comparing numerically', () => {
  assert.equal(probe(`console.log(g.maxGlibc(Buffer.from('\\0GLIBC_2.2.5\\0GLIBC_2.34\\0GLIBC_2.9\\0')))`), '2.34',
    '2.34 is newer than 2.9: a string compare would pick 2.9');
  assert.equal(probe(`console.log(g.maxGlibc(Buffer.from('xx GLIBC_2.42 yy GLIBC_2.17')))`), '2.42');
  assert.equal(probe(`console.log(JSON.stringify(g.maxGlibc(Buffer.from('no versions here'))))`), '""');
});

test('the ceiling is Ubuntu 22.04, and 0.13.0\'s binary (GLIBC_2.42) would have been refused', () => {
  assert.equal(probe('console.log(g.GLIBC_CEILING)'), '2.35');
  assert.equal(probe(`console.log(g.cmpVersion('2.42', g.GLIBC_CEILING) > 0)`), 'true');
  assert.equal(probe(`console.log(g.cmpVersion('2.35', g.GLIBC_CEILING) > 0)`), 'false');
});

test('the packaged Linux gate applies the ceiling, and both Linux build jobs run on ubuntu-22.04', () => {
  const v = fs.readFileSync('scripts/verify-package.mjs', 'utf8');
  assert.ok(/maxGlibcOfFile\(n\)/.test(v) && /GLIBC_CEILING\) > 0/.test(v), 'checkStaticLinux must refuse a binary above the ceiling');
  const rel = fs.readFileSync('.github/workflows/release-linux.yml', 'utf8');
  assert.ok(/runs-on: ubuntu-22\.04/.test(rel) && !/runs-on: ubuntu-latest/.test(rel), 'release-linux must not build on ubuntu-latest');
  const ci = fs.readFileSync('.github/workflows/ci.yml', 'utf8');
  assert.ok(/runs-on: ubuntu-22\.04/.test(ci) && /ubuntu-22\.04/.test(ci.slice(0, ci.indexOf('xvfb-run'))), 'the CI Linux build must use the release image');
});
