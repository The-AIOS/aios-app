/**
 * Has this AIOS actually become someone's, or is it still the template?
 *
 * The distinction matters more than it sounds. `hasIdentity()` used to ask whether
 * `about_me.md` contained "my name is" and was longer than 40 characters — and the shipped
 * template opens with `My name is {{full name}}.`, so it passed on a vault nobody had touched.
 * The Setup step went green while every field was still a mustache placeholder, which is worse
 * than a red step: it tells the operator a thing is done and then behaves as though it is.
 *
 * The same question decides whether the rituals should run at all. `/aios:today` on a template
 * vault produces a plan for a person who does not exist yet — confidently, which is the
 * problem. So the gate and the step share one predicate.
 *
 * EVIDENCE, NOT A FLAG. The obvious implementation is a marker the app writes when the setup
 * session finishes. That marker can be true of an empty vault (it records that a button was
 * clicked, not that work happened), survives a vault swap, and drifts the moment anything is
 * restored from backup. Reading the vault instead is self-correcting: if the personalization is
 * really there the checks pass, and if someone reverts it they go back to failing on their own.
 */

/** Mustache tokens as the AIOS templates use them: `{{full name}}`, `{{date}}`. */
const PLACEHOLDER = /\{\{[^{}]{1,80}\}\}/;

/** Does this text still carry template placeholders the operator was meant to replace? */
export function hasPlaceholders(text: string): boolean {
  return PLACEHOLDER.test(text);
}

/**
 * A declared-context file counts as written when it has real prose and no placeholders left.
 * The length floor is deliberately low: someone who replaced the template with three honest
 * sentences has personalized their vault, and demanding volume would punish brevity.
 */
export function isWritten(text: string | null | undefined): boolean {
  if (!text) return false;
  const body = text.replace(/^---[\s\S]*?\n---\n/, '').trim();   // frontmatter is not content
  return body.length >= 120 && !hasPlaceholders(body);
}

export interface PersonalizationEvidence {
  /** `about_me.md` is written, not the template. */
  declared: boolean;
  /** USER.md names a primary session — the app knows who to greet. */
  named: boolean;
  /** The vault pushes somewhere of the operator's own, not the framework repo. */
  remote: boolean;
}

/**
 * Two of the three, with `declared` mandatory.
 *
 * Mandatory `declared` because it is the one piece nothing else can substitute for: it IS the
 * context that makes every later session worth having. The other two are corroboration and
 * either can be legitimately absent — an operator may run entirely local with no remote, or
 * work from a cloned vault whose USER.md they have not renamed yet. Requiring all three would
 * fail people who are genuinely set up; requiring only one would pass a vault where a single
 * file got edited by hand.
 */
export function isPersonalized(e: PersonalizationEvidence): boolean {
  return e.declared && (e.named || e.remote);
}

/** Which pieces are missing — so the operator is told what to fix, not just that it failed. */
export function missingEvidence(e: PersonalizationEvidence): string[] {
  const out: string[] = [];
  if (!e.declared) out.push('declared');
  if (!e.named && !e.remote) out.push('named-or-remote');
  return out;
}
