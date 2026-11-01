import * as fs from 'fs';
import * as path from 'path';
import { StringDecoder } from 'string_decoder';
import { createTranscriptTracker, isConversationLine, type ChatItem, type TranscriptTracker, type TranscriptUsage } from '../core/transcriptChat';
import { projectsDir } from './usageIo';

/**
 * Chat skin — follow a session's transcript file live and turn it into chat events.
 *
 * Imports nothing from electron: the file location is injected and every event leaves through the
 * callback given to `watch`, so the whole thing runs (and is tested) under plain node.
 *
 * What it has to survive, all of which happen to real transcripts:
 *  - the file does not exist yet (a brand-new session writes its first line seconds after launch),
 *    so locating it is retried instead of failing once;
 *  - the writer appends a line in two writes, so a read can end mid-line — the tail is held back
 *    until its newline arrives (and a multi-byte character split across reads is decoded whole);
 *  - the file is large (tens of MB with the request blobs, hundreds of MB after weeks), so the view is given
 *    only the TAIL of it — the last TAIL_LINES conversation lines, at most TAIL_MAX_BYTES — read backwards in chunks,
 *    async, and never blocking the main process. WHY A TAIL: the renderer paints and keeps every row it is sent, so
 *    sending the whole history made the DOM, the renderer's memory and the cost of each new line grow with the file
 *    (measured: 160k DOM nodes and 1.4 GB of renderer memory at 50k lines, versus 15k nodes at 5k; scripts/chat-bench.mjs).
 *    What is before the window is fetched on demand with `loadEarlier`, one window at a time, as the operator scrolls up;
 *  - the file is truncated or replaced, in which case the view is reset and re-read from the top;
 *  - `fs.watch` is unreliable (coalesced, missed after a replace, EMFILE), so a slow poll runs
 *    alongside it and is the guarantee; the watcher only makes it quicker.
 * Nothing is left behind: `unwatch` clears the fs watcher and the timer, and a read in flight
 * notices and stops emitting.
 */

export type TailEvent =
  | { type: 'reset' }
  /** Right after `reset`: whether the file has lines BEFORE the window about to be sent (so the view can ask for them). */
  | { type: 'span'; earlier: boolean }
  /** The answer to `loadEarlier`: older items, oldest first, to go ABOVE the ones already shown. `more`: still older lines exist. */
  | { type: 'earlier'; items: ChatItem[]; more: boolean }
  | { type: 'items'; items: ChatItem[] }
  | { type: 'turn'; open: boolean }
  | { type: 'usage'; contextTokens?: number; model?: string }
  | { type: 'missing' }
  | { type: 'error'; code: string };

export type TailEmit = (ev: { paneId: number } & TailEvent) => void;

export type WatchResult = { ok: true; file: string } | { ok: false; error: 'not-found' | 'bad-id' };

export interface TailOptions {
  /** Claude Code's projects folder. Defaults to the one honouring CLAUDE_CONFIG_DIR. */
  projectsDir?: () => string;
  /** Poll period. Also how often a missing file is searched for (slower after a while). */
  pollMs?: number;
  /** Bytes per backfill read. */
  chunkBytes?: number;
  /** How many conversation lines a window holds at least (default TAIL_LINES). */
  tailLines?: number;
  /** The most bytes a window reads before giving up on reaching `tailLines` (default TAIL_MAX_BYTES). */
  tailMaxBytes?: number;
}

/**
 * The window the view starts with, and each step back. Lines, not bytes, because that is what becomes rows; the byte cap is
 * for transcripts whose lines are huge (a tool result is ~160 KB on average in a real one, so 300 lines can be tens of MB).
 * ~300 lines is a few hundred rows' worth of DOM at most; 16 MB parses in ~0.1 s. Both are options so a test can use tiny ones.
 */
export const TAIL_LINES = 300;
export const TAIL_MAX_BYTES = 16 * 1024 * 1024;
/** A window that cuts a tool call in two is extended by this many chunks at most, then accepted as it is. */
const SEAM_EXTRA_CHUNKS = 3;

