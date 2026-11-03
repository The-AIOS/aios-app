/**
 * Reading a session's transcript without ever loading it whole. Electron-free, so it can be
 * tested directly; the command bus uses it to verify sends and the kill guard to read idleSince.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as aios from './aios';

/** Where a session's transcript lives, or undefined when it does not exist (yet). */
export function transcriptPath(sessionId: string): string | undefined {
  if (!sessionId) return undefined;
  const base = path.join(aios.claudeConfigDir(), 'projects');
  let dirs: string[] = [];
  try { dirs = fs.readdirSync(base); } catch { return undefined; }
  for (const d of dirs) {
    const f = path.join(base, d, `${sessionId}.jsonl`);
    if (fs.existsSync(f)) return f;
  }
  return undefined;
}

/** A whole-transcript read is refused above this: V8 cannot hold a string past ~512 MB, and reading
 *  hundreds of MB on the main thread stalls the App anyway. Callers treat '' as "nothing to read". */
export const WHOLE_TRANSCRIPT_MAX_BYTES = 400 * 1024 * 1024;

/** Read the target's whole transcript (the kill guard's idleSince); the counting RULE is pure and lives
 *  in core/sendQueue. Sends do NOT use this — they read only what was appended (TranscriptSince). */
export function readTranscript(sessionId: string): string {
  const f = transcriptPath(sessionId);
  if (!f) return '';
  try { if (fs.statSync(f).size > WHOLE_TRANSCRIPT_MAX_BYTES) return ''; return fs.readFileSync(f, 'utf8'); } catch { return ''; }
}

/**
 * VERIFY A SEND BY READING ONLY WHAT WAS APPENDED SINCE IT STARTED.
 *
 * The measured failure: every repeat delivery went to one session whose transcript had grown to
 * 554 MB. The verifier read the WHOLE file into a string; past V8's ~512 MB string limit that read
 * throws, the old catch turned the throw into '' — zero deliveries — and an idle target was then
 * typed the same message every 20 s, three times. So:
 *  · the first read records the file's size, and every later read returns only the bytes after it
 *    (deliveries counted are the ones since this send began, which is what the old `sinceMs` filter
 *    reduced the whole file to anyway);
 *  · a read that FAILS (anything but "no file yet") is null — "cannot verify" — and the caller must
 *    never re-type on it: the message was typed once, and a second copy is the bug.
 */
export class TranscriptSince {
  private offsets = new Map<string, number>();
  /** Text appended since this send first looked; '' when there is no file yet; null when unreadable. */
  read(sessionId: string): string | null {
    const f = transcriptPath(sessionId);
    if (!f) return '';
    try {
      const size = fs.statSync(f).size;
      if (!this.offsets.has(sessionId)) this.offsets.set(sessionId, size);
      const from = this.offsets.get(sessionId) as number;
      if (size <= from) return '';
      if (size - from > WHOLE_TRANSCRIPT_MAX_BYTES) return null;   // absurd growth mid-send: cannot verify
      const buf = Buffer.alloc(size - from);
      const fd = fs.openSync(f, 'r');
      try { fs.readSync(fd, buf, 0, buf.length, from); } finally { fs.closeSync(fd); }
      return buf.toString('utf8');
    } catch { return null; }
  }
}
