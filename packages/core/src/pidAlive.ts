/**
 * Is this pid a running process? One answer, for every place that asks.
 *
 * The surfaces asked this in five places and gave three different answers. The naive form,
 * `try { process.kill(pid, 0); return true } catch { return false }`, is wrong twice:
 *
 *  · EPERM is not absence. Signal 0 performs the existence and permission checks and delivers
 *    nothing; EPERM means the process EXISTS and is not ours to signal. Only ESRCH proves it is
 *    gone. Reading EPERM as dead evicts a live surface from its own presence record.
 *  · On Linux, kill() also accepts a THREAD id, so signal 0 succeeds for a number that is only a
 *    thread of some other process. A record naming a dead surface then reads as alive as soon as
 *    the number is reused by any thread (measured: a presence record named 1301, which after a
 *    reboot was a thread of another process, and the surface deferred to it on every start). A
 *    real process is its own thread-group leader, so its Tgid equals its pid.
 *
 * This module touches the process table and, on Linux, /proc. Both are injectable so the rule is
 * tested without a process to kill.
 */
import * as fs from 'fs';

export interface PidProbe {
  /** Deliver signal 0. Throws like `process.kill` when the pid cannot be signalled. */
  signal0: (pid: number) => void;
  platform: NodeJS.Platform;
  /** Contents of /proc/<pid>/status. Throws when unreadable. Only read on Linux. */
  procStatus: (pid: number) => string;
}

const realProbe: PidProbe = {
  signal0: (pid) => { process.kill(pid, 0); },
  platform: process.platform,
  procStatus: (pid) => fs.readFileSync(`/proc/${pid}/status`, 'utf8'),
};

export function pidAlive(pid: unknown, probe: PidProbe = realProbe): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 1) return false;
  try { probe.signal0(pid); } catch (e) {
    return (e as NodeJS.ErrnoException)?.code !== 'ESRCH';
  }
  if (probe.platform === 'linux') {
    try {
      const m = /^Tgid:\s*(\d+)/m.exec(probe.procStatus(pid));
      if (m && Number(m[1]) !== pid) return false;
    } catch { /* gone between the two calls, or no /proc: the signal already said alive */ }
  }
  return true;
}

/**
 * Is this pid a running process OF THIS USER?
 *
 * For a pid that can only ever have belonged to one of our own processes (the surface that
 * stamped a hold, for instance), EPERM is not "alive and not ours to signal": we could always
 * signal the process that wrote it. It means that process is gone and the number now belongs to
 * someone else's. So here only a signal that goes through counts as alive.
 */
export function ownPidAlive(pid: unknown, probe: PidProbe = realProbe): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 1) return false;
  try { probe.signal0(pid); } catch { return false; }
  if (probe.platform === 'linux') {
    try {
      const m = /^Tgid:\s*(\d+)/m.exec(probe.procStatus(pid));
      if (m && Number(m[1]) !== pid) return false;
    } catch { /* no /proc to read: the signal already said alive */ }
  }
  return true;
}
