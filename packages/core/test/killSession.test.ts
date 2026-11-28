/** Closing a session: its process group only when the group is provably just the session. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { killScope, terminate, parsePsRows, commName, KILL_GRACE_MS, type KillIo, type ProcRow, type KillScope } from '../src/killSession';

const row = (pid: number, ppid: number, pgid: number, comm: string): ProcRow => ({ pid, ppid, pgid, comm });
const OWN = 100;   // the surface
const base = [row(1, 0, 1, '/sbin/launchd'), row(OWN, 1, OWN, '/Applications/AIOS.app/Contents/MacOS/AIOS')];
const scope = (rows: ProcRow[], pid: number, others: number[] = [], platform: NodeJS.Platform = 'darwin', parentCommand?: string): KillScope =>
  killScope([...base, ...rows], pid, OWN, others, platform, parentCommand);
const LAUNCHER = '/bin/zsh /Users/x/.aios/run/abc/spawn-launch-designer.sh';
const pidOnly = (s: KillScope, why: RegExp): void => {
  assert.equal(s.scope, 'pid');
  if (s.scope === 'pid') assert.match(s.why, why);
};

test('parsePsRows and commName read `ps -axo pid=,ppid=,pgid=,comm=`', () => {
  const rows = parsePsRows(['    1     0     1 /sbin/launchd', '  500   400   500 claude', '  501   500   500 npm exec @scope/server', ' 400 100 400 -zsh', 'junk', ''].join('\n'));
  assert.deepEqual(rows.map((r) => r.pid), [1, 500, 501, 400]);
  assert.equal(rows[2].comm, 'npm exec @scope/server');
  assert.equal(commName('/bin/zsh'), 'zsh');
  assert.equal(commName('-zsh'), 'zsh', 'a login shell');
  assert.equal(commName('claude'), 'claude');
  assert.equal(commName('/Applications/Visual Studio Code.app/Contents/MacOS/Electron'), 'Electron', 'a path with spaces keeps its last component');
  assert.equal(commName('/Users/some one/.local/bin/claude'), 'claude');
});

test('GROUP: a session as the surfaces launch it — claude leads its own group, its helpers inside', () => {
  /* Measured on a session the App launched: pane shell in its own group; claude the leader of
     another, with its MCP servers and caffeinate in it. */
  const rows = [row(400, OWN, 400, '-zsh'), row(500, 400, 500, 'claude'), row(501, 500, 500, 'npm exec x'), row(502, 501, 500, 'node'), row(503, 500, 500, 'caffeinate')];
  assert.deepEqual(scope(rows, 500), { scope: 'group', pgid: 500 });
});

test('GROUP: a session inside the spawn wrapper — its direct parent is the launcher and leads the group', () => {
  const rows = [row(300, 1, 300, '-zsh'), row(400, 300, 400, '/bin/zsh'), row(500, 400, 400, 'claude'), row(501, 500, 400, 'node')];
  assert.deepEqual(scope(rows, 500, [], 'darwin', LAUNCHER), { scope: 'group', pgid: 400 }, 'the loop shell goes with the session');
  assert.deepEqual(scope(rows, 500, [], 'darwin', '/tmp/spawn-launch-x.sh'), { scope: 'group', pgid: 400 }, 'run by its shebang');
});

