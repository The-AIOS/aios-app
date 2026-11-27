import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { normalizeVerb, BUS_VERBS } from '../src/busVerbs';
import { latestAgentName, pickResume } from '../src/resumeTarget';
import { TIMINGS, decideAfterVerifyMiss, maxAttemptsFor, claimVerdict, triedBy, withTried, fulfillerId,
  surfaceForAncestry, parsePresence, processTreeRoot, type MissAction } from '../src/sendQueue';

/* THE BUS PROTOCOL, AS BEHAVIOUR.
 *
 * The App and Glass both fulfil requests on the same bus and RACE for them, so a request must
 * behave identically whichever one wins. While each surface kept its own copy of these modules,
 * the only thing that could travel between the two repositories was a hash: each repo's
 * protocolContract test pinned the modules and this decision table by digest, and a human compared
 * the digests across two pull requests.
 *
 * Both surfaces now run this one package, so there is no second copy for a digest to compare with.
 * What stays is the behaviour itself: the agreed values, the decision table, and the regressions
 * that were measured live. Each surface keeps, in its own repo, the tests that read its own
 * dispatcher.
 *
 * WHEN ONE OF THESE FAILS: you changed the protocol. That is allowed, and it is a PROTOCOL change:
 * it ships as a new version of this package, both surfaces move to it, and the inbox README's
 * invariants section says so.
 */

test('PROTOCOL: the values themselves are the agreed ones', () => {
  // Belt and braces: the hash catches edits, these catch a hash updated without thought.
  assert.equal(TIMINGS.QUEUE_CEILING_MS, 24 * 60 * 60 * 1000, 'A busy target is waited on until its next idle');
  assert.equal(TIMINGS.HOLD_STALE_MS, 24 * 60 * 60 * 1000 + 45 * 60 * 1000);
  assert.ok(TIMINGS.HOLD_STALE_MS > TIMINGS.QUEUE_CEILING_MS + TIMINGS.MAX_HOLD_MS, 'stale must exceed the WORST-CASE legitimate hold: queued to the ceiling, then watched for verification (should-fix 7)');
  assert.equal(TIMINGS.MAX_HOLD_MS, 30 * 60 * 1000);
  assert.ok(TIMINGS.HOLD_STALE_MS > TIMINGS.QUEUE_CEILING_MS, 'a LIVE holder waiting for an idle target must never look stale to a sibling');
  assert.equal(TIMINGS.RETIRE_TTL_MS, 10 * 60 * 1000);
  assert.equal(TIMINGS.MAX_RELEASES, 2);
  assert.equal(TIMINGS.MAX_DELIVERY_ATTEMPTS, 3);
  // MAX_HOLD_MS must stay below HOLD_STALE_MS or a claimer gives up after its hold is adoptable.
  assert.ok(TIMINGS.MAX_HOLD_MS < TIMINGS.HOLD_STALE_MS, 'a fulfiller must give up before its claim goes stale');
});

/* The four-way decision after a delivery that did not verify.
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

/* ── THE DECISION TABLE ─────────────────────────────────────────────────────
   Same inputs, same action, on every surface that runs this package. */
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

test('processTreeRoot finds the pid a session actually sees, and cannot hang', () => {
  /* The bug this fixes, measured 2026-08-14 in a live dev host: Glass announced its EXTENSION HOST
     (53705, a "Helper (Plugin)" process) while a terminal it owns descended from the ptyHost
     (92733, a plain "Helper"). Siblings — both children of the IDE's Electron root 92519 — so every
     IDE-hosted session derived "neither", defeating the whole point of the record. Both resolve to
     92519, which is the pid to announce. */
  const tree: Record<number, number> = { 66663: 66468, 66468: 92733, 92733: 92519, 92519: 1, 53705: 92519 };
  const parentOf = (p: number) => tree[p] ?? 0;
  assert.equal(processTreeRoot(53705, parentOf), 92519, 'the extension host resolves to the IDE root');
  assert.equal(processTreeRoot(66663, parentOf), 92519, 'and so does a terminal session under it');
  assert.equal(processTreeRoot(92519, parentOf), 92519, 'a root resolves to itself');

  // an unreadable parent stops the walk rather than returning something wrong
  assert.equal(processTreeRoot(4242, () => 0), 4242);
  // a cycle must terminate — a hang here would block startup, which is worse than a wrong answer
  const cyclic = (p: number) => (p === 7 ? 8 : 7);
  assert.ok([7, 8].includes(processTreeRoot(7, cyclic)), 'a cycle terminates');
  // and a pathologically deep tree is bounded
  /* Step by 2 so the walk never lands on pid 1 — that value is the reached-init sentinel and
     returns immediately, which is what made the first version of this assertion wrong. */
  assert.equal(processTreeRoot(0, (p) => p + 2), 64, 'bounded at 32 hops');
});

test('PROTOCOL: a renamed session resolves by its LATEST name, and never to itself', () => {
  const rec = (n: string) => JSON.stringify({ type: 'agent-name', agentName: n });
  assert.equal(latestAgentName([rec('app-walker'), rec('aios-app')].join('\n')), 'aios-app');
  assert.equal(pickResume('w', [
    { sessionId: 'nnnn1111-n1n1-4n1n-8n1n-nnnn11112222', mtimeMs: 9, latestName: 'w' },
    { sessionId: 'oooo1111-o1o1-4o1o-8o1o-oooo11112222', mtimeMs: 1, latestName: 'w' },
  ]), 'nnnn1111-n1n1-4n1n-8n1n-nnnn11112222');
  assert.equal(pickResume('w', [{ sessionId: 'mmmm1111-m1m1-4m1m-8m1m-mmmm11112222', mtimeMs: 9, latestName: 'w' }], 'mmmm1111-m1m1-4m1m-8m1m-mmmm11112222'), undefined);
});

test('PROTOCOL: absent means spawn, unrecognised means refuse', () => {
  /* The two halves of the one rule that resume made load-bearing. Absent is contract-1
     back-compat (`{name, task}` requests still exist); unrecognised is a typo, and answering a
     typo'd `"resmue"` with a spawn hands back a fresh something for a request that named a
     someone — the exact substitution resume exists to prevent. */
  assert.equal(normalizeVerb(undefined), 'spawn', 'contract-1 {name, task}');
  assert.equal(normalizeVerb(''), 'spawn');
  assert.equal(normalizeVerb('   '), 'spawn');
  assert.equal(normalizeVerb(42), 'spawn', 'a non-string action is no action at all');
  for (const v of BUS_VERBS) {
    assert.equal(normalizeVerb(v), v);
    assert.equal(normalizeVerb(`  ${v.toUpperCase()} `), v, 'case and space are not significant');
  }
  assert.equal(normalizeVerb('resmue'), 'unknown', 'a typo must never be guessed into a verb');
  assert.equal(normalizeVerb('frobnicate'), 'unknown');
  assert.equal(normalizeVerb('re sume'), 'unknown');
});
test('MY_SURFACE is not declared here: it is the one value that must differ per surface', () => {
  /* The DECLARATION, not the word: the module's own comment explains why it is absent. Each
     surface declares its own beside its dispatcher; a shared default would have every surface
     claiming to be the same one. */
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'sendQueue.ts'), 'utf8');
  assert.doesNotMatch(src, /export const MY_SURFACE/);
});
