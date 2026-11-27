/**
 * What a session is doing, ONCE for the whole App.
 *
 * Two sources say it. The registry (~/.claude/sessions) is polled and lags. A session running in
 * one of the App's terminals also tells that terminal itself, the instant it changes (OSC 7501,
 * see core/programStatus). The panel used to be the only reader of the second one, so with a
 * permission prompt just opened the panel said "waiting on you" while Ask, the quick bar and the
 * palette, reading the registry, still said busy.
 *
 * This module holds the signals and every list the operator reads goes through
 * `effectiveSessions`. The rule of who wins (the newer of the two; a clockless `waiting` is not
 * overridden) is core/programStatus's own, unchanged. A session outside the App's terminals has no
 * signal and keeps its registry status.
 *
 * Not a reader here, on purpose: the keep-awake driver and the command bus still read the registry.
 * For them the fresher signal would change WHEN the machine sleeps and WHEN a message is typed,
 * which are decisions of their own.
 */
import { parseProgramStatus, overlayProgramStatus, type ProgramStatus } from '../core/programStatus';

/** The latest OSC 7501 status per session id, as the renderer relayed it. */
const signals = new Map<string, ProgramStatus>();

/** Record a terminal's signal. True when something changed (a status kept or withdrawn). */
export function noteProgramStatus(sessionId: string, data: string, at: number): boolean {
  const id = String(sessionId || '').trim();
  if (!id) return false;
  const s = parseProgramStatus(data, Number(at) || Date.now());
  if (s === null || s === 'query') return false;
  if (s === 'clear') signals.delete(id); else signals.set(id, s);
  return true;
}

/** Drop the signals of sessions that are no longer in `liveIds`. */
export function forgetEndedSessions(liveIds: readonly string[]): void {
  const live = new Set(liveIds);
  for (const id of signals.keys()) if (!live.has(id)) signals.delete(id);
}

/** The list as the operator should read it: each session's registry status, overlaid by its own fresher signal. */
export function effectiveSessions<T extends { sessionId: string; status: string; waitingFor?: string; statusUpdatedAt?: number }>(list: readonly T[]): T[] {
  return overlayProgramStatus(list, signals);
}

/** Tests only: start from no signals. */
export function clearProgramStatusForTests(): void { signals.clear(); }
