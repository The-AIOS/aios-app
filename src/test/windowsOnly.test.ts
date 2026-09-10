/**
 * The two Windows-only fixes, and the property that matters most about both:
 * **they cannot change macOS or Linux.**
 *
 * The operator's constraint was explicit — *"be careful not to break things that are already
 * working for us and linux"* — so each of these is gated at the point of use rather than trusted
 * to a comment, and this file asserts the gate rather than the intent.
 *
 * Neither can be verified from macOS. A green run here is not evidence that either WORKS; it is
 * evidence that neither can reach a platform where the behaviour is already correct.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';

const main = fs.readFileSync('src/main/main.ts', 'utf8');
const bus = fs.readFileSync('src/main/commandBus.ts', 'utf8');
const codeOf = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').map((l) => l.split('//')[0]).join('\n');

test('A · the alternate-screen default is Windows-only, and an operator can override it', () => {
  /* WHY IT EXISTS: a session runs in the alternate screen with mouse tracking `any`, so the
     terminal holds ZERO scrollback and the wheel is encoded as an SGR mouse report for Claude to
     act on. On macOS it arrives and Claude scrolls; on Windows it does not, in every terminal.
     Turning the alternate screen off moves the output into the normal buffer, where the
     terminal's own scrollback works — the path that already works on that machine. */
  const code = codeOf(main);
  assert.match(code, /process\.platform === 'win32' && !env\.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN/,
    'gated on win32 AND on the operator not having set it');

  /* A DEFAULT, NOT A HARDCODE. This is Claude's variable, not ours — the neighbouring lines force
     OUR variables and are right to, but an operator who wants the alternate screen must keep it
     by exporting their own value. Forcing it would also fail SILENTLY the day upstream renames
     the knob, which is the worse half of the risk. */
  const forced = code.split('\n')
    .filter((l) => l.includes('CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN') && !l.includes('!env.'));
  assert.deepEqual(forced.map((l) => l.trim()), ["env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN = '1';"],
    'the only assignment must be the one inside the guard');

  /* NOT LINUX. The mechanism is ConPTY; Linux has a real pty like macOS and shows no defect.
     Changing a platform nobody measured would trade a known-good behaviour for a guess. */
  assert.doesNotMatch(code, /platform !== 'darwin'[^\n]*ALTERNATE_SCREEN/,
    'do not widen this to "everything but macOS" — Linux was never measured');
});

test('B · resolveTier finds an interpreter, and refuses by NAME when it cannot (AI-146)', () => {
  /* MEASURED on Windows: a request carrying a tier retired as `spawnSync bash ENOENT`, while the
     same request without the field was fulfilled. The resolver is fine; the App's Node process
     simply has no shell. `ENOENT` reads like the hook is broken and sends the operator to the
     wrong file — so the refusal has to name the missing interpreter. */
  assert.match(bus, /function resolveBash\(\): string \| null \{/, 'the resolver must exist');
  const fn = bus.slice(bus.indexOf('function resolveBash()'));
  const body = fn.slice(0, fn.indexOf('\n}'));

  /* STEP 1 IS "DO NOT TOUCH THE WORKING PATH". Non-Windows returns the bare word, so macOS and
     Linux behaviour is byte-identical to before this change. */
  assert.match(body, /if \(process\.platform !== 'win32'\) return 'bash';/,
    'non-Windows must return the same bare interpreter it always used');

  /* The ordered lookup, each step proving something different. */
  assert.match(body, /process\.env\.SHELL/, '2 · launched from a bash');
  assert.match(body, /execFileSync\('where', \['bash'\]/, "3 · on PATH, via Windows' own lookup");
  assert.match(body, /Git', 'bin', 'bash\.exe'/, '4 · where Git for Windows actually puts it');
  assert.match(body, /return null;/, '5 · nothing found is a refusal, not a fallback');

  /* NEVER DEFAULT A MODEL. A loud dead letter beats a silent wrong model — that is the whole
     value of the four contract branches, and defaulting on failure would spend it. */
  assert.doesNotMatch(body, /return 'sh'|claude-|--model/, 'no model, no shell substitute, on failure');
  const call = bus.slice(bus.indexOf('const bash = resolveBash();'));
  const guard = call.slice(0, call.indexOf('try {'));
  assert.match(guard, /no bash interpreter found/, 'the refusal names what is missing');
  assert.match(guard, /\$SHELL/, 'and says where it looked, so the operator can fix it');

  /* THE FOUR CONTRACT BRANCHES SURVIVE — they are the value in that function, not the interpreter.
     Empty-at-exit-0 is a real answer (inherit the default) and must never become --model "". */
  assert.match(bus, /return model \? \{ model \} : \{\};/, 'empty + exit 0 passes NO flag');
  assert.match(bus, /is missing — run \/aios:update/, 'an absent hook still refuses and says how to get it');
  assert.match(bus, /rejected \(exit \$\{err\.status \?\? '\?'\}\)/, 'a non-zero exit still quotes the script');

  /* The interpreter is used, not merely computed — the shape of a fix that looks done and is not. */
  assert.match(bus, /execFileSync\(bash, \[hook, tier\]/, 'the resolved interpreter must be the one invoked');
  assert.doesNotMatch(codeOf(bus), /execFileSync\('bash', \[hook/, 'the bare word must be gone from the call');
});
