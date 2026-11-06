/**
 * THE QUICK BAR'S REQUEST — what one Enter in the bar puts in the spawn inbox (RFC: docs/rfcs/menu-bar.md § 3.2).
 *
 * The bar never types into a pane. Everything that makes a delivery safe — waiting out a busy session,
 * holding while the operator has a draft open, verifying the text reached the transcript, dead-lettering
 * what could not be delivered — lives on the bus, before the renderer is ever asked to type. So the bar
 * writes an ordinary request, addressed to this surface, and the bus treats it exactly like an agent's.
 *
 * Pure: the main process writes the file; this decides its name and body.
 */
import { sanitizeName } from './commandBus';

export type QuickBarDestination =
  | { kind: 'new'; name: string }      // a new session under this name
  | { kind: 'agent'; name: string; session?: string }    // launch this agent with the text as its task, in a session named `session` (default: the agent's name)
  | { kind: 'session'; name: string }; // send the text to this live session

export type QuickBarRequest =
  | { ok: true; file: string; body: Record<string, string> }
  | { ok: false; reason: 'empty' | 'name' };

/** The first prompt *Launch agent* already sends (renderer `pickAgent`), so both doors start the same session. */
export function agentTask(agent: string, text: string): string {
  return text ? `/aios:agent ${agent} — ${text}` : `/aios:agent ${agent}`;
}

/**
 * Build the inbox request. `now` names the file: two sends to the same session a second apart must be two
 * files, or the second would overwrite the first before the bus claims it.
 *
 * No `from`: it is the writer's registry name, and the bus uses it to let a NEWER message from the same
 * writer supersede an older queued one. The operator is not a session, and two things they typed are two
 * messages — neither may silently replace the other.
 */
export function quickBarRequest(dest: QuickBarDestination, rawText: string, now: number): QuickBarRequest {
  const text = String(rawText ?? '').trim();
  const name = sanitizeName(dest.name);
  if (!name) return { ok: false, reason: 'name' };
  /* A new session or an agent may start with nothing to do; a message to a live session may not. */
  if (!text && dest.kind === 'session') return { ok: false, reason: 'empty' };
  const file = `quick-bar-${name}-${now}.json`;
  switch (dest.kind) {
    case 'session':
      return { ok: true, file, body: { action: 'send', name, prompt: text, surface: 'app' } };
    case 'agent': {
      /* The session may need a name other than the agent's: a spawn under a name that is already running is
         only revealed by the bus, and the text would be dropped. */
      const session = dest.session === undefined ? name : sanitizeName(dest.session);
      if (!session) return { ok: false, reason: 'name' };
      return { ok: true, file: `quick-bar-${session}-${now}.json`, body: { name: session, task: agentTask(name, text), surface: 'app' } };
    }
    case 'new':
      return text
        ? { ok: true, file, body: { name, task: text, surface: 'app' } }
        : { ok: true, file, body: { name, surface: 'app' } };
  }
}
