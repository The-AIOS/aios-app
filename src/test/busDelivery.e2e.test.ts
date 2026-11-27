import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
/* node-pty is a NATIVE module, built for the platform that packages the app. The cheap linux
   CI job installs no prebuild, so these cannot run there — and that is how the suite went red
   on its first push. But a pty test that quietly stops running EVERYWHERE is worse than no pty
   test, which is precisely the failure class this ticket exists for. So skip only where a pty
   genuinely cannot exist, and treat a missing pty on darwin — dev machines and the release
   runner, the two places that must be honest — as a hard error rather than a quirk. */
let pty: typeof import('node-pty') | null = null;
let ptyLoadError = '';
try { pty = require('node-pty') as typeof import('node-pty'); }
catch (e) { ptyLoadError = String((e as Error)?.message ?? e); }
if (!pty && process.platform === 'darwin') {
  throw new Error(`node-pty must load on macOS — run: npx electron-rebuild -f -w node-pty (${ptyLoadError})`);
}
/* On macOS node-pty spawns through a small `spawn-helper` binary. `npm ci` unpacks the prebuilt one
   WITHOUT its execute bit (node-pty 1.1.0), and every spawn then dies with a bare
   "posix_spawnp failed." that names neither the file nor the fix. Same policy as the load check
   above: on darwin this is an error, never a skip — a skip would silently retire these tests on
   every fresh checkout. The helper is resolved the way node-pty resolves it (lib/utils.js
   loadNativeModule, unbundled layout): the first of its native folders whose pty.node LOADS. */
function spawnHelperProblem(): string | null {
  if (!pty || process.platform !== 'darwin') return null;
  const root = path.resolve(path.dirname(require.resolve('node-pty')), '..');
  for (const dir of ['build/Release', 'build/Debug', `prebuilds/${process.platform}-${process.arch}`]) {
    try { require(path.join(root, dir, 'pty.node')); } catch { continue; }
    const helper = path.join(root, dir, 'spawn-helper');
    if (!fs.existsSync(helper)) return `node-pty's spawn-helper is missing at ${helper}. Run: npx electron-rebuild -f -w node-pty`;
    try { fs.accessSync(helper, fs.constants.X_OK); return null; }
    catch {
      return `node-pty's spawn-helper is not executable: ${helper}. `
        + '`npm ci` unpacks the prebuilt helper without its execute bit, and every pty spawn then fails with a bare "posix_spawnp failed.". '
        + `Run: chmod +x "${helper}"  (or rebuild it: npx electron-rebuild -f -w node-pty)`;
    }
  }
  return null;
}
const helperProblem = spawnHelperProblem();
if (helperProblem) throw new Error(helperProblem);
/* node-pty DOES load on Windows (N-API prebuild), so `skip` would be false and these would RUN —
   but roundTrip drives `/bin/sh -c '… stty raw -echo …; cat'`, which does not exist on Windows, and the
   specific hazard it guards (the POSIX MAX_CANON 1024-byte canonical-mode tail-loss) has no ConPTY
   analog — Windows pty delivery is exercised instead by the packaged `--smoke` pty gate. So skip on
   win32 too, with the reason stated, rather than fail on an absent /bin/sh. */
const skip = pty
  ? (process.platform === 'win32'
      ? 'raw-pty round-trip uses /bin/sh + stty (POSIX); ConPTY has no MAX_CANON buffer, and Windows pty delivery is covered by the packaged --smoke pty gate'
      : false)
  : `no node-pty prebuild on ${process.platform}; pty round-trips run on macOS`;
import { INLINE_LIMIT, needsPointer, pointerText, byteLength } from '../core/busPayload';

/* Pointer delivery, end-to-end. The other suite reasons about the RULE; this one puts bytes through a real
   pty, because the incident was not a logic error — it was a delivery that silently lost its
   tail. A rule that is right about a channel nobody exercised is the same false green that
   produced the bug.

   Everything here goes through a REAL node-pty in raw mode, which is the discipline a Claude
   session's TUI actually runs in. */

