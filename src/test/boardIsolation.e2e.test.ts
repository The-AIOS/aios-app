/**
 * #91 — a board that tries to reach the network, a file outside its folder, another board, a script
 * or a navigation is BLOCKED, measured in real Chromium (boardIsolationHarness.ts) rather than read
 * from source: CSP, iframe sandboxing and navigation are the browser's to enforce.
 *
 * Two runs of the same hostile page:
 *  · guarded — the board viewer as the App installs it. Nothing may reach the hit server, nothing
 *    outside the folder may be requested or served, and the board's own stylesheet and image MUST
 *    load (a viewer that loads nothing would pass everything else).
 *  · control — the same page opened the way the HTML viewer opens a file today. It MUST reach the
 *    network. If it ever stops, the probe has gone blind and this file says so instead of passing.
 *
 * Needs the Electron binary and a display. The ubuntu unit job installs with --ignore-scripts (no
 * binary), so there it skips and says why; AIOS_BOARD_E2E_STRICT=1 turns that skip into a failure.
 * The smoke run checks the same probe against the real App's card (main.ts, boards gate).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { startHitServer, judgeProbe, type HostileFixture } from '../main/boardProbe';

const STRICT = process.env.AIOS_BOARD_E2E_STRICT === '1';

function electronBinary(): { bin?: string; why?: string } {
  let p: unknown;
  try { p = require('electron'); } catch (e) { return { why: `electron is not installed (${(e as Error).message.split('\n')[0]})` }; }
  if (typeof p !== 'string' || !fs.existsSync(p)) return { why: 'the electron binary was not downloaded (npm ci --ignore-scripts)' };
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return { why: 'no display (run under xvfb-run)' };
  return { bin: p };
}

interface Run { result: { mode: string; fx: HostileFixture; served: string[]; blocked: string[]; requested: string[] }; hits: string[] }

async function runHarness(bin: string, mode: 'guarded' | 'control'): Promise<Run> {
  const srv = await startHitServer();
  const env: NodeJS.ProcessEnv = { ...process.env, BOARD_PROBE_MODE: mode, BOARD_PROBE_PORT: String(srv.port) };
  delete env.ELECTRON_RUN_AS_NODE;   // set by some parents; it would make the binary a plain node
  const child = spawn(bin, [path.join(__dirname, 'boardIsolationHarness.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  const code = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(null); }, 60_000);
    child.on('exit', (c) => { clearTimeout(timer); resolve(c); });
  });
  await new Promise((r) => setTimeout(r, 300));   // a request in flight at exit still counts
  await srv.close();
  const line = out.split('\n').find((l) => l.startsWith('PROBE_RESULT '));
  assert.ok(line, `harness (${mode}) printed no result; exit ${code}\nstdout: ${out.slice(-800)}\nstderr: ${err.slice(-1500)}`);
  const result = JSON.parse(line!.slice('PROBE_RESULT '.length));
  try { fs.rmSync(path.dirname(result.fx.root), { recursive: true, force: true }); } catch { /* temp */ }
  return { result, hits: [...srv.hits] };
}

const { bin, why } = electronBinary();
const skip = !bin && !STRICT ? `skipped: ${why}` : false;

test('a hostile board reaches no network, no file outside its folder, no other board, and cannot navigate', { skip }, async () => {
  assert.ok(bin, `strict mode, but ${why}`);
  const { result, hits } = await runHarness(bin!, 'guarded');
  const verdict = judgeProbe(result.fx, { hits, requested: result.requested, served: result.served, blockedNavigations: result.blocked });
  assert.deepEqual(verdict.why, [], verdict.why.join('\n'));
  assert.ok(result.blocked.some((u) => u.endsWith('/parent-set')),
    `the navigation guard did not refuse the frame being pointed at the network: blocked=${JSON.stringify(result.blocked)}`);
});

test('control: the same page opened the way the HTML viewer opens files DOES reach the network (the probe can fail)', { skip }, async () => {
  assert.ok(bin, `strict mode, but ${why}`);
  const { hits } = await runHarness(bin!, 'control');
  assert.ok(hits.length > 0, 'the unprotected control reached nothing, so the guarded run above proves nothing');
});
