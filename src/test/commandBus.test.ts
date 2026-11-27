/**
 * Command-bus tests — the pure request/command model (parse · sanitize ·
 * whitelist · task-file handoff · command build), plus static invariant guards
 * that lock the 0.4.3 robustness fixes into the main-side dispatcher (mirroring
 * Glass's smoke-test guard: a refactor can't silently regress them).
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {
  parseRequest, sanitizeName, whitelistModel, whitelistTier,
  needsTaskFile, shq, taskFileInstruction, buildSpawnCmd,
} from '../core/commandBus';

test('sanitizeName: kebab handle, matches the app + Glass sanitizer', () => {
  assert.equal(sanitizeName('Heron Fleet'), 'heron-fleet');
  assert.equal(sanitizeName('  UPPER  '), 'upper');
  assert.equal(sanitizeName('a!!b'), 'ab');
  assert.equal(sanitizeName('--x--'), 'x');
  assert.equal(sanitizeName(''), '');
  assert.equal(sanitizeName(undefined), '');
});

test('whitelistModel: only claude-* ids pass; injection is dropped', () => {
  assert.equal(whitelistModel('claude-opus-4-8'), 'claude-opus-4-8');
  assert.equal(whitelistModel('claude-sonnet-5'), 'claude-sonnet-5');
  assert.equal(whitelistModel('rm -rf /'), undefined);
  assert.equal(whitelistModel('gpt-4'), undefined);
  assert.equal(whitelistModel('claude-opus; whoami'), undefined);
  assert.equal(whitelistModel(''), undefined);
});

test('whitelistTier validates SHAPE, never membership — the rung list is not ours to hold', () => {
  /* Rung-table drift. This used to be `s === 'mechanical' || s === 'judgment'` beside a local rung→model
     table, and the pair failed two different ways once the ladder grew to four rungs: `fast`,
     `scale` and `frontier` were STRIPPED here — the field gone before anything could act on
     it, worker silently on the session default — while `mechanical` and `judgment` resolved
     through the stale table to the WRONG model, which is worse because it looks like it
     worked. Membership belongs to hooks/resolve-tier and nowhere else. */
  for (const rung of ['frontier', 'judgment', 'scale', 'fast', 'mechanical']) {
    assert.equal(whitelistTier(rung), rung, `${rung} must survive parsing`);
  }
  assert.equal(whitelistTier('JUDGMENT'), 'judgment', 'case-folded');
  // a rung this build has never heard of must still reach the resolver, which adjudicates
  assert.equal(whitelistTier('some-future-rung'), 'some-future-rung');
  // shape is still enforced — this value becomes an argv entry
  for (const bad of ['', '  ', '-lead', 'has space', 'semi;colon', '$(x)', 'a'.repeat(40), '9start']) {
    assert.equal(whitelistTier(bad), undefined, `must reject ${JSON.stringify(bad)}`);
  }
});

test('no rung→model table survives anywhere in the App — one table, and it is not ours', () => {
  /* The duplication IS the defect, so the guard is an absence. Comments are stripped first:
     both files now explain the stale ids they used to carry, and a naive scan would fire on
     that prose. The two asserts under the stripper are its control — an over-eager strip would
     make every doesNotMatch below pass for the wrong reason. */
  const strip = (src: string) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  for (const f of ['src/core/commandBus.ts', 'src/main/commandBus.ts']) {
    const code = strip(fs.readFileSync(f, 'utf8'));
    assert.doesNotMatch(code, /the stale table/, `${f}: the comment stripper did not strip`);
    assert.match(code, /export function|function /, `${f}: the comment stripper ate the code`);
    assert.doesNotMatch(code, /claude-(opus|sonnet|haiku|fable)-[\d.]/,
      `${f} names a concrete model id — rung→model belongs to hooks/resolve-tier alone`);
    assert.doesNotMatch(code, /TIER_MODELS|tierToModel/, `${f} still carries a rung table`);
  }
  // and main resolves by asking that script, by name
  const main = fs.readFileSync('src/main/commandBus.ts', 'utf8');
  assert.match(main, /findHook\('resolve-tier', \(r\) => fs\.existsSync\(path\.join\(root, r\)\)\)/);   // hooks/pipeline/ first since v0.8.19 (aios#309)
});

