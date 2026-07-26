#!/usr/bin/env node
/**
 * verify-package — does the app we are about to SHIP actually launch?
 *
 * Every gate this repo had could pass while the shipped dmg was dead on arrival. 197 unit
 * tests, `check:tokens` and `npm run smoke` all run against SOURCE, where Electron is
 * node_modules/electron: its bundle is named "Electron", its helpers are "Electron Helper.app",
 * and its Info.plist is upstream's. None of them can observe a PACKAGING mistake.
 *
 * That is not hypothetical. Setting `CFBundleName: "The-AIOS"` in extendInfo — a change that
 * reads purely cosmetic — made every packaged build abort at startup with
 *
 *     FATAL electron_main_delegate_mac.mm:66  Unable to find helper app
 *
 * because Electron derives the helper path from CFBundleName and went looking for
 * "The-AIOS Helper.app" inside a bundle that ships "AIOS Helper.app". Green everywhere,
 * DOA in the operator's hands. So the packaged bundle gets checked as the artifact it is.
 *
 * Two checks, cheapest first:
 *   1. STATIC — CFBundleName must match the helper apps actually present, and all four must
 *      exist and be executable. Instant, deterministic, and would have caught the above.
 *   2. LIVE — run the packaged binary with `--smoke` (the in-app gate) and require a clean
 *      exit. The only check that can prove the shipped artifact runs.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const HELPERS = ['', ' (GPU)', ' (Renderer)', ' (Plugin)'];
const fail = (msg) => { console.error(`verify-package: ✗ ${msg}`); process.exitCode = 1; };
const ok = (msg) => console.log(`verify-package: ✓ ${msg}`);

/** Every packaged .app electron-builder just produced. */
function bundles() {
  const dist = 'dist';
  if (!fs.existsSync(dist)) return [];
  const out = [];
  for (const d of fs.readdirSync(dist)) {
    if (!/^mac/.test(d)) continue;                       // mac-arm64, mac-x64, mac (universal)
    const dir = path.join(dist, d);
    for (const a of fs.readdirSync(dir)) if (a.endsWith('.app')) out.push(path.join(dir, a));
  }
  return out;
}

function plist(app, key) {
  try {
    return execFileSync('defaults', ['read', path.resolve(app, 'Contents/Info.plist'), key],
      { encoding: 'utf8' }).trim();
  } catch { return ''; }
}

function checkStatic(app) {
  const name = plist(app, 'CFBundleName');
  const exe = plist(app, 'CFBundleExecutable');
  if (!name) return fail(`${app}: no CFBundleName`);

  const fw = path.join(app, 'Contents/Frameworks');
  const present = fs.existsSync(fw)
    ? fs.readdirSync(fw).filter((f) => f.endsWith('Helper.app') || /Helper \(/.test(f))
    : [];
  if (!present.length) return fail(`${app}: no helper apps in Contents/Frameworks`);

  // the prefix Electron will build its path from
  const prefix = present[0].replace(/ Helper.*$/, '');
  if (prefix !== name) {
    return fail(`${app}: CFBundleName is "${name}" but the helpers are "${prefix} Helper.app". `
      + `Electron resolves the helper path from CFBundleName, so this build cannot start. `
      + `CFBundleName must equal productName — put an Apple-facing name in the bundle id or `
      + `the App Store listing, never here.`);
  }
  for (const suffix of HELPERS) {
    const n = `${name} Helper${suffix}`;
    const p = path.join(fw, `${n}.app`, 'Contents/MacOS', n);
    try { fs.accessSync(p, fs.constants.X_OK); } catch { return fail(`${app}: missing/unexecutable helper ${n}`); }
  }
  ok(`${path.basename(path.dirname(app))}: CFBundleName "${name}" matches all 4 helpers (exe "${exe}")`);
  return true;
}

/** Run the PACKAGED binary's own smoke gate. */
function checkLive(app) {
  const exe = plist(app, 'CFBundleExecutable') || 'AIOS';
  const bin = path.join(app, 'Contents/MacOS', exe);
  const arch = execFileSync('uname', ['-m'], { encoding: 'utf8' }).trim();
  // an arm64 host cannot execute an x64 bundle's smoke gate without Rosetta; skip honestly
  const isThis = path.dirname(app).includes(arch) || !/mac-(arm64|x64)/.test(path.dirname(app));
  if (!isThis) { console.log(`verify-package: – ${path.basename(path.dirname(app))}: skipped (not ${arch})`); return Promise.resolve(true); }

  return new Promise((resolve) => {
    const p = spawn(bin, ['--smoke'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      // a packaged app must not be handed the dev tree's state
      env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' },
    });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => { p.kill('SIGKILL'); }, 90_000);
    p.on('exit', (code, signal) => {
      clearTimeout(timer);
      const fatal = /FATAL|Unable to find helper app/.test(out);
      if (fatal) {
        fail(`${app}: the packaged app ABORTED at startup:\n    ${out.split('\n').filter(Boolean).slice(-3).join('\n    ')}`);
      } else if (code !== 0) {
        fail(`${app}: packaged --smoke exited ${code}${signal ? ` (${signal})` : ''}:\n    ${out.split('\n').filter(Boolean).slice(-6).join('\n    ')}`);
      } else {
        ok(`${path.basename(path.dirname(app))}: packaged --smoke passed — the shipped artifact launches`);
      }
      resolve(!fatal && code === 0);
    });
    p.on('error', (e) => { clearTimeout(timer); fail(`${app}: could not execute — ${e.message}`); resolve(false); });
  });
}

const apps = bundles();
if (!apps.length) {
  console.error('verify-package: ✗ no packaged .app found under dist/ — run the build first');
  process.exit(1);
}
for (const app of apps) checkStatic(app);
for (const app of apps) await checkLive(app);
console.log(process.exitCode ? 'verify-package: FAILED — do not ship this build' : 'verify-package: all checks passed');
