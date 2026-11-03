/**
 * What each session used (Skill / Agent), read incrementally from its transcript.
 * Shared by the App (main process) and Glass (extension host); both used to carry their own copy.
 *
 * Review should-fix 17 named four faults in those copies, and each one is answered here:
 *  - an 8 MB SYNCHRONOUS read per tick blocked the App's main thread and Glass's extension host.
 *    Reads are now async (the surface injects them), bounded per tick, and never overlap per session;
 *    the row shows what is known so far and fills in on later ticks.
 *  - the cache was never pruned. `prune()` drops every session that is no longer running.
 *  - a session with no transcript yet re-scanned every project folder on every tick. A miss is now
 *    remembered and retried at most every `missRetryMs`.
 *  - a chunk edge could cut a UTF-8 character in half, decoding it as U+FFFD. The carry is now kept
 *    as BYTES and cut at the last newline BYTE — 0x0A never occurs inside a multi-byte sequence, so
 *    every decoded slice is whole characters.
 * Pure: no fs import. The surface supplies the three I/O calls.
 */
import { usageIn, type ToolUsage } from './toolUse';

export interface UsageIo {
  /** The transcript path for this session id, or undefined when there is none (yet). */
  find(sessionId: string): Promise<string | undefined>;
  size(file: string): Promise<number>;
  read(file: string, offset: number, length: number): Promise<Uint8Array>;
}
export interface UsageReaderOptions {
  chunkBytes?: number;      // one read
  maxBytesPerTick?: number; // catch-up budget per refresh, so a cold 200 MB transcript is spread over ticks
  missRetryMs?: number;
  now?: () => number;
}
interface Entry { file: string; offset: number; carry: Uint8Array; usage: ToolUsage; busy: boolean; missAt: number }

const NL = 0x0a;
const decoder = new TextDecoder('utf-8');

/** Fold one chunk into the state: decode up to the last newline byte, keep the rest as bytes. */
export function feedUsage(state: { carry: Uint8Array; usage: ToolUsage }, chunk: Uint8Array): void {
  const all = new Uint8Array(state.carry.length + chunk.length);
  all.set(state.carry, 0);
  all.set(chunk, state.carry.length);
  const cut = all.lastIndexOf(NL);
  if (cut === -1) { state.carry = all; return; }
  usageIn(decoder.decode(all.subarray(0, cut)), state.usage);
  state.carry = all.slice(cut + 1);
}

export class UsageReader {
  private cache = new Map<string, Entry>();
  private readonly chunk: number;
  private readonly budget: number;
  private readonly missRetryMs: number;
  private readonly now: () => number;
  constructor(private readonly io: UsageIo, o: UsageReaderOptions = {}) {
    this.chunk = o.chunkBytes ?? 1024 * 1024;
    this.budget = o.maxBytesPerTick ?? 8 * 1024 * 1024;
    this.missRetryMs = o.missRetryMs ?? 30_000;
    this.now = o.now ?? (() => Date.now());
  }

  /** What is known now; starts (never awaits) a catch-up read. Never blocks the caller. */
  get(sessionId: string): ToolUsage | undefined {
    if (!sessionId) return undefined;
    void this.refresh(sessionId);
    const e = this.cache.get(sessionId);
    return e && e.file ? e.usage : undefined;
  }

  /** Forget every session that is not in `live` — the cache tracks the running list, nothing more. */
  prune(live: Iterable<string>): void {
    const keep = new Set(live);
    for (const id of this.cache.keys()) if (!keep.has(id)) this.cache.delete(id);
  }

  get size(): number { return this.cache.size; }

  /** One bounded catch-up. Awaitable for tests; `get` fires it and moves on. */
  async refresh(sessionId: string): Promise<void> {
    let e = this.cache.get(sessionId);
    if (e?.busy) return;
    if (!e) { e = { file: '', offset: 0, carry: new Uint8Array(0), usage: { skills: [], agents: [] }, busy: false, missAt: -Infinity }; this.cache.set(sessionId, e); }
    if (!e.file && this.now() - e.missAt < this.missRetryMs) return;
    e.busy = true;
    try {
      if (!e.file) {
        const f = await this.io.find(sessionId);
        if (!f) { e.missAt = this.now(); return; }
        e.file = f;
      }
      const size = await this.io.size(e.file);
      if (size < e.offset) { e.offset = 0; e.carry = new Uint8Array(0); e.usage = { skills: [], agents: [] }; }   // rewritten
      let spent = 0;
      while (e.offset < size && spent < this.budget) {
        const len = Math.min(this.chunk, size - e.offset, this.budget - spent);
        const buf = await this.io.read(e.file, e.offset, len);
        if (!buf.length) break;
        e.offset += buf.length;
        spent += buf.length;
        feedUsage(e, buf);
      }
    } catch { /* momentarily unreadable — the next tick retries */ }
    finally { e.busy = false; }
  }
}
