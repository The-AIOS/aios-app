/**
 * Finish setup — the App wires what the guided setup session is not allowed to.
 *
 * WHY THIS EXISTS. The setup session runs in `auto` permission mode (renderer: spawnSetupSession),
 * and SETUP.md asks it to register the skills, install the AIOS plugin, install the `spawn`
 * wrapper (it writes the operator's PowerShell `$PROFILE` / `~/.zshrc`) and wire the hooks into
 * `~/.claude/settings.json`. Auto mode's classifier blocks exactly that class of change by default
 * — shell-profile persistence, edits to the agent's own settings and skills, `-ExecutionPolicy
 * Bypass` — and in auto mode a block raises no permission dialog. So the session does what it is
 * told to on a denial: it hands the operator `!` lines to paste. On Windows that is where first
 * installs stalled — Claude Code hard-wraps long lines, a copied command arrives split in two, and
 * the `!` lines were pasted into a separate PowerShell window where `!` means nothing.
 *
 * The App can run these installers itself, in its own lane (the doctor already did for two of
 * them). The consent is a click on a button that names each change; nothing here works around the
 * classifier, because the AI is not the one executing.
 *
 * Pure by design (no fs, no exec, no electron), like core/onboarding.ts: aios.ts feeds it real
 * check results and a real repair function; the tests feed it fabricated ones.
 */

import { hookCandidates } from './hookPaths';
export interface FinishCheckLike {
  id: string;
  status: 'pass' | 'warn' | 'fail';
  label?: string;
  message?: string;
  canRepair?: boolean;
  repairHint?: string;
  blockedBy?: string;
}

/** The four pieces of wiring, IN THE ORDER they run. Skills first: they are what the plugin's
 *  commands lean on. Hooks last: they only take effect in a NEW session, so nothing after them in
 *  this run could notice them anyway. */
export const FINISH_SETUP_IDS = ['skills', 'plugin', 'spawn', 'hooks'] as const;
export type FinishSetupId = typeof FINISH_SETUP_IDS[number];

/**
 * Offer "Finish setup" only when it can do something AND has something to do.
 *
 * Framework first: every one of these installers lives inside the framework checkout, so before
 * the setup session has cloned it there is nothing to run — the button would be a promise the App
 * cannot keep. And an operator whose machine is already wired never sees it: a button that does
 * nothing is noise on the one screen that has to stay quiet.
 */
export function needsFinishSetup(checks: readonly FinishCheckLike[]): boolean {
  const fw = checks.find((c) => c.id === 'framework');
  if (!fw || fw.status !== 'pass') return false;
  return FINISH_SETUP_IDS.some((id) => {
    const c = checks.find((x) => x.id === id);
    return !!c && c.status !== 'pass';
  });
}

export interface FinishSetupOutcome<C extends FinishCheckLike = FinishCheckLike> {
  /** One entry per wiring check, in run order — re-checked where it ran, as found where it did not. */
  results: C[];
  /** Every one of the four passes at the end. */
  ok: boolean;
  /** The id that stopped the run, when one did. Later ones were NOT attempted. */
  stoppedAt?: string;
  /** Why it stopped, in the doctor's own words (the re-checked message, or what is in the way). */
  reason?: string;
}

/**
 * Run the repairs in order, re-check each, and STOP at the first one that does not come back green.
 *
 * Stop rather than press on: a failure here is usually environmental (a policy, a missing tool,
 * an unreachable network), and the next step would meet the same wall with a second, vaguer error.
 * One clear sentence about the first thing in the way is the actionable version. What was not
 * attempted keeps its current (amber) result, so the screen still says exactly what is left.
 *
 * A check that already passes is never re-run — every installer is idempotent, but "it did
 * nothing" is still not something to spend an operator's wait on.
 */
export async function runFinishSetup<C extends FinishCheckLike>(
  current: readonly C[],
  repair: (id: FinishSetupId) => Promise<C | null>,
): Promise<FinishSetupOutcome<C>> {
  const results: C[] = [];
  let stoppedAt: string | undefined;
  let reason: string | undefined;
  for (const id of FINISH_SETUP_IDS) {
    const before = current.find((c) => c.id === id);
    if (!before) continue;                       // a battery without this check: nothing to say about it
    if (stoppedAt || before.status === 'pass') { results.push(before); continue; }
    if (!before.canRepair) {
      /* Nothing the App can run here — the check has already said why (a missing tool, a policy,
         an installer the framework does not ship). Running anything else after it would bury that. */
      results.push(before);
      stoppedAt = id;
      reason = before.blockedBy ? `needs ${before.blockedBy}` : (before.message || '');
      continue;
    }
    let after: C | null = null;
    try { after = await repair(id); } catch { after = null; }
    const shown = after ?? before;
    results.push(shown);
    if (shown.status !== 'pass') { stoppedAt = id; reason = shown.message || ''; }
  }
  return { results, ok: !stoppedAt && results.every((r) => r.status === 'pass'), stoppedAt, reason };
}