export interface TranscriptTail {
  watch(paneId: number, sessionId: string, onEvent: TailEmit): Promise<WatchResult>;
  unwatch(paneId: number): void;
  /** Read whatever the writer flushed last, THEN stop — for a session that just exited. */
  finish(paneId: number): Promise<void>;
  unwatchAll(): void;
  /** Pane ids with a live watcher — what a leak test (and the quit path) asks. */
  active(): number[];
  /**
   * Read the window of lines just before what the pane has been given and emit it as one `earlier` event (oldest first).
   * Resolves false when there is nothing to answer with (no watcher, file not located yet, another request in flight).
   */
  loadEarlier(paneId: number): Promise<boolean>;
  /** What a pane's watcher follows right now: the session id and, once located, its file. */
  current(paneId: number): { sessionId: string; file?: string } | undefined;
}

/** The id becomes part of a PATH, so anything that is not id-shaped is refused before it is joined. */
export const isSessionId = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9-]{8,}$/.test(s);

/**
 * Find `<base>/<any project folder>/<sessionId>.jsonl`. The project folder is the cwd slug, which
 * the caller usually does not know (the session may have been resumed from another folder), so
 * every subdirectory is tried.
 */
export async function locateTranscript(base: string, sessionId: string): Promise<string | undefined> {
  if (!isSessionId(sessionId)) return undefined;
  let dirs: fs.Dirent[];
  try { dirs = await fs.promises.readdir(base, { withFileTypes: true }); } catch { return undefined; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const f = path.join(base, d.name, `${sessionId}.jsonl`);
    try { await fs.promises.access(f); return f; } catch { /* not in this folder */ }
  }
  return undefined;
}

interface Watcher {
  paneId: number;
  sessionId: string;
  emit: TailEmit;
  tracker: TranscriptTracker;
  file?: string;
  ino?: number;
  offset: number;
  rest: string;
  decoder: StringDecoder;
  fsw?: fs.FSWatcher;
  timer?: NodeJS.Timeout;
  closed: boolean;
  reading: boolean;
  again: boolean;
  /** True from "file located / reset" until the backfill pass ends: only items are streamed then. */
  syncing: boolean;
  /** Byte offset where the lines the view has been given begin (0: nothing earlier exists). Always the start of a line. */
  from: number;
  /** The window has been read for this pass; bumps on every rewind so a read in flight from an older pass drops its result. */
  windowed: boolean;
  gen: number;
  earlierBusy: boolean;
  missingSent: boolean;
  polls: number;
}

