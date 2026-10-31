/**
 * name → session, for EVERY transcript, kept current incrementally (resume lookup).
 *
 * THE MEASURED FAILURE. `resume` used to read only the 60 newest transcripts by mtime. On a fleet
 * that opens dozens of sessions a day that window is about a day and a half wide, so a worker idle
 * since the day before yesterday dead-lettered with "no transcript found" while its transcript sat
 * on disk. Five such requests failed in one morning. The verb for continuity failed for exactly
 * the sessions that had been idle longest, which are the ones most often resumed.
 *
 * THE FIX. One pass over the whole tree, done once in the background and persisted, then kept
 * current by re-reading only what changed: a transcript that GREW is read from where the last pass
 * stopped (minus a small overlap, so a record cut mid-write is seen whole), and only a file that
 * shrank or was rewritten in place is read again in full. A lookup is a stat of each file plus
 * the few tails that moved, never a re-read of the history.
 *
 * WHAT IS STORED, AND WHY PER FILE. Each transcript's CURRENT name (its last `agent-name` record,
 * the rule in core/resumeTarget). Not a name → id map: a session can rename itself, so the newest
 * holder of a name can change without that name's own file changing. Per-file entries feed
 * `pickResume` unchanged, so the decision (newest wins, unsafe ids dropped, never the caller's own
 * session) stays in the pinned shared core and is not reimplemented here.
 *
 * Nothing here decides anything a stale index could get wrong: every lookup refreshes first, so
 * the index is a cache of reads, never a second source of truth.
 */
import * as fs from 'fs';
import * as path from 'path';
import { StringDecoder } from 'string_decoder';
import { agentNamesIn, pickResume, type ResumeCandidate } from '../core/resumeTarget';

const INDEX_VERSION = 1;
/** A record is ~150 bytes; re-reading this much before the old end catches one cut mid-write. */
const OVERLAP = 4096;
const CHUNK = 1 << 20;
/** Files read at once during a pass. Enough to keep the disk busy, few enough to stay polite. */
const POOL = 8;
/** Persist progress this often during a long cold build, so a quit does not cost the work. */
const SAVE_EVERY = 500;
/** Stats in flight at once while listing — parallel, but bounded so a huge tree cannot exhaust fds. */
const STAT_BATCH = 64;

export interface IndexEntry {
  sessionId: string;
  mtimeMs: number;
  size: number;
  /** Current name (last agent-name record), lowercased — undefined if the session never had one. */
  latestName?: string;
}

interface IndexFile {
  version: number;
  base: string;
  files: Record<string, IndexEntry>;
}

/** Every agent-name in [from, end) of a file, read in chunks so a large transcript is never held whole. */
async function namesFrom(file: string, from: number): Promise<string[]> {
  const fh = await fs.promises.open(file, 'r');
  try {
    const decoder = new StringDecoder('utf8');
    /* Sized to what is left to read: a cold build reads thousands of small transcripts, and a
       full CHUNK per file was thousands of large allocations for a few KB each. */
    const { size } = await fh.stat();
    const buf = Buffer.allocUnsafe(Math.max(1, Math.min(CHUNK, size - from)));
    let pos = from;
    let carry = '';
    let last: string[] = [];
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
      if (bytesRead <= 0) break;
      pos += bytesRead;
      const text = carry + decoder.write(buf.subarray(0, bytesRead));
      const found = agentNamesIn(text);
      if (found.length) last = found;          // only the newest matters; overlap duplicates are harmless
      carry = text.slice(-OVERLAP);
    }
    const tail = carry + decoder.end();
    const found = agentNamesIn(tail);
    if (found.length) last = found;
    return last;
  } finally {
    await fh.close();
  }
}

