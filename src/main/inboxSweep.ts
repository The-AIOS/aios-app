/**
 * The inbox sweep: look again, on a clock, at requests nobody has taken.
 *
 * A fulfiller decides what to do with a `*.json` request when a file event arrives for it, and
 * once more for whatever is on disk at startup. A request it SKIPS because it is addressed to
 * another surface produces no further event, so nothing ever asked the question again.
 * `claimVerdict` answers `retire` once the request is older than `RETIRE_TTL_MS`, but only to
 * someone who asks: a request addressed to a surface that is not running sat in the inbox for
 * good, while the inbox README promised it would be retired (The-AIOS/aios-app#218).
 *
 * The other kind of skip, a request this instance tried and handed back for a sibling, already
 * had someone asking: the releaser sets a timer for `RETIRE_TTL_MS`. The sweep reaches that case
 * too, so it no longer rests on one timer.
 *
 * So this asks again every minute, through the SAME consume the watcher and the startup drain
 * use. It adds no decision of its own: what happens to a request is still `claimVerdict`'s to
 * say, and a claim is still one atomic rename, so a sweep that meets a file event for the same
 * request cannot take it twice. A side effect worth having: a request whose file event was lost
 * is picked up a minute later instead of never.
 *
 * No timing of the contract lives here. The cadence is how often this surface looks, not when a
 * request may be retired; that is `TIMINGS.RETIRE_TTL_MS` in core/sendQueue, untouched.
 *
 * This file holds no surface-specific code and is kept the same, by hand, in the App
 * (src/main/) and in Glass (src/bus/) until the bus decisions move into the shared package
 * (The-AIOS/aios-app#229). Nothing compares the two copies; change both.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parsePresenceRecord } from '../core/presence';

/** How often a surface re-examines the requests still waiting in the inbox. */
export const INBOX_SWEEP_MS = 60_000;

/**
 * A request younger than this is left to its own file event. The sweep exists for requests that
 * have been waiting; a file written a moment ago may still be half-written, and its writer's
 * event is about to arrive anyway. Handing it over here would only add a second chance to read
 * it before it is whole.
 */
export const SWEEP_MIN_AGE_MS = 5_000;

/** The requests waiting in `dir`: `*.json` only, and only those at least `minAgeMs` old by their
 *  mtime. A `.holding` is claimed and a `.undelivered` is finished; neither is a request any
 *  more. An unreadable directory holds none, and a file that vanishes mid-listing is skipped. */
export function pendingRequests(dir: string, minAgeMs: number = 0, nowMs: number = Date.now()): string[] {
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out: string[] = [];
  for (const f of names.filter((n) => n.endsWith('.json')).sort()) {
    const p = path.join(dir, f);
    if (minAgeMs > 0) {
      try { if (nowMs - fs.statSync(p).mtimeMs < minAgeMs) continue; } catch { continue; }
    }
    out.push(p);
  }
  return out;
}

/** Hand every request that has been waiting at least `SWEEP_MIN_AGE_MS` to `consume`, once.
 *  Returns how many it handed over. A consume that throws on one request does not stop the rest. */
export function sweepInbox(dir: string, consume: (fsPath: string) => void): number {
  let n = 0;
  for (const p of pendingRequests(dir, SWEEP_MIN_AGE_MS)) {
    n++;
    try { consume(p); } catch { /* one bad request must not hide the others */ }
  }
  return n;
}

/** Sweep `dir` every `everyMs` until the returned function is called. The timer does not keep
 *  the process alive. */
export function startInboxSweep(dir: string, consume: (fsPath: string) => void, everyMs: number = INBOX_SWEEP_MS): () => void {
  const timer = setInterval(() => { sweepInbox(dir, consume); }, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * Is the surface a request was addressed to running right now?
 *
 * Each surface publishes `~/.aios/surfaces/<surface>.json` with its pid. A record outlives its
 * process, so only a pid that is still alive counts, and a record written before this boot names
 * nobody whatever its pid now belongs to. Absent, unreadable and malformed all mean "not running".
 */
export function addresseeRunning(
  surface: string,
  pidAlive: (pid: number) => boolean,
  surfacesDir: string = path.join(os.homedir(), '.aios', 'surfaces'),
  nowMs: number = Date.now(),
  uptimeS: number = os.uptime(),
): boolean {
  if (!/^[a-z0-9-]+$/.test(surface)) return false;
  let raw: string;
  try { raw = fs.readFileSync(path.join(surfacesDir, `${surface}.json`), 'utf8'); } catch { return false; }
  const rec = parsePresenceRecord(raw);
  const pid = Number(rec?.pid);
  if (!Number.isInteger(pid) || pid <= 1) return false;
  if (typeof rec?.at === 'number' && rec.at < nowMs - uptimeS * 1000 - 60_000) return false;
  return pidAlive(pid);
}

/** The reason written into the dead letter of a request its addressee never took. It names the
 *  addressee and says whether it was running, because the two cases want different answers from
 *  whoever reads it: start that surface, or find out why a running one did not take the request. */
export function unclaimedReason(surface: string, ageMs: number, running: boolean): string {
  const min = Math.round(ageMs / 60000);
  return running
    ? `addressed to '${surface}', which is running and did not take it; unclaimed for ${min} min`
    : `addressed to '${surface}', which is not running; unclaimed for ${min} min`;
}
