/**
 * Append the fingerprint of every text this surface TYPES into a session to
 * ~/.aios/bus-sent.jsonl ($AIOS_BUS_LOG overrides), so canonical's provenance hook can label it
 * "delivered, not typed by the operator" however the request file was written. The format and
 * the fingerprint are canonical hooks/bus_log.py's, ported in core/busLog (pinned by vectors).
 * Best-effort: a failure here must never stop a delivery.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { busSentLine } from '../core/busLog';

export function busLogPath(): string {
  return process.env.AIOS_BUS_LOG || path.join(os.homedir(), '.aios', 'bus-sent.jsonl');
}

/* `via: "surface"` and `from` are inbox contract 4's record (canonical inbox-contract-4.md). */
export function recordTyped(text: string, to: string, action: string, from?: string): void {
  const via = 'surface';
  try {
    const p = busLogPath();
    let existing = '';
    try { existing = fs.readFileSync(p, 'utf8'); } catch { /* first entry */ }
    const line = busSentLine(text, to, action, via, existing, Math.floor(Date.now() / 1000), from);
    if (!line) return;
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, line + '\n');
  } catch { /* never block a delivery over its provenance record */ }
}