export class ResumeIndex {
  private files: Record<string, IndexEntry> = {};
  private loaded = false;
  private dirty = false;
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly base: string, private readonly indexPath: string) {}

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(fs.readFileSync(this.indexPath, 'utf8')) as IndexFile;
      if (raw && raw.version === INDEX_VERSION && raw.base === this.base && raw.files) this.files = raw.files;
    } catch { /* absent or corrupt → cold build */ }
  }

  /* Async: this runs in the App's main process, on every lookup that found a live transcript
     changed, so a synchronous write of the whole index would stall the UI. Saves are serialised
     by the pass chain and by awaiting here, so two never share the temp file. */
  private async save(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      await fs.promises.mkdir(path.dirname(this.indexPath), { recursive: true });
      const tmp = `${this.indexPath}.${process.pid}.tmp`;
      const body: IndexFile = { version: INDEX_VERSION, base: this.base, files: this.files };
      await fs.promises.writeFile(tmp, JSON.stringify(body), { mode: 0o600 });
      await fs.promises.rename(tmp, this.indexPath);
    } catch { this.dirty = true; /* an unsaved index is only a slower next start */ }
  }

  /**
   * Every transcript on disk, newest first, with its stat — plus the folders that could NOT be
   * read. A folder that failed to list is not a folder with no transcripts: pruning on its
   * absence would throw away the whole index (or that project's part) over a passing outage,
   * and the next resume would pay the full cold build.
   */
  private async listing(): Promise<{ items: { f: string; mtimeMs: number; size: number }[]; unreadable: Set<string> | 'all' }> {
    const out: { f: string; mtimeMs: number; size: number }[] = [];
    const unreadable = new Set<string>();
    /* Review should-fix 18: a lookup used to stat every transcript ONE AT A TIME — thousands of
       serial round-trips before a resume could answer. Entries now come with their type (no stat to
       tell a folder from a file), and the stats run in parallel batches. */
    let dirs: fs.Dirent[] = [];
    try { dirs = await fs.promises.readdir(this.base, { withFileTypes: true }); } catch { return { items: out, unreadable: 'all' }; }
    const files: string[] = [];
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      let entries: fs.Dirent[] = [];
      try { entries = await fs.promises.readdir(path.join(this.base, d.name), { withFileTypes: true }); } catch { unreadable.add(path.join(this.base, d.name)); continue; }
      for (const e of entries) if (e.isFile() && e.name.endsWith('.jsonl')) files.push(path.join(this.base, d.name, e.name));
    }
    for (let i = 0; i < files.length; i += STAT_BATCH) {
      const batch = await Promise.all(files.slice(i, i + STAT_BATCH).map(async (f) => {
        try { const st = await fs.promises.stat(f); return { f, mtimeMs: st.mtimeMs, size: st.size }; }
        catch { return undefined; /* vanished between readdir and stat */ }
      }));
      for (const it of batch) if (it) out.push(it);
    }
    return { items: out.sort((a, b) => b.mtimeMs - a.mtimeMs), unreadable };
  }

  private async pass(): Promise<void> {
    this.load();
    const seen = new Set<string>();
    const todo: { f: string; mtimeMs: number; size: number }[] = [];
    const { items, unreadable } = await this.listing();
    for (const it of items) {
      seen.add(it.f);
      const prev = this.files[it.f];
      if (!prev || prev.mtimeMs !== it.mtimeMs || prev.size !== it.size) todo.push(it);
    }
    if (unreadable !== 'all') {
      for (const f of Object.keys(this.files)) {
        if (!seen.has(f) && !unreadable.has(path.dirname(f))) { delete this.files[f]; this.dirty = true; }
      }
    }
    let done = 0;
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < todo.length) {
        const it = todo[next++];
        const prev = this.files[it.f];
        /* Grown → read only the new tail. Shrunk, or same size with a new mtime → rewritten, read all.
           A rewrite that leaves the file LARGER also reads as growth and only its tail is read; Claude
           Code's transcripts are append-only, so that case is not expected to occur. */
        const grew = !!prev && it.size > prev.size;
        try {
          const names = await namesFrom(it.f, grew ? Math.max(0, prev.size - OVERLAP) : 0);
          this.files[it.f] = {
            sessionId: path.basename(it.f, '.jsonl'),
            mtimeMs: it.mtimeMs,
            size: it.size,
            latestName: names.length ? names[names.length - 1] : (grew ? prev.latestName : undefined),
          };
          this.dirty = true;
        } catch { /* unreadable now; retried on the next pass because it stays unindexed */ }
        if (++done % SAVE_EVERY === 0) await this.save();
      }
    };
    await Promise.all(Array.from({ length: Math.min(POOL, todo.length) }, worker));
    await this.save();
  }

  /** Bring the index up to date. Passes are serialised: concurrent callers share one queue. */
  refresh(): Promise<void> {
    const run = this.chain.then(() => this.pass());
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** Every indexed session currently answering to `name` — the input pickResume expects. */
  candidates(name: string): ResumeCandidate[] {
    const want = String(name ?? '').trim().toLowerCase();
    return Object.values(this.files)
      .filter((e) => e.latestName === want)
      .map((e) => ({ sessionId: e.sessionId, mtimeMs: e.mtimeMs, latestName: e.latestName }));
  }

  /** The session `resume <name>` should reopen, however old. Refreshes first, so never stale. */
  async lookup(name: string, excludeSessionId?: string): Promise<string | undefined> {
    await this.refresh();
    return pickResume(name, this.candidates(name), excludeSessionId);
  }

  /** The transcript file a session id came from, for the launch-time name check (AI-228). */
  fileOf(sessionId: string): string | undefined {
    return Object.keys(this.files).find((f) => this.files[f].sessionId === sessionId);
  }

  /** How many transcripts are indexed — for the log line and the tests. */
  size(): number { return Object.keys(this.files).length; }
}
