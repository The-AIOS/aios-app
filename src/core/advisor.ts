/**
 * The advisor. Facts from Claude Code 2.1.296's own source, not inferred:
 *  - advisor choices are the aliases fable · opus · sonnet (filtered by what the account has);
 *    the setting is `advisorModel` (alias or id); absent = no advisor.
 *  - "the advisor must be at least as capable as the main model" — otherwise it is NOT USED.
 *    MEASURED: an Opus 5.5 session with advisorModel "sonnet" shows nothing on screen and writes
 *    nothing to its transcript (only Claude's debug log says it), so the operator would believe an
 *    advisor is reviewing their work while none is. That silence is what this module exists for.
 */
export const ADVISOR_OPTIONS = ['fable', 'opus', 'sonnet'] as const;

const RANK: [RegExp, number][] = [[/fable/i, 4], [/opus/i, 3], [/sonnet/i, 2], [/haiku/i, 1]];
export function familyRank(model: string): number | undefined {
  for (const [re, n] of RANK) if (re.test(String(model ?? ''))) return n;
  return undefined;
}

/**
 * Can `advisor` advise `main`? `undefined` when either side is unknown (an unset main model is
 * Claude's own default, which the App cannot rank) — never a guess in either direction.
 */
export function canAdvise(advisor: string, main: string): boolean | undefined {
  if (!advisor) return undefined;
  const a = familyRank(advisor), m = familyRank(main);
  if (a === undefined || m === undefined) return undefined;
  return a >= m;
}

/**
 * Review nit — the consult instruction. Canonical's `spawn --advisor` appends it for a Sonnet- or
 * Haiku-class worker (MODEL-ROUTING § The advisor): measured by Anthropic, those workers called an
 * Opus advisor on none of 198 questions without it, while the tool's ~1,000-token definition still
 * went out every request. Opus and Fable call it well unprompted and the instruction LOWERED their
 * pass rates, so they never get it — nor does an unset model (Claude's default is not ranked here).
 * The text is canonical's wrapper block, verbatim, so both launch paths brief a worker identically.
 */
export function needsConsultBlock(workerModel: string | undefined, advisorModel: string | undefined): boolean {
  if (!advisorModel || !workerModel) return false;
  const r = familyRank(workerModel);
  return r === 1 || r === 2;
}
export const ADVISOR_CONSULT_BLOCK = `
# You have an advisor

This worker runs with an advisor: a stronger model you can consult through the \`advisor\`
tool. It sees everything you have done so far and returns short advice. It only helps if
you call it, and workers on your model rarely do unprompted, so:

- Call it once BEFORE substantive work, with your plan.
- Call it once BEFORE you declare the task done. Save your work first (write the file,
  commit if the task says to), so nothing is lost if the call is slow.
- Call it when you are stuck, or about to choose between two approaches.
- Ask it to keep its guidance under 80 words.
`;
