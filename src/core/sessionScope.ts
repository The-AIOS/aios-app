/**
 * Which sessions are the OPERATOR'S. The panel, the Dock badge and the banners list
 * only those; everything else (a build session's probes, a helper, a script) is hidden and never
 * notifies. Measured: `osc-live` / `title-probe` were Claude sessions a build session started in
 * ~/code while testing, and the App put "osc-live needs you" on the operator's screen.
 *
 * A session is the operator's when ANY of these holds:
 *  - it is open in one of this App's panes;
 *  - its name is a primary session declared in USER.md;
 *  - the spawn inbox delivered to it (the provenance log names it) — agents the operator's own
 *    coordinators start or message;
 *  - it runs inside the framework or one of the operator's workspace folders.
 * Headless runs are already excluded before this (kind / entrypoint). Pure.
 */
export interface SessionScope {
  paneSessionIds: ReadonlySet<string>;
  primaries: ReadonlySet<string>;      // lowercased
  busNames: ReadonlySet<string>;       // lowercased
  roots: readonly string[];            // real paths, no trailing separator
  caseInsensitive: boolean;            // macOS / Windows default file systems
}

export function within(dir: string, root: string, caseInsensitive: boolean): boolean {
  const n = (p: string) => { const s = p.replace(/[\\/]+$/, ''); return caseInsensitive ? s.toLowerCase() : s; };
  const d = n(dir), r = n(root);
  if (!d || !r) return false;
  return d === r || d.startsWith(r + '/') || d.startsWith(r + '\\');
}

export function inScope(a: { sessionId: string; name: string; cwd: string }, s: SessionScope): boolean {
  if (a.sessionId && s.paneSessionIds.has(a.sessionId)) return true;
  const name = (a.name || '').trim().toLowerCase();
  if (name && (s.primaries.has(name) || s.busNames.has(name))) return true;
  return !!a.cwd && s.roots.some((r) => within(a.cwd, r, s.caseInsensitive));
}

/** Names the inbox delivered to recently, from bus-sent.jsonl lines ({to, at}). */
export function busNamesFrom(jsonl: string, nowSec: number, keepSec = 14 * 86400): Set<string> {
  const out = new Set<string>();
  for (const line of String(jsonl ?? '').split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as { to?: unknown; at?: unknown };
      if (typeof e.to === 'string' && e.to && typeof e.at === 'number' && e.at >= nowSec - keepSec) out.add(e.to.toLowerCase());
    } catch { /* torn line */ }
  }
  return out;
}
