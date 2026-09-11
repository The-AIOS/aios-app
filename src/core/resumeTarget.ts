/**
 * Which session does a name resume to? — the decision, with no filesystem in it (AI-149).
 *
 * THE MEASURED PROBLEM. `targetByName()` answers from the live session registry, and the registry
 * holds ONLY running sessions — measured: four entries, all alive, and a killed worker's entry is
 * gone within seconds. So the thing the bus already uses to find a session cannot find a CLOSED
 * one, which is the only kind `resume` is for.
 *
 * WHAT CAN. Transcripts persist, and they carry the name: every session's `.jsonl` holds
 * `{"type":"agent-name","agentName":"…","sessionId":"…"}` — the same record CLAUDE.md's own
 * identity ritual greps for. That makes the transcript the durable name→session mapping the
 * registry is not.
 *
 * AND A SESSION CAN BE RENAMED. This very repo shipped tab rename in 0.9.3, where a live session
 * renames ITSELF, so one transcript can hold several name records — observed: a transcript whose
 * first record says `app-walker` while the registry calls the same session `aios-app`. The name a
 * session answers to is therefore its LAST record, not its first. Resolving on the first would
 * quietly resume a session under a name it no longer has, which is the exact substitution — a
 * different someone — this verb exists to prevent.
 */

/** Every `agent-name` record in a transcript, in file order. */
export function agentNamesIn(transcript: string): string[] {
  const out: string[] = [];
  const re = /"type"\s*:\s*"agent-name"[^}]*?"agentName"\s*:\s*"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(transcript)) !== null) out.push(m[1].trim().toLowerCase());
  return out;
}

/** The name a session currently answers to — its most recent record, or undefined. */
export function latestAgentName(transcript: string): string | undefined {
  const all = agentNamesIn(transcript);
  return all.length ? all[all.length - 1] : undefined;
}

export interface ResumeCandidate {
  sessionId: string;
  /** Newest first is the caller's job; this is carried so a tie can be reasoned about. */
  mtimeMs: number;
  /** The candidate's CURRENT name — see latestAgentName. */
  latestName?: string;
}

/**
 * The newest session that currently answers to `name`. `undefined` = nothing to resume, which
 * the caller must report rather than paper over: falling back to a spawn without being asked
 * hands back a fresh something when the caller asked for the same someone.
 *
 * `excludeSessionId` keeps a request from resuming the session that FILED it — a session asking
 * to resume its own name would otherwise reopen itself, which is at best a duplicate and at
 * worst a loop.
 */
export function pickResume(
  name: string,
  candidates: readonly ResumeCandidate[],
  excludeSessionId?: string,
): string | undefined {
  const want = String(name ?? '').trim().toLowerCase();
  if (!want) return undefined;
  const hit = [...candidates]
    .filter((c) => c.sessionId && c.sessionId !== excludeSessionId && c.latestName === want)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
  return hit ? hit.sessionId : undefined;
}
