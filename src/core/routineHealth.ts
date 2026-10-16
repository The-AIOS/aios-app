/**
 * #27 — scheduled-job health, read from canonical's status files (~/.aios/health/<name>.json,
 * written by hooks/aios-health.py since v0.8.12). Pure: main reads the directory, this decides.
 *
 * The contract is canonical's, ported rule for rule so the App and /today never disagree:
 *  · one file per job: { name, state: ok|warn|fail|pending, detail, written_at, valid_until }
 *  · past valid_until → OVERDUE ("no result since {written_at}"), never "didn't run" — it may have
 *    run and failed to write. A job installed but never completed (state pending, now overdue)
 *    says exactly that.
 *  · an unreadable file is a row ("unreadable"), never skipped — a broken writer is news.
 *  · no directory, no files → no rows: a machine with no scheduled jobs shows nothing.
 */

export type RoutineState = 'ok' | 'warn' | 'fail' | 'pending';
export type RoutineStatus = 'ok' | 'waiting' | 'warn' | 'fail' | 'overdue' | 'unreadable';

export interface RoutineRow {
  name: string;
  status: RoutineStatus;
  state?: RoutineState;
  detail?: string;
  writtenAt?: number;     // ms
  validUntil?: number;    // ms
  why?: string;           // unreadable only
}

const STATES: readonly RoutineState[] = ['ok', 'warn', 'fail', 'pending'];
const FIELDS = ['name', 'state', 'detail', 'written_at', 'valid_until'] as const;
/* Canonical writes exactly `YYYY-MM-DDTHH:MM:SSZ`; anything else is a malformed file, as it is there. */
const ISO_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

function parseIso(v: unknown): number {
  if (typeof v !== 'string' || !ISO_Z.test(v)) throw new Error(`bad timestamp ${JSON.stringify(v)}`);
  const t = Date.parse(v);
  if (!Number.isFinite(t)) throw new Error(`bad timestamp ${JSON.stringify(v)}`);
  return t;
}

/** One row per `<name>.json` (dot-files skipped, as canonical's temp files are). Sorted by name. */
export function routineRows(files: ReadonlyArray<{ file: string; text: string }>, now: number): RoutineRow[] {
  const out: RoutineRow[] = [];
  for (const { file, text } of [...files].sort((a, b) => a.file.localeCompare(b.file))) {
    if (!file.endsWith('.json') || file.startsWith('.')) continue;
    const name = file.slice(0, -5);
    try {
      const rec = JSON.parse(text) as Record<string, unknown>;
      if (!rec || typeof rec !== 'object' || FIELDS.some((k) => !(k in rec)) || !STATES.includes(rec.state as RoutineState)) {
        throw new Error('missing field or unknown state');
      }
      const writtenAt = parseIso(rec.written_at), validUntil = parseIso(rec.valid_until);
      if (validUntil <= writtenAt) throw new Error('valid_until is not after written_at');
      const state = rec.state as RoutineState;
      const status: RoutineStatus = now > validUntil ? 'overdue' : state === 'pending' ? 'waiting' : state;
      out.push({ name, status, state, detail: String(rec.detail ?? ''), writtenAt, validUntil });
    } catch (e) {
      out.push({ name, status: 'unreadable', why: String((e as Error).message || e).slice(0, 120) });
    }
  }
  return out;
}

/** Does this row need the operator? Everything except a job that is fine or not yet due. */
export const routineNeedsAttention = (r: RoutineRow): boolean => r.status !== 'ok' && r.status !== 'waiting';
