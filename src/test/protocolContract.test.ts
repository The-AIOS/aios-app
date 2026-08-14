import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { TIMINGS, decideAfterVerifyMiss, maxAttemptsFor, claimVerdict, triedBy, withTried, fulfillerId,
  surfaceForAncestry, parsePresence, type MissAction } from '../core/sendQueue';

/* THE CROSS-REPO DIFF-GUARD.
 *
 * `aios-app` and `aios-glass` both fulfil requests on the same bus, and contract 2 has them
 * RACE — so a request must behave identically whichever one wins. The two `sendQueue.ts` copies
 * had silently diverged by 248 lines, and `TIMINGS` — the block literally commented "these are
 * CONTRACT, not local tuning" — existed in only ONE of them. The only thing linking the surfaces
 * was a code comment reading `// Glass: MAX_HOLD_MS`.
 *
 * They agreed anyway, because someone hand-copied them. Nothing enforced it.
 *
 * A true diff cannot run here: these are separate repositories, so neither CI can see the other's
 * tree. What CAN travel is a HASH. Both repos record the same digest of the TIMINGS block, so
 * editing the contract in one repo fails that repo's test until the digest is updated — and the
 * digest is a 16-character string a human compares across the two PRs in one glance. It converts
 * silent drift into a visible, deliberate act.
 *
 * WHEN THIS FAILS: you changed TIMINGS. That is allowed — but it is a PROTOCOL change. Make the
 * identical edit in the other repo, recompute, update PROTOCOL_TIMINGS_SHA in BOTH, and update
 * the inbox README's invariants section. All in the same push, or a live fleet runs split-brain.
 */
const PROTOCOL_TIMINGS_SHA = 'ee54bd44cff806e1';

function timingsBlock(): string {
  const src = fs.readFileSync('src/core/sendQueue.ts', 'utf8');
  const m = /export const TIMINGS = \{[\s\S]*?\n\} as const;/.exec(src);
  assert.ok(m, 'the TIMINGS block must exist in this surface — it is the contract');
  return m![0];
}

test('PROTOCOL: the TIMINGS block is byte-identical across both fulfillers', () => {
  const sha = crypto.createHash('sha256').update(timingsBlock()).digest('hex').slice(0, 16);
  assert.equal(sha, PROTOCOL_TIMINGS_SHA,
    'TIMINGS changed. This is a PROTOCOL change: make the same edit in the sibling repo, update this SHA in BOTH, and update the inbox README — in one push.');
});

test('PROTOCOL: the values themselves are the agreed ones', () => {
  // Belt and braces: the hash catches edits, these catch a hash updated without thought.
  assert.equal(TIMINGS.HOLD_STALE_MS, 45 * 60 * 1000);
  assert.equal(TIMINGS.MAX_HOLD_MS, 30 * 60 * 1000);
  assert.equal(TIMINGS.RETIRE_TTL_MS, 10 * 60 * 1000);
  assert.equal(TIMINGS.MAX_RELEASES, 2);
  assert.equal(TIMINGS.MAX_DELIVERY_ATTEMPTS, 3);
  // MAX_HOLD_MS must stay below HOLD_STALE_MS or a claimer gives up after its hold is adoptable.
  assert.ok(TIMINGS.MAX_HOLD_MS < TIMINGS.HOLD_STALE_MS, 'a fulfiller must give up before its claim goes stale');
});

/* AI-66 pt4 — the four-way decision after a delivery that did not verify.
   Pure, so it can be exhaustively tested WITHOUT an extension host or an Electron window —
   which is the whole reason it lives in this module rather than inside each surface's async
   delivery loop, where the bug originally hid in two places at once. */