test('presence is WIRED to the shared decision, on all three paths', () => {
  /* WHAT this file decides now lives in core/presence and is tested purely there, including the
     ordering that took the record away from a live App. What remains App-specific is the wiring,
     and the wiring is where the original bug hid: announce did not consult anything at all.
     So each of the three paths must go through the shared verdict — the earlier version of this
     test asserted the literal text of ONE of them, which is how a protocol ends up enforced on
     the exit and not the entrance. */
  const main = fs.readFileSync('src/main/commandBus.ts', 'utf8');
  const fn = (name: string): string => {
    const i = main.indexOf(`function ${name}(`);
    assert.notEqual(i, -1, `${name} must exist`);
    const rest = main.slice(i + 1);
    const j = rest.indexOf('\nfunction ');
    return rest.slice(0, j === -1 ? undefined : j);
  };

  assert.match(fn('announcePresence'), /presenceVerdict\([\s\S]{0,80}?'leave'/,
    'ARRIVING must defer to a live incumbent — this is the half that was missing');
  assert.match(fn('healPresence'), /presenceVerdict\(/,
    'and the heal re-claims only when the record names nobody alive');
  assert.match(fn('retractPresence'), /mayRetract\(/,
    'LEAVING must not delete a record it does not own');

  /* Liveness is decided by a signal, never by a process name or a `ps` grep — the record exists
     precisely because Glass cannot be identified by process name. */
  /* The probe itself is the shared one (@the-aios/core/pidAlive, tested there: only ESRCH proves
     absence). What this file owes is to USE it, and to keep no second, weaker probe of its own. */
  assert.match(main, /import \{ pidAlive, ownPidAlive \} from '@the-aios\/core\/pidAlive'/, 'the shared probes are the liveness probes');
  assert.doesNotMatch(main, /process\.kill\([a-zA-Z.]+, 0\)/, 'no local signal-0 probe beside the shared one');

  // the heal must actually be scheduled, or it is a function nobody calls
  assert.match(main, /setInterval\(\(\) => healPresence\(appVersion\)/, 'the heal is on a timer');

  assert.match(main, /app\.on\('before-quit', retractPresence\)/);
  // and it stays packaged-only, symmetric with the announce it undoes
  const gate = main.slice(main.indexOf('function announcePresence'), main.indexOf('function retractPresence'));
  assert.ok(gate.indexOf('!app.isPackaged') < gate.indexOf("app.on('before-quit'"),
    'the retract must be registered behind the same isPackaged gate as the announce');
  assert.match(fn('healPresence'), /if \(!app\.isPackaged\) return;/,
    'and so is the heal — a dev build must not claim the record the installed App depends on');
});

test('the App announces ITSELF, and a reused pid or a pre-boot record never reads as alive', () => {
  /* Measured on Linux: the AppImage's parent is `systemd --user` (not pid 1), so walking the tree
     announced the session manager — an ancestor of every process the user runs — and after a
     reboot the stale record's pid was a containerd THREAD, which signal 0 accepts. The App then
     deferred to that "live incumbent" on every start and every heal, and agents following the
     liveness rule concluded no surface existed while the App kept fulfilling spawns. */
  const main = fs.readFileSync('src/main/commandBus.ts', 'utf8');
  assert.doesNotMatch(main, /processTreeRoot\(/, 'the App must not walk out of its own process');
  assert.match(main, /function appRoot\(\): number \{\s*return process\.pid;/);
  /* Both rules are the shared ones now (a thread id is not a process; a record written before
     this boot names nobody), tested in the package. Here: aliveFor is built from them. */
  assert.match(main, /aliveForRecord\(rec, Date\.now\(\), os\.uptime\(\), \(pid\) => pidAlive\(pid\)\)/,
    'liveness per record = the shared probe, and never a record from before this boot');
  for (const name of ['announcePresence', 'healPresence']) {
    const i = main.indexOf(`function ${name}(`);
    const body = main.slice(i, main.indexOf('\nfunction ', i + 1));
    assert.match(body, /presenceVerdict\(rec, root, aliveFor\(rec\)\)/, `${name} judges liveness per record`);
  }
});

test('an unresolvable rung REFUSES the spawn — defaulting on a typo is the bug itself', () => {
  const main = fs.readFileSync('src/main/commandBus.ts', 'utf8');
  // the refusal is a dead letter, and it RETURNS — it must not fall through into the launch
  assert.match(main, /if \('error' in r\) \{ markUndelivered\(heldPath, req, r\.error\); return; \}/);
  // a missing hook is the same class as a bad rung: refuse, and say how to get it
  assert.match(main, /is missing — run \/aios:update to sync it/);
  // empty resolution is a REAL answer, kept distinct from failure
  assert.match(main, /return model \? \{ model \} : \{\};/);
  // explicit model wins, exactly as the wrapper does it
  assert.match(main, /let model = req\.model;\s*\n\s*if \(!model && req\.tier\)/);
});

test('parseRequest: spawn is the default action (back-compat {name,task})', () => {
  const r = parseRequest('{"name":"Heron Fleet","task":"do a thing"}');
  assert.ok(r);
  assert.equal(r.action, 'spawn');
  assert.equal(r.name, 'heron-fleet');
  assert.equal(r.task, 'do a thing');
});

test('parseRequest: kill + send verbs', () => {
  const k = parseRequest('{"action":"kill","name":"worker-1"}');
  assert.equal(k?.action, 'kill');
  assert.equal(k?.name, 'worker-1');
  const s = parseRequest('{"action":"send","name":"worker-1","prompt":"go"}');
  assert.equal(s?.action, 'send');
  assert.equal(s?.prompt, 'go');
});

test('parseRequest: send falls back to task when prompt absent', () => {
  const s = parseRequest('{"action":"send","name":"x","task":"nudge"}');
  assert.equal(s?.action, 'send');
  assert.equal(s?.prompt, 'nudge');
});

test('parseRequest: an unknown action is REFUSED; only an absent one means spawn', () => {
  /* CONTRACT CHANGE. This used to degrade any unrecognised verb to 'spawn'. Adding
     `resume` made that degrade dangerous rather than forgiving: the two verbs hand back
     different things — a fresh something vs the same someone — so a typo'd `"resmue"` would
     silently spawn a duplicate of a session the caller asked to reopen. The back-compat case
     the old rule actually existed for is a request with NO action at all (contract-1
     `{name, task}`), and that is preserved exactly. */
  const r = parseRequest('{"action":"frobnicate","name":"x"}');
  assert.equal(r?.action, 'unknown');
  assert.equal(r?.rawAction, 'frobnicate', 'the dead letter quotes what was written');
  assert.equal(parseRequest('{"name":"x","task":"go"}')?.action, 'spawn', 'contract-1 still spawns');
});

test('parseRequest: bad JSON / no name / empty → null (log-and-ignore)', () => {
  assert.equal(parseRequest('{not json'), null);
  assert.equal(parseRequest('{"task":"orphan, no name"}'), null);
  assert.equal(parseRequest('{"name":"!!!"}'), null); // sanitizes to empty
  assert.equal(parseRequest('   '), null);
});

test('parseRequest: the door whitelists model ids and rung SHAPE, not rung membership', () => {
  const ok = parseRequest('{"name":"x","model":"claude-opus-4-8","tier":"mechanical"}');
  assert.equal(ok?.model, 'claude-opus-4-8');
  assert.equal(ok?.tier, 'mechanical');
  // injection is still refused at the door — both fields land in argv
  const bad = parseRequest('{"name":"x","model":"$(whoami)","tier":"$(id)"}');
  assert.equal(bad?.model, undefined);
  assert.equal(bad?.tier, undefined);
  /* CHANGED with the rung-table fix, deliberately: an unknown-but-well-formed rung used to be dropped
     HERE (this line asserted `tier: "turbo"` → undefined). That silent strip is the defect —
     it is how `fast`, `scale` and `frontier` disappeared and the worker ran on the session
     default with nothing reported. The door no longer decides which rungs exist; it passes a
     safe token through and hooks/resolve-tier refuses an unknown one by name, listing the
     valid rungs. The refusal is asserted in "an unresolvable rung REFUSES the spawn". */
  assert.equal(parseRequest('{"name":"x","tier":"turbo"}')?.tier, 'turbo');
});

test('needsTaskFile: long or multi-line tasks go to a file (0.4.3 crash fix)', () => {
  assert.equal(needsTaskFile('short task'), false);
  assert.equal(needsTaskFile(undefined), false);
  assert.equal(needsTaskFile('line one\nline two'), true);
  assert.equal(needsTaskFile('x'.repeat(241)), true);
  assert.equal(needsTaskFile('x'.repeat(240)), false);
});

test('shq: POSIX single-quote escaping (embedded quotes safe)', () => {
  assert.equal(shq('plain'), "'plain'");
  assert.equal(shq("it's"), "'it'\\''s'");
});

test('buildSpawnCmd: bare · task · resolved model · never an empty --model · task-file', () => {
  assert.equal(buildSpawnCmd('claude', 'heron', {}), 'claude --name heron');
  assert.equal(buildSpawnCmd('claude', 'heron', { task: 'do it' }), "claude --name heron 'do it'");
  assert.equal(buildSpawnCmd('claude', 'heron', { model: 'claude-opus-4-8', task: 'x' }), "claude --model claude-opus-4-8 --name heron 'x'");
  /* `judgment` resolves to EMPTY at exit 0 — a real answer meaning "inherit the binary's
     frontier default". It must emit no flag: `--model ""` pins the empty string instead. */
  for (const empty of [undefined, '', '   ']) {
    assert.equal(buildSpawnCmd('claude', 'heron', { model: empty }), 'claude --name heron',
      `model ${JSON.stringify(empty)} must emit no --model at all`);
  }
  // task-file replaces the inline task with a read-instruction
  assert.equal(
    buildSpawnCmd('claude', 'heron', { task: 'huge...', taskFile: '/home/op/.aios/run/aios-spawn-task-heron.md' }),
    `claude '--add-dir' '/home/op/.aios/run' --name heron ${shq(taskFileInstruction('/home/op/.aios/run/aios-spawn-task-heron.md'))}`,
    'aios#231: the worker may read its task file; --add-dir is variadic, so the next token is a flag',
  );
  // a custom claudeCmd is honored (Settings override)
  assert.ok(buildSpawnCmd('claude-fast', 'heron', {}).startsWith('claude-fast '));
});

// ── static invariant guards: the 0.4.3 robustness fixes must stay in the dispatcher ──
test('INVARIANT: kill resolves pid from the registry (reaches resumed sessions)', () => {
  const src = fs.readFileSync('src/main/commandBus.ts', 'utf8');
  assert.match(src, /listRunningAgents/, 'kill must resolve the pid from the session registry, not a pane name');
  assert.match(src, /process\.kill\(/, 'kill must signal the resolved pid');
});

test('INVARIANT: spawn hands long tasks off via a temp file, never types them', () => {
  const src = fs.readFileSync('src/main/commandBus.ts', 'utf8');
  assert.match(src, /needsTaskFile/, 'spawn must gate on needsTaskFile');
  assert.match(src, /tmpdir\(\)|writeFileSync/, 'the long task must be written to a temp file');
});

test('INVARIANT: verbs reuse existing renderer intents (no bespoke renderer code)', () => {
  const src = fs.readFileSync('src/main/commandBus.ts', 'utf8');
  for (const intent of ['terminal', 'closeByName', 'sendByName', 'focusByName']) {
    assert.match(src, new RegExp(`'${intent}'`), `bus must emit the existing '${intent}' intent`);
  }
});

test('an ambiguous name is refused for every verb, before anything is typed, killed or launched', () => {
  /* The verdict is the shared one (@the-aios/core/nameResolve, tested there). What only this file
     can show is that the dispatcher asks it FIRST. A kill used to find "no target", close any pane
     of that name and retire as done; a spawn found "not running" and launched one more session
     under a name two already shared; and two sessions with the very same name resolved to
     whichever the registry listed first. */
  const main = fs.readFileSync('src/main/commandBus.ts', 'utf8');
  const fn = (name: string): string => {
    const i = main.indexOf(`function ${name}(`);
    assert.notEqual(i, -1, `${name} must exist`);
    const j = main.indexOf('\nfunction ', i + 1);
    return main.slice(i, j === -1 ? undefined : j);
  };
  const refusal = /const clash = ambiguousNames\(req\.name\);\s*\n\s*if \(clash\) \{ markUndelivered\(heldPath, req, ambiguousReason\(req\.name, clash\)\); return; \}/;

  const immediate = fn('runImmediate');
  const at = immediate.search(refusal);
  assert.ok(at > 0, 'runImmediate refuses an ambiguous name with a dead letter that names the sessions');
  /* `'closeByName'`, not the whole `emit(win(), …)` call: how the window is reached is not what this
     pins (a kill that waits for the window's answer reaches it through a local). */
  for (const later of ["req.action === 'kill'", 'closeSession(', "'closeByName'", 'resumeOrReveal(', 'runSpawn(win, heldPath, req)']) {
    const i = immediate.indexOf(later);
    assert.ok(i > at, `the refusal must come before ${later}`);
  }

  const send = main.slice(main.indexOf('async function runSend('), main.indexOf('\nfunction runSpawn('));
  const sAt = send.search(refusal);
  assert.ok(sAt > 0, 'runSend refuses an ambiguous name too');
  assert.ok(sAt < send.indexOf("emit(win(), 'sendByName'"), 'before anything is typed');

  /* And no later step can pick one of the two: the lookup yields a target only for ONE. */
  assert.match(fn('targetByName'), /const hit = v\.kind === 'one' \? all\.find\(\(a\) => a\.name === v\.name\) : undefined;/);
});

test('a kill by a FORMER name is refused when the new name is shared, and never retired as done', () => {
  /* The session that used to be `x` is now `y`, and another live session is `y` too. The current
     name is not ambiguous for `x` (nobody is called `x`), so the first refusal does not fire; the
     former-name lookup then yields `y`, which means two sessions. Without a second refusal the
     kill found no target, closed a pane and retired as done with both still running. */
  const main = fs.readFileSync('src/main/commandBus.ts', 'utf8');
  const i = main.indexOf("if (req.action === 'kill') {");
  const kill = main.slice(i, main.indexOf("} else if (req.action === 'resume')", i));
  const refuse = kill.indexOf('const renamedClash = ambiguousNames(renamed);');
  assert.ok(refuse > 0, 'the renamed name is checked for ambiguity');
  assert.match(kill, /if \(renamedClash\) \{ markUndelivered\(heldPath, req, [^;]*ambiguousReason\(renamed, renamedClash\)[^;]*\); return; \}/);
  assert.ok(refuse < kill.indexOf('t = targetByName(renamed);'), 'before the target is looked up');
  assert.ok(kill.indexOf('closeSession(') > 0 && refuse < kill.indexOf('closeSession('), 'and before anything is signalled');
});

test('a name that turns ambiguous while a send is in flight ends it with what happened, never as "no live session"', () => {
  /* A second session taking the same name mid-send made the by-name lookup find nobody, and the
     request ended as "no live session by that name": false, and a dead letter is work still owed,
     so the sender sent it again. The lookup is unchanged (the loop follows the name and never
     types into a name two sessions share); what changed is that the ending says the truth. */
  const main = fs.readFileSync('src/main/commandBus.ts', 'utf8');
  const send = main.slice(main.indexOf('async function runSend('), main.indexOf('\nfunction runSpawn('));
  assert.match(send, /const stoppedByAmbiguity = \(\): boolean => \{[\s\S]{0,260}if \(!fs\.existsSync\(heldPath\)\) return true;\s*\n\s*const clash = ambiguousNames\(req\.name\);\s*\n\s*if \(!clash\) return false;/,
    'a request that is already gone (cancelled, superseded) ends silently: no dead letter is written for it');
  assert.match(send, /const target = targetByName\(req\.name\);\s*\n\s*if \(!target && stoppedByAmbiguity\(\)\) return;/, 'at the top of every pass');
  assert.match(send, /const after = targetByName\(req\.name\);\s*\n\s*if \(!after && stoppedByAmbiguity\(\)\) return;/, 'and before a verify miss is read as "the target is gone"');
  assert.match(send, /markUndelivered\(heldPath, req, firstTypedAt \? ambiguousAfterTypedReason\(req\.name, clash\) : ambiguousReason\(req\.name, clash\)\);/,
    'typed already: it MAY have arrived, and the dead letter says so; nothing typed yet: the plain refusal');
  assert.ok(send.indexOf('if (!target && stoppedByAmbiguity()) return;') < send.indexOf("emit(win(), 'sendByName'"), 'before anything is typed in that pass');
  assert.doesNotMatch(send, /sessionId\) : targetByName|targetBySessionId/, 'the loop does not switch to following a session id: that typed retries into a namesake');
});

test('the owner of a hold is probed as a process of this user: EPERM means it is gone', () => {
  /* Presence asks "does anyone alive own this record" and must read EPERM as alive. A hold is
     different: its owner is always one of our own surfaces, so EPERM is a reused pid. */
  const main = fs.readFileSync('src/main/commandBus.ts', 'utf8');
  assert.match(main, /const alive = \(pid: number\): boolean => ownPidAlive\(pid\);/);
  assert.match(main, /const holderAlive = !!stamp && alive\(stamp\.pid\);/);
  assert.match(main, /if \(c && !alive\(c\.pid\)\) continue;/);
  assert.match(main, /aliveForRecord\(rec, Date\.now\(\), os\.uptime\(\), \(pid\) => pidAlive\(pid\)\)/, 'presence keeps the other rule');
});