export function createTranscriptTail(opts: TailOptions = {}): TranscriptTail {
  const base = (): string => (opts.projectsDir ?? projectsDir)();
  const pollMs = opts.pollMs ?? 1000;
  const chunk = Math.max(4096, opts.chunkBytes ?? 1024 * 1024);
  /** The step of a read from the END: small, because a window is sized to the nearest step above what it needs (a 1 MB step would
   *  hand a chatty transcript, whose lines are a few hundred bytes, thousands of lines for a window meant to hold ~300). */
  const back = Math.min(chunk, 256 * 1024);
  const watchers = new Map<number, Watcher>();

  const emit = (w: Watcher, ev: TailEvent): void => {
    if (w.closed) return;
    try { w.emit({ paneId: w.paneId, ...ev }); } catch { /* the window is gone; nothing to tell */ }
  };

  function closeFsWatcher(w: Watcher): void {
    try { w.fsw?.close(); } catch { /* already closed */ }
    w.fsw = undefined;
  }

  function startFsWatcher(w: Watcher): void {
    closeFsWatcher(w);
    if (!w.file) return;
    try {
      // 'rename' means the inode went away (replace/delete): re-arm on the next pump
      w.fsw = fs.watch(w.file, (kind) => { if (kind === 'rename') closeFsWatcher(w); void pump(w); });
      w.fsw.on('error', () => closeFsWatcher(w));   // polling still covers us
    } catch { /* EMFILE, or the file vanished: the poll is the guarantee */ }
  }

  /** (Re)start reading from the top: the view is told to empty itself first. */
  function rewind(w: Watcher): void {
    w.tracker.reset();
    w.offset = 0;
    w.rest = '';
    w.decoder = new StringDecoder('utf8');
    w.syncing = true;
    w.from = 0; w.windowed = false; w.gen++;
    emit(w, { type: 'reset' });
  }

  function flush(w: Watcher, lines: string[]): void {
    if (lines.length === 0) return;
    const u = w.tracker.feedAll(lines);
    if (u.items.length) emit(w, { type: 'items', items: u.items });
    // while backfilling, the flips of a whole history are noise; the end state is announced once
    if (w.syncing) return;
    if (u.turnOpen !== undefined) emit(w, { type: 'turn', open: u.turnOpen });
    if (u.usage) emit(w, { type: 'usage', ...usageFields(u.usage) });
  }

  const usageFields = (u: TranscriptUsage): { contextTokens?: number; model?: string } => ({
    ...(u.contextTokens !== undefined ? { contextTokens: u.contextTokens } : {}),
    ...(u.model !== undefined ? { model: u.model } : {}),
  });

  async function readTo(w: Watcher, size: number): Promise<void> {
    if (!w.file) return;
    const fh = await fs.promises.open(w.file, 'r');
    try {
      while (!w.closed && w.offset < size) {
        const buf = Buffer.alloc(Math.min(chunk, size - w.offset));
        const { bytesRead } = await fh.read(buf, 0, buf.length, w.offset);
        if (bytesRead === 0) break;
        w.offset += bytesRead;
        const text = w.rest + w.decoder.write(buf.subarray(0, bytesRead));
        const lines = text.split('\n');
        w.rest = lines.pop() ?? '';        // the unfinished tail waits for its newline
        flush(w, lines);
      }
    } finally { await fh.close(); }
  }

  /**
   * The lines of `[start, end)` where `end` is a line boundary (or the end of the file) and `start` is chosen by reading
   * BACKWARDS in chunks until at least `minLines` conversation lines and `minBytes` bytes are in, never past `maxBytes`.
   * Works on bytes and cuts at a newline byte, which cannot occur inside a multi-byte character, so no character is split.
   * `rest` is the unfinished text after the last newline (the writer's half-written line), empty when `end` is a boundary.
   */
  async function readBack(file: string, end: number, minLines: number, minBytes: number, maxBytes: number): Promise<{ start: number; lines: string[]; rest: string }> {
    const fh = await fs.promises.open(file, 'r');
    try {
      const bufs: Buffer[] = [];
      let pos = end, total = 0, kept = 0;
      while (pos > 0 && total < maxBytes && (kept < minLines || total < minBytes)) {
        const n = Math.min(back, pos);
        const buf = Buffer.alloc(n);
        const { bytesRead } = await fh.read(buf, 0, n, pos - n);
        if (bytesRead !== n) break;                       // the file shrank under us: what we have is what we have
        bufs.unshift(buf); pos -= n; total += n;
        // Count the lines that START in this chunk: its first piece is the end of a line begun in the previous one (unless this is
        // the top of the file), and judging a fragment by its head would count every chunk of a huge bookkeeping line as a row.
        // latin1: no UTF-8 validation, the type tag is ASCII.
        const pieces = buf.toString('latin1').split('\n');
        for (let i = pos === 0 ? 0 : 1; i < pieces.length; i++) if (isConversationLine(pieces[i])) kept++;
      }
      const all = Buffer.concat(bufs);
      let cut = 0;
      if (pos > 0) {
        const nl = all.indexOf(0x0a);
        if (nl === -1) return { start: end, lines: [], rest: '' };   // one line longer than the whole budget: skip it rather than hold it
        cut = nl + 1;                                     // the first line is a fragment: it belongs to the window before this one
      }
      const lines = all.subarray(cut).toString('utf8').split('\n');
      return { start: pos + cut, lines, rest: lines.pop() ?? '' };
    } finally { await fh.close(); }
  }

  /** Where the line ending at `end` begins. Scans without holding the line: this is for one no window can hold. */
  async function lineStart(file: string, end: number): Promise<number> {
    const fh = await fs.promises.open(file, 'r');
    try {
      const buf = Buffer.alloc(back);
      let pos = end - 1;                                  // the byte before `end` is that line's own newline
      while (pos > 0) {
        const n = Math.min(back, pos);
        const { bytesRead } = await fh.read(buf, 0, n, pos - n);
        if (bytesRead !== n) return 0;                    // the file shrank under us
        const nl = buf.subarray(0, n).lastIndexOf(0x0a);
        if (nl !== -1) return pos - n + nl + 1;
        pos -= n;
      }
      return 0;
    } finally { await fh.close(); }
  }

  /** readBack, then feed `tracker` and widen the read while a tool result's call is missing (the window cut a call in two). */
  async function readWindow(file: string, end: number, tracker: TranscriptTracker): Promise<{ start: number; rest: string; items: ChatItem[] }> {
    const minLines = Math.max(1, opts.tailLines ?? TAIL_LINES);
    const maxBytes = Math.max(back, opts.tailMaxBytes ?? TAIL_MAX_BYTES);
    let minBytes = 0;
    for (let extra = 0; ; extra++) {
      const r = await readBack(file, end, minLines, minBytes, maxBytes + extra * back);
      if (r.start === end && end > 0) {                   // a line no window can hold: step over it, or the read never moves and the view asks forever
        end = await lineStart(file, end);
        extra--; minBytes = 0;
        continue;
      }
      tracker.reset();
      const u = tracker.feedAll(r.lines);
      if (tracker.snapshot().orphanResults === 0 || r.start === 0 || extra >= SEAM_EXTRA_CHUNKS) return { start: r.start, rest: r.rest, items: u.items };
      minBytes = end - r.start + back;
    }
  }

  /** The first pass of a (re)wind: read the tail window instead of the file, tell the view whether there is more before it. */
  async function loadWindow(w: Watcher, size: number): Promise<void> {
    w.windowed = true;
    const gen = w.gen;
    const r = await readWindow(w.file as string, size, w.tracker);
    if (w.closed || gen !== w.gen) return;                // replaced meanwhile: that pass owns the view now
    w.from = r.start;
    w.offset = size;                                      // live lines are read from here on, as before
    w.rest = r.rest;
    emit(w, { type: 'span', earlier: r.start > 0 });
    if (r.items.length) emit(w, { type: 'items', items: r.items });
  }

  async function loadEarlier(paneId: number): Promise<boolean> {
    const w = watchers.get(paneId);
    if (!w || w.closed || !w.file || !w.windowed || w.syncing || w.earlierBusy) return false;
    if (w.from <= 0) { emit(w, { type: 'earlier', items: [], more: false }); return true; }
    w.earlierBusy = true;
    const gen = w.gen;
    try {
      // a tracker of its own: the live one holds the turn state and the calls still running, and must not see old history
      const r = await readWindow(w.file, w.from, createTranscriptTracker());
      if (w.closed || gen !== w.gen) return true;
      w.from = r.start;
      emit(w, { type: 'earlier', items: r.items, more: r.start > 0 });
    } catch { emit(w, { type: 'error', code: 'read-failed' }); }
    finally { w.earlierBusy = false; }
    return true;
  }

  async function locate(w: Watcher): Promise<boolean> {
    if (w.file) return true;
    const f = await locateTranscript(base(), w.sessionId);
    if (w.closed) return false;
    if (!f) {
      if (!w.missingSent) { w.missingSent = true; emit(w, { type: 'missing' }); }
      return false;
    }
    w.file = f;
    w.ino = undefined;
    rewind(w);
    startFsWatcher(w);
    return true;
  }

  async function pump(w: Watcher): Promise<void> {
    if (w.closed) return;
    if (w.reading) { w.again = true; return; }
    w.reading = true;
    try {
      do {
        w.again = false;
        if (!(await locate(w))) break;
        let st: fs.Stats;
        try { st = await fs.promises.stat(w.file as string); }
        catch {
          // deleted under us: forget the file and go back to searching (a new one may appear)
          closeFsWatcher(w); w.file = undefined; w.missingSent = false; w.ino = undefined;
          break;
        }
        if (w.ino !== undefined && (st.ino !== w.ino || st.size < w.offset)) {
          rewind(w);                       // replaced or truncated: the old offset means nothing
          startFsWatcher(w);
        }
        w.ino = st.ino;
        if (!w.fsw) startFsWatcher(w);
        if (w.syncing && !w.windowed && w.offset === 0) await loadWindow(w, st.size);
        if (st.size > w.offset) await readTo(w, st.size);
        if (w.syncing && !w.closed) {
          w.syncing = false;
          const s = w.tracker.snapshot();
          emit(w, { type: 'turn', open: s.turnOpen });
          if (s.usage.contextTokens !== undefined || s.usage.model !== undefined) emit(w, { type: 'usage', ...usageFields(s.usage) });
        }
      } while (w.again && !w.closed);
    } catch {
      emit(w, { type: 'error', code: 'read-failed' });
    } finally { w.reading = false; }
  }

  function stop(w: Watcher): void {
    w.closed = true;
    if (w.timer) clearInterval(w.timer);
    w.timer = undefined;
    closeFsWatcher(w);
    if (watchers.get(w.paneId) === w) watchers.delete(w.paneId);
  }

  function unwatch(paneId: number): void {
    const w = watchers.get(paneId);
    if (w) stop(w);
  }

  async function finish(paneId: number): Promise<void> {
    const w = watchers.get(paneId);
    if (!w) return;
    // A session's last lines (the closing answer, turn_duration) land right before its pty exits,
    // usually before the poll has seen them. Wait out a read in flight, take one more pass, stop.
    for (let i = 0; i < 100 && w.reading && !w.closed; i++) await new Promise((r) => setTimeout(r, 20));
    if (!w.closed) await pump(w);
    stop(w);
  }

  async function watch(paneId: number, sessionId: string, onEvent: TailEmit): Promise<WatchResult> {
    unwatch(paneId);                       // a pane follows one session at a time
    if (!isSessionId(sessionId)) return { ok: false, error: 'bad-id' };
    const w: Watcher = {
      paneId, sessionId, emit: onEvent, tracker: createTranscriptTracker(),
      offset: 0, rest: '', decoder: new StringDecoder('utf8'),
      closed: false, reading: false, again: false, syncing: true, missingSent: false, polls: 0,
      from: 0, windowed: false, gen: 0, earlierBusy: false,
    };
    watchers.set(paneId, w);
    // The poll is the guarantee. A session that never writes a transcript (a shell, a claude that
    // never started) is searched for less and less often instead of every second forever.
    w.timer = setInterval(() => {
      w.polls++;
      if (!w.file && w.polls > 30 && w.polls % 5 !== 0) return;
      void pump(w);
    }, pollMs);
    w.timer.unref?.();
    // Hold the read lock while locating, or the first poll tick can locate the same file at the same
    // time and the view gets two resets. A tick that lands meanwhile just asks for another pass.
    w.reading = true;
    let found = false;
    try { found = await locate(w); } finally { w.reading = false; }
    if (w.closed) return { ok: false, error: 'not-found' };   // unwatched while we looked
    void pump(w);                          // backfill streams after this returns
    return found ? { ok: true, file: w.file as string } : { ok: false, error: 'not-found' };
  }

  return {
    watch,
    unwatch,
    finish,
    loadEarlier,
    unwatchAll(): void { for (const w of [...watchers.values()]) stop(w); },
    active(): number[] { return [...watchers.keys()]; },
    current(paneId: number): { sessionId: string; file?: string } | undefined {
      const w = watchers.get(paneId);
      return w ? { sessionId: w.sessionId, ...(w.file ? { file: w.file } : {}) } : undefined;
    },
  };
}
