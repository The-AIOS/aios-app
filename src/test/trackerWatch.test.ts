/**
 * /aios:update writes `.aios-update` with `sed -i`, which REPLACES the file. A watch on the file
 * follows the old one: it fires once and never again. So the second /aios:update in one App
 * session left the header on "update available" until the focus re-check or the 5-minute poll
 * (reported 2026-09-22 — measured: three `sed -i` writes, one event).
 *
 * This runs the real wireWatchers against a temp framework root and replaces the tracker three
 * times, the way sed does (write a new file, rename it over the old). Each replace must reach the
 * update check. It fails against the file watch it replaced.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('every /aios:update is seen, not only the first — the tracker is replaced, not edited', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-fw-'));
  const tracker = path.join(root, '.aios-update');
  fs.writeFileSync(tracker, 'repo=x\nhash=a\n');
  const replace = (h: string) => {                         // what `sed -i` does
    const tmp = path.join(root, '.aios-update.tmp');
    fs.writeFileSync(tmp, `repo=x\nhash=${h}\n`);
    fs.renameSync(tmp, tracker);
  };

  const Module = require('module') as { _load(r: string, p: unknown, m: boolean): unknown };
  const orig = Module._load;
  const electron = { BrowserWindow: { fromWebContents: () => null }, nativeImage: { createFromDataURL: () => ({}) },
    app: { setBadgeCount: () => { /* */ } }, Notification: Object.assign(class { on() { return this; } show() { /* */ } }, { isSupported: () => false }) };
  Module._load = function (this: unknown, r: string, p: unknown, m: boolean) { return r === 'electron' ? electron : orig.call(this, r, p, m); } as typeof Module._load;
  let host: { wireWatchers(): void; dispose(): void } | undefined;
  const aios = require('../main/aios') as Record<string, unknown>;
  const saved = { f: aios.frameworkRoot, v: aios.vaultRoot };
  try {
    for (const k of Object.keys(require.cache)) if (/[\\/]main[\\/](panelHost|attention)\.js$/.test(k)) delete require.cache[k];
    aios.frameworkRoot = () => root;
    aios.vaultRoot = () => undefined;
    const { PanelHost } = require('../main/panelHost') as { PanelHost: new (wc: unknown) => typeof host & object };
    host = new PanelHost({ isDestroyed: () => false, send: () => { /* */ } });
    let checks = 0;
    (host as unknown as { postUpdateStatus(): void }).postUpdateStatus = () => { checks++; };
    (host as unknown as { scheduleRefresh(): void }).scheduleRefresh = () => { /* */ };
    host!.wireWatchers();
    await sleep(150);

    const seen: number[] = [];
    for (const h of ['b', 'c', 'd']) {
      const before = checks;
      replace(h);
      await sleep(900);                                     // past the 400ms debounce
      seen.push(checks - before);
    }
    assert.ok(seen.every((n) => n >= 1),
      `each replace must trigger a check; got ${JSON.stringify(seen)} — a watch on the FILE stops after the first`);

    const before = checks;
    fs.writeFileSync(path.join(root, 'README.md'), 'x');
    await sleep(900);
    assert.equal(checks, before, 'another file in the framework root does not trigger a network check');
  } finally {
    host?.dispose();
    aios.frameworkRoot = saved.f; aios.vaultRoot = saved.v;
    Module._load = orig;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