test('PID ONLY: a shell that leads the group and is NOT the wrapper\'s launcher — a script, a terminal profile, a login shell', () => {
  /* `run.sh` that runs claude and then cleans up; a terminal profile `zsh -c 'claude; exec zsh'`.
     Closing the group would end the script before its remaining steps, or the user's terminal. */
  const rows = [row(400, 1, 400, '/bin/bash'), row(500, 400, 400, 'claude')];
  pidOnly(scope(rows, 500, [], 'darwin', 'bash ./run.sh'), /not the spawn wrapper's launcher/);
  pidOnly(scope(rows, 500, [], 'darwin', "zsh -c claude; exec zsh"), /not the spawn wrapper's launcher/);
  pidOnly(scope(rows, 500), /not the spawn wrapper's launcher/, );
  pidOnly(scope(rows, 500, [], 'darwin', 'cat /tmp/notes-about-spawn-launch.txt'), /not the spawn wrapper's launcher/);
  const login = [row(400, 1, 400, '-zsh'), row(500, 400, 400, 'claude')];
  pidOnly(scope(login, 500, [], 'darwin', LAUNCHER), /login shell/);
});

test('PID ONLY: a session hosted by an editor or another app sits in its host\'s group', () => {
  /* The case that makes the rule strict. An editor extension starts the CLI without a group of
     its own: the session's group is the editor's, led by the editor, an ANCESTOR of the session.
     "Led by an ancestor" would send SIGTERM to the editor, every terminal in it and every session
     in those terminals. */
  const editor = [
    row(700, 1, 700, '/Applications/Code.app/Contents/MacOS/Electron'),
    row(710, 700, 700, 'Code Helper (Plugin)'), row(711, 700, 700, 'Code Helper (Renderer)'),
    row(720, 710, 700, 'claude'),
  ];
  pidOnly(scope(editor, 720), /neither the session nor its direct parent/);
  // even when the host IS the direct parent: it is not a shell
  const direct = [row(700, 1, 700, 'Google Chrome'), row(701, 700, 700, 'Google Chrome Helper'), row(720, 700, 700, 'claude')];
  pidOnly(scope(direct, 720), /which is not a shell/);
});

test('PID ONLY: a shell that leads the group but has other work in it (a script, a job)', () => {
  const rows = [row(400, 1, 400, 'bash'), row(410, 400, 400, 'make'), row(500, 400, 400, 'claude')];
  pidOnly(scope(rows, 500, [], 'darwin', LAUNCHER), /holds 1 process\(es\) that are not the session's \(e\.g\. 410 'make'\)/);
});

test('PID ONLY: the pid is not a session any more (a registry entry outlived its process)', () => {
  const rows = [row(500, 1, 500, '/usr/sbin/someDaemon'), row(501, 500, 500, 'worker')];
  pidOnly(scope(rows, 500), /the process at that pid is 'someDaemon', not a session/);
  pidOnly(scope([], 4242), /not in the process table/);
});

test('PID ONLY: another session in the group, the surface\'s own group, an unreadable group, Windows', () => {
  const two = [row(400, 1, 400, 'zsh'), row(500, 400, 400, 'claude'), row(600, 500, 400, 'claude')];
  pidOnly(scope(two, 500, [600], 'darwin', LAUNCHER), /another live session is in the same process group/);
  pidOnly(scope([row(500, OWN, OWN, 'claude')], 500), /this surface's own process group/);
  pidOnly(scope([row(500, 1, 0, 'claude')], 500), /could not be read/);
  pidOnly(scope([row(500, 1, 1, 'claude')], 500), /could not be read/);
  pidOnly(scope([row(500, 400, 500, 'claude')], 500, [], 'win32'), /Windows/);
});

/** A fake world: the session stops running `stopsAfterMs` after the signal named in `stopsOn`. */
function fakeIo(stopsOn: 'SIGTERM' | 'SIGKILL' | 'never', stopsAfterMs = 0): KillIo & { sent: string[]; t: number } {
  let stopAt = Infinity;
  const io = {
    sent: [] as string[], t: 0,
    signal(addr: number, sig: 'SIGTERM' | 'SIGKILL'): void { io.sent.push(`${sig} ${addr}`); if (sig === stopsOn) stopAt = io.t + stopsAfterMs; },
    running: (): boolean => io.t < stopAt,
    sleep: async (ms: number): Promise<void> => { io.t += ms; },
    now: (): number => io.t,
  };
  return io;
}

test('terminate, group: SIGTERM is enough when the session handles it — and nothing is SIGKILLed', async () => {
  const io = fakeIo('SIGTERM', 1500);
  const r = await terminate({ scope: 'group', pgid: 500 }, 500, io);
  assert.equal(r.ended, 'on-term');
  assert.deepEqual(io.sent, ['SIGTERM -500'], 'the GROUP is addressed as a negative pid, and no SIGKILL follows');
  if (r.ended === 'on-term') assert.ok(r.afterMs >= 1500 && r.afterMs < KILL_GRACE_MS);
});

test('terminate, group: a session still running after the grace gets SIGKILL, and not before', async () => {
  const io = fakeIo('SIGKILL');
  const r = await terminate({ scope: 'group', pgid: 500 }, 500, io);
  assert.equal(r.ended, 'on-kill');
  assert.deepEqual(io.sent, ['SIGTERM -500', 'SIGKILL -500']);
  if (r.ended === 'on-kill') assert.ok(r.afterMs >= KILL_GRACE_MS, 'the full grace was given first');
});

test('terminate, group: a pid that is no longer the session is never SIGKILLed, however alive it looks', async () => {
  /* The session exits, its parent collects it, and the number goes to a new process before the
     grace is over. `running` answers for the SESSION (same start time), so it says no, and the
     kill ends there: no SIGKILL to "the group of that pid", which is now somebody else's. */
  const sent: string[] = [];
  let t = 0;
  const reused: KillIo = { signal: (a, sig) => { sent.push(`${sig} ${a}`); }, running: () => false, sleep: async (ms) => { t += ms; }, now: () => t };
  const r = await terminate({ scope: 'group', pgid: 500 }, 500, reused);
  assert.equal(r.ended, 'on-term');
  assert.deepEqual(sent, ['SIGTERM -500']);
});

test('terminate, pid: one SIGTERM and nothing more, whatever the process does — as it always was', async () => {
  const io = fakeIo('never');
  const r = await terminate({ scope: 'pid', why: 'x' }, 500, io);
  assert.deepEqual(r, { ended: 'term-sent', scope: 'pid' });
  assert.deepEqual(io.sent, ['SIGTERM 500'], 'no wait, no SIGKILL: only a group shown to be the session\'s is ever escalated');
});

test('terminate: nothing there, or not ours to signal', async () => {
  const failing = (code: string): KillIo => ({ signal: () => { throw Object.assign(new Error(code), { code }); }, running: () => true, sleep: async () => {}, now: () => 0 });
  assert.deepEqual(await terminate({ scope: 'group', pgid: 500 }, 500, failing('ESRCH')), { ended: 'already-gone', scope: 'group' });
  assert.deepEqual(await terminate({ scope: 'pid', why: 'x' }, 500, failing('EPERM')), { ended: 'not-permitted', scope: 'pid', code: 'EPERM' });
});

/* ── WITH REAL PROCESSES: toys this test starts and ends itself ─────────────────
   A "session" here is an `sh` this test spawns, with `sleep` children. The rule that the session
   must be `claude` is relaxed to `sh` for these, and only for these. Nothing below ever looks up,
   or signals, a process this test did not start. */
const posix = process.platform !== 'win32';
/* A toy "session" is a shell, and the toy "launcher" is the `sh -c` this test spawned. */
const TOY = { sessionComm: /^(sh|dash|bash)$/, wrapperLoop: /^sh -c / };
const commandOf = (pid: number): string => execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim();
const table = (): ProcRow[] => parsePsRows(execFileSync('ps', ['-axo', 'pid=,ppid=,pgid=,comm='], { encoding: 'utf8' }));
/* Running, as opposed to merely not yet collected: a process that has exited stays in the table as
   a zombie until its parent reaps it, and signal 0 still succeeds on it. */
const running = (pid: number): boolean => {
  try { process.kill(pid, 0); } catch { return false; }
  try { return !/^Z/.test(execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim()); } catch { return false; }
};
/** The real signals, bound to one process by its start time, as the App binds them. */
const realIoFor = (pid: number): KillIo => {
  const born = startedAt(pid);
  return {
    signal: (p, sig) => { process.kill(p, sig); },
    running: (p) => p === pid && born !== '' && running(p) && startedAt(p) === born,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
  };
};
async function until(cond: () => boolean, ms = 4000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return true; await new Promise((r) => setTimeout(r, 50)); }
  return cond();
}
/* When a process started, as `ps` prints it: what tells "still the process this test started"
   from "a number the system has since given to something else". '' when it is gone. */
const startedAt = (pid: number): string => {
  try { return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }).trim(); } catch { return ''; }
};
/** Start a toy: `sh -c script`, leader of its own new group. It prints the pids it wants known. */
async function toy(script: string, expectPids: number): Promise<{ leader: number; pids: number[]; stop: () => void }> {
  const child = spawn('sh', ['-c', script], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  child.stdout.on('data', (d) => { out += String(d); });
  const reported = (): number[] => out.split('\n').map((l) => Number(l.trim())).filter((n) => Number.isInteger(n) && n > 1);
  await until(() => reported().length >= expectPids);
  const leader = child.pid as number;
  const pids = reported();
  const born = new Map(pids.map((p) => [p, startedAt(p)]));
  /* Cleanup that can only reach this toy's own processes, on a machine that reuses pids within
     minutes:
       · the GROUP is signalled only while the leader has not been collected: until then its
         number, and so the group's, cannot have been given to anything else;
       · a reported pid is signalled only if the process there started when the one this test
         saw did. */
  const stop = (): void => {
    if (child.exitCode === null && child.signalCode === null) { try { process.kill(-leader, 'SIGKILL'); } catch { /* empty */ } }
    for (const p of pids) {
      const was = born.get(p);
      if (was && startedAt(p) === was) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } }
    }
  };
  return { leader, pids, stop };
}
/* How to start something OUTSIDE the session's group, as the inbox README recommends it. */
const OUTSIDE = 'perl -MPOSIX -e \'setsid() or die; exec @ARGV\' sleep 602 & echo $!';

test('REAL PROCESSES: the session and what sits in its group end; what was started in a session of its own survives', { skip: !posix }, async () => {
  /* `cmd &` and `nohup cmd &` stay in the group (nohup does NOT leave it). The third is started
     the way the README says to start something that must outlive its session. */
  const s = await toy(['sleep 600 & echo $!', 'nohup sleep 601 >/dev/null 2>&1 & echo $!', OUTSIDE, 'wait'].join('\n'), 3);
  try {
    assert.equal(s.pids.length, 3, 'the three children reported their pids');
    const [plain, nohup, outside] = s.pids;
    /* `$!` is printed before perl has called setsid(): wait until it has left the group. */
    assert.ok(await until(() => table().find((r) => r.pid === outside)?.pgid !== s.leader), 'the third child moved to a session of its own');
    const rows = table();
    const groupOf = (p: number): number | undefined => rows.find((r) => r.pid === p)?.pgid;
    assert.equal(groupOf(s.leader), s.leader, 'the toy session leads its own group');
    assert.equal(groupOf(plain), s.leader);
    assert.equal(groupOf(nohup), s.leader, 'nohup does not change the process group');
    assert.notEqual(groupOf(outside), s.leader, 'setsid put this one in a session of its own');

    const sc = killScope(rows, s.leader, process.pid, [], process.platform, undefined, TOY);
    assert.deepEqual(sc, { scope: 'group', pgid: s.leader });
    const r = await terminate(sc, s.leader, realIoFor(s.leader), 3000);
    assert.equal(r.ended, 'on-term', 'the session ended on SIGTERM');
    assert.ok(await until(() => !running(plain) && !running(nohup) && !running(s.leader)), 'the session and what was in its group are gone');
    assert.equal(running(outside), true, 'what was started outside the group is still running');
  } finally { s.stop(); }
});

test('REAL PROCESSES: a session that ignores SIGTERM is SIGKILLed, with its group, after the grace', { skip: !posix }, async () => {
  /* An ignored signal stays ignored across exec, so the `sleep` ignores SIGTERM too. */
  const s = await toy('trap "" TERM\nsleep 603 & echo $!\nwait', 1);
  try {
    const [child] = s.pids;
    const sc = killScope(table(), s.leader, process.pid, [], process.platform, undefined, TOY);
    assert.equal(sc.scope, 'group');
    const started = Date.now();
    const r = await terminate(sc, s.leader, realIoFor(s.leader), 600);
    assert.equal(r.ended, 'on-kill');
    assert.ok(Date.now() - started >= 600, 'SIGKILL only after the grace');
    assert.ok(await until(() => !running(child) && !running(s.leader)), 'and then everything in the group is gone');
  } finally { s.stop(); }
});

test('REAL PROCESSES: the wrapper shape — the loop shell that leads the group goes with the session', { skip: !posix }, async () => {
  /* An outer shell (the "loop") runs an inner shell (the "session") and would go on afterwards.
     The session's direct parent is a shell and leads the group: the group is closed, loop included. */
  /* Each inner script ends with `:` so the shell stays a shell: dash execs the last command of a
     `-c` string, and `$$` would then be a `sleep`. */
  const s = await toy('sh -c \'echo $$; sleep 604; :\'\necho after', 1);
  try {
    const [session] = s.pids;
    const rows = table();
    assert.equal(rows.find((r) => r.pid === session)?.pgid, s.leader, 'the session sits in the loop\'s group');
    assert.equal(rows.find((r) => r.pid === session)?.ppid, s.leader);
    const sc = killScope(rows, session, process.pid, [], process.platform, commandOf(s.leader), TOY);
    assert.deepEqual(sc, { scope: 'group', pgid: s.leader });
    await terminate(sc, session, realIoFor(session), 3000);
    assert.ok(await until(() => !running(session) && !running(s.leader)), 'the session AND its loop are gone: nothing is left to start a new one');
  } finally { s.stop(); }
});

test('REAL PROCESSES: a group that holds anything else is left alone — only the session\'s pid is signalled', { skip: !posix }, async () => {
  /* The outer shell has other work in its group (a sibling `sleep`), like a script that started a
     session among other things. The sibling and the outer shell must survive. */
  const s = await toy('sleep 605 & echo $!\nsh -c \'echo $$; sleep 606; :\'\nsleep 607\n:', 2);
  try {
    const [sibling, session] = s.pids;
    const sc = killScope(table(), session, process.pid, [], process.platform, commandOf(s.leader), TOY);
    assert.equal(sc.scope, 'pid', 'the group is not only the session');
    if (sc.scope === 'pid') assert.match(sc.why, /that are not the session's/, 'refused for the sibling, not for some other reason');
    const r = await terminate(sc, session, realIoFor(session), 3000);
    assert.deepEqual(r, { ended: 'term-sent', scope: 'pid' });
    assert.ok(await until(() => !running(session)), 'the session got its SIGTERM');
    assert.equal(running(sibling), true, 'the other work in that group is untouched');
    assert.equal(running(s.leader), true, 'and so is the shell that started both');
  } finally { s.stop(); }
});
