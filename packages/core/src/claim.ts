/**
 * Claiming a request: the ORDER of the writes, in one place.
 *
 * Both surfaces watch one directory and race for the same `*.json`. The verdict (is this request
 * mine to take?) was already shared, `claimVerdict` in sendQueue. The writes around it were not,
 * and they are where two owners came from:
 *
 *   · One surface stamped `_claim` by REWRITING the request and then renamed it. If the sibling
 *     had already renamed the file away, the rewrite re-created it under the old name and the
 *     rename then replaced the sibling's hold: both believed they held the request, and it was
 *     fulfilled twice.
 *   · The other renamed first and stamped after: one winner, by the filesystem. But it decided
 *     from whatever it could read, so a file caught half-written read as an empty request, was
 *     claimed, found empty, and deleted with no dead letter. And between its rename and its stamp
 *     the hold sat on disk with no owner written in it, which a sibling looking for orphans reads
 *     as "nobody holds this" and adopts.
 *
 * The one order:
 *   1. READ, and if the request does not parse yet give its writer a moment.
 *   2. DECIDE.
 *   3. TAKE it: rename it to a name of our own, `<name>.json.claiming-<surface>-<pid>`. Atomic, so
 *      one process wins; and that name is neither a request (`*.json`) nor a hold (`*.holding`),
 *      so no watcher and no orphan sweep of any surface, old or new, looks at it.
 *   4. STAMP that private file.
 *   5. PUBLISH it as the hold: rename it to `<name>.json.holding`. The hold therefore never exists
 *      without its stamp, not even for an instant.
 *
 * Nothing is ever written to the request under its own name, and nothing is written to a file
 * another process can see.
 *
 * A crash between 3 and 5 leaves the private file behind. `recoverClaims` puts such a file back
 * as a request once the process named in it is gone, so the request is claimed again and not lost.
 *
 * `mayAdoptHold` is the other half, for holds made by a surface that still renames before it
 * stamps: an unstamped hold is left alone until it has been a hold for longer than that instant.
 *
 * This module reads, renames and writes. The filesystem calls are a parameter, so the order is
 * tested without a disk and with a sibling that acts between any two steps.
 */
import * as nodeFs from 'fs';
import { claimVerdict, triedBy, fulfillerId, holdPathFor, withQueuedAt, canAdoptHold, type ClaimStamp, type Surface } from './sendQueue';
import { sanitizeName } from './nameResolve';

/** How long a request that does not parse is given to finish being written. Local to each
 *  surface's patience with a writer, not a cross-process timing: it is not in TIMINGS. */
export const PARSE_GRACE_MS = 2_000;

export interface ClaimFs {
  readFileSync(path: string, encoding: 'utf8'): string;
  statSync(path: string): { mtimeMs: number };
  renameSync(from: string, to: string): void;
  writeFileSync(path: string, data: string): void;
  readdirSync(path: string): string[];
  existsSync(path: string): boolean;
}

/** The private name a request has between being taken and being published as a hold. */
export const CLAIMING_INFIX = '.claiming-';
export const claimingPathFor = (requestPath: string, surface: Surface, pid: number): string =>
  `${requestPath}${CLAIMING_INFIX}${surface}-${pid}`;
const CLAIMING_NAME = /^(.+\.json)\.claiming-(app|glass)-(\d+)$/;

export interface ClaimInput {
  /** This surface. */
  surface: Surface;
  pid: number;
  nowMs: number;
  /** TIMINGS.RETIRE_TTL_MS: how long an addressed or handed-back request waits for its taker. */
  retireTtlMs: number;
  parseGraceMs?: number;
  fs?: ClaimFs;
}

export type ClaimResult =
  /** Ours. `body` is the request as it was written (no `_claim`); the held file carries the stamp. */
  | { kind: 'claimed'; heldPath: string; raw: string; body: Record<string, unknown>; at: number }
  /** Not readable as a request yet, and young: look again after `afterMs`. Nothing was touched. */
  | { kind: 'wait'; afterMs: number }
  /** Old enough and still not a request, or a request whose claim could not be written: the
   *  caller dead-letters the file at `path` (the request's own name), with this reason. */
  | { kind: 'malformed'; reason: string }
  /** Addressed to another surface, or already tried here: leave it exactly where it is. */
  | { kind: 'skip' }
  /** Nobody took it in time: the caller dead-letters it, with this reason. Nothing was touched. */
  | { kind: 'retire'; reason: string; body: Record<string, unknown> }
  /** It vanished, or a sibling won the rename. Not an error. */
  | { kind: 'gone' };

/** A request is a JSON object with a name that survives cleaning. Anything else is not one yet. */
function parseBody(raw: string): Record<string, unknown> | undefined {
  if (!raw.trim()) return undefined;
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return undefined; }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  return sanitizeName((v as Record<string, unknown>).name) ? v as Record<string, unknown> : undefined;
}