/* How the round trip knows when to write, and when it has its answer — no fixed sleeps (#424).

   It used to write at a fixed 120 ms and read at a fixed 900 ms. Under load the shell sometimes had
   not yet run `stty raw -echo` at 120 ms, so the write landed in CANONICAL mode, the line discipline
   kept only what fit its buffer, and the tail never came back — not late, never (measured: 10 s of
   waiting did not bring it). The test was reproducing the very bug it guards, caused by its own
   setup. Waiting longer could not fix that, and it could not tell a slow machine from a lost tail.

   So, three stages, each with a generous ceiling and a red that names the stage:
     1. READY — the shell prints a marker only once `stty` succeeded AND the tty reports
        `-icanon`; nothing is written until it is seen.
     2. FENCE — a short marker written right after the payload, in a second write. A raw pty is
        FIFO: once the fence is back, everything before it that was going to come back has.
        "Fence back, tail missing" is therefore a PROVEN loss, decided in milliseconds.
     3. What is compared is only what came back between the two markers.
   A fence that never comes back is NOT a pass and NOT an excuse: a pty that fell back to canonical
   mode swallows the fence together with the tail (neither ends in a newline), so that red names
   both causes — a stalled channel, or the lost-tail bug itself. Measured on a loaded machine
   (1-min load 17-18): ready in 9 ms p50 / 30 ms max, tail 3 ms after the write. */
const READY = '<<aios-pty-ready>>';
const FENCE = '<<aios-pty-fence>>';
const CEILING_MS = 10_000;

interface RoundTripOptions {
  /** Corrupts the payload before it is written (the negative control). */
  mutate?: (s: string) => string;
  /** Shell run before `stty` — models a shell that is slow to reach raw mode. */
  prelude?: string;
  /** What reads the pty once it is raw; `cat` echoes the payload back. */
  reader?: string;
  ceilingMs?: number;
}

/** Write `payload` into a raw-mode pty and return exactly what came back out of it. */
function roundTrip(payload: string, opts: RoundTripOptions = {}): Promise<string> {
  const { mutate = (s: string) => s, prelude = '', reader = 'cat', ceilingMs = CEILING_MS } = opts;
  return new Promise((resolve, reject) => {
    const raw = `stty raw -echo && stty -a | grep -q -- '-icanon'`;   // raw mode applied, and the tty says so
    const p = pty!.spawn('/bin/sh', ['-c', `${prelude}${raw} && printf '%s' '${READY}' && ${reader}`], {
      name: 'xterm-256color', cols: 200, rows: 50,
    });
    let got = '';
    let written = false;
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { p.kill(); } catch { /* already gone */ }
      fn();
    };
    const afterReady = () => got.slice(got.indexOf(READY) + READY.length);
    const timer = setTimeout(() => settle(() => reject(new Error(written
      ? `PTY CHANNEL TIMEOUT — the fence written after the payload did not come back within ${ceilingMs} ms `
        + `(${byteLength(afterReady())} payload bytes back of ${byteLength(mutate(payload))} written; `
        + `head ${afterReady().includes(payload.slice(0, 16)) ? 'back' : 'not back'}). Two causes fit: a stalled `
        + 'channel or machine, or the pty left raw mode and its line discipline swallowed the tail with '
        + 'the fence — the lost-tail bug this file guards. Not a pass either way.'
      : `PTY SETUP TIMEOUT — the shell did not report raw mode within ${ceilingMs} ms `
        + `(${byteLength(got)} bytes of output so far). Nothing was written; this is not the lost-tail bug.`))), ceilingMs);
    p.onExit(({ exitCode }) => settle(() => reject(new Error(written
      ? `PTY EXITED — the shell exited (code ${exitCode}) before the fence came back; ${byteLength(afterReady())} payload bytes back.`
      : `PTY EXITED — the shell exited (code ${exitCode}) before confirming raw mode; nothing was written, `
        + 'so this is a setup failure, not the lost-tail bug.'))));
    p.onData((d) => {
      got += d;
      if (!written && got.includes(READY)) {
        written = true;
        p.write(mutate(payload));
        p.write(FENCE);
      }
      if (written && afterReady().includes(FENCE)) {
        const back = afterReady();
        settle(() => resolve(back.slice(0, back.indexOf(FENCE))));
      }
    });
  });
}

/** The assertion a delivery makes. No tolerance: tolerance is how silence comes back. */
const intact = (sent: string, received: string): boolean =>
  received.includes(sent) && byteLength(received) >= byteLength(sent);

test('E2E: a message well over the inline limit arrives whole', { skip }, async () => {
  // 2.6KB — the size of the brief that was cut at 2043 in the field.
  const sent = 'AI66-HEAD ' + 'x'.repeat(2600) + ' AI66-TAIL-do-NOT-push';
  assert.ok(byteLength(sent) > INLINE_LIMIT, 'the fixture must exceed the limit or it proves nothing');
  const got = await roundTrip(sent);
  assert.ok(got.includes('AI66-HEAD'), 'the head must arrive');
  assert.ok(got.includes('AI66-TAIL-do-NOT-push'), 'THE TAIL MUST ARRIVE — the lost tail is the whole bug');
  assert.equal(intact(sent, got), true, 'every byte must arrive');
});

