/**
 * #75: record a pane's raw terminal output, so a screen that is drawn wrong (a reply drawn twice, a
 * redraw that starts rows too high, seen on Windows) can be replayed byte for byte and the wrong
 * redraw pinned on the program that sent it or on the terminal that drew it.
 *
 * The file is asciicast v2 (https://docs.asciinema.org/manual/asciicast/v2/): a header line, then one
 * JSON array per event, `[seconds, "o", data]` for output and `[seconds, "r", "COLSxROWS"]` for a resize.
 * Any asciinema player replays it, and so does a headless xterm fed the "o" events in order.
 * It holds EVERYTHING the pane showed, secrets included: it is written only when the operator turns it
 * on for one tab, kept in the App's own folder, readable by the operator alone. Pure, so the format is
 * tested here.
 */

export interface RecordHeader { width: number; height: number; timestamp: number; title?: string }
export type RecordEvent = { t: number; kind: 'o'; data: string } | { t: number; kind: 'r'; cols: number; rows: number };

const secs = (ms: number): number => Math.max(0, Math.round(ms) / 1000);

/** The first line: terminal size at the start, and when it started (Unix seconds). */
export function headerLine(cols: number, rows: number, startMs: number, title?: string): string {
  const h: Record<string, unknown> = { version: 2, width: Math.max(1, Math.floor(cols)), height: Math.max(1, Math.floor(rows)), timestamp: Math.floor(startMs / 1000) };
  if (title) h.title = String(title).slice(0, 200);
  return JSON.stringify(h) + '\n';
}

/** Output the program sent, `elapsedMs` after the start. JSON keeps every byte, escape codes included. */
export function outputLine(elapsedMs: number, data: string): string {
  return JSON.stringify([secs(elapsedMs), 'o', String(data)]) + '\n';
}

/** The pane was resized. */
export function resizeLine(elapsedMs: number, cols: number, rows: number): string {
  return JSON.stringify([secs(elapsedMs), 'r', `${Math.floor(cols)}x${Math.floor(rows)}`]) + '\n';
}

/** Read a recording back: its header and events in order. Lines that are not events are skipped. */
export function parseRecording(text: string): { header: RecordHeader | null; events: RecordEvent[] } {
  const lines = String(text || '').split('\n').filter((l) => l.trim());
  let header: RecordHeader | null = null;
  const events: RecordEvent[] = [];
  lines.forEach((l, i) => {
    let v: unknown;
    try { v = JSON.parse(l); } catch { return; }
    if (i === 0 && v && !Array.isArray(v) && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (o.version === 2) header = { width: Number(o.width), height: Number(o.height), timestamp: Number(o.timestamp), ...(typeof o.title === 'string' ? { title: o.title } : {}) };
      return;
    }
    if (!Array.isArray(v) || v.length < 3 || typeof v[0] !== 'number') return;
    const t = Math.round(v[0] * 1000);
    if (v[1] === 'o' && typeof v[2] === 'string') events.push({ t, kind: 'o', data: v[2] });
    else if (v[1] === 'r' && typeof v[2] === 'string') {
      const m = /^(\d+)x(\d+)$/.exec(v[2]);
      if (m) events.push({ t, kind: 'r', cols: Number(m[1]), rows: Number(m[2]) });
    }
  });
  return { header, events };
}

/** A file name for one recording: the tab's name, made safe, and the local time it started. */
export function recordingName(tabName: string, startMs: number): string {
  const d = new Date(startMs);
  const pad = (n: number): string => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}${String(d.getMilliseconds()).padStart(3, '0')}`;
  const safe = String(tabName || 'terminal').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'terminal';
  return `${safe}-${stamp}.cast`;
}
