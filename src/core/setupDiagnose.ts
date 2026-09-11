/**
 * Setup triage — the pure decisions behind "Having issues?" and the red-state rule.
 *
 * THE RULE, from the first external setup fix (#18): *every check distinguishes its failure
 * states; every red state carries a working action; never offer a command for a tool that is not
 * installed.* That last clause is the one that bit us — "Connect GitHub" ran `gh auth login` on a
 * machine with no `gh`, so the operator got `command not found` under a banner saying the step
 * just needed another try. It was fixed for `gh` by hand. This module is that fix as a RULE, so
 * the next command offered for a missing tool fails a test instead of an operator.
 *
 * WHY DIAGNOSIS DOES NOT MAKE REPAIR REDUNDANT — the question this design has to answer, because
 * the obvious objection is "if you can detect it, why not just fix it?". There are two separate
 * unknowns and only one of them is knowable ahead of time:
 *
 *   WHAT is missing        — knowable in advance. The doctor checks answer it, and since #18 the
 *                            installer ladder can usually act on it without asking anyone.
 *   WHICH ROUTE works HERE — NOT knowable in advance. No admin rights; a Homebrew owned by
 *                            another account; no winget; a profile that aborts halfway. This is
 *                            irreducibly machine-specific, and it is why the ladder is
 *                            check-then-act at every rung rather than a plan followed by a fix.
 *
 * So diagnosis is not a phase before the repair — it is how the repair chooses its route. What
 * survives every rung is genuinely not ours to fix (it needs a password, an admin, or a human
 * decision), and THAT residue is what the entry point below exists to name precisely instead of
 * leaving someone to guess.
 *
 * Pure by design: no fs, no exec, no electron. The caller runs the probes; this decides.
 */

export interface DiagCheck {
  id: string;
  status: 'pass' | 'warn' | 'fail';
  message?: string;
  repairCmd?: string;
  repairHint?: string;
  canRepair?: boolean;
}

/* Tools a setup command can invoke, and the check id that proves each one exists. Only tools the
   doctor actually checks belong here: a tool with no check cannot be proven present, so claiming
   it is missing would be as wrong as claiming it is there. */
export const TOOL_CHECK: Readonly<Record<string, string>> = {
  gh: 'gh', git: 'git', claude: 'claude', node: 'node', npm: 'node', npx: 'node',
};

/** Our own installer ladder — the one command that is runnable BECAUSE the tool is missing. */
const LADDER = /install-tool\.(sh|ps1)/;

/**
 * Which checked tools a command would invoke.
 *
 * Reads command POSITIONS, not any mention: `gh auth login` invokes gh, while
 * `--then 'gh auth login'` handed to the ladder does not — the ladder installs gh first and runs
 * the follow-up itself, with the new PATH. Treating the argument as an invocation would refuse
 * the one command that fixes the problem.
 */