export function claimRequest(fsPath: string, o: ClaimInput): ClaimResult {
  const fs = o.fs ?? nodeFs;
  const grace = o.parseGraceMs ?? PARSE_GRACE_MS;

  // 1. READ. A file we cannot read is gone or mid-write by a writer that will finish; either way
  //    the next directory event brings it back.
  let raw: string;
  try { raw = fs.readFileSync(fsPath, 'utf8'); } catch { return { kind: 'gone' }; }
  let ageMs = 0;
  try { ageMs = Math.max(0, o.nowMs - fs.statSync(fsPath).mtimeMs); } catch { /* treat as fresh */ }

  const body = parseBody(raw);
  if (!body) {
    /* A watcher fires on CREATE, before the writer has written. Young and unparseable is "not
       finished"; only old AND unparseable is malformed. Deciding from a half-read file is how a
       request was claimed as empty and deleted. */
    if (ageMs < grace) return { kind: 'wait', afterMs: grace };
    return { kind: 'malformed', reason: 'unparseable request (bad JSON, or no usable name)' };
  }

  // 2. DECIDE, from the shared verdict.
  const tried = triedBy(body);
  const myId = fulfillerId(o.surface, o.pid);
  const verdict = claimVerdict(body.surface, o.surface, ageMs, o.retireTtlMs, tried, myId);
  if (verdict === 'skip') return { kind: 'skip' };
  if (verdict === 'retire') {
    const mins = Math.round(ageMs / 60000);
    const reason = tried.includes(myId)
      ? `handed back for a sibling ${mins} min ago and no other surface took it`
      : `addressed to '${String(body.surface)}' but unclaimed for ${mins} min`;
    return { kind: 'retire', reason, body };
  }

  // 3. TAKE. Atomic: exactly one process gets past this line for a given file, and it is the
  //    only thing ever done to the request's own name, so a loser can never re-create it.
  const mine = claimingPathFor(fsPath, o.surface, o.pid);
  try { fs.renameSync(fsPath, mine); } catch { return { kind: 'gone' }; }

  // 4. STAMP the private file. Nobody else looks at this name.
  const at = o.nowMs;
  const stampedBody: Record<string, unknown> = { ...body, _claim: { surface: o.surface, pid: o.pid, at } };
  withQueuedAt(stampedBody, at);   // when it FIRST queued: kept through adoption and release
  try { fs.writeFileSync(mine, JSON.stringify(stampedBody, null, 2) + '\n'); } catch (e) {
    /* We hold a request we cannot stamp (a read-only file, a full disk). Running it unstamped
       would leave a hold any sibling may adopt. Put it back under its own name and say so: the
       caller dead-letters it, which renames it away, so it is not claimed again in a loop. */
    try { fs.renameSync(mine, fsPath); } catch { return { kind: 'gone' }; }
    return { kind: 'malformed', reason: `the claim could not be written into the request (${(e as NodeJS.ErrnoException)?.code ?? 'write failed'})` };
  }

  // 5. PUBLISH. The hold appears already stamped.
  const heldPath = holdPathFor(fsPath);
  try { fs.renameSync(mine, heldPath); } catch {
    try { fs.renameSync(mine, fsPath); } catch { /* recoverClaims finds it when this process is gone */ }
    return { kind: 'gone' };
  }
  return { kind: 'claimed', heldPath, raw, body, at };
}

/**
 * Put back the requests a dead process had taken and not yet published.
 *
 * A crash between TAKE and PUBLISH leaves `<name>.json.claiming-<surface>-<pid>` on disk, a name
 * no watcher claims. Once the process named in it is gone, the file goes back to `<name>.json`
 * and is claimed like any other request. A file whose process is still alive is in the middle of
 * a claim and is left alone, however long it has been there: a claimer that is merely paused (a
 * debugger, a suspended machine) will stamp and publish when it resumes, and restoring its file
 * meanwhile would have the request fulfilled twice. So is a file whose request name has been
 * reused meanwhile.
 *
 * The cost of that caution: after a crash, if the pid in the name is reused by another process of
 * this user, the file waits until that process ends. Rare, and it delays one request; it never
 * duplicates one.
 *
 * Returns the request paths it restored, for the caller to consume.
 */
export function recoverClaims(dir: string, o: { pid: number; isAlive: (pid: number) => boolean; fs?: ClaimFs; join?: (dir: string, name: string) => string }): string[] {
  const fs = o.fs ?? nodeFs;
  const join = o.join ?? ((d, n) => `${d}/${n}`);
  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const restored: string[] = [];
  for (const name of names) {
    const m = CLAIMING_NAME.exec(name);
    if (!m) continue;
    const pid = Number(m[3]);
    if (pid === o.pid || o.isAlive(pid)) continue;   // mid-claim, here or in a live sibling
    const back = join(dir, m[1]);
    if (fs.existsSync(back)) continue;               // that request name is in use again: leave both
    try { fs.renameSync(join(dir, name), back); restored.push(back); } catch { /* a sibling restored it first */ }
  }
  return restored;
}

/**
 * May a hold found on disk be adopted?
 *
 * `canAdoptHold` (sendQueue) answers for a stamped hold: its claimer is gone, or the hold is
 * stale. For a hold with NO stamp it says yes at once, because an unstamped hold used to mean a
 * request from before stamps existed. It is also what the claim of a surface that renames before
 * it stamps looks like for an instant, and adopting it then fulfils the request twice. So an
 * unstamped hold is left alone until it has BEEN A HOLD for longer than that instant.
 *
 * `holdAgeMs` is how long ago the file became a hold, which is not its mtime: a rename keeps the
 * mtime of the request it came from, so a request that waited a minute would look like a
 * minute-old hold the moment it is claimed. Pass the time since the later of mtime and ctime
 * (`holdAgeMs` below); the rename moves ctime.
 */
export const UNSTAMPED_HOLD_GRACE_MS = PARSE_GRACE_MS;
export function mayAdoptHold(
  claim: ClaimStamp | undefined,
  nowMs: number,
  staleMs: number,
  claimerAlive: boolean,
  holdAgeMs: number,
): boolean {
  if (!claim && holdAgeMs < UNSTAMPED_HOLD_GRACE_MS) return false;
  return canAdoptHold(claim, nowMs, staleMs, claimerAlive);
}

/** How long a file has been a hold: since the later of its last write and its last rename. */
export function holdAgeMs(stat: { mtimeMs: number; ctimeMs: number }, nowMs: number): number {
  return Math.max(0, nowMs - Math.max(stat.mtimeMs, stat.ctimeMs));
}
