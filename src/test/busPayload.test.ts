import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import {
  INLINE_LIMIT, PAYLOAD_TTL_MS, byteLength, needsPointer, pointerText,
  isStalePayload, assertDeliverable,
} from '../core/busPayload';

/* AI-66. The bug was SILENT truncation: a 2.6KB send arrived cut at 2043 with no error on any
   surface. So these tests are written to a higher bar than "the happy path works" — the point
   is to prove the suite can SEE a truncation, because a test that would pass on a truncated
   message is worth nothing against a bug whose signature is silence. */

test('the measured ceiling is the threshold, and it is about BYTES', () => {
  assert.equal(INLINE_LIMIT, 1024, 'the one ceiling that was actually measured and reproduced');
  assert.equal(needsPointer('x'.repeat(1024)), false, 'exactly at the limit still inlines');
  assert.equal(needsPointer('x'.repeat(1025)), true, 'one over spills');
  // em dashes are 3 bytes each: 400 of them is 1200 bytes but only 400 characters. A
  // .length check would call this deliverable and it is not.
  const emDashes = '—'.repeat(400);
  assert.equal(emDashes.length, 400, 'fewer CHARACTERS than the limit');
  assert.equal(byteLength(emDashes), 1200, 'but more BYTES than the limit');
  assert.equal(needsPointer(emDashes), true, 'must be judged by bytes, or multi-byte prompts slip through');
});

test('the pointer is self-executing and cannot itself be truncated', () => {
  const p = pointerText('/tmp/aios-bus/payload-abc.md');
  assert.ok(p.includes('/tmp/aios-bus/payload-abc.md'), 'names the file');
  assert.match(p, /Read .+ and follow/, 'states the action without assuming prior knowledge');
  assert.match(p, /Do not act on this line alone/, 'says it is NOT the whole instruction');
  assert.ok(!p.includes('\n'), 'one line — a newline would submit early');
  // The pointer is the one string that must always survive inline delivery.
  assert.ok(byteLength(p) < INLINE_LIMIT / 2, 'must sit far below the limit, not near it');
});

test('a fulfiller that cannot spill FAILS LOUDLY instead of truncating', () => {
  // "Never truncate-and-report-success" is the whole contract. A caller with no spill path
  // must throw, because a partial prompt that looks delivered is the original bug.
  assert.equal(assertDeliverable('short'), 'short');
  assert.throws(() => assertDeliverable('x'.repeat(INLINE_LIMIT + 1)), /refusing to deliver/);
});

test('payload files age out — they hold arbitrary prompt text', () => {
  const now = 1_000_000_000_000;
  assert.equal(isStalePayload(now - 60_000, now), false, 'a minute old is live');
  assert.equal(isStalePayload(now - PAYLOAD_TTL_MS - 1, now), true, 'past the TTL it is stale');
});

/* ── THE NEGATIVE CONTROL ──────────────────────────────────────────────────────
   Chuy's requirement, and the important one: prove the check can DETECT truncation.
   Both halves of a round trip are exercised — a whole message must pass the assertion, and a
   deliberately truncated one must FAIL it. If the second half ever stops failing, the first
   half has stopped meaning anything and this suite is decoration. */

/** The assertion a delivery test makes: what arrived is byte-identical to what was sent. */
function arrivedIntact(sent: string, received: string): boolean {
  return byteLength(received) === byteLength(sent) && received === sent;
}

test('NEGATIVE CONTROL: the intactness check actually fails on a truncated message', () => {
  const sent = 'A'.repeat(2600) + ' — and do NOT push.';   // the shape of the real incident

  // 1. the honest case passes
  assert.equal(arrivedIntact(sent, sent), true, 'an intact message must pass');

  // 2. the FIELD case must fail — cut at 2043, exactly where the real one was cut
  const cutAt2043 = sent.slice(0, 2043);
  assert.equal(arrivedIntact(sent, cutAt2043), false,
    'a message cut at the observed byte must FAIL — if this passes, the test is blind');

  // 3. the cruellest case: cut so late that only the final instruction is missing. This is
  //    the one that nearly shipped a `push` nobody asked for.
  const cutJustBeforeTheImportantBit = sent.slice(0, sent.length - ' — and do NOT push.'.length);
  assert.equal(arrivedIntact(sent, cutJustBeforeTheImportantBit), false,
    'losing only the tail must FAIL — that is the failure mode that caused this ticket');

  // 4. and one byte short still fails: no tolerance, because tolerance is how silence returns
  assert.equal(arrivedIntact(sent, sent.slice(0, sent.length - 1)), false, 'one byte short is not delivered');
});

test('NEGATIVE CONTROL: needsPointer would have caught the original incident', () => {
  // The real message was ~2.6KB and was delivered inline anyway. Under the new rule it never
  // travels inline at all, so the ceiling stops being load-bearing.
  const original = 'x'.repeat(2600);
  assert.equal(needsPointer(original), true, 'the 2.6KB brief must route to a file');
  // and the pointer that replaces it is deliverable by the measured-safe path
  assert.equal(needsPointer(pointerText('/tmp/aios-bus/p.md')), false);
});

test('INVARIANT: neither surface delivers a send without the length gate', () => {
  // Source-level, because the bug was that a delivery path simply had no check. The App's
  // bus send goes through commandBus; a future path that skips the gate is the regression.
  const bus = fs.readFileSync('src/main/commandBus.ts', 'utf8');
  assert.match(bus, /needsPointer|busPayload/, 'the App bus send must consult the length gate');
});