test('E2E NEGATIVE CONTROL: the same assertion FAILS on a deliberately truncated delivery', { skip }, async () => {
  /* The operator's requirement. The test above is worthless unless it can fail, and a silent bug needs
     a test proven able to detect silence. So: truncate on purpose, at exactly the byte the real
     incident was cut at, and assert the check REJECTS it. If this test ever stops failing to
     detect the cut, the test above has gone blind and the suite is decoration. */
  const sent = 'AI66-HEAD ' + 'x'.repeat(2600) + ' AI66-TAIL-do-NOT-push';
  // The fence came back (roundTrip resolved), so the channel was alive: the tail's absence below
  // is a loss the check must see, not a channel that simply had not answered yet.
  const got = await roundTrip(sent, { mutate: (s) => s.slice(0, 2043) });   // the field cut, reproduced

  assert.ok(got.includes('AI66-HEAD'), 'the head still arrives — which is why truncation looks fine');
  assert.ok(!got.includes('AI66-TAIL-do-NOT-push'), 'the tail is gone, as in the incident');
  assert.equal(intact(sent, got), false,
    'THE CHECK MUST FAIL HERE. If it passes, the E2E test above cannot see truncation.');
});

test('E2E: under the new rule the long prompt never travels inline at all', { skip }, async () => {
  // The point of the fix: the ceiling stops being load-bearing, because the long form is not
  // what crosses the channel. Only the pointer does, and the pointer is small by construction.
  const long = 'x'.repeat(2600);
  assert.equal(needsPointer(long), true, 'a 2.6KB prompt must route to a file');

  const ptr = pointerText('/tmp/aios-bus-payloads/probe.md');
  assert.equal(needsPointer(ptr), false, 'the pointer itself must be inline-safe');

  const got = await roundTrip(ptr);
  assert.equal(intact(ptr, got), true, 'and it must survive the real channel intact');
  assert.ok(got.includes('Do not act on this line alone'),
    'the self-executing clause must survive — a pointer read as an instruction is its own bug');
});

test('E2E HARNESS: a shell slow to reach raw mode still gets the whole message', { skip }, async () => {
  /* The race that made this file flaky (#424), pinned. With the old fixed 120 ms write this lost the
     tail every time — 2048 bytes back, head present, tail gone — because the write landed before
     `stty raw` ran. The round trip must wait for raw mode, however long the shell takes. */
  const sent = 'AI66-HEAD ' + 'x'.repeat(2600) + ' AI66-TAIL-do-NOT-push';
  const got = await roundTrip(sent, { prelude: 'sleep 0.3; ' });
  assert.ok(got.includes('AI66-TAIL-do-NOT-push'), 'THE TAIL MUST ARRIVE — a slow shell must not turn into a lost tail');
  assert.equal(intact(sent, got), true, 'every byte must arrive');
});

test('E2E HARNESS: a shell that never reaches raw mode is reported as a setup timeout, not a lost tail', { skip }, async () => {
  await assert.rejects(roundTrip('probe', { prelude: 'sleep 5; ', ceilingMs: 300 }), /PTY SETUP TIMEOUT/);
});

test('E2E HARNESS: a failed `stty` never lets the payload be written into a canonical pty', { skip }, async () => {
  // `stty` shadowed by a failing function: raw mode is never reached, so READY must never print
  // and nothing may be written — a setup failure, not a write into the line discipline.
  await assert.rejects(roundTrip('probe', { prelude: 'stty() { return 1; }; ', ceilingMs: 2000 }),
    /PTY EXITED — the shell exited \(code \d+\) before confirming raw mode; nothing was written/);
});

test('E2E HARNESS: a pty that falls back to canonical mode is a red that names the lost-tail bug', { skip }, async () => {
  /* The original bug's shape, through this harness: the reader turns canonical mode back on after
     READY, so the 2.6 KB line (no newline) is held by the line discipline and neither the tail nor
     the fence ever reaches `cat`. That must be red — and its message must not blame the machine alone. */
  const sent = 'AI66-HEAD ' + 'x'.repeat(2600) + ' AI66-TAIL-do-NOT-push';
  await assert.rejects(roundTrip(sent, { reader: 'stty icanon; cat', ceilingMs: 500 }),
    /PTY CHANNEL TIMEOUT[\s\S]*the lost-tail bug this file guards/);
});

test('E2E HARNESS: a channel that never answers is reported as a channel timeout, not a lost tail', { skip }, async () => {
  // Raw mode is reached, but nothing reads the pty, so neither the payload nor the fence comes back.
  await assert.rejects(roundTrip('probe', { reader: 'sleep 5', ceilingMs: 300 }), /PTY CHANNEL TIMEOUT/);
});
