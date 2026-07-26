/**
 * Pure task/routine model — NO vscode import, NO fs. This is the testable core
 * (`node --test` runs it outside the extension host) and the seed of the kernel
 * a future standalone shell shares with the extension.
 */

export interface FreqTask {
  id: string;
  label: string;
  kind: 'agent' | 'command' | 'skill' | 'prompt';
  /** agent/command/skill name, or (kind 'prompt') the free-form instruction itself */
  target: string;
  /** tooltip — says plainly what happens */
  hint: string;
  /**
   * Optional fixed task SENT on every run (agent / command / skill). One click
   * shoots — there is no run-time question. Blank → launch bare: the agent
   * self-interviews, the command/skill guides. (kind 'prompt' carries its
   * instruction in `target`, so it ignores this.)
   */
  assignment?: string;
}

export function slug(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'task';
}

/**
 * Migrate legacy tasks. The old run-time question lived in `prompt`; the model is
 * now a fixed `assignment` that's SENT. For a USER-authored agent/command/skill
 * task, the text they typed into that "question" field was really the task they
 * wanted to fire — so promote it to `assignment` (this silently fixes tasks made
 * under the old flow). Defaults and prompt-kind tasks just drop the stale question.
 */
export function migrateTask(t: FreqTask & { prompt?: string }): FreqTask {
  const { prompt, ...rest } = t;
  if (rest.assignment === undefined && prompt && rest.kind !== 'prompt' && String(rest.id).startsWith('u-')) {
    rest.assignment = prompt;
  }
  return rest;
}

/** One ordered step of a routine's combined instruction, phrased per task mechanism. */
export function stepText(t: FreqTask, n: number): string {
  const a = (t.assignment ?? (t as { prompt?: string }).prompt)?.trim() || '';
  if (t.kind === 'agent') return `${n}. Wear the ${t.target} agent hat (load it via /aios:agent ${t.target}) and ${a || 'complete its core task for today'}.`;
  if (t.kind === 'command') return `${n}. Run /aios:${t.target}${a ? ` with: ${a}` : ''}.`;
  if (t.kind === 'skill') return `${n}. Use the ${t.target} skill${a ? `: ${a}` : ''}.`;
  return `${n}. ${t.target}`; // prompt-kind carries its full instruction in target
}

/**
 * Session name for an Ask AIOS intent — from the intent's CONTENT words, not its
 * filler: "i need a social media strategy" → ask-social-media-strategy.
 */
const STOP = new Set(['i', 'a', 'an', 'the', 'to', 'for', 'of', 'on', 'in', 'at', 'by', 'my', 'me', 'our', 'we', 'us', 'you', 'your', 'it', 'is', 'are', 'am', 'and', 'or', 'with', 'about', 'need', 'needs', 'want', 'wants', 'please', 'can', 'could', 'should', 'would', 'like', 'help', 'make', 'create', 'do', 'get', 'give', 'let', 'lets', 'some', 'this', 'that', 'new', 'have', 'has']);

export function askSessionName(intent: string): string {
  const words = intent.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w && !STOP.has(w));
  const core = (words.length ? words : ['intent']).slice(0, 3).join('-');
  return ('ask-' + core).slice(0, 28).replace(/-+$/, '');
}