test('a verify miss on a LIVE target inside the hold budget never retires', () => {
  // The bug: "no sibling left" was read as "undeliverable" and a brief died in 20 seconds
  // with 29m40s of MAX_HOLD_MS unspent. Nothing below may return 'retire' while the target
  // is alive and the clock has not run out.
  for (const targetBusy of [false, true]) {
    for (const attempts of [0, 1, 2, 3, 9]) {
      const d = decideAfterVerifyMiss({ targetAlive: true, targetBusy, heldMs: 20_000, attempts });
      assert.notEqual(d.do, 'retire', `alive + 20s in must never retire (busy=${targetBusy} attempts=${attempts})`);
    }
  }
});

test('a BUSY target is never re-sent to — it has not had the chance to write the turn', () => {
  /* 2026-08-12: one `/aios:close-session --auto` was delivered FOUR times to a session that was
     busy throughout, ~2 minutes apart, with no operator typing it. The text landed every time; a
     busy session simply does not write an incoming message to its transcript until its current
     turn ends. Meanwhile two IDLE targets in the same minutes verified and consumed on the first
     try — that contrast is the whole diagnosis.
     So: while the target is mid-turn, the ONLY correct action is to wait. Not retry, not release. */
  for (const attempts of [0, 1, 2, 3, 99]) {
    const d = decideAfterVerifyMiss({ targetAlive: true, targetBusy: true, heldMs: 60_000, attempts });
    assert.equal(d.do, 'wait', `busy target must wait, never re-type (attempts=${attempts})`);
    assert.match(d.reason, /busy during verification/);
  }
});

test('a verify miss can NEVER hand the request to a sibling — we already typed it', () => {
  /* `release` used to be the FIRST branch here, and it is now unreachable by construction.
     Reaching this function means the surface typed the message successfully (a surface that could
     not type it returns !ok and releases on THAT path — the case release was built for). Handing an
     already-typed request to a sibling asks a second surface to type it again: double delivery,
     which this protocol calls explicitly worse than latency.
     And with one fulfiller running there is no sibling, so the release came back to the same App,
     which re-typed it and burned a release — twice, to MAX_RELEASES, one step from retiring work
     that had already completed as a FALSE dead letter. */
  for (const targetBusy of [false, true]) {
    for (const attempts of [0, 1, 2, 3, 99]) {
      for (const heldMs of [0, 60_000, TIMINGS.MAX_HOLD_MS - 1]) {
        const d = decideAfterVerifyMiss({ targetAlive: true, targetBusy, heldMs, attempts });
        assert.notEqual(d.do, 'release',
          `a typed message must never be handed to a sibling (busy=${targetBusy} attempts=${attempts} held=${heldMs})`);
      }
    }
  }
});

test('sends are capped, patience is not', () => {
  const idle = { targetAlive: true, targetBusy: false, heldMs: 60_000 };
  assert.equal(decideAfterVerifyMiss({ ...idle, attempts: TIMINGS.MAX_DELIVERY_ATTEMPTS - 1 }).do, 'retry');
  // out of sends but still inside the hold: WAIT. Retrying forever would re-type the message
  // every verify window for 30 minutes — double delivery, which is worse than the delay.
  assert.equal(decideAfterVerifyMiss({ ...idle, attempts: TIMINGS.MAX_DELIVERY_ATTEMPTS }).do, 'wait');
  assert.equal(decideAfterVerifyMiss({ ...idle, attempts: 99 }).do, 'wait');
});

test('REGRESSION — canonical\'s captured request must not produce another delivery', () => {
  /* The live request file, read from ~/.aios/spawn-inbox/aios-canonical.json.holding at 20:42:
       { action: 'send', name: 'aios-canonical', prompt: '/aios:close-session --auto',
         releases: 2, _claim: { surface: 'app', pid: 37390, at: 1786588841767 } }
     `releases: 2` is MAX_RELEASES, the claimer was ALIVE (an early report said dead — that came
     from a sandboxed `ps` returning empty, which is a different bug entirely), and the target was
     busy. This exact state must yield WAIT. The old code yielded 'release' → re-claim → re-type. */
  const captured = { targetAlive: true, targetBusy: true, heldMs: 212_000, attempts: 1 };
  const d = decideAfterVerifyMiss(captured);
  assert.equal(d.do, 'wait', `the captured state must wait, got '${d.do}': ${d.reason}`);
  // and once it goes idle without the turn appearing, retrying is legitimate — bounded
  assert.equal(decideAfterVerifyMiss({ ...captured, targetBusy: false }).do, 'retry');
});