/**
 * The plugin repair as ARGV ARRAYS — two calls, no shell.
 *
 * It used to be ONE string, `claude plugin marketplace add '…' && claude plugin install …`, opened
 * in a terminal. Windows PowerShell 5.1 — the shell that terminal is on Windows — has no `&&`, so
 * the button failed there before Claude ever ran, and the quoting was POSIX quoting. As argv there
 * is nothing to parse: no chaining operator, no quote dialect, and a path with a space or an
 * apostrophe is just a string.
 *
 * The marketplace is skipped when Claude already knows it: `marketplace add` on a known name
 * errors, and that error would read as the repair having failed.
 */
export function pluginRepairArgv(marketplaceSrc: string, marketplaceKnown: boolean): string[][] {
  const steps: string[][] = [];
  if (!marketplaceKnown) steps.push(['plugin', 'marketplace', 'add', marketplaceSrc]);
  steps.push(['plugin', 'install', 'aios@the-aios']);
  return steps;
}

/**
 * The framework hooks `install-settings.py` registers, by the SIGNATURE that script itself matches
 * on (its `signature()`), and the files that make each one real. A hook is only required when the
 * framework actually ships its script — so an older or newer framework never leaves this row amber
 * over a hook it does not have.
 */
export const FRAMEWORK_HOOKS: ReadonlyArray<{ sig: string; files: readonly string[] }> = [
  { sig: 'inject-datetime', files: ['inject-datetime.sh', 'inject-datetime.ps1'] },   // A · the clock
  { sig: 'provenance.py', files: ['provenance.py'] },                                // D · provenance
  { sig: 'bus_log.py', files: ['bus_log.py'] },                                      // D · inbox prompts
  { sig: 'floor-at-start.py', files: ['floor-at-start.py'] },                        // E · the floor
  { sig: 'model-switch-log.py', files: ['model-switch-log.py'] },                    // F · model switches
  { sig: 'suggest-agent-hint.py', files: ['suggest-agent-hint.py'] },                // G · suggest an agent mid-session (v0.8.19)
];

/** Every hook command in a settings.json object, whatever event it sits under. Tolerant by design:
 *  a shape this cannot read contributes nothing rather than throwing — the installer is the one
 *  that refuses a malformed file, with a sentence that says where. */
export function hookCommands(settings: unknown): string[] {
  const hooks = (settings && typeof settings === 'object' ? (settings as { hooks?: unknown }).hooks : undefined);
  if (!hooks || typeof hooks !== 'object') return [];
  const out: string[] = [];
  for (const groups of Object.values(hooks as Record<string, unknown>)) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      const list = g && typeof g === 'object' ? (g as { hooks?: unknown }).hooks : undefined;
      if (!Array.isArray(list)) continue;
      for (const h of list) {
        const cmd = h && typeof h === 'object' ? (h as { command?: unknown }).command : undefined;
        if (typeof cmd === 'string') out.push(cmd);
      }
    }
  }
  return out;
}

/** Which shipped framework hooks are NOT in this settings object. Empty → the row passes. `ships` is asked
 *  for paths relative to the framework root, in a hook's new folder first, then the old flat place (aios#309). */
export function missingHooks(settings: unknown, ships: (rel: string) => boolean, frameworkPrefixes: readonly string[] = []): string[] {
  const cmds = hookCommands(settings).map((c) => c.replace(/\\/g, '/'));
  return FRAMEWORK_HOOKS
    .filter((h) => h.files.some((f) => hookCandidates(f).some(ships)))
    .filter((h) => !cmds.some((c) => c.includes(h.sig) && pointsWhereShipped(c, h.files, ships, frameworkPrefixes)))
    .map((h) => h.sig);
}

/* A wired command counts only if it runs the hook where the framework ships it now. After the v0.8.19 regroup (aios#309)
   a settings.json can still run hooks/provenance.py; that works through a forwarding file until v0.8.20 (aios#330) and
   then points at nothing. When the hook ships in its new folder, a command naming the old flat path is not wired, so
   the row warns and Repair rewrites it (review of the hook moves). */
/* Only an old path INTO THIS FRAMEWORK is flagged (`frameworkPrefixes`: its root as written, `~/aios`, `$HOME/aios`):
   that is the one Repair rewrites. The operator's own copy elsewhere, or a relative path, is theirs, and flagging it
   would warn forever with nothing Repair could fix (review of the hook moves). No prefixes given → never flagged. */
function pointsWhereShipped(cmd: string, files: readonly string[], ships: (rel: string) => boolean, prefixes: readonly string[]): boolean {
  for (const f of files) {
    const [best] = hookCandidates(f);
    if (best === `hooks/${f}` || !ships(best) || cmd.includes(best)) continue;
    const oldIntoFramework = prefixes.some((p) => p && cmd.includes(`${p.replace(/\\/g, '/').replace(/\/+$/, '')}/hooks/${f}`));
    if (oldIntoFramework) return false;
  }
  return true;
}

/**
 * A command an operator can paste ONCE: one physical line, no `!` prefix.
 *
 * Both halves are the field failures, measured: a command hard-wrapped onto two lines runs as two
 * commands (the second, a bare `C:\…` path, in red), and a `!`-prefixed line is Claude Code's
 * "run this yourself" syntax that means nothing in PowerShell. Statements that were on separate
 * lines are joined with `; `, which both PowerShell 5.1 and POSIX shells read as "then".
 */
export function oneLine(cmd: string): string {
  return String(cmd || '')
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/^!\s*/, ''))
    .filter(Boolean)
    .join('; ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}
