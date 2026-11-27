/** One verdict for "which live session does this name mean": one, none, or ambiguous. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveName, sanitizeName, ambiguousReason, ambiguousAfterTypedReason } from '../src/nameResolve';
import { resolveSessionName, sessionKey } from '../src/nameMatch';

test('one: an exact match, or the single session whose name cleans to the same handle', () => {
  assert.deepEqual(resolveName('w', ['w', 'x']), { kind: 'one', name: 'w' });
  assert.deepEqual(resolveName('market-desk', ['Market-desk', 'x']), { kind: 'one', name: 'Market-desk' });
  // exact wins over a look-alike, as nameMatch has always had it
  assert.deepEqual(resolveName('market-desk', ['Market-desk', 'market-desk']), { kind: 'one', name: 'market-desk' });
});

test('none: nobody answers, and an empty handle never matches anything', () => {
  assert.deepEqual(resolveName('w', ['x', 'y']), { kind: 'none' });
  assert.deepEqual(resolveName('w', []), { kind: 'none' });
  assert.deepEqual(resolveName('---', ['---']).kind, 'one', 'an exact match is still an exact match');
  assert.deepEqual(resolveName('!!!', ['x']), { kind: 'none' });
});

test('ambiguous: two sessions that clean to the same handle, with the names that collided', () => {
  assert.deepEqual(resolveName('market-desk', ['Market-desk', 'MARKET-DESK', 'x']),
    { kind: 'ambiguous', names: ['Market-desk', 'MARKET-DESK'] });
});

test('ambiguous: two sessions registered under the very same name', () => {
  /* The case a list of DISTINCT names hides: the registry holds one entry per session, and two of
     them can carry one name. The first one listed is not "the" session. */
  assert.deepEqual(resolveName('w', ['w', 'x', 'w']), { kind: 'ambiguous', names: ['w', 'w'] });
  assert.deepEqual(resolveName('W', ['w', 'w']), { kind: 'ambiguous', names: ['w', 'w'] });
  // an exact name carried twice is ambiguous even with a look-alike beside it, and whichever is asked for
  assert.deepEqual(resolveName('w', ['w', 'w', 'W']), { kind: 'ambiguous', names: ['w', 'w'] });
  assert.deepEqual(resolveName('W', ['w', 'w', 'W']), { kind: 'one', name: 'W' }, 'the one session with exactly that name');
  assert.deepEqual(resolveName('w', ['w', 'W', 'w']).kind, 'ambiguous');
});

test('a registered name with shell metacharacters is never handed on', () => {
  assert.deepEqual(resolveName('x', ['x; rm -rf ~']), { kind: 'none' });
  assert.deepEqual(resolveName('x', ['x', 'x; rm -rf ~']), { kind: 'one', name: 'x' });
});

test('it agrees with nameMatch wherever nameMatch had an answer', () => {
  const lives = [['w'], ['Market-desk'], ['a', 'b'], ['Market-desk', 'market-desk'], ['A', 'a', 'x'], []];
  /* Where the two DIFFER, on purpose: the same name carried twice. nameMatch answers with the
     name (it sees distinct names); this refuses. */
  assert.equal(resolveSessionName('w', ['w', 'w']), 'w');
  assert.equal(resolveName('w', ['w', 'w']).kind, 'ambiguous');
  for (const live of lives) {
    for (const want of ['w', 'market-desk', 'a', 'A', 'zzz']) {
      const old = resolveSessionName(want, live);
      const v = resolveName(want, live);
      if (old !== undefined) assert.deepEqual(v, { kind: 'one', name: old }, `${want} in ${JSON.stringify(live)}`);
      else assert.notEqual(v.kind, 'one', `${want} in ${JSON.stringify(live)}: nameMatch refused, so must this`);
    }
  }
});

test('sanitizeName is the one handle rule: lowercase kebab, no edge hyphens', () => {
  assert.equal(sanitizeName('  My Worker  '), 'my-worker');
  assert.equal(sanitizeName('-x-'), 'x', 'edge hyphens go: one surface kept them and the other did not');
  assert.equal(sanitizeName('a  b__c'), 'a-bc');
  assert.equal(sanitizeName(undefined), '');
  assert.equal(sanitizeName(42), '42');
  for (const s of ['Market-desk', ' a b ', '--x--', 'ÁÉ', '']) assert.equal(sanitizeName(s), sessionKey(s));
});

test('the dead letter names the sessions that collided', () => {
  assert.match(ambiguousReason('market-desk', ['Market-desk', 'MARKET-DESK']), /2 live sessions answer to 'market-desk' \('Market-desk', 'MARKET-DESK'\)/);
  assert.match(ambiguousReason('w', ['w', 'w']), /2 live sessions are named 'w'/);
  assert.match(ambiguousReason('w', ['w', 'w']), /not delivered to any of them/);
});

test('a send already typed when its name became ambiguous is never called "not delivered"', () => {
  const r = ambiguousAfterTypedReason('w', ['w', 'w']);
  assert.match(r, /^typed once into 'w'/);
  assert.match(r, /2 live sessions are named 'w'/);
  assert.match(r, /It MAY have been delivered: check before sending it again/);
  assert.doesNotMatch(r, /not delivered/);
});
