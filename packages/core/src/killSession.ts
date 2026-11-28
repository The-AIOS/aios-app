/**
 * Closing a session the bus was asked to kill: ONE way, for both surfaces.
 *
 * Each surface closed a session its own way. One sent SIGTERM to the session's pid alone; the
 * other closed the terminal when it owned it, and otherwise ran a shell helper that found the
 * process by a pattern on its command line and SIGKILLed its process group.
 *
 * A pid alone is not always the whole session: one started through the `spawn` wrapper runs
 * inside a shell loop that starts a new `claude` under the same name when the old one ends
 * abnormally. And a pattern on a command line is not an address: a name that is a prefix of
 * another matches both.
 *
 * So the target is a PID from the session registry, and what is closed is that pid's PROCESS
 * GROUP, but only when the group is provably nothing more than the session:
 *
 *   · the process at that pid is `claude` (a registry entry can outlive its process, and the
 *     number can belong to something else by now); AND
 *   · the group is led by the session itself, or by its DIRECT PARENT when that parent is the
 *     `spawn` wrapper's launcher (a shell, not a login shell, running `spawn-launch-<name>.sh`;
 *     in practice macOS, where the wrapper opens a terminal on that script); AND
 *   · every member of the group is that leader, the session, or a descendant of the session; AND
 *   · the group is not the surface's own, and no other registered session is in it.
 *
 * Anything else, and only the pid gets a single SIGTERM, exactly as before. The rule has to be
 * this tight because a process group is whatever the launcher made it. A session hosted by an
 * editor or by another application is started without a group of its own and sits in its host's
 * group, with the host as an ancestor: "led by an ancestor" would close the whole editor, every
 * terminal in it and every session in those. A session a script started shares the script's
 * group, and so does one run by a terminal profile (`zsh -c 'claude; exec zsh'`): closing that
 * group would end the script before its remaining steps, or the user's terminal. So a parent
 * that leads the group counts only when it is the wrapper's own launcher, by its command line.
 *
 * What that leaves out, on purpose: a session started by the wrapper's in-shell form (the loop
 * runs in the user's interactive shell and `claude` leads its own group). Its group is closed,
 * the loop is not, and the loop may start a new session. Ending someone's interactive shell to
 * stop it is not this module's call.
 *
 * WHAT THE GROUP HOLDS, measured on sessions as the surfaces launch them: `claude` leads its own
 * group, with its MCP servers and helpers in it. Commands a session runs through its Bash tool
 * are NOT in it: each runs in a group of its own.
 *
 * THE SEQUENCE: SIGTERM to the group; then watch the SESSION, not the group, for up to `graceMs`
 * (5 s). `claude` handles SIGTERM (measured: gone in about 1.5 s, its children with it). If the
 * session is still running after the grace, SIGKILL the group. If the session ended, nothing is
 * SIGKILLed: whatever it left behind in the group (a hook that is still writing) is left to finish.
 *
 * This module signals processes. Everything it touches is a parameter, and its tests use toy
 * processes of their own; nothing here is ever pointed at a real session by a test.
 */

export interface ProcRow { pid: number; ppid: number; pgid: number; comm: string }

/** Parse `ps -axo pid=,ppid=,pgid=,comm=` output. `comm` is the rest of the line (it may hold spaces). */
export function parsePsRows(out: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)(?:\s+(.*\S))?\s*$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), comm: m[4] ?? '' });
  }
  return rows;
}

/** The program's own name: no directory, no login-shell dash (`-zsh`). `ps -o comm=` gives a
 *  path that may hold spaces on macOS and a short name on Linux; neither carries arguments. */
export function commName(comm: string): string {
  return (comm.trim().split('/').pop() ?? '').replace(/^-/, '');
}

const SHELLS = new Set(['sh', 'zsh', 'bash', 'dash', 'fish', 'ksh']);

export interface KillRules {
  /** What the session's own process must be called. `claude`, except in tests with toy processes. */
  sessionComm: RegExp;
  /** The command line of a parent that may lead the group: the `spawn` wrapper's launcher. */
  wrapperLoop: RegExp;
}
export const SESSION_RULES: KillRules = { sessionComm: /^claude$/, wrapperLoop: /(^|[/\s])spawn-launch-[^/\s]+\.sh(\s|$)/ };

export type KillScope =
  | { scope: 'group'; pgid: number }
  | { scope: 'pid'; why: string };

/**
 * Pure: may the session's whole process group be closed, or only its pid?
 * `rows` is the process table at this moment; `otherSessionPids` are the other registered sessions.
 */
