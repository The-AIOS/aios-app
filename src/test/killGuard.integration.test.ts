/**
 * The conditional kill end to end (third review): the REAL `initCommandBus` drains a throwaway
 * inbox, so both callers of the kill — `claim` (a fresh `*.json`) and `adoptHolds` (a `.holding`
 * left by a dead surface) — run as shipped. Electron and the session registry are stubbed and
 * `process.kill` is intercepted, so no signal ever leaves this process.
 *
 * The rewrite lands where the review asked: AFTER the claim and BEFORE the re-read. Both paths ask
 * the registry for the target in between (withRealName, then targetByName), and the stub rewrites
 * the held file the first time it sees it stamped with this process's claim — i.e. claimed or
 * adopted, never earlier. Every refused case targets a LIVE, BUSY session whose writer saw it idle,
 * so a guard that went missing would show up here as a SIGTERM.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const SID = '0b5c2a4e-1111-4222-8333-944455556666';
const DEAD_PID = 2_999_999;   // the "previous surface" whose hold gets adopted; never running

type Rewrite = (body: Record<string, unknown>) => Record<string, unknown> | 'delete' | undefined;
interface Case { name: string; status: string; body: Record<string, unknown>; rewrite: Rewrite; kills: boolean; adopt: boolean; pid: number }

const guarded = (name: string): Record<string, unknown> => ({ action: 'kill', name, surface: 'app', expect: { status: 'idle' } });
const SHAPES: Array<{ id: string; status: string; plain?: boolean; rewrite: Rewrite; kills: boolean }> = [
  { id: 'emptied', status: 'busy', rewrite: () => ({}), kills: false },
  { id: 'expect-removed', status: 'busy', rewrite: (b) => { const { expect: _e, ...rest } = b; return rest; }, kills: false },
  { id: 'expect-weakened', status: 'busy', rewrite: (b) => ({ ...b, expect: { sessionId: SID } }), kills: false },
  { id: 'expect-changed', status: 'busy', rewrite: (b) => ({ ...b, expect: { status: 'busy' } }), kills: false },
  { id: 'read-fails', status: 'busy', rewrite: () => 'delete', kills: false },
  // positive controls: these MUST kill, or the refusals above prove nothing
  { id: 'guard-satisfied', status: 'idle', rewrite: () => undefined, kills: true },
  { id: 'only-bookkeeping', status: 'idle', rewrite: (b) => ({ ...b, _tried: ['glass:1'], _releases: 2, _queuedAt: 1 }), kills: true },
  { id: 'plain-kill', status: 'busy', plain: true, rewrite: () => undefined, kills: true },
];

test('claim and adoptHolds, run for real: a request rewritten after the claim never reaches the SIGTERM', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'killguard-int-'));
  const inbox = path.join(tmp, 'inbox');
  fs.mkdirSync(inbox);
  process.env.HOME = tmp;                          // nothing below may touch the real ~/.aios
  process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
  process.env.AIOS_BUS_DIR = inbox;
  delete process.env.AIOS_BUS_DISABLED;

  const cases: Case[] = [];
  let pid = 4_100_000;
  for (const adopt of [false, true]) {
    for (const s of SHAPES) {
      const name = `${adopt ? 'adopt' : 'claim'}-${s.id}`;
      const body = s.plain ? { action: 'kill', name, surface: 'app' } : guarded(name);
      cases.push({ name, status: s.status, body, rewrite: s.rewrite, kills: s.kills, adopt, pid: pid++ });
    }
  }
  for (const c of cases) {
    const file = path.join(inbox, `${c.name}.json`);
    if (c.adopt) {
      const stale = { ...c.body, _claim: { surface: 'app', pid: DEAD_PID, at: Date.now() - 60_000 }, _queuedAt: Date.now() - 60_000 };
      fs.writeFileSync(`${file}.holding`, JSON.stringify(stale, null, 2) + '\n');
    } else {
      fs.writeFileSync(file, JSON.stringify(c.body, null, 2) + '\n');
      const old = new Date(Date.now() - 10_000);   // past the parse grace window
      fs.utimesSync(file, old, old);
    }
  }

  const rewritten = new Set<string>();
  const registry = () => {
    for (const c of cases) {
      if (rewritten.has(c.name)) continue;
      const held = path.join(inbox, `${c.name}.json.holding`);
      let now: Record<string, unknown>;
      try { now = JSON.parse(fs.readFileSync(held, 'utf8')); } catch { continue; }
      if ((now._claim as { pid?: number } | undefined)?.pid !== process.pid) continue;   // not claimed by us yet
      rewritten.add(c.name);
      const r = c.rewrite(now);
      if (r === 'delete') fs.unlinkSync(held);
      else if (r) fs.writeFileSync(held, JSON.stringify(r, null, 2) + '\n');
    }
    return cases.map((c) => ({ name: c.name, pid: c.pid, status: c.status, sessionId: SID }));
  };

  const Module = require('module') as { _load(r: string, p: unknown, m: boolean): unknown };
  const noop = () => { /* stub */ };
  const electron = {
    app: { isPackaged: false, getVersion: () => '0.0.0-test', getPath: () => tmp, on: noop, whenReady: () => Promise.resolve() },
    ipcMain: { on: noop, handle: noop, removeHandler: noop },
    BrowserWindow: { getAllWindows: () => [], fromWebContents: () => undefined },
    Notification: Object.assign(class { on() { return this; } show() { /* */ } }, { isSupported: () => false }),
    nativeImage: { createFromDataURL: () => ({}) },
  };
  const origLoad = Module._load;
  const origKill = process.kill;
  const origInterval = global.setInterval;
  const realFs = require('fs') as typeof fs;   // the module itself: `import * as` is a read-only view
  const origWatch = realFs.watch;
  const sigterms: number[] = [];
  Module._load = function (this: unknown, r: string, p: unknown, m: boolean) { return r === 'electron' ? electron : origLoad.call(this, r, p, m); } as typeof Module._load;
  /* NO SIGNAL EVER LEAVES THIS TEST. Only a liveness probe (signal 0) is forwarded to the real
     `process.kill`. Every real signal, to any pid or process group, is recorded and refused here:
     the one SIGTERM a kill sends to a case pid, and anything else as a stray. These pids are not
     in the process table, so the kill takes its "pid alone" path; if a future change ever
     addressed a group, or followed up with a SIGKILL, it would show up as a stray and never reach
     a process (Linux allows pids this high, so one of these numbers can be somebody's). */
  const casePids = new Set<number>();
  const strays: string[] = [];
  (process as { kill: unknown }).kill = (p: number, sig?: string | number) => {
    if (sig === 0) return origKill.call(process, p, 0);   // liveness checks stay real
    if (sig === undefined) sig = 'SIGTERM';               // a bare process.kill(pid) IS a SIGTERM
    if (sig === 'SIGTERM' && casePids.has(p)) { sigterms.push(p); return true; }
    strays.push(`${String(sig)} ${p}`);
    throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
  };
  for (const c of cases) casePids.add(c.pid);
  /* CLOSE what the bus opens, never only unref it. On Windows an unref'd fs.watch still held the test
     process open after every assertion passed: measured on a windows-latest runner, the only
     JS-visible resources left were the two stdio pipes, and the file never exited (CI hung to the
     6 h cancel on every push since this test landed). With everything closed it exits in ~260 ms. */
  const intervals: ReturnType<typeof setInterval>[] = [];
  const watchers: fs.FSWatcher[] = [];
  (global as { setInterval: unknown }).setInterval = ((fn: () => void, ms: number) => { const t = origInterval(fn, ms).unref(); intervals.push(t); return t; }) as typeof setInterval;
  (realFs as { watch: unknown }).watch = ((...a: Parameters<typeof fs.watch>) => { const w = origWatch(...a).unref(); watchers.push(w); return w; }) as typeof fs.watch;
  try {
    const aios = require('../main/aios') as Record<string, unknown>;
    aios.listRunningAgents = registry;
    const bus = require('../main/commandBus') as { initCommandBus(w: () => undefined, v?: string): void };
    bus.initCommandBus(() => undefined, '0.0.0-test');
  } finally {
    Module._load = origLoad;
    (global as { setInterval: unknown }).setInterval = origInterval;
    (realFs as { watch: unknown }).watch = origWatch;
  }

  for (const c of cases) {
    const killed = sigterms.includes(c.pid);
    assert.equal(killed, c.kills, `${c.name}: ${c.kills ? 'must kill' : 'must NOT kill'}`);
    if (!c.kills) {
      assert.ok(rewritten.has(c.name), `${c.name}: the rewrite must have landed between the claim and the re-read`);
      const dead = path.join(inbox, `${c.name}.json.undelivered`);
      assert.ok(fs.existsSync(dead), `${c.name}: a refused kill is dead-lettered`);
      const reason = String((JSON.parse(fs.readFileSync(dead, 'utf8'))._undelivered as { reason?: string }).reason);
      assert.match(reason, /^kill refused — the held request (changed since it was claimed|could not be re-read)/, `${c.name}: ${reason}`);
    }
  }
  assert.equal(sigterms.length, cases.filter((c) => c.kills).length, 'no SIGTERM beyond the controls');
  assert.ok(cases.some((c) => c.adopt && c.kills) && cases.some((c) => !c.adopt && c.kills), 'both paths reached a kill');
  /* Let every kill settle before the real process.kill returns. */
  await new Promise((r) => setTimeout(r, 300));
  (process as { kill: unknown }).kill = origKill;
  assert.deepEqual(strays, [], 'a pid that is not provably a session gets one SIGTERM: no group signal, no SIGKILL, nothing to any other pid');
  for (const t of intervals) clearInterval(t);
  for (const w of watchers) w.close();
  assert.ok(watchers.length > 0, 'the bus must have watched the inbox — otherwise this closed nothing');
  fs.rmSync(tmp, { recursive: true, force: true });
});
