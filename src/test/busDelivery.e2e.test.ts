import { test } from 'node:test';
import assert from 'node:assert/strict';
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
/* node-pty DOES load on Windows (N-API prebuild), so `skip` would be false and these would RUN —
   but roundTrip drives `/bin/sh -c 'stty raw -echo; cat'`, which does not exist on Windows, and the
   specific hazard it guards (the POSIX MAX_CANON 1024-byte canonical-mode tail-loss) has no ConPTY
   analog — Windows pty delivery is exercised instead by the packaged `--smoke` pty gate. So skip on
   win32 too, with the reason stated, rather than fail on an absent /bin/sh. */
const skip = pty
  ? (process.platform === 'win32'
      ? 'raw-pty round-trip uses /bin/sh + stty (POSIX); ConPTY has no MAX_CANON buffer, and Windows pty delivery is covered by the packaged --smoke pty gate'
      : false)
  : `no node-pty prebuild on ${process.platform}; pty round-trips run on macOS`;
import { INLINE_LIMIT, needsPointer, pointerText, byteLength } from '../core/busPayload';

/* AI-66 end-to-end. The other suite reasons about the RULE; this one puts bytes through a real
   pty, because the incident was not a logic error — it was a delivery that silently lost its
   tail. A rule that is right about a channel nobody exercised is the same false green that
   produced the bug.

   Everything here goes through a REAL node-pty in raw mode, which is the discipline a Claude
   session's TUI actually runs in. */

/** Write `payload` into a raw-mode pty and return exactly what came back out. */
function roundTrip(payload: string, mutate: (s: string) => string = (s) => s): Promise<string> {
  return new Promise((resolve) => {
    const p = pty!.spawn('/bin/sh', ['-c', 'stty raw -echo; cat'], {
      name: 'xterm-256color', cols: 200, rows: 50,
    });
    let got = '';
    p.onData((d) => { got += d; });
    setTimeout(() => p.write(mutate(payload)), 120);
    setTimeout(() => { try { p.kill(); } catch { /* already gone */ } resolve(got); }, 900);
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
  /* Chuy's requirement. The test above is worthless unless it can fail, and a silent bug needs
     a test proven able to detect silence. So: truncate on purpose, at exactly the byte the real
     incident was cut at, and assert the check REJECTS it. If this test ever stops failing to
     detect the cut, the test above has gone blind and the suite is decoration. */
  const sent = 'AI66-HEAD ' + 'x'.repeat(2600) + ' AI66-TAIL-do-NOT-push';
  const got = await roundTrip(sent, (s) => s.slice(0, 2043));   // the field cut, reproduced

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