export function killScope(
  rows: readonly ProcRow[],
  pid: number,
  ownPid: number,
  otherSessionPids: readonly number[],
  platform: NodeJS.Platform,
  /** The full command line of the session's parent (`ps -o command= -p <ppid>`), when known. */
  parentCommand: string | undefined = undefined,
  rules: KillRules = SESSION_RULES,
): KillScope {
  const only = (why: string): KillScope => ({ scope: 'pid', why });
  if (platform === 'win32') return only('Windows has no process groups');
  const by = new Map(rows.map((r) => [r.pid, r]));
  const me = by.get(pid);
  if (!me) return only('the process is not in the process table');
  if (!rules.sessionComm.test(commName(me.comm))) return only(`the process at that pid is '${commName(me.comm)}', not a session`);
  const g = me.pgid;
  if (!Number.isInteger(g) || g <= 1) return only('the process group could not be read');
  if (g === by.get(ownPid)?.pgid) return only('the session is in this surface\'s own process group');

  // Who leads the group: the session, or its direct parent when that parent is the wrapper's launcher.
  if (g !== pid) {
    const parent = by.get(me.ppid);
    if (g !== me.ppid || !parent) return only(`the group is led by ${g}, which is neither the session nor its direct parent`);
    if (!SHELLS.has(commName(parent.comm))) return only(`the group is led by the session's parent, '${commName(parent.comm)}', which is not a shell`);
    if (parent.comm.trim().startsWith('-')) return only('the group is led by a login shell: a terminal, not the wrapper\'s launcher');
    if (!parentCommand || !rules.wrapperLoop.test(parentCommand)) return only('the group is led by a shell that is not the spawn wrapper\'s launcher (a script, or a terminal profile)');
  }

  // Every member: the leader, the session, or a descendant of the session.
  const descendsFromSession = (p: number): boolean => {
    let cur = by.get(p);
    for (let hops = 0; cur && hops < 64; hops++) {
      if (cur.pid === pid) return true;
      cur = by.get(cur.ppid);
    }
    return false;
  };
  const strangers = rows.filter((r) => r.pgid === g && r.pid !== g && !descendsFromSession(r.pid));
  if (strangers.length) return only(`the group holds ${strangers.length} process(es) that are not the session's (e.g. ${strangers[0].pid} '${commName(strangers[0].comm)}')`);

  const others = new Set(otherSessionPids.filter((p) => p !== pid));
  if (rows.some((r) => r.pgid === g && others.has(r.pid))) return only('another live session is in the same process group');
  return { scope: 'group', pgid: g };
}

export interface KillIo {
  /** `process.kill`: a negative pid signals a process group. Throws ESRCH when nothing is there. */
  signal(pidOrNegativeGroup: number, sig: 'SIGTERM' | 'SIGKILL'): void;
  /**
   * Is THE SESSION still running at this pid: in the process table, not a zombie waiting to be
   * collected, and the SAME process that was there when the kill began. Pids are reused within
   * minutes on a busy machine; once the session exits, its number can belong to something else
   * before the grace is over, and a SIGKILL to "the group of that pid" would then land on a
   * stranger. The implementation remembers the process's start time and compares it.
   */
  running(pid: number): boolean;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export const KILL_GRACE_MS = 5_000;
const POLL_MS = 200;

export type KillOutcome =
  | { ended: 'already-gone'; scope: 'group' | 'pid' }
  | { ended: 'on-term'; scope: 'group'; afterMs: number }
  | { ended: 'on-kill'; scope: 'group'; afterMs: number }
  | { ended: 'term-sent'; scope: 'pid' }
  | { ended: 'not-permitted'; scope: 'group' | 'pid'; code: string };

/**
 * `pid` scope: one SIGTERM to the pid, and nothing more, as the surfaces always did.
 * `group` scope: SIGTERM to the group, watch the session, SIGKILL the group only if the session is
 * still running after the grace.
 */
export async function terminate(target: KillScope, pid: number, io: KillIo, graceMs: number = KILL_GRACE_MS): Promise<KillOutcome> {
  const scope = target.scope;
  const address = target.scope === 'group' ? -target.pgid : pid;
  try { io.signal(address, 'SIGTERM'); } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code ?? 'error';
    return code === 'ESRCH' ? { ended: 'already-gone', scope } : { ended: 'not-permitted', scope, code };
  }
  if (target.scope === 'pid') return { ended: 'term-sent', scope: 'pid' };
  const started = io.now();
  while (io.now() - started < graceMs) {
    if (!io.running(pid)) return { ended: 'on-term', scope: 'group', afterMs: io.now() - started };
    await io.sleep(POLL_MS);
  }
  if (!io.running(pid)) return { ended: 'on-term', scope: 'group', afterMs: io.now() - started };
  try { io.signal(address, 'SIGKILL'); } catch { /* it left between the last look and now */ }
  return { ended: 'on-kill', scope: 'group', afterMs: io.now() - started };
}
