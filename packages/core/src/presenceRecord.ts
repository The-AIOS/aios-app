/**
 * What a surface writes into `~/.aios/surfaces/<surface>.json`, and when a record it reads there
 * still names somebody.
 *
 * `presence` decides who OWNS the record. This is the rest of it, which each surface had on its
 * own: the App wrote `capabilities` and Glass did not, so a writer could not tell from the record
 * what the surface behind it honours; and the App discarded a record written before the last
 * boot while Glass trusted any pid that existed.
 */
import type { PresenceRecord } from './presence';

/**
 * Was this timestamp written before the machine last booted?
 *
 * A record written before this boot names nobody, whatever its pid now belongs to: pids restart
 * from low numbers after a reboot, and a crash or a power cut leaves the record behind, so the
 * old number is soon reused by an unrelated process. A minute of slack absorbs clock skew.
 *
 * `uptimeSec` is `os.uptime()`. A record with no timestamp at all is not judged here.
 */
export const BOOT_SLACK_MS = 60_000;
export function writtenBeforeBoot(at: unknown, nowMs: number, uptimeSec: number): boolean {
  if (typeof at !== 'number' || Number.isNaN(at)) return false;
  return at < nowMs - uptimeSec * 1000 - BOOT_SLACK_MS;
}

/** The record as written. `capabilities` names what this surface honours beyond the contract. */
export interface PresenceBody {
  surface: string;
  pid: number;
  at: number;
  version: string;
  capabilities: string[];
}

export function buildPresenceRecord(o: { surface: string; pid: number; version: string; capabilities?: readonly string[]; nowMs: number }): PresenceBody {
  return { surface: o.surface, pid: o.pid, at: o.nowMs, version: o.version, capabilities: [...new Set(o.capabilities ?? [])].sort() };
}

/** The exact text both surfaces put on disk, so two writers of the same record write the same bytes. */
export function serializePresenceRecord(body: PresenceBody): string {
  return JSON.stringify(body, null, 2) + '\n';
}

/**
 * Liveness for the pid a given record names: alive, AND the record was written in this boot.
 * Returned as a function of the pid so it plugs into `presenceVerdict(rec, mine, isAlive)`.
 */
export function aliveForRecord(
  rec: PresenceRecord | undefined,
  nowMs: number,
  uptimeSec: number,
  isAlive: (pid: number) => boolean,
): (pid: number) => boolean {
  const stale = writtenBeforeBoot(rec?.at, nowMs, uptimeSec);
  return (pid) => !stale && isAlive(pid);
}

/** Does a presence record declare this capability? Tolerant of junk: anything else is "no". */
export function presenceHasCapability(rec: unknown, capability: string): boolean {
  const caps = (rec as { capabilities?: unknown } | null | undefined)?.capabilities;
  return Array.isArray(caps) && caps.includes(capability);
}
