import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as crypto from 'crypto';

/* WHAT THIS SURFACE OWES THE BUS PROTOCOL.
 *
 * The protocol itself (the timings, the decision table, the verb rule, name resolution, presence)
 * lives in `@the-aios/core`, the package the App and Glass both run, and is tested there
 * (packages/core/test/protocol.test.ts). One version, so there is no copy here to pin by hash.
 *
 * What stays in this repo is what only this repo can check: that the App's own dispatcher
 * (src/main/commandBus.ts) consults the shared rules in the right order, and the three files that
 * are still one file in two repos (resumeIndex, privateRun, handoffDir), pinned by hash until they
 * move into the package too.
 */

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

test('a DEV App must not overwrite the real presence record', () => {
  /* Observed 2026-08-14: a dev App launched from a terminal inside an App-hosted session walked up
     to the INSTALLED App's pid and announced it as its own root, rewriting ~/.aios/surfaces/app.json.
     The value matched that time. From a plain terminal it would have written a pid that is not the
     installed App, and every session that App hosts would then derive "neither" — the feature
     silently doing nothing, which is the failure mode this whole subsystem specialises in.
     Glass deliberately still announces in a dev host: its root is the IDE either way, so a dev host
     and the installed extension write the same pid. */
  const src = fs.readFileSync('src/main/commandBus.ts', 'utf8');
  const fn = /function announcePresence\([\s\S]*?\n\}/.exec(src);
  assert.ok(fn, 'announcePresence must exist');
  assert.match(fn![0], /if \(!app\.isPackaged\)[\s\S]*?return;/,
    'a dev build must return before writing the presence file');
  const guard = fn![0].indexOf('app.isPackaged');
  const write = fn![0].indexOf('writeFileSync');
  assert.ok(guard > 0 && write > guard, 'the guard must precede the write, not follow it');
});

/* Where this surface reads the verb, and where it acts on it. The App parses in core and
   dispatches in main; Glass does both in extension.ts. Only these bindings differ. */
const VERB_PARSER = 'src/core/commandBus.ts';
const DISPATCHER = 'src/main/commandBus.ts';
const DISPATCH_FN = 'function runImmediate';
const LAUNCH = 'runSpawn(win, heldPath, req)';

test('PROTOCOL: this surface refuses an unknown verb before launching anything', () => {
  /* Each surface implements the dispatch itself, so this reads the source rather than the
     module: the shared rule is only worth having if the local dispatcher actually consults it
     and stops. */
  const strip = (f: string) => fs.readFileSync(f, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  const parser = strip(VERB_PARSER);
  assert.doesNotMatch(parser, /back-compat with plain/, 'the comment stripper did not strip');
  assert.match(parser, /function |=>/, 'the comment stripper ate the code');
  assert.match(parser, /normalizeVerb\(/, 'the verb must be read through the shared rule, not restated');
  /* Scoped to the dispatch function's own body: searching the whole file would match
     the launcher's DEFINITION (and its import), both of which legitimately precede the check. */
  const whole = strip(DISPATCHER);
  const body = whole.slice(whole.indexOf(DISPATCH_FN));
  assert.ok(whole.includes(DISPATCH_FN), 'the dispatch function must exist — this guard reads the wrong file otherwise');
  const refusal = body.indexOf("=== 'unknown'");
  assert.ok(refusal > 0, 'the dispatcher must handle the unknown verb explicitly');
  const launch = body.indexOf(LAUNCH);
  assert.ok(launch > 0, 'the launcher must be called from the dispatcher — this guard proves nothing otherwise');
  assert.ok(refusal < launch, 'the refusal must come before any launcher runs');
});

/* The resume index is ONE file in two repos (App main/resumeIndex.ts, Glass
   agents/resumeIndex.ts). Pinned whole: an edit on one side alone goes red.
   The digest moved once without the code changing: the file's one import of the name-resolution
   rule now names the package (`@the-aios/core/resumeTarget`) where it named `../core/resumeTarget`
   (2932f09b4970ba40 before). Glass's copy takes the same line, and this same digest, when it adopts
   the package; until then the two digests differ by that one line and nothing else. */
const RESUME_INDEX_SHA = '9f096265ba399889';
test('PROTOCOL: the resume index is byte-identical across both fulfillers', () => {
  const src = fs.readFileSync('src/main/resumeIndex.ts', 'utf8');
  assert.equal(crypto.createHash('sha256').update(src).digest('hex').slice(0, 16), RESUME_INDEX_SHA,
    'resumeIndex.ts changed: make the same edit in the sibling repo and update RESUME_INDEX_SHA in BOTH.');
});

const PRIVATE_RUN_SHA = '6383fdd3758496ab';
test('PROTOCOL: private run files are written by byte-identical code in both surfaces', () => {
  const src = fs.readFileSync('src/main/privateRun.ts', 'utf8');
  assert.equal(crypto.createHash('sha256').update(src).digest('hex').slice(0, 16), PRIVATE_RUN_SHA,
    'privateRun.ts changed: make the same edit in the sibling repo and update PRIVATE_RUN_SHA in BOTH.');
});

const HANDOFF_DIR_SHA = 'ca911564e51186b7';
test('PROTOCOL: handed-over files get their own folder by byte-identical code in both surfaces', () => {
  const src = fs.readFileSync('src/main/handoffDir.ts', 'utf8');
  assert.equal(crypto.createHash('sha256').update(src).digest('hex').slice(0, 16), HANDOFF_DIR_SHA,
    'handoffDir.ts changed: make the same edit in the sibling repo and update HANDOFF_DIR_SHA in BOTH.');
});
