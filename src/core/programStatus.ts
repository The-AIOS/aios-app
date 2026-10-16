/**
 * AI-196 — Claude Code's own "working / waiting on you / done" signal: the Program Status
 * Protocol, OSC 7501 (Claude Code 2.1.295+).
 *
 * MEASURED in the App's PTY on 2.1.296, not assumed:
 *  - Claude first sends `OSC 7501 ; ?` and turns the protocol on only if the terminal answers
 *    with an OSC 7501 whose data starts with `?`. xterm answers nothing by default, so until the
 *    App replies, a session in the App never says anything.
 *  - Then: `state=working:app=claude-code[:msg=<b64>]`, `state=blocked:app=claude-code:kind=permission:
 *    msg=<b64 "approve Write: …">` the moment a permission prompt opens, and
 *    `state=done:app=claude-code[:msg=<b64 one-line summary>]` at the end of a turn.
 *    `title` and `msg` are base64; `state=clear` withdraws the status.
 *
 * The registry (~/.claude/sessions) already says `waiting`, but it is polled; this is the
 * session telling its own terminal, the instant it happens. The two are merged by recency:
 * whichever changed last wins, so neither can pin a stale state on the other.
 */

export interface ProgramStatus {
  state: string;            // working | blocked | done | idle | failed | …
  kind?: string;            // with blocked: permission | input | …
  msg?: string;
  title?: string;
  progress?: number;
  at: number;               // ms epoch, when the terminal received it
}

/** The probe reply the terminal sends back (OSC 7501 ; ? ST). */
export const PROGRAM_STATUS_REPLY = '\x1b]7501;?\x1b\\';

const b64 = (v: string): string => {
  try { return Buffer.from(v, 'base64').toString('utf8'); } catch { return ''; }
};

/** 'query' for the probe, 'clear' to withdraw, a status, or null for anything unreadable. */
export function parseProgramStatus(data: string, now: number): ProgramStatus | 'query' | 'clear' | null {
  const raw = String(data ?? '');
  if (raw.startsWith('?')) return 'query';
  const f: Record<string, string> = {};
  for (const part of raw.split(':')) {
    const i = part.indexOf('=');
    if (i > 0) f[part.slice(0, i)] = part.slice(i + 1);
  }
  if (!f.state) return null;
  if (f.state === 'clear') return 'clear';
  const s: ProgramStatus = { state: f.state, at: now };
  if (f.kind) s.kind = f.kind;
  if (f.msg) s.msg = b64(f.msg).slice(0, 300);
  if (f.title) s.title = b64(f.title).slice(0, 200);
  if (f.progress && Number.isFinite(Number(f.progress))) s.progress = Number(f.progress);
  return s;
}

/** The registry status a program status means. undefined = no opinion (keep the registry's). */
export function registryStatusOf(s: ProgramStatus): { status: string; waitingFor?: string } | undefined {
  if (s.state === 'blocked') return { status: 'waiting', waitingFor: s.msg || s.kind || 'input needed' };
  if (s.state === 'working') return { status: 'busy' };
  if (s.state === 'done' || s.state === 'idle') return { status: 'idle' };
  return undefined;
}

/**
 * Overlay the sessions' own signals onto the registry list, by session id. A signal wins only if
 * it is at least as recent as the registry's own status change (`statusUpdatedAt`).
 */
export function overlayProgramStatus<T extends { sessionId: string; status: string; waitingFor?: string; statusUpdatedAt?: number }>(
  running: readonly T[], statuses: ReadonlyMap<string, ProgramStatus>,
): T[] {
  return running.map((a) => {
    const s = statuses.get(a.sessionId);
    if (!s || s.at < (a.statusUpdatedAt ?? 0)) return a;
    const r = registryStatusOf(s);
    if (!r) return a;
    /* A WAITING REGISTRY WITH NO CLOCK IS NOT OVERRIDDEN by a signal that says anything else. With
       no `statusUpdatedAt` there is nothing to compare against, so the signal always won — and a
       stale "working" could mask "waiting on you", which is the one status that notifies. Hiding a
       block costs the operator the prompt; showing one a moment late costs nothing. (Hardening
       after a report that banners stopped on one Windows machine after 0.11.0.) */
    if (a.status === 'waiting' && !a.statusUpdatedAt && r.status !== 'waiting') return a;
    const out = { ...a, status: r.status, statusUpdatedAt: s.at } as T;
    if (r.waitingFor) out.waitingFor = r.waitingFor; else delete out.waitingFor;
    return out;
  });
}
