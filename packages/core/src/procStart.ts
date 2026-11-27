/**
 * #78 twin — A REUSED PID MUST NOT MAKE A CLOSED SESSION LOOK LIVE.
 *
 * Liveness was `process.kill(pid, 0)` alone. Claude Code's registry file (~/.claude/sessions/<pid>.json)
 * can outlive its session, and once the OS hands that pid to an unrelated process the stale entry
 * reads as a live session — most often on Windows, which recycles pids quickly. The registry records
 * when ITS process started (`procStart`), so an entry is live only if the process now holding the pid
 * started at that time.
 *
 * The recorded format, read from real registry files (Claude Code 2.1.312, macOS, pidDomain "darwin"):
 *   "procStart": "Wed Oct 28 01:33:15 2026"   — `ps -o lstart=` rendered in UTC, second precision.
 * Claude Code computes it exactly so on macOS and Linux (`LC_ALL=C TZ=UTC ps -o lstart= -p <pid>`).
 * On Windows it writes `procStartFt` instead, a numeric string it only compares for equality; it is
 * read here as a FILETIME (100 ns ticks since 1601) only when the value is in FILETIME's plausible
 * range (below 3e17, a threshold Claude Code itself uses to tell its two Windows encodings apart).
 * Anything absent or unparseable keeps the old behaviour (signal 0 decides): never declare a session
 * dead on a field we could not read.
 *
 * This module is the PURE half, in core so sync-core hands the App the same comparison; reading the
 * actual start time is per surface (Glass: src/agents/procStart.ts).
 */
/** Tolerance between the recorded start and the measured one: second-precision clocks, rounding. */
export const PROC_START_TOLERANCE_MS = 2000;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Parse a `ps -o lstart=` string ("Wed Oct 28 01:33:15 2026") as UTC; undefined when it is not one. */
export function parseLstartUtc(s: string | undefined): number | undefined {
  if (typeof s !== 'string') return undefined;
  const m = /^\s*[A-Z][a-z]{2}\s+([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(\d{4})\s*$/.exec(s);
  if (!m) return undefined;
  const mon = MONTHS.indexOf(m[1]);
  if (mon < 0) return undefined;
  const t = Date.UTC(Number(m[6]), mon, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]));
  return Number.isFinite(t) ? t : undefined;
}

/** A Windows FILETIME string (100 ns ticks since 1601-01-01 UTC) → epoch ms; undefined when it is not one. */
export function parseFiletime(s: string | undefined): number | undefined {
  if (typeof s !== 'string' || !/^\d{15,20}$/.test(s.trim())) return undefined;
  const ticks = BigInt(s.trim());
  if (ticks >= 300000000000000000n) return undefined;   // another encoding: unknown, so the old behaviour
  const ms = Number(ticks / 10000n) - 11644473600000;
  return ms > Date.UTC(2000, 0, 1) ? ms : undefined;
}

/** The start time a registry entry records, epoch ms, or undefined when it records none we can read. */
/* A recorded start further than this from the entry's own `startedAt` is a reading we got wrong,
   not a process that changed: the session starts seconds after its process. */
export const STARTED_AT_PLAUSIBLE_MS = 10 * 60 * 1000;

export function recordedStart(entry: { procStart?: unknown; procStartFt?: unknown; startedAt?: unknown }): number | undefined {
  const t = parseLstartUtc(typeof entry.procStart === 'string' ? entry.procStart : undefined)
    ?? parseFiletime(typeof entry.procStartFt === 'string' ? entry.procStartFt : undefined);
  /* SELF-CHECK AGAINST CLAUDE CODE'S OWN CLOCK. `procStartFt` (Windows) is compared only for
     equality by Claude Code, so reading it as a FILETIME is an inference, never measured on
     Windows. If that inference were wrong, every live Windows session would read as "a different
     process" and vanish. `startedAt` is written by Claude Code in epoch ms beside it, so a reading
     that disagrees with it by minutes is discarded and the old behaviour (signal 0) decides. */
  const started = typeof entry.startedAt === 'number' && entry.startedAt > 0 ? entry.startedAt : undefined;
  if (t !== undefined && started !== undefined && Math.abs(t - started) > STARTED_AT_PLAUSIBLE_MS) return undefined;
  return t;
}

/**
 * Is the process holding this pid the one the registry entry was written for?
 * `recorded` / `actual` are epoch ms; either undefined → true (unknown keeps the old behaviour).
 */
export function sameProcessStart(recorded: number | undefined, actual: number | undefined,
  toleranceMs = PROC_START_TOLERANCE_MS): boolean {
  if (recorded === undefined || actual === undefined) return true;
  return Math.abs(recorded - actual) <= toleranceMs;
}