export function toolsInvoked(cmd: string): string[] {
  if (!cmd || LADDER.test(cmd)) return [];
  const out = new Set<string>();
  /* Split into statements, then read each one's FIRST word — the command position. Only that
     position counts, which is what separates `gh auth login` (invokes gh) from
     `echo 'run gh auth login'` (mentions it). A leading quoted run is taken whole, because a
     Windows command path routinely contains a space ('C:\Program Files\…\gh.exe').
     Splitting the raw string can over-split a quoted argument containing a separator; that only
     ever ADDS a candidate command, so the guard fails closed — the safe direction. */
  for (const stmt of cmd.split(/&&|\|\||[;\n|]/)) {
    const s0 = stmt.trim();
    const quoted = /^(['"])(.*?)\1/.exec(s0);
    const first = quoted ? quoted[2] : (s0.split(/\s+/)[0] || '');
    const tool = first.replace(/^.*[/\\]/, '').replace(/\.(exe|cmd|bat)$/i, '');
    if (Object.prototype.hasOwnProperty.call(TOOL_CHECK, tool)) out.add(tool);
  }
  return [...out];
}

/**
 * Is this command safe to offer, given what the doctor found? A command is refused when it would
 * invoke a tool whose own check is failing — the `gh auth login` class.
 *
 * A tool with NO check result is allowed: absence of evidence is not evidence of absence, and
 * refusing on it would disable working remedies on any machine whose battery ran short.
 */
export function isRunnable(cmd: string | undefined, checks: readonly DiagCheck[]):
  { ok: true } | { ok: false; missing: string } {
  if (!cmd) return { ok: true };
  for (const tool of toolsInvoked(cmd)) {
    const c = checks.find((x) => x.id === TOOL_CHECK[tool]);
    if (c && c.status === 'fail') return { ok: false, missing: tool };
  }
  return { ok: true };
}

/**
 * Checks whose PASS is only meaningful while some tool actually runs.
 *
 * `account` is the measured case. It answers from `~/.claude.json` on disk — an `oauthAccount`
 * and a completed-onboarding flag — and never touches the `claude` binary. So on a machine where
 * Claude is missing or off PATH it still reports "signed in", and the step renders a green tick
 * reading *"Log in to Claude · you@example.com"* while nothing can run. That is a FALSE GREEN:
 * the operator is told a step is handled when the thing it names does not work, which is worse
 * than a red row, because a red row at least sends them somewhere.
 *
 * Off-PATH is the case that makes this worth a rule rather than a one-off. It is a real reported
 * failure (the claude check has a whole branch for it, including a profile that aborts partway),
 * and in exactly that state the credential file is perfectly intact — so this check passes with
 * confidence while the machine is unusable.
 */
export const CHECK_NEEDS: Readonly<Record<string, string>> = { account: 'claude' };

/**
 * Which passing checks cannot currently be trusted, because the tool they depend on is failing.
 * Pure: the caller decides what to do about it. Only PASS is interesting — a check already
 * reporting warn/fail is saying something true and is left exactly as it is.
 */
export function unverifiable(checks: readonly DiagCheck[]): { id: string; needs: string }[] {
  const out: { id: string; needs: string }[] = [];
  for (const c of checks) {
    if (c.status !== 'pass') continue;
    const needs = CHECK_NEEDS[c.id];
    if (!needs) continue;
    const dep = checks.find((x) => x.id === needs);
    if (dep && dep.status === 'fail') out.push({ id: c.id, needs });
  }
  return out;
}

/** One rung of an installer ladder, as `install-tool --plan` reports it. */
export interface PlanRung { id: string; label: string; available: boolean; }
export interface ToolPlan { tool: string; rungs: PlanRung[]; page?: string; }

/**
 * Parse `install-tool.{sh,ps1} <tool> --plan`. The plan is what makes a red state describable
 * BEFORE the operator clicks: it is non-mutating and machine-specific, so it can be run at first
 * paint to say "this machine can do it this way" rather than "something went wrong".
 */
export function parsePlan(tool: string, out: string): ToolPlan {
  const rungs: PlanRung[] = [];
  let page: string | undefined;
  for (const line of String(out || '').split('\n')) {
    const m = /^\s*\d+\.\s*([a-z0-9_-]+)\s*—\s*(.*?)\s*\((available here|not available here)\)\s*$/i.exec(line);
    if (m) { rungs.push({ id: m[1], label: m[2], available: /^available/i.test(m[3]) }); continue; }
    const p = /^\s*page:\s*(\S+)\s*$/i.exec(line);
    if (p) page = p[1];
  }
  return { tool, rungs, page };
}

/** The rung that will actually be used here, if any. */
export function firstAvailable(plan: ToolPlan | undefined): PlanRung | undefined {
  return plan?.rungs.find((r) => r.available);
}

export type TriageKind =
  /** A route exists and we can take it — the button IS the fix. */
  | 'run'
  /** Nothing here can install it; the operator needs the vendor's own download. */
  | 'open'
  /** We know what is wrong and cannot act on it — hand the operator something to send. */
  | 'support';

export interface TriageItem {
  checkId: string;
  kind: TriageKind;
  /** Present for 'run'. */
  cmd?: string;
  /** Present for 'open'. */
  url?: string;
  /** The rung this machine will actually use, when a plan was supplied. */
  via?: string;
  message?: string;
}

export interface Triage {
  /** Every failing check, worst first, each with the one action that fits it. */
  items: TriageItem[];
  /** True when NOTHING is actionable — the only honest remaining move is support. */
  supportOnly: boolean;
}

/**
 * What "Having issues?" should DO. Deliberately not a report: a screen that restates what the
 * stepper already shows adds a surface and removes no friction. It resolves to the single next
 * action, and in the common case that action is the fix itself.
 *
 * `fail` before `warn` because a warn never blocks anyone — offering to repair a degraded skill
 * count while Claude itself is missing would be answering the wrong question.
 */
export function triage(
  checks: readonly DiagCheck[],
  plans: Readonly<Record<string, ToolPlan>> = {},
): Triage {
  const bad = checks.filter((c) => c.status !== 'pass')
    .sort((a, b) => (a.status === b.status ? 0 : a.status === 'fail' ? -1 : 1));
  const items: TriageItem[] = [];
  for (const c of bad) {
    const plan = plans[c.id];
    const rung = firstAvailable(plan);
    const runnable = isRunnable(c.repairCmd, checks);
    if (c.repairCmd && runnable.ok) {
      items.push({ checkId: c.id, kind: 'run', cmd: c.repairCmd, via: rung?.label, message: c.message });
      continue;
    }
    /* No usable command. A vendor page is the honest next move — it is what the ladder itself
       falls back to when every rung is unusable, so the two agree by construction. */
    const url = plan?.page || (/^https:\/\//.test(c.repairHint || '') ? c.repairHint : undefined);
    if (url) { items.push({ checkId: c.id, kind: 'open', url, message: c.message }); continue; }
    items.push({ checkId: c.id, kind: 'support', message: c.message });
  }
  return { items, supportOnly: items.length > 0 && items.every((i) => i.kind === 'support') };
}

/**
 * The text the support fallback copies. Facts a maintainer can act on and nothing else —
 * no paths from outside the framework, no environment dump, no account identifiers. A bundle
 * someone is afraid to paste is a bundle that never gets sent.
 */
export function diagnosticsReport(
  checks: readonly DiagCheck[],
  plans: Readonly<Record<string, ToolPlan>>,
  meta: { app: string; platform: string; arch: string },
): string {
  const lines = [
    `AIOS setup diagnostics`,
    `app ${meta.app} · ${meta.platform}/${meta.arch}`,
    '',
  ];
  for (const c of checks) {
    /* One line per check, always. A check's message can be multi-line (a version probe that
       echoed twice, a path with a trailing newline) and a report that silently reflows is one a
       maintainer has to squint at to count rows. */
    const msg = String(c.message || '').replace(/\s+/g, ' ').trim();
    lines.push(`[${c.status.toUpperCase().padEnd(4)}] ${c.id}${msg ? ` — ${msg}` : ''}`);
    const plan = plans[c.id];
    if (plan) {
      for (const r of plan.rungs) lines.push(`         ${r.available ? 'can' : '---'} ${r.id} (${r.label})`);
    }
  }
  return lines.join('\n');
}
