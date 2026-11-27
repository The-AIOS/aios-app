/**
 * The surface records what it TYPES, so the provenance label reaches every bus message.
 *
 * Canonical's `hooks/provenance.py` labels a prompt "delivered, not typed by the operator" when
 * its fingerprint is in ~/.aios/bus-sent.jsonl. That log was written only by `hooks/bus_log.py`,
 * which sees a request written with a session's Write/Edit tool or caught by a watcher — and
 * sessions often write inbox files through Bash, so most agent-to-agent messages arrived with no
 * label. The one place every message passes is here: the surface, just before it types.
 *
 * THE FINGERPRINT MUST BE BYTE-IDENTICAL TO bus_log.py, which is Python:
 *   norm(t) = re.sub(r"\s+", " ", t).strip().lower();  fp = sha256(norm(t)[:2000]).hexdigest()[:24]
 * Two places where a naive JS port silently differs, each pinned by a vector in the shared
 * fixture generated FROM bus_log.py (test/fixtures/bus-fingerprints.json):
 *   · `\s` and strip(): Python's whitespace includes \x1c-\x1f and \x85 and excludes U+FEFF;
 *     JS's is the reverse. So the class is spelled out below, not borrowed from JS.
 *   · [:2000] counts CODE POINTS in Python and UTF-16 units in JS: an emoji before the cut moves
 *     it. So the slice is taken over Array.from(), which iterates code points.
 * lower() needs no help: both languages apply the full Unicode mapping, word-final Σ → ς
 * included (a vector pins that too; lowercasing per character was tried first and is wrong).
 * Pure: no fs. Each surface does its own append.
 */
import { createHash } from 'crypto';

/** Exactly the characters for which Python's str.isspace() is true. */
const PY_SPACE = '\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const RUNS = new RegExp(`[${PY_SPACE}]+`, 'gu');
const EDGES = new RegExp(`^[${PY_SPACE}]+|[${PY_SPACE}]+$`, 'gu');

export const BUS_LOG_KEEP_SECONDS = 14 * 86400;   // bus_log.KEEP_SECONDS

export function busNorm(text: string): string {
  const collapsed = String(text ?? '').replace(RUNS, ' ').replace(EDGES, '');
  return collapsed.toLowerCase();
}

export function busFingerprint(text: string): string {
  const head = Array.from(busNorm(text)).slice(0, 2000).join('');
  return createHash('sha256').update(head, 'utf8').digest('hex').slice(0, 24);
}

/**
 * The line to append to bus-sent.jsonl for one typed text, or null when there is nothing to add:
 * an empty text, or the same fingerprint already logged within the window provenance.py trusts.
 * (An older entry for the same text is NOT enough — the matcher ignores entries past 14 days, so
 * a text re-sent after that must be logged again.)
 */
export function busSentLine(
  text: string, to: string, action: string, via: string, existingLog: string, nowSec: number, from?: string,
): string | null {
  if (!String(text ?? '').trim()) return null;
  const fp = busFingerprint(text);
  const cutoff = nowSec - BUS_LOG_KEEP_SECONDS;
  for (const line of String(existingLog ?? '').split('\n')) {
    if (!line.includes(fp)) continue;
    try {
      const e = JSON.parse(line) as { fp?: string; at?: number };
      if (e.fp === fp && (e.at ?? 0) >= cutoff) return null;
    } catch { /* a torn line is not a match */ }
  }
  /* `from` (contract 4) only when the request carried a usable one — a claim, never an identity. */
  return JSON.stringify({ at: nowSec, fp, to, action, via, head: busNorm(text).slice(0, 80), ...(from ? { from } : {}) });
}
