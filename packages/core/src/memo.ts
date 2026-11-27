/**
 * Tiny TTL memoizer for the discovery walks (agents / commands / skills).
 * Those readdir+parse sweeps run synchronously on the extension host on every
 * picker open, palette invocation, and panel refresh (~20 call sites) — fine at
 * vault scale, stuttery with a big company mount. A short TTL keeps rapid
 * re-opens free while a just-created file still appears within seconds.
 */
export function ttlMemo<T>(fn: () => T, ttlMs: number, now: () => number = Date.now): () => T {
  let at = -Infinity;
  let val: T;
  return () => {
    const t = now();
    if (t - at > ttlMs) { val = fn(); at = t; }
    return val;
  };
}