test('only a dead target or a spent hold budget retires a request', () => {
  const dead = decideAfterVerifyMiss({ targetAlive: false, targetBusy: false, heldMs: 0, attempts: 0 });
  assert.equal(dead.do, 'retire');
  assert.match(dead.reason, /no longer a live session/);
  const timedOut = decideAfterVerifyMiss({ targetAlive: true, targetBusy: false, heldMs: TIMINGS.MAX_HOLD_MS, attempts: 9 });
  assert.equal(timedOut.do, 'retire');
  assert.match(timedOut.reason, /held for \d+ min/);
  // one millisecond short of the budget is still not a failure
  assert.notEqual(decideAfterVerifyMiss({ targetAlive: true, targetBusy: false, heldMs: TIMINGS.MAX_HOLD_MS - 1, attempts: 9 }).do, 'retire');
});

test('a dead target beats every other consideration', () => {
  // Ordering matters: no amount of remaining budget makes a vanished session deliverable.
  assert.equal(decideAfterVerifyMiss({ targetAlive: false, targetBusy: false, heldMs: 0, attempts: 0 }).do, 'retire');
});

test('the delivery cap gates the SEND, not just the log line', () => {
  /* Traced, not assumed: a 'wait' verdict does `continue`, which re-enters the delivery
     branch. A cap enforced only in the after-a-miss decision therefore capped NOTHING — the
     loop would keep re-typing the message for the whole hold budget. The guard must sit
     before the send itself. */
  /* Pinned to the INVARIANT — the ORDER of the gate and the counter — not to the expression
     inside it. This assertion broke when the cap became per-text (maxAttemptsFor), which is the
     third time today a source-scrape guard failed on a line that legitimately moved. A guard that
     goes red for correct changes teaches people to update it without reading it. */
  const src = fs.readFileSync('src/main/commandBus.ts', 'utf8');
  const gate = src.search(/attempts >= (maxAttemptsFor\(|TIMINGS\.MAX_DELIVERY_ATTEMPTS)/);
  assert.ok(gate > 0, 'the cap must be checked BEFORE delivering, whatever the cap expression is');
  const bump = src.indexOf('attempts++', gate);
  assert.ok(bump > gate, 'the guard must precede the attempt counter, or it runs too late');
  /* And the cap must be PER-TEXT, or a slash command is typed three times (measured 2026-08-14). */
  assert.match(src, /maxAttemptsFor\(/, 'the send gate must use the per-text cap');
});

/* ── THE BEHAVIOURAL CONTRACT — the guard the TIMINGS hash cannot provide ─────
   TIMINGS is hashed because it is a data literal, identical in both repos. The FUNCTIONS around
   it cannot be: the two surfaces' lint regimes disagree about braces on single-statement bodies,
   so hashing `decideAfterVerifyMiss`'s source would fail forever and teach everyone to ignore the
   one test that guards cross-process behaviour — the failure mode of every check in this ticket.

   What CAN be identical is the DECISION TABLE. Same inputs, same action, on both surfaces. The
   table below is byte-identical across repos and hashed like TIMINGS, so changing the protocol on
   one surface without the other goes red — which is exactly how the two implementations silently
   diverged by 248 lines in the first place.

   WHEN THIS FAILS: you changed the decision. That is allowed — it is a PROTOCOL change. Make the
   identical edit in the sibling repo, recompute, update BEHAVIOUR_SHA in BOTH, and say so in the
   inbox README, in one push. */
const DECISION_VECTORS: ReadonlyArray<{ why: string; alive: boolean; busy: boolean; heldMin: number; attempts: number; cap?: number; want: MissAction }> = [
  { why: 'dead target, everything else fresh',      alive: false, busy: false, heldMin: 0,  attempts: 0, want: 'retire' },
  { why: 'dead target beats a busy reading',         alive: false, busy: true,  heldMin: 0,  attempts: 0, want: 'retire' },
  { why: 'hold budget spent',                       alive: true,  busy: false, heldMin: 30, attempts: 0, want: 'retire' },
  { why: 'busy mid-turn: silence is not failure',    alive: true,  busy: true,  heldMin: 1,  attempts: 0, want: 'wait'   },
  { why: 'busy stays waiting even out of sends',     alive: true,  busy: true,  heldMin: 1,  attempts: 9, want: 'wait'   },
  { why: 'idle with sends left: deliver again',      alive: true,  busy: false, heldMin: 1,  attempts: 0, want: 'retry'  },
  { why: 'idle, last send available',                alive: true,  busy: false, heldMin: 1,  attempts: 2, want: 'retry'  },
  { why: 'sends capped, time left: watch, never type', alive: true, busy: false, heldMin: 1, attempts: 3, want: 'wait'   },
  { why: 'the 2026-08-12 captured state',            alive: true,  busy: true,  heldMin: 3,  attempts: 1, want: 'wait'   },
  // A slash command is typed ONCE (cap 1) and then only watched — measured 2026-08-14, /help was
  // delivered three times because it writes no transcript record, so a miss was read as a failed
  // send. Waiting still catches a command that verifies late; re-typing catches neither.
  { why: 'slash command, first miss: never re-type', alive: true,  busy: false, heldMin: 1,  attempts: 1, cap: 1, want: 'wait'   },
  { why: 'slash command, cap not yet reached',       alive: true,  busy: false, heldMin: 1,  attempts: 0, cap: 1, want: 'retry'  },
  { why: 'a dead target still beats the cap',        alive: false, busy: false, heldMin: 1,  attempts: 0, cap: 1, want: 'retire' },
];
const BEHAVIOUR_SHA = 'e39f627771a97d53';

test('PROTOCOL: the decision table is byte-identical across both fulfillers', () => {
  const src = fs.readFileSync('src/test/protocolContract.test.ts', 'utf8');
  const m = /const DECISION_VECTORS: ReadonlyArray<\{[\s\S]*?\n\];/.exec(src);
  assert.ok(m, 'the decision table must exist in this surface — it is the contract');
  const sha = crypto.createHash('sha256').update(m[0]).digest('hex').slice(0, 16);
  assert.equal(sha, BEHAVIOUR_SHA,
    'The decision table changed. This is a PROTOCOL change: make the same edit in the sibling repo, update BEHAVIOUR_SHA in BOTH, and update the inbox README — in one push.');
});

test('PROTOCOL: every vector produces the agreed action on this surface', () => {
  for (const v of DECISION_VECTORS) {
    const got = decideAfterVerifyMiss({
      targetAlive: v.alive, targetBusy: v.busy, heldMs: v.heldMin * 60_000, attempts: v.attempts,
      maxAttempts: v.cap,
    });
    assert.equal(got.do, v.want, `${v.why}: expected '${v.want}', got '${got.do}' (${got.reason})`);
  }
});

test('a slash command is typed ONCE — the /help triple-delivery, as a unit test', () => {
  /* Measured live 2026-08-14 in an Extension Development Host: `/help` was delivered, the operator
     watched the help menu appear, and the transcript held 37 records / 3 user records / ZERO
     containing the needle — the CLI handles it client-side and writes nothing. Verification
     therefore failed for a delivery that had plainly succeeded, and the command was typed THREE
     times before MAX_DELIVERY_ATTEMPTS stopped it.
     Retry only pays when a miss is EVIDENCE of a failed send. For a slash command it is not, so
     attempts 2 and 3 were pure cost — a visible duplicate for the operator, no information for us. */
  assert.equal(maxAttemptsFor('/help'), 1, 'a slash command gets one attempt');
  assert.equal(maxAttemptsFor('/aios:today'), 1);
  assert.equal(maxAttemptsFor('  /config'), 1, 'leading whitespace does not change the shape');
  assert.equal(maxAttemptsFor('respond with: bus ok'), TIMINGS.MAX_DELIVERY_ATTEMPTS, 'plain text keeps the protocol default');
  assert.equal(maxAttemptsFor('hello /help'), TIMINGS.MAX_DELIVERY_ATTEMPTS, 'a command mid-sentence is not a command');

  // and the decision agrees with the gate, which is the whole reason the cap is passed in
  const miss = { targetAlive: true, targetBusy: false, heldMs: 60_000 };
  assert.equal(decideAfterVerifyMiss({ ...miss, attempts: 1, maxAttempts: maxAttemptsFor('/help') }).do, 'wait',
    'after one attempt a slash command must WAIT, never re-type');
  assert.equal(decideAfterVerifyMiss({ ...miss, attempts: 1, maxAttempts: maxAttemptsFor('plain text') }).do, 'retry',
    'plain text still retries — it produces a verifiable turn, so a miss IS evidence');
  // it still waits out the hold budget rather than giving up: /config DOES write a record and may
  // verify late, while /help never will. Waiting covers both; re-typing covers neither.
  assert.notEqual(decideAfterVerifyMiss({ ...miss, attempts: 1, maxAttempts: 1 }).do, 'retire');
});

test('DELIBERATE EDGE CASE: a path-shaped prompt is treated as a command', () => {
  /* Documented rather than out-smarted. Consequence: if such a message were genuinely dropped it
     dead-letters LOUDLY instead of retrying — the safe direction. A path-vs-command heuristic
     would be wrong in subtler ways than this is. */
  assert.equal(maxAttemptsFor('/Users/someone/notes/file.md please read this'), 1);
});

test('REGRESSION — a surface never re-claims its own release (the 19:43 self-loop)', () => {
  /* Captured live 2026-08-14 from ~/.aios/logs/command-bus.log, three lines 100ms apart:
       19:43:05.242 [app:6322] released relay-test.json for a sibling (no pane by that name…); release 1/2
       19:43:05.342 [app:6322] released relay-test.json for a sibling (no pane by that name…); release 2/2
       19:43:05.444 [app:6322] DEAD LETTER — a message to 'bus-test' was never delivered
     The App claimed a send for a session hosted in the IDE, correctly found no pane, handed it to
     "a sibling" — and re-claimed its own release twice, spending MAX_RELEASES before Glass's
     watcher ever fired. The message never reached the only surface that could deliver it.
     The bias is structural: a release writes back into the directory the releaser is already
     watching with a hot watcher, while a sibling waits on an OS notification. */
  const fresh = 0, stale = TIMINGS.RETIRE_TTL_MS;

  // before the fix: an unaddressed request is always claimable, so the releaser takes it back
  assert.equal(claimVerdict(undefined, 'app', fresh, TIMINGS.RETIRE_TTL_MS, [], 'app:1'), 'claim');

  // after: the surface that already tried must not claim again
  assert.equal(claimVerdict(undefined, 'app', fresh, TIMINGS.RETIRE_TTL_MS, ['app:1'], 'app:1'), 'skip',
    'the releaser must not re-claim its own release');
  // …while the sibling still can, which is the whole point of releasing
  assert.equal(claimVerdict(undefined, 'glass', fresh, TIMINGS.RETIRE_TTL_MS, ['app:1'], 'glass:2'), 'claim',
    'the sibling the release was FOR must still be able to take it');
});

test('NOTHING ROTS — a handed-back request nobody takes dead-letters instead of sitting forever', () => {
  /* `_tried` would otherwise trade a false dead letter for a SILENT one: with no sibling running,
     the releaser skips its own file and nothing else ever fires. So the same grace an absent
     addressee gets applies here, and then the request is retired honestly. */
  assert.equal(claimVerdict(undefined, 'app', TIMINGS.RETIRE_TTL_MS, TIMINGS.RETIRE_TTL_MS, ['app:1'], 'app:1'), 'retire');
  assert.equal(claimVerdict(undefined, 'app', TIMINGS.RETIRE_TTL_MS - 1, TIMINGS.RETIRE_TTL_MS, ['app:1'], 'app:1'), 'skip',
    'one millisecond short of the grace is still a sibling’s chance');
});

test('addressing still wins over tried — an addressed request is never touched by the other surface', () => {
  // Ordering matters: `surface` is an instruction, `_tried` is history. The instruction comes first.
  assert.equal(claimVerdict('glass', 'app', 0, TIMINGS.RETIRE_TTL_MS, []), 'skip');
  assert.equal(claimVerdict('glass', 'app', 0, TIMINGS.RETIRE_TTL_MS, ['glass:2'], 'app:1'), 'skip',
    'even if glass already tried, app must not take a glass-addressed request while it is fresh');
  assert.equal(claimVerdict('glass', 'glass', 0, TIMINGS.RETIRE_TTL_MS, []), 'claim',
    'and the addressee itself still claims');
});

test('triedBy / withTried: tolerant of junk, idempotent, order-preserving, non-mutating', () => {
  assert.deepEqual(triedBy(undefined), []);
  assert.deepEqual(triedBy({}), []);
  assert.deepEqual(triedBy({ _tried: 'app:1' }), [], 'a string is not a list — do not guess');
  assert.deepEqual(triedBy({ _tried: ['app:1', 7, null, 'glass:2'] }), ['app:1', 'glass:2'], 'junk dropped');
  assert.equal(fulfillerId('app', 1234), 'app:1234', 'the id is the pair `_claim` already records');
  assert.deepEqual(withTried({}, 'app:1')._tried, ['app:1']);
  assert.deepEqual(withTried({ _tried: ['app:1'] }, 'app:1')._tried, ['app:1'], 'idempotent');
  assert.deepEqual(withTried({ _tried: ['app:1'] }, 'glass:2')._tried, ['app:1', 'glass:2'], 'order preserved');
  const orig: Record<string, unknown> = { _tried: ['app:1'] };
  withTried(orig, 'glass:2');
  assert.deepEqual(orig._tried, ['app:1'], 'returns a copy — the release path re-reads the file');
});

test('MULTI-WINDOW — a second window of the SAME surface is still a valid sibling', () => {
  /* The reason `_tried` is keyed by instance and not by surface name. This file's own release doc
     says "another window may own that terminal", and MAX_RELEASES is documented as "sibling-window
     handoffs" — so two App windows are two candidate fulfillers of one surface. Keying by surface
     would have blocked the exact handoff the bound exists for.
     Caught 2026-08-14 when a leftover dev instance raced a fresh one and both were 'app'. */
  const tried = ['app:1000'];
  assert.equal(claimVerdict(undefined, 'app', 0, TIMINGS.RETIRE_TTL_MS, tried, 'app:1000'), 'skip',
    'the instance that released must abstain');
  assert.equal(claimVerdict(undefined, 'app', 0, TIMINGS.RETIRE_TTL_MS, tried, 'app:2000'), 'claim',
    'a DIFFERENT window of the same surface is a legitimate sibling');
  assert.equal(claimVerdict(undefined, 'glass', 0, TIMINGS.RETIRE_TTL_MS, tried, 'glass:3000'), 'claim',
    'and the other surface, as before');
  // no id supplied (a caller that does not know its own identity) → never blocked
  assert.equal(claimVerdict(undefined, 'app', 0, TIMINGS.RETIRE_TTL_MS, tried), 'claim');
});

test('REGRESSION — adoptHolds must never adopt a hold this process is already working', () => {
  /* Measured 2026-08-14 in a dev App: one request produced TWO delivery loops in one process.
     The startup drain claims every pending `.json` into `.holding` stamped with our own pid, and
     adoptHolds runs immediately after — so `stamp.pid !== process.pid` (which forced
     holderAlive=false for our own stamp) made it adopt what the drain had just claimed.
     I had inspected this clause the same morning and concluded it was safe because adoptHolds
     "runs once at startup". It does — right after the drain that creates exactly such a hold.
     Guarded statically: the ordering lives in initCommandBus and cannot be exercised here. */
  const src = fs.readFileSync('src/main/commandBus.ts', 'utf8');
  assert.match(src, /if \(stamp && stamp\.pid === process\.pid\) \{/,
    'a self-stamped hold must be skipped outright, not fed to canAdoptHold');
  assert.doesNotMatch(src, /stamp\.pid !== process\.pid && alive\(/,
    'the clause that inverted our own liveness must not come back');
  // and the drain still has to run before adoptHolds — that order is what makes the guard needed
  const drain = src.indexOf("if (f.endsWith('.json')) consume(getWin,");
  const adopt = src.indexOf('adoptHolds(getWin, dir)', drain);
  assert.ok(drain > 0 && adopt > drain, 'the drain precedes adoptHolds — the guard exists for that');
});

test('surfaceForAncestry: nearest ancestor wins, and NEITHER is a supported answer', () => {
  /* The requester-side half of surface awareness: a session that wants a worker in the surface it
     already lives in derives that from its own process ancestry, compared against the pids the
     surfaces announce. Pids, not process names — Glass runs inside whatever IDE the operator uses
     (Antigravity, VS Code, Cursor, Windsurf), so a name list breaks the day they switch. */
  const present = [{ surface: 'app', pid: 100 }, { surface: 'glass', pid: 200 }];
  assert.equal(surfaceForAncestry([9, 8, 100, 1], present), 'app');
  assert.equal(surfaceForAncestry([9, 200, 1], present), 'glass');
  // NEAREST wins: a dev host running inside the App resolves to the inner surface
  assert.equal(surfaceForAncestry([9, 200, 100, 1], present), 'glass', 'nearest ancestor, not outermost');
  /* undefined is NOT an error — a `spawn`-wrapper session in a plain Terminal window belongs to
     neither surface, and those must stay reachable. Callers treat it as "let them race". */
  assert.equal(surfaceForAncestry([9, 8, 1], present), undefined);
  assert.equal(surfaceForAncestry([], present), undefined);
  assert.equal(surfaceForAncestry([100], []), undefined, 'nothing announced → nothing derivable');
});

test('parsePresence rejects junk rather than inventing a surface', () => {
  /* A malformed or absent presence record must read as "not running". Guessing would route a spawn
     into a surface that is not there, which fails later and further from the cause. */
  assert.deepEqual(parsePresence({ surface: 'app', pid: 42 }), { surface: 'app', pid: 42 });
  assert.equal(parsePresence(undefined), undefined);
  assert.equal(parsePresence({}), undefined);
  assert.equal(parsePresence({ surface: 'app' }), undefined, 'no pid');
  assert.equal(parsePresence({ surface: 'nope', pid: 42 }), undefined, 'not a known surface');
  assert.equal(parsePresence({ surface: 'app', pid: 'x' }), undefined, 'pid must be a number');
  assert.equal(parsePresence({ surface: 'app', pid: Infinity }), undefined, 'and finite');
});

test('the presence file lives OUTSIDE the inbox — the watchers claim *.json', () => {
  /* A presence record written into the inbox would be picked up as a request and "fulfilled".
     Asserted because the mistake is invisible until something tries to spawn a session named after
     a surface. */
  const src = fs.readFileSync('src/main/commandBus.ts', 'utf8');
  const m = /['"`]\.aios['"`],\s*['"`]surfaces['"`]/.exec(src);
  assert.ok(m, 'presence must be written under ~/.aios/surfaces');
  assert.doesNotMatch(src, /spawn-inbox['"`]\),\s*`\$\{[a-zA-Z_]*[Ss]urface\}\.json`/,
    'never inside the inbox directory');
});
