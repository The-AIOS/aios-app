/**
 * Spawn-inbox contract 4: three optional request fields, decided in ONE place both
 * fulfillers run (shared core, synced into the App). Canonical's spec and its conformance fixture
 * (skills/aios/orchestration-ladder/inbox-contract-4.*) are the authority; this is the decision
 * that fixture tests, so "two implementations of one protocol" is one function and one test.
 *
 *   from     send, resume   the writer's registry name. A CLAIM, never an identity: it informs
 *                           the receiver and authorises nothing. Unusable values are dropped.
 *   effort   spawn, resume  low · medium · high · xhigh · max → `claude --effort <v>`.
 *                           Anything else is dead-lettered NAMING the field and value.
 *   advisor  spawn, resume  a rung (from the contract's own ADVISOR_BY_RUNG table) or a model id
 *                           → `claude --settings '{"advisorModel":"<id>"}'`. Measured on Claude
 *                           Code 2.1.296: `advisorModel` is in the settings schema (a hidden
 *                           `--advisor <model>` flag also exists; the documented route is used).
 * Verbs are unchanged. A contract-3 request decides exactly as before.
 */
import { normalizeVerb, type BusVerbResult } from './busVerbs';

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = typeof EFFORT_LEVELS[number];
export const RUNGS = ['frontier', 'judgment', 'scale', 'fast'] as const;
/**
 * A rung names a FIXED advisor model (inbox-contract-4.md § advisor) — not hooks/resolve-tier,
 * which answers `judgment` with '' ("inherit the default"), and an empty advisor names nothing.
 */
export const ADVISOR_BY_RUNG: Readonly<Record<string, string>> = {
  frontier: 'claude-fable-5-1', judgment: 'claude-opus-5-5', scale: 'claude-sonnet-5-5', fast: 'claude-haiku-5-5',
};

export function cleanFrom(v: unknown): string | undefined {
  return typeof v === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(v) ? v : undefined;
}

export type Contract4 =
  | { accept: true; from?: string; effort?: Effort; advisor?: string; advisorRung?: boolean }
  | { accept: false; field: 'effort' | 'advisor'; value: string };

/** Validate the three fields for one request. `action` is the already-normalised verb. */
export function contract4Fields(j: Record<string, unknown>, action: BusVerbResult): Contract4 {
  const takesLaunch = action === 'spawn' || action === 'resume';
  const out: { accept: true; from?: string; effort?: Effort; advisor?: string; advisorRung?: boolean } = { accept: true };
  if (action === 'send' || action === 'resume') { const f = cleanFrom(j.from); if (f) out.from = f; }
  if (takesLaunch && j.effort !== undefined) {
    const e = typeof j.effort === 'string' ? j.effort.trim().toLowerCase() : '';
    if (!(EFFORT_LEVELS as readonly string[]).includes(e)) return { accept: false, field: 'effort', value: String(j.effort) };
    out.effort = e as Effort;
  }
  if (takesLaunch && j.advisor !== undefined) {
    const a = typeof j.advisor === 'string' ? j.advisor.trim() : '';
    if (!/^[A-Za-z0-9._[\]-]{1,80}$/.test(a)) return { accept: false, field: 'advisor', value: String(j.advisor) };   // the contract's pattern: it is written into JSON
    out.advisor = a;
    out.advisorRung = (RUNGS as readonly string[]).includes(a);
  }
  return out;
}

/** The arguments a contract-4 request ADDS to the claude command line (model already resolved). */
export function contract4LaunchArgs(c: { effort?: string; advisorModel?: string }): string[] {
  const args: string[] = [];
  if (c.effort) args.push('--effort', c.effort);
  if (c.advisorModel) args.push('--settings', JSON.stringify({ advisorModel: c.advisorModel }));
  return args;
}

export type Contract4Decision =
  | { accept: true; verb: 'spawn' | 'send' | 'resume' | 'kill'; launchArgs: string[]; record?: { to: string; action: string; via: 'surface'; from?: string } }
  | { accept: false; field: string; value: string; reason: string };

/** The advisor model a request names: a rung via the contract's table, else the id as given. */
export function advisorModelFor(advisor: string | undefined, isRung: boolean | undefined): string | undefined {
  if (!advisor) return undefined;
  return isRung ? ADVISOR_BY_RUNG[advisor] : advisor;
}

/** The whole contract-4 decision for one request — exactly what the conformance fixture tests. */
export function contract4Decide(j: Record<string, unknown>): Contract4Decision {
  const verb = normalizeVerb(j.action);
  if (verb === 'unknown') {
    const v = typeof j.action === 'string' ? j.action.trim() : String(j.action);
    return { accept: false, field: 'action', value: v, reason: `unknown action '${v}'` };
  }
  const f = contract4Fields(j, verb);
  if (!f.accept) return { accept: false, field: f.field, value: f.value, reason: `${f.field} '${f.value}' is not one of: ${f.field === 'effort' ? EFFORT_LEVELS.join(', ') : 'a rung or a model id'}` };
  const advisorModel = advisorModelFor(f.advisor, f.advisorRung);
  const name = typeof j.name === 'string' ? j.name : '';
  const launchArgs = verb === 'spawn' || verb === 'resume' ? contract4LaunchArgs({ effort: f.effort, advisorModel }) : [];
  const record = verb === 'kill' ? undefined : { to: name, action: verb, via: 'surface' as const, ...(f.from ? { from: f.from } : {}) };
  return { accept: true, verb, launchArgs, record };
}
