/**
 * AI-241 (issue 95) — never start a second session under a name a live process already holds.
 *
 * A pane that starts a NEW session (`claude … --name X`) has no session id yet, so the check that
 * keeps a restore from reopening a live session (#59) never applies to it. Measured on Windows
 * Server: a session started by a scheduled launcher, outside the App, held `AIOS-Main-Session`;
 * the App started another under the same name. Two registry entries then share one name, the bus
 * refuses `send`/`kill` as ambiguous, and the copy reruns the startup routine.
 *
 * Pure: main feeds it the live registry (already filtered for reused pids, #78) and the session
 * ids open in the App's own panes. A holder inside the App is the caller's business (it reveals
 * that tab); this answers only for a holder the App has no tab for.
 */
export interface NameEntry { pid: number; name: string; sessionId: string }

/** The name a command STARTS a session under, or '' when it starts none: no `--name`, or a
 *  `--resume` / `--continue`, which reopens a transcript rather than starting one. Reads the
 *  renderer's `shq` quoting on both platforms (POSIX `'\''`, PowerShell `''`). */
export function nameStartedBy(cmd: string): string {
  const s = String(cmd ?? '');
  if (/(?:^|\s)(?:--resume|--continue|-r|-c)(?:\s|=|$)/.test(s)) return '';
  const m = s.match(/(?:^|\s)--name(?:=|\s+)(?:'((?:'\\''|''|[^'])*)'|"([^"]*)"|(\S+))/);
  if (!m) return '';
  const raw = m[1] !== undefined ? m[1].replace(/'\\''/g, "'").replace(/''/g, "'") : (m[2] ?? m[3] ?? '');
  return raw.trim();
}

/** The live session outside the App that holds `name`, compared trimmed and case-insensitively
 *  (as the primaries are), or undefined. */
export function heldElsewhere(name: string, live: readonly NameEntry[], inApp: ReadonlySet<string>): NameEntry | undefined {
  const want = String(name ?? '').trim().toLowerCase();
  if (!want) return undefined;
  return live.find((a) => String(a.name ?? '').trim().toLowerCase() === want && !(a.sessionId && inApp.has(a.sessionId)));
}
