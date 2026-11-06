/**
 * A background reading that can never pile up, and never makes its caller wait for it.
 *
 * Built for the Windows process table (a PowerShell `Get-CimInstance Win32_Process` per reading),
 * reported as able to freeze a loaded machine (issue #131). The old shape was a 4 s TTL memo over a
 * synchronous spawn: every poll past 4 s started a new scan and waited on it on the App's main
 * thread. On a machine under memory pressure a scan takes longer, so the App froze for longer, and
 * each new PowerShell added the load that made the next one slower.
 *
 * The rules, each one a property the tests pin:
 *  - `read()` never waits: it returns the last finished result ('' before the first).
 *  - single-flight: while a scan runs, no second one starts, however often `read()` is called.
 *  - the gap between scans grows with how long a scan took (`slowFactor` × duration), so the
 *    reading gets CHEAPER when the machine is struggling, which is exactly when it can least
 *    afford it. Bounded by `minIntervalMs` and `maxIntervalMs`.
 *  - a failed scan keeps the previous result and backs off (doubling, up to the max).
 */
export interface BackgroundScanOptions {
  run: () => Promise<string>;
  minIntervalMs: number;
  maxIntervalMs: number;
  /** Gap after a successful scan = duration × slowFactor (then clamped). */
  slowFactor: number;
  now?: () => number;
}

export interface BackgroundScan {
  /** The last finished result; starts a new scan in the background when one is due. */
  read(): string;
  /** Start a scan unless one is running; resolves when the running scan settles. */
  refresh(): Promise<void>;
  /** For tests and diagnostics. */
  state(): { inFlight: boolean; intervalMs: number; failures: number };
}

export function backgroundScan(o: BackgroundScanOptions): BackgroundScan {
  const now = o.now ?? Date.now;
  const clamp = (ms: number) => Math.min(o.maxIntervalMs, Math.max(o.minIntervalMs, ms));
  let value = '';
  let finishedAt = -Infinity;
  let intervalMs = o.minIntervalMs;
  let failures = 0;
  let inFlight: Promise<void> | null = null;

  const refresh = (): Promise<void> => {
    if (inFlight) return inFlight;
    const started = now();
    let p: Promise<string>;
    try { p = o.run(); } catch (e) { p = Promise.reject(e); }
    inFlight = p.then(
      (text) => { value = text; failures = 0; intervalMs = clamp((now() - started) * o.slowFactor); },
      () => { failures += 1; intervalMs = clamp(o.minIntervalMs * 2 ** failures); },
    ).finally(() => { finishedAt = now(); inFlight = null; });
    return inFlight;
  };

  return {
    read() {
      if (!inFlight && now() - finishedAt >= intervalMs) void refresh();
      return value;
    },
    refresh,
    state: () => ({ inFlight: !!inFlight, intervalMs, failures }),
  };
}
