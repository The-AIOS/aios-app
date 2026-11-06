/**
 * Unattended install — WHEN a downloaded update may restart the app on its own.
 *
 * Unattended mode (app#88) brings every session back after a relaunch, but on a machine nobody
 * is watching the relaunch never comes: a downloaded update waits for a click on the pill, and
 * `autoInstallOnAppQuit` only fires on a quit nobody performs. So the server stays on the old
 * version, and the "everything comes back" path is never exercised by the event it was built for.
 *
 * This is the policy for closing that gap, kept pure so it is tested directly (the driver in
 * `src/main/updater.ts` only reads the inputs and acts). A restart is the one thing the app does
 * that kills work in flight — a turn mid-write, a tool mid-run, a message mid-delivery — so the
 * rule is conservative on every axis, and "never quiet" is an acceptable outcome: the pill stays,
 * exactly as with the mode off.
 *
 * QUIET means, all at once and for QUIET_MS without a break:
 *  - no session is busy, and none is waiting on a background shell it started (`busy`, read from
 *    the keep-awake driver, which already owns that signal — never re-derived here);
 *  - no session is `waiting` (a permission or question prompt). On an unattended machine such a
 *    prompt may wait forever, and that is fine: restarting under it would throw away the request
 *    it is waiting on. The pill remains the way out;
 *  - no bus `send` is held mid-delivery. A held request survives a restart (it is re-adopted),
 *    but one already half-typed into a terminal does not;
 *  - nobody has touched the machine for IDLE_MIN_S. "Unattended" is a setting, not a fact — a
 *    person who came in over screen sharing must never have the app restart under their hands.
 *
 * The streak matters because a session driven by the bus flips to idle for a moment between
 * messages; one quiet sample is not a quiet machine.
 *
 * NEVER THE SAME VERSION TWICE. If an install fails, the app comes back on the old version with
 * the update still downloaded, and the next quiet window would try again — a restart loop on a
 * machine nobody is watching. So the version is recorded before the attempt, and a recorded
 * version falls back to the pill.
 */

/** Quiet must hold this long, unbroken, before the restart. */
import { isBlockedStatus } from './attention';

export const QUIET_MS = 2 * 60 * 1000;
/** Seconds without keyboard or mouse input on the machine before it counts as unattended. */
export const IDLE_MIN_S = 10 * 60;
/** How often the driver samples while an install is pending. */
export const SAMPLE_MS = 30 * 1000;
/** After this long armed and never quiet, the driver says so once in the log. */
export const NEVER_QUIET_WARN_MS = 12 * 60 * 60 * 1000;

export interface QuietInputs {
  /** Some session is busy, or idle while waiting on a shell it started. */
  busy: boolean;
  /** Registry statuses of every live session. */
  statuses: readonly unknown[];
  /** Bus sends currently held mid-delivery. */
  heldSends: number;
  /** Seconds since the last keyboard/mouse input on the machine. */
  idleSec: number;
}

export type QuietBlocker = 'busy' | 'waiting' | 'delivering' | 'person';

/** The first thing that makes the machine not quiet right now, or null when it is. */
export function quietBlocker(i: QuietInputs): QuietBlocker | null {
  if (i.busy) return 'busy';
  /* The panel's own "needs you" test, not a literal 'waiting': other Claude Code versions name the state differently, and
     restarting under a pending prompt throws the request away (0.15.0 review). */
  if (i.statuses.some((s) => isBlockedStatus(String(s ?? '')))) return 'waiting';
  if (i.heldSends > 0) return 'delivering';
  if (!(i.idleSec >= IDLE_MIN_S)) return 'person';
  return null;
}

export interface InstallStep {
  /** When the current unbroken quiet streak began (0 = not quiet). */
  quietSince: number;
  install: boolean;
  blocker: QuietBlocker | null;
}

/**
 * One sample. `quietSince` is the previous step's value; the caller keeps it between samples.
 * A sample further than two intervals after the previous one breaks the streak: the machine
 * slept, or the process was suspended, and nothing is known about the gap.
 */
export function installStep(i: QuietInputs, prev: { quietSince: number; lastSampleAt: number }, now: number): InstallStep {
  const blocker = quietBlocker(i);
  if (blocker) return { quietSince: 0, install: false, blocker };
  const gap = prev.lastSampleAt > 0 && now - prev.lastSampleAt > 2 * SAMPLE_MS;
  const quietSince = prev.quietSince > 0 && !gap ? prev.quietSince : now;
  return { quietSince, install: now - quietSince >= QUIET_MS, blocker: null };
}

/** May this version be installed without a person? Not if an earlier attempt already tried it. */
export function mayAutoInstall(version: string, attempted: string): boolean {
  return !!version && version !== attempted;
}
