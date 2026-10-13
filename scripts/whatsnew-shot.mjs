#!/usr/bin/env node
/**
 * whatsnew-shot — the LAST step before an App tag (operator rule, 0.11.0): render the What's New tab in
 * the real App, at the exact commit about to be tagged, in an isolated copy (synthetic home, bus off),
 * and save a screenshot plus the text for the operator to approve. 0.11.0 was tagged with What's New
 * describing features the operator's own test rounds had removed or renamed; it was caught only
 * because the release gate held the draft.
 *
 * Usage:  npm run whatsnew:shot            → ~/Downloads/AIOS-<version>-whats-new-<n>.png + .txt
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-whatsnew-'));
const home = path.join(work, 'home');
execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'demo.mjs'), '--build-only', '--out', home], { stdio: 'ignore' });
const PORT = 9336;
const electron = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
const app = spawn(electron, ['.', `--user-data-dir=${path.join(work, 'ud')}`, '--use-mock-keychain', `--remote-debugging-port=${PORT}`], {
  cwd: ROOT, stdio: 'ignore',
  env: { ...process.env, HOME: home, USERPROFILE: home, AIOS_BUS_DISABLED: '1', GLASS_FRAMEWORK_PATH: path.join(home, 'aios') },
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  let page;
  for (let i = 0; i < 60 && !page; i++) { try { page = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page' && /index\.html/.test(t.url)); } catch { /* not up yet */ } if (!page) await sleep(500); }
  if (!page) throw new Error('the App did not come up');
  const ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const call = (method, params = {}) => new Promise((res) => { const my = ++id; ws.addEventListener('message', function h(m) { const d = JSON.parse(m.data); if (d.id === my) { ws.removeEventListener('message', h); res(d.result); } }); ws.send(JSON.stringify({ id: my, method, params })); });
  await sleep(3000);
  await call('Runtime.evaluate', { expression: 'openWhatsNewTab()', awaitPromise: true });
  await sleep(1500);
  // The tab scrolls inside its own pane, so capture it page by page from the heading's scroll container.
    // What's New is `.tool.home` > .tbig + .tsub + .wngrid + .wnfoot (renderer/app.js openWhatsNewTab).
  const FIND = `(() => { const g = [...document.querySelectorAll('.wngrid')].find((e) => e.offsetParent); if (!g) return null; const h = g.parentElement; let c = h; while (c && c.scrollHeight <= c.clientHeight + 4) c = c.parentElement; return { h, c: c || document.scrollingElement }; })()`;
  const info = await call('Runtime.evaluate', { expression: `(() => { const r = ${FIND}; if (!r) return null; r.c.scrollTop = 0; return { text: r.h.innerText, pages: Math.ceil(r.c.scrollHeight / r.c.clientHeight) }; })()`, returnByValue: true });
  const v = info?.result?.value;
  if (!v) throw new Error("the What's New tab did not render a heading");
  const out = path.join(os.homedir(), 'Downloads', `AIOS-${version}-whats-new`);
  fs.writeFileSync(out + '.txt', v.text);
  for (let p = 0; p < Math.min(v.pages, 8); p++) {
    await call('Runtime.evaluate', { expression: `(() => { const r = ${FIND}; r.c.scrollTop = ${p} * r.c.clientHeight; })()` });
    await sleep(300);
    const shot = await call('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(`${out}-${p + 1}.png`, Buffer.from(shot.data, 'base64'));
  }
  console.log(`whatsnew-shot: ${out}-*.png (${Math.min(v.pages, 8)} page(s)) and .txt — show these to the operator; tag only after their yes.`);
  ws.close();
} finally { app.kill(); fs.rmSync(work, { recursive: true, force: true }); }
