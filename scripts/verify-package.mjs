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

/** Every packaged Linux tree electron-builder just produced (linux-unpacked, linux-arm64-unpacked…). */
function linuxTrees() {
  const dist = 'dist';
  if (!fs.existsSync(dist)) return [];
  return fs.readdirSync(dist)
    .filter((d) => /^linux.*-unpacked$/.test(d))
    .map((d) => path.join(dist, d))
    .filter((d) => fs.statSync(d).isDirectory());
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

/* ── Linux ─────────────────────────────────────────────────────────────────────────────────
   Same contract as the mac path, different artifact. There is no Info.plist and no helper
   quartet on Linux — one ELF binary plus resources/ — so the STATIC check re-aims at the
   failure this platform actually has:

   node-pty is the only native module here, and it ships NO Linux prebuild (upstream publishes
   darwin-* and win32-* only, which is why the pty e2e test skips off macOS). The Linux binary
   therefore exists solely because `npm run rebuild` compiled it. Build the Linux target on a
   machine that skipped that step — or cross-build from macOS — and electron-builder happily
   packages a tree whose only .node files are Mach-O. Nothing else notices: the app boots, the
   window paints, the menu works, and EVERY terminal is dead on arrival. That is this
   platform's CFBundleName bug — cosmetic-looking, green everywhere, DOA in the operator's
   hands — so it gets the same treatment: check the shipped artifact, by magic number. */
const MAGIC = { '7f454c46': 'ELF', cffaedfe: 'Mach-O', cafebabe: 'Mach-O (fat)', '4d5a9000': 'PE/DLL' };
const magicOf = (f) => {
  try {
    const fd = fs.openSync(f, 'r'); const b = Buffer.alloc(4);
    fs.readSync(fd, b, 0, 4, 0); fs.closeSync(fd);
    return MAGIC[b.toString('hex')] ?? `unknown(${b.toString('hex')})`;
  } catch { return 'unreadable'; }
};

function linuxExe(tree) {
  // electron-builder names the executable after package.json `name` unless executableName is
  // set. Resolve it from the artifact rather than assuming, so a later rename cannot make this
  // check silently pass by looking for a file that no longer exists.
  const skip = /^(chrome-sandbox|chrome_crashpad_handler)$/;
  const found = fs.readdirSync(tree).filter((f) => {
    if (skip.test(f) || f.includes('.')) return false;
    const p = path.join(tree, f);
    try { return fs.statSync(p).isFile() && magicOf(p) === 'ELF'; } catch { return false; }
  });
  return found.length ? path.join(tree, found[0]) : '';
}

function checkStaticLinux(tree) {
  const label = path.basename(tree);
  const bin = linuxExe(tree);
  if (!bin) return fail(`${label}: no ELF executable at the tree root`);
  try { fs.accessSync(bin, fs.constants.X_OK); } catch { return fail(`${label}: ${path.basename(bin)} is not executable`); }

  const asar = path.join(tree, 'resources', 'app.asar');
  if (!fs.existsSync(asar)) return fail(`${label}: no resources/app.asar`);

  // node-pty must be present as a LINUX binary. It is asarUnpack'd, so it is a real file.
  const ptyRoot = path.join(tree, 'resources/app.asar.unpacked/node_modules/node-pty');
  if (!fs.existsSync(ptyRoot)) return fail(`${label}: node-pty was not unpacked from the asar`);
  const nodes = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else if (e.name.endsWith('.node')) nodes.push(p);
    }
  };
  walk(ptyRoot);
  if (!nodes.length) return fail(`${label}: node-pty shipped with no .node binary at all`);
  const elf = nodes.filter((n) => magicOf(n) === 'ELF');
  if (!elf.length) {
    const kinds = [...new Set(nodes.map(magicOf))].join(', ');
    return fail(`${label}: node-pty ships ${nodes.length} .node file(s) but NONE is ELF (found: ${kinds}). `
      + `Every terminal in this build would fail to open. Run \`npm run rebuild\` on a Linux host `
      + `before packaging — node-pty publishes no Linux prebuild, so the binary only exists if it was compiled here.`);
  }

  ok(`${label}: ${path.basename(bin)} is ELF+executable, app.asar present, node-pty has ${elf.length} ELF binary(ies)`);
  return true;
}

function checkLiveLinux(tree) {
  const label = path.basename(tree);
  const bin = linuxExe(tree);
  if (!bin) return Promise.resolve(false);

  /* chrome-sandbox must be root-owned mode 4755 to be usable. electron-builder cannot set that
     (the build does not run as root), so an UNINSTALLED tree always fails closed with
     "The SUID sandbox helper binary was found, but is not configured correctly". That is a
     property of the unpacked dir, not of the build — the .deb's postinst and the AppImage
     runtime both handle it — so drop the sandbox for this gate and say so rather than
     reporting a packaging failure that is not one. */
  const sb = path.join(tree, 'chrome-sandbox');
  let suid = false;
  try { const st = fs.statSync(sb); suid = st.uid === 0 && (st.mode & 0o4000) !== 0; } catch { /* absent */ }
  const args = ['--smoke', ...(suid ? [] : ['--no-sandbox'])];

  return new Promise((resolve) => {
    const p = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' },
    });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => { p.kill('SIGKILL'); }, 90_000);
    p.on('exit', (code, signal) => {
      clearTimeout(timer);
      const fatal = /FATAL|Trace\/breakpoint trap/.test(out);
      if (fatal) {
        fail(`${label}: the packaged app ABORTED at startup:\n    ${out.split('\n').filter(Boolean).slice(-3).join('\n    ')}`);
      } else if (code !== 0) {
        fail(`${label}: packaged --smoke exited ${code}${signal ? ` (${signal})` : ''}:\n    ${out.split('\n').filter(Boolean).slice(-6).join('\n    ')}`);
      } else {
        ok(`${label}: packaged --smoke passed${suid ? '' : ' (--no-sandbox: chrome-sandbox not SUID in an unpacked tree)'} — the shipped artifact launches`);
      }
      resolve(!fatal && code === 0);
    });
    p.on('error', (e) => { clearTimeout(timer); fail(`${label}: could not execute — ${e.message}`); resolve(false); });
  });
}

/* Dispatch on the host, and REFUSE to no-op silently on anything else. A verifier that prints
   nothing and exits 0 on an unrecognised platform is indistinguishable from one that checked
   everything and found it clean — the build would then ship on the strength of a gate that
   never ran. */
if (process.platform === 'darwin') {
  const apps = bundles();
  if (!apps.length) {
    console.error('verify-package: ✗ no packaged .app found under dist/ — run the build first');
    process.exit(1);
  }
  for (const app of apps) checkStatic(app);
  for (const app of apps) await checkLive(app);
} else if (process.platform === 'linux') {
  const trees = linuxTrees();
  if (!trees.length) {
    console.error('verify-package: ✗ no linux*-unpacked tree found under dist/ — run the build first');
    process.exit(1);
  }
  for (const t of trees) checkStaticLinux(t);
  for (const t of trees) await checkLiveLinux(t);
} else {
  console.error(`verify-package: ✗ no verifier for platform "${process.platform}" — refusing to report a pass it did not measure`);
  process.exit(1);
}
console.log(process.exitCode ? 'verify-package: FAILED — do not ship this build' : 'verify-package: all checks passed');
