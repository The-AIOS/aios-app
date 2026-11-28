/** The guards asked right before a bus message is typed into a session. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  operatorComposing, operatorAtTerminal, composeStaleMs, hasPromptStash, landedBeforeRetype,
  COMPOSE_QUIET_MS, COMPOSE_STALE_MS, COMPOSE_STALE_STASH_MS, STASH_MIN_VERSION,
} from '../src/sendGuards';

const NOW = 1_800_000_000_000;

test('operatorComposing: a surface that sees keystrokes holds while a draft is being written', () => {
  assert.equal(operatorComposing(undefined, NOW), false, 'nothing reported: nobody is writing');
  assert.equal(operatorComposing({ composing: true, at: NOW - 1000 }, NOW), true, 'a draft, a key a second ago');
  assert.equal(operatorComposing({ composing: true, at: NOW - COMPOSE_STALE_MS }, NOW), false, 'a draft nobody touched for three minutes is abandoned');
  assert.equal(operatorComposing({ composing: false, at: NOW - COMPOSE_QUIET_MS + 1 }, NOW), true, 'just sent: the box is not pulled away mid-thought');
  assert.equal(operatorComposing({ composing: false, at: NOW - COMPOSE_QUIET_MS }, NOW), false);
  assert.equal(operatorComposing({ composing: true, at: NOW - COMPOSE_STALE_STASH_MS }, NOW, COMPOSE_STALE_STASH_MS), false, 'with the stash, ten quiet seconds are enough');
});

test('the caps: ten seconds when the session sets a draft aside before a send, three minutes when it does not', () => {
  assert.equal(composeStaleMs(true), 10_000);
  assert.equal(composeStaleMs(false), 3 * 60 * 1000);
  assert.equal(hasPromptStash(STASH_MIN_VERSION), true);
  assert.equal(hasPromptStash('2.1.332'), true);
  assert.equal(hasPromptStash('2.1.68'), false);
  assert.equal(hasPromptStash(undefined), false, 'no version in the registry: assume no stash');
  assert.equal(hasPromptStash('junk'), false);
});

test('operatorAtTerminal: a surface that cannot see keystrokes holds while the operator is at that terminal', () => {
  /* An editor's extension API says which terminal is active and whether the window has focus,
     never what is being typed. "At that terminal" is the nearest signal there is. */
  const first = operatorAtTerminal({ present: true, holdSince: undefined, now: NOW, staleMs: COMPOSE_STALE_MS });
  assert.deepEqual(first, { do: 'hold', holdSince: NOW }, 'the hold starts when the guard first finds the operator there');
  const later = operatorAtTerminal({ present: true, holdSince: first.holdSince, now: NOW + 60_000, staleMs: COMPOSE_STALE_MS });
  assert.deepEqual(later, { do: 'hold', holdSince: NOW }, 'and keeps its start: the cap is not pushed back on every look');
});

test('operatorAtTerminal: when the operator is not at that terminal, the message goes', () => {
  /* This is also where the guard is weaker than the App's: a draft LEFT in the box when the
     operator switched away is not seen, and the message is typed onto it. Nothing here can know. */
  assert.deepEqual(operatorAtTerminal({ present: false, holdSince: undefined, now: NOW, staleMs: COMPOSE_STALE_MS }), { do: 'go', holdSince: undefined });
  assert.deepEqual(operatorAtTerminal({ present: false, holdSince: NOW - 5000, now: NOW, staleMs: COMPOSE_STALE_MS }), { do: 'go', holdSince: undefined },
    'another terminal became active, or the window lost focus');
});

test('operatorAtTerminal: the hold is capped, because "at the terminal" is also true of someone only reading', () => {
  assert.equal(operatorAtTerminal({ present: true, holdSince: NOW, now: NOW + COMPOSE_STALE_MS - 1, staleMs: COMPOSE_STALE_MS }).do, 'hold');
  assert.equal(operatorAtTerminal({ present: true, holdSince: NOW, now: NOW + COMPOSE_STALE_MS, staleMs: COMPOSE_STALE_MS }).do, 'go', 'past three minutes the message is typed');
  // the cap is the caller's: a surface that stashes the draft itself may pass the shorter one
  assert.equal(operatorAtTerminal({ present: true, holdSince: NOW, now: NOW + COMPOSE_STALE_STASH_MS, staleMs: COMPOSE_STALE_STASH_MS }).do, 'go');
});

test('operatorAtTerminal: leaving and coming back starts the count again', () => {
  const left = operatorAtTerminal({ present: false, holdSince: NOW - 9000, now: NOW, staleMs: 10_000 });
  const back = operatorAtTerminal({ present: true, holdSince: left.holdSince, now: NOW + 1, staleMs: 10_000 });
  assert.deepEqual(back, { do: 'hold', holdSince: NOW + 1 });
});

test('operatorAtTerminal: "never held" is not a time — zero is a valid clock reading, and a start in the future is ignored', () => {
  const atZero = operatorAtTerminal({ present: true, holdSince: undefined, now: 0, staleMs: 1000 });
  assert.deepEqual(atZero, { do: 'hold', holdSince: 0 });
  assert.deepEqual(operatorAtTerminal({ present: true, holdSince: atZero.holdSince, now: 999, staleMs: 1000 }), { do: 'hold', holdSince: 0 }, 'the hold that began at 0 is the same hold');
  assert.equal(operatorAtTerminal({ present: true, holdSince: atZero.holdSince, now: 1000, staleMs: 1000 }).do, 'go');
  // the wall clock stepped back: a start that is now in the future must not hold past the cap
  const stepped = operatorAtTerminal({ present: true, holdSince: NOW + 60_000, now: NOW, staleMs: 1000 });
  assert.deepEqual(stepped, { do: 'hold', holdSince: NOW });
});

test('operatorAtTerminal: junk fails open — a message is typed, not held forever', () => {
  assert.equal(operatorAtTerminal({ present: true, holdSince: NOW, now: NaN, staleMs: 1000 }).do, 'go');
  assert.equal(operatorAtTerminal({ present: true, holdSince: NOW, now: NOW, staleMs: NaN }).do, 'go');
  assert.equal(operatorAtTerminal({ present: true, holdSince: undefined, now: NOW, staleMs: 0 }).do, 'go');
  assert.equal(operatorAtTerminal({ present: true, holdSince: NOW, now: NOW + 1, staleMs: Infinity }).do, 'go', 'a cap that is not a number is no cap: it must not become "hold for as long as the operator stays"');
});

test('landedBeforeRetype: asked before every re-type', () => {
  assert.equal(landedBeforeRetype(true, 0, 1), true, 'the earlier copy arrived: do not type again');
  assert.equal(landedBeforeRetype(true, 0, 0), false);
  assert.equal(landedBeforeRetype(false, 0, 1), false, 'the first type is never skipped');
});
