/**
 * The interpreter ordering, exercised from a machine that is not Windows.
 *
 * The spec that decided AI-146 says the quiet part out loud: *"a green CI on Linux is not
 * evidence here."* That is true of the END-TO-END behaviour and always will be — but it must not
 * become an excuse for shipping the ORDERING untested, which is the part that is pure logic and
 * has four ways to be wrong. Hence a pure decision with the filesystem injected: every Windows
 * branch below runs on macOS and in CI.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { pickBash, gitBashCandidates } from '../core/bashResolve';

const never = () => false;
const only = (...ok: string[]) => (p: string) => ok.includes(p);

test('every platform that already works keeps the bare word — unchanged, and first', () => {
  /* Step 1 is what protects the operator's stated constraint. If this ever stops returning
     'bash' verbatim, macOS and Linux inherit a Windows bug fix they never needed. */
  for (const plat of ['darwin', 'linux', 'freebsd', 'aix']) {
    assert.equal(pickBash(plat, { exists: never }), 'bash', `${plat} must be untouched`);
  }
  /* And it must not consult ANYTHING first — a $SHELL of /bin/zsh must not change the answer. */
  assert.equal(pickBash('darwin', { shell: '/bin/zsh', exists: () => true }), 'bash');
});

test('on Windows the order is $SHELL, then PATH, then Git for Windows', () => {
  const SH = 'C:\\Program Files\\Git\\usr\\bin\\bash.exe';
  const HIT = 'C:\\other\\bash.exe';
  /* $SHELL wins when it names a bash that exists — the app was launched FROM one. */
  assert.equal(pickBash('win32', { shell: SH, pathHit: HIT, exists: only(SH, HIT) }), SH);
  /* A $SHELL that is not a bash is ignored rather than trusted. PowerShell is not an
     interpreter for a `#!/usr/bin/env bash` script, and using it would fail confusingly. */
  assert.equal(pickBash('win32', { shell: 'C:\\...\\powershell.exe', pathHit: HIT, exists: () => true }), HIT);
  /* A $SHELL that names a bash which is GONE falls through rather than returning a dead path. */
  assert.equal(pickBash('win32', { shell: SH, pathHit: HIT, exists: only(HIT) }), HIT);
  /* Nothing on PATH → the known install locations, in order. */
  const [first, second] = gitBashCandidates('C:\\Program Files');
  assert.equal(pickBash('win32', { programFiles: 'C:\\Program Files', exists: only(first, second) }), first);
  assert.equal(pickBash('win32', { programFiles: 'C:\\Program Files', exists: only(second) }), second);
  /* The per-user install, which is where Git lands without admin rights. */
  const local = 'C:\\Users\\x\\AppData\\Local';
  const perUser = gitBashCandidates('C:\\Program Files', local)[2];
  assert.equal(pickBash('win32', { programFiles: 'C:\\Program Files', localAppData: local, exists: only(perUser) }), perUser);
});

test('found nothing is a REFUSAL — never a substitute', () => {
  /* This is the branch the whole fix exists to make honest. Defaulting to a model on failure
     would spend exactly what the four contract branches bought: a loud dead letter beats a
     silent wrong model. `null` is the only acceptable answer. */
  assert.equal(pickBash('win32', { exists: never }), null);
  assert.equal(pickBash('win32', { shell: 'C:\\sh.exe', pathHit: 'C:\\nope.exe', exists: never }), null,
    'a $SHELL that is not bash and a PATH hit that does not exist still means refuse');
});

test('a missing LOCALAPPDATA drops the per-user candidate rather than inventing a path', () => {
  /* `undefined` in a path template produces "undefined\\Programs\\Git" — a real string that
     existsSync will happily answer false for, which is harmless but is the shape of the bug that
     produces "C:\\undefined\\..." in a log and sends someone hunting. */
  const c = gitBashCandidates('C:\\PF');
  assert.equal(c.length, 2);
  assert.ok(!c.some((x) => /undefined/.test(x)), 'no undefined may reach a candidate path');
});