/* AI-66 pt4 — the conflation that killed a real message.
   The BEHAVIOUR is tested where it lives: decideAfterVerifyMiss in protocolContract.test.ts,
   pure and exhaustive. What is asserted here is that the surface DELEGATES to it. Both
   fulfillers previously re-derived this policy by hand and both got it wrong the same way, so
   "does this surface still own a copy of the decision?" is the regression worth guarding. */

test('INVARIANT: the surface delegates the miss decision, never re-derives it', () => {
  const bus = fs.readFileSync('src/main/commandBus.ts', 'utf8');
  assert.match(bus, /decideAfterVerifyMiss\(/, 'the surface must call the shared decision');
  // Every outcome the decision can RETURN must be handled — dropping one silently reintroduces a
  // conflation. 'release' is deliberately absent from both the type and this list since
  // 2026-08-12: reaching the miss decision means the message was typed, so releasing it asks a
  // second surface to type it again. Handling it here would imply it is still reachable.
  for (const arm of ['retry', 'wait']) {
    assert.match(bus, new RegExp(`miss\\.do === '${arm}'`), `the '${arm}' outcome must be handled`);
  }
  assert.doesNotMatch(bus, /miss\.do === 'release'/,
    'a typed message must never be handed to a sibling — release belongs to the !sendResult.ok path');
  // And retirement must be the FALL-THROUGH, i.e. only what the decision did not claim.
  assert.match(bus, /markUndelivered\(heldPath, req, `sent to '\$\{req\.name\}' — \$\{miss\.reason\}`\)/,
    'retiring must use the shared decision\'s reason, not a locally invented one');
});

test('INVARIANT: contract values are never re-declared in the surface', () => {
  const bus = fs.readFileSync('src/main/commandBus.ts', 'utf8');
  for (const k of ['MAX_HOLD_MS', 'MAX_RELEASES', 'RETIRE_TTL_MS', 'HOLD_STALE_MS', 'MAX_DELIVERY_ATTEMPTS']) {
    assert.match(bus, new RegExp(`const ${k} = TIMINGS\\.`), `${k} must come from the contract`);
  }
});

test('INVARIANT: the inbox override is dev-only and cannot divert a packaged build', () => {
  /* AIOS_BUS_DIR exists so the bus can be exercised end to end without a second fulfiller
     racing the installed App for live traffic — the absence of that seam is why the 2026-08-12
     double-delivery bug was found by a session complaining instead of by a test.
     But a test seam reachable in production is worse than no seam: a stray env var would make the
     shipped App watch an empty directory, and every dropped request would go unserved with
     nothing pointing at the cause. So the guard is asserted here, because it is the kind of
     condition someone simplifies away while refactoring. */
  const bus = fs.readFileSync('src/main/commandBus.ts', 'utf8');
  assert.match(bus, /AIOS_BUS_DIR/, 'the override must exist — the bus needs to be testable');
  assert.match(bus, /if \(override && !app\.isPackaged\) return path\.resolve\(override\)/,
    'the override must be gated on !app.isPackaged — a packaged build may never be diverted');
  // And the real path must remain the unconditional fall-through.
  assert.match(bus, /return path\.join\(os\.homedir\(\), '\.aios', 'spawn-inbox'\);/,
    'the machine-global inbox must stay the default with no condition attached');
});

test('INVARIANT: the verification baseline is captured ONCE, not per attempt', () => {
  /* 2026-08-12, the half that made the bug unrecoverable. `before` was computed at the top of the
     delivery loop, so on a re-attempt it absorbed the PREVIOUS attempt's own user turn. After that
     no poll could ever show an increase — the message had demonstrably arrived and the loop kept
     re-typing it, because the baseline had moved to include it.
     A baseline that is re-read cannot detect the event it exists to detect. Asserted at the source
     because the failure is invisible in any single-attempt test. */
  const bus = fs.readFileSync('src/main/commandBus.ts', 'utf8');
  assert.match(bus, /let baseline: number \| undefined;/, 'the baseline must be declared OUTSIDE the delivery loop');
  assert.match(bus, /if \(baseline === undefined\) baseline = countUserTurnsContaining\(/,
    'it must be captured only on the first pass');
  assert.doesNotMatch(bus, /const before = countUserTurnsContaining\(/,
    're-reading the baseline per attempt is the bug — derive `before` from the captured baseline');
});

test('INVARIANT: every test invocation uses the one portable spelling', () => {
  /* `node --test out/test` (a bare directory) throws MODULE_NOT_FOUND on Node 21+ — it resolves
     the path as a module instead of discovering tests. It happened to work on Node 20, which is
     why it reached CI twice: once in package.json (green CI on the old Node 20 pins, broken on the
     maintainer's Node 26), and once inline in the two Windows jobs after the first fix missed them.

     The directory form exists for a real reason — npm runs scripts through cmd.exe on Windows,
     which does not expand globs. The QUOTED glob satisfies both: the shell leaves it alone and Node
     expands it internally, so it works on cmd.exe, Git Bash and POSIX alike (Node 21+).

     Asserted because five call sites drifting apart is invisible in review — the failure is loud in
     CI but only on the one platform that happens to run the odd one out. */
  const want = 'node --test "out/test/*.test.js"';
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> };
  assert.ok(pkg.scripts.test.includes(want), `package.json test script must use: ${want}`);
  for (const f of fs.readdirSync('.github/workflows').filter((n) => n.endsWith('.yml'))) {
    const body = fs.readFileSync(`.github/workflows/${f}`, 'utf8');
    for (const line of body.split('\n')) {
      if (!line.includes('node --test')) continue;
      assert.ok(line.includes(want),
        `${f}: every test invocation must be ${want} — found: ${line.trim()}`);
    }
  }
});
