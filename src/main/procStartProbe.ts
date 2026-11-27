/* #78 — when the process holding a pid started, read from the OS. The comparison is pure and
 * shared with Glass (core/procStart.ts); this is the side-effecting half, the App's twin of
 * Glass's src/agents/procStart.ts. Async and time-limited: the App never waits on `ps` or
 * PowerShell for long, and an answer it could not read is `undefined`, which keeps the old
 * behaviour (signal 0 decides) rather than declaring a live session dead. */
import { execFile } from 'child_process';
import { parseLstartUtc } from '@the-aios/core/procStart';

/* A pid's start time cannot change while that pid lives, so caching longer is never wrong in
   the unsafe direction: a pid reused inside the window keeps its old answer, which is the old
   behaviour. Windows gets 10 min because each probe launches PowerShell (slow to start). */
const CACHE_MS = process.platform === 'win32' ? 10 * 60_000 : 30_000;
const cache = new Map<number, { at: number; start: number | undefined }>();
const pending = new Map<number, Promise<number | undefined>>();

function run(cmd: string, args: string[], timeout: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout, windowsHide: true, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } },
        (err, out) => resolve(err ? undefined : String(out)));
    } catch { resolve(undefined); }
  });
}

/** When the process now holding `pid` started (epoch ms), or undefined when it cannot be read. */
export function processStartMs(pid: number, platform: NodeJS.Platform = process.platform): Promise<number | undefined> {
  const hit = cache.get(pid);
  if (hit && Date.now() - hit.at < CACHE_MS) return Promise.resolve(hit.start);
  const inFlight = pending.get(pid);
  if (inFlight) return inFlight;
  const p = (async () => {
    let start: number | undefined;
    if (platform === 'win32') {
      const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `[DateTimeOffset]::new((Get-Process -Id ${Math.trunc(pid)} -ErrorAction Stop).StartTime).ToUnixTimeMilliseconds()`], 5000);
      const n = Number((out ?? '').trim());
      start = out && Number.isFinite(n) && n > 0 ? n : undefined;
    } else {
      start = parseLstartUtc(await run('ps', ['-o', 'lstart=', '-p', String(Math.trunc(pid))], 3000));
    }
    cache.set(pid, { at: Date.now(), start });
    pending.delete(pid);
    return start;
  })();
  pending.set(pid, p);
  return p;
}

/** The cached answer only — never starts a probe, never waits. undefined = not known yet. */
export function cachedStartMs(pid: number): number | undefined {
  const hit = cache.get(pid);
  return hit && Date.now() - hit.at < CACHE_MS ? hit.start : undefined;
}
