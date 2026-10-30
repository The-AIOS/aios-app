/**
 * Command-bus core — the pure, testable model behind the spawn-inbox.
 *
 * Ported from AIOS Glass 0.4.2/0.4.3 (the spawn-inbox command bus): an agent
 * can't call `spawn`/`spawn-kill` directly anymore — Claude Code's auto-mode
 * classifier reads them as "launch/kill an autonomous agent" and denies them
 * (silent red dot). So the agent drops a benign `*.json` request file in
 * `~/.aios/spawn-inbox/` and a user-trusted surface (Glass, or THIS app) fulfils
 * it natively. One channel, three verbs — spawn · kill · send.
 *
 * This module is the engine-free half: parse + sanitize + whitelist + build the
 * command string. The main-process half (`src/main/commandBus.ts`) does the fs
 * watch, the registry lookups, and the intent emission. Kept pure so the parsing
 * rules and the 0.4.3 robustness fixes (task-file handoff) are unit-tested.
 *
 * Divergence from Glass, deliberate: Glass types `spawn <name>` into a VS Code
 * terminal; this app launches `claude --name <name>` directly in its own pane
 * (mirroring the app's existing "Spawn a session" flow, app.js:2571) — so the
 * session lives IN the app grid, never a detached window, and no shell-wrapper
 * marker is involved.
 */
import { addDirArgs } from './addDir';
import { contract4Fields } from './contract4';
import { normalizeVerb, type BusVerbResult } from './busVerbs';

import { isSurface, type Surface } from './sendQueue';

/* 'unknown' is a PARSED verb the bus refuses, not a parse failure. Absent action still means
   'spawn' (contract-1 `{name, task}` back-compat), but a verb that was WRITTEN and not recognised
   is a typo or a newer contract, and guessing 'spawn' for it is the substitution AI-149 exists to
   prevent: `{"action":"resmue"}` would hand back a fresh something for a request that named a
   someone. Dead-letter it instead, naming the verb, so the author can see what they wrote. */
export type BusAction = BusVerbResult;

export interface BusRequest {
  action: BusAction;
  /** The verb as written, present only when `action` is 'unknown'. */
  rawAction?: string;
  name: string;                 // sanitized kebab handle
  task?: string;                // spawn: the first prompt
  prompt?: string;              // send: text delivered into the live session
  model?: string;               // spawn: explicit model id (whitelisted)
  tier?: string;                // spawn: rung name — resolved by hooks/resolve-tier, never here
  /* contract 2: which fulfiller may take this request. Absent = any, which is exactly
     contract-1 behaviour — the field is additive, never required. */
  surface?: Surface;
  /* how many times this request has been released for a sibling to try; bounded so two
     fulfillers cannot ping-pong it forever. */
  releases?: number;
  /* resume: what to do when the name has no transcript to reopen. Absent = refuse and say so,
     which is the honest default — silently spawning would hand back a fresh SOMETHING when the
     caller asked for the same SOMEONE, and that substitution is the whole point of the verb. */
  fallback?: 'spawn';
  /* spawn/resume: the directory the session's terminal opens in, AS WRITTEN. Validated (absolute,
     existing, a directory, inside home) by the main side, which has the filesystem — a value it
     cannot honour is dead-lettered naming the field. Absent = the framework root, as before. */
  cwd?: string;
  /* spawn/resume: extra directories the session may work in, each passed as its own `--add-dir`.
     Kept AS WRITTEN (any JSON value) so a malformed one reaches the main side's validation and is
     dead-lettered naming the field, never dropped — a session missing a directory it was promised
     looks fine until it stalls asking for permissions. Absent = none, as before. */
  addDirs?: unknown;
  /* Contract 4 (AI-198) — optional, decided by core/contract4 (shared with Glass). */
  from?: string;                // send/resume: the writer's registry name — a claim, not an identity
  effort?: string;              // spawn/resume: low · medium · high · xhigh · max
  advisor?: string;             // spawn/resume: a rung (resolved via resolve-tier) or a model id
  advisorRung?: boolean;
  /* A contract-4 field that must be dead-lettered, naming the field and the value as written. */
  fieldError?: { field: string; value: string; reason: string };
}

/** kebab-case handle — matches app.js:2568 + Glass's sanitizer exactly. */
export function sanitizeName(raw: unknown): string {
  return String(raw ?? '').trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/^-+|-+$/g, '');
}

/** Model ids are whitelisted before they ever touch a command line. */
export function whitelistModel(raw: unknown): string | undefined {
  const s = String(raw ?? '').trim();
  return /^claude-[a-z0-9.\-]{1,40}$/i.test(s) ? s : undefined;
}

/**
 * A rung is validated by SHAPE here, never by membership.
 *
 * This used to be `s === 'mechanical' || s === 'judgment'`, beside a local rung→model table.
 * Both went stale the moment the ladder grew to four rungs, and they failed in two different
 * ways at once: `fast`/`scale`/`frontier` were STRIPPED here (so the field vanished before
 * anything could act on it, and the worker ran on the session default), while `mechanical` and
 * `judgment` resolved through the stale table to the WRONG model — the second being worse,
 * because it looks like it worked. Measured 2026-09-07 against 0.9.1.
 *
 * Which rungs exist, and what each resolves to, is ONE table: `hooks/resolve-tier`. A
 * membership list here would be a second implementation of exactly the fact that churns, and
 * it would drift again — it already did. So this only asserts the value is a safe token to
 * hand to that script, and the script adjudicates (exit 2 on an unknown rung, which the
 * caller must surface rather than swallow).
 */
export function whitelistTier(raw: unknown): string | undefined {
  const s = String(raw ?? '').trim().toLowerCase();
  return /^[a-z][a-z0-9-]{1,23}$/.test(s) ? s : undefined;
}

/**
 * Parse a raw request file. Returns null for anything unusable (bad JSON, no
 * name) so the caller can log-and-ignore. `action` defaults to 'spawn'
 * (back-compat with a plain `{name, task}`).
 */
export function parseRequest(raw: string): BusRequest | null {
  if (!raw.trim()) return null;
  let j: Record<string, unknown>;
  try { j = JSON.parse(raw); } catch { return null; }
  const name = sanitizeName(j.name);
  if (!name) return null;
  /* The absent/unknown split is the shared protocol, not this surface's choice — core/busVerbs
     holds it byte-identical with Glass so neither can drift. */
  const written = typeof j.action === 'string' ? j.action.trim().toLowerCase() : '';
  const action: BusAction = normalizeVerb(j.action);
  return {
    action,
    /* Carried ONLY so a dead letter can quote what the author actually wrote. */
    rawAction: action === 'unknown' ? written : undefined,
    name,
    task: typeof j.task === 'string' ? j.task : undefined,
    prompt: typeof j.prompt === 'string' ? j.prompt : (typeof j.task === 'string' ? j.task : undefined),
    model: whitelistModel(j.model),
    tier: whitelistTier(j.tier),
    surface: isSurface(j.surface) ? j.surface : undefined,
    /* `_releases` is the fulfillers' bookkeeping name (Glass and the inbox README use it; underscore
       = never hand-written). Older Apps wrote `releases`, so both are read and the larger wins —
       the count only ever bounds a ping-pong, so over-counting is the safe side. */
    releases: Math.max(
      typeof j._releases === 'number' && j._releases >= 0 ? j._releases : 0,
      typeof j.releases === 'number' && j.releases >= 0 ? j.releases : 0),
    /* resume only, and deliberately NOT a boolean: `"fallback":"spawn"` says WHAT to fall back
       to, so a future second fallback does not need a second field — and an unrecognised value
       means no fallback rather than a guessed one. */
    fallback: j.fallback === 'spawn' ? 'spawn' : undefined,
    /* A non-string is kept (stringified) rather than dropped, so it reaches validation and is
       refused by name instead of quietly opening the session somewhere else. */
    cwd: j.cwd === undefined || j.cwd === null ? undefined : (typeof j.cwd === 'string' ? j.cwd : JSON.stringify(j.cwd)),
    addDirs: j.addDirs === undefined || j.addDirs === null ? undefined : j.addDirs,
    ...contract4Of(j, action),
  };
}

function contract4Of(j: Record<string, unknown>, action: BusAction): Partial<BusRequest> {
  const c = contract4Fields(j, action);
  if (!c.accept) return { fieldError: { field: c.field, value: c.value, reason: `${c.field} '${c.value}' is not valid — ${c.field === 'effort' ? 'use one of low, medium, high, xhigh, max' : 'use a rung or a model id'}` } };
  return { from: c.from, effort: c.effort, advisor: c.advisor, advisorRung: c.advisorRung };
}

/**
 * 0.4.3 fix: a multi-line or long task, typed into a terminal, floods it (a burst
 * of Enter-presses / a huge line) and can crash the host. Such tasks go to a temp
 * file the worker is told to read — mirroring the shell wrapper's own long-task
 * indirection (and how this very session was spawned). Short single-liners inline.
 */
export function needsTaskFile(task: string | undefined): boolean {
  if (!task) return false;
  return task.includes('\n') || task.length > 240;
}

/**
 * The spawn a `resume` with `"fallback":"spawn"` falls back to. A resume carries its first message
 * in `prompt`; a spawn reads `task`. Handing the resume request to the spawn path unchanged opened
 * the fresh session with the generic bootstrap ("Start session") and lost the caller's message —
 * the one thing the request existed to deliver. Everything else (name, model, tier, cwd, addDirs, contract-4
 * fields) carries over as written.
 */
export function fallbackSpawnRequest(req: BusRequest): BusRequest {
  return { ...req, action: 'spawn', task: req.task ?? req.prompt };
}

/** POSIX single-quote (mirrors renderer app.js:1869 `shq`). */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The short prompt handed to a worker whose real task lives in a file. */
export function taskFileInstruction(file: string): string {
  return `Read ${file} and follow the instructions inside.`;
}

/**
 * The `--add-dir` arguments of a launch, unquoted: one flag per directory the request granted, then
 * the task file's folder (aios#231). All of them go straight after the binary — the flag is variadic,
 * so the token after the last one must be a flag, never the prompt.
 */
function launchAddDirArgs(addDirs: string[] | undefined, taskFile: string | undefined): string[] {
  return [...(addDirs ?? []).flatMap((d) => ['--add-dir', d]), ...addDirArgs(taskFile)];
}

/**
 * Build the `claude --name …` command the app runs in a pane. `taskFile`, when given, replaces
 * the inline task with a read-the-file instruction (see needsTaskFile). A bare spawn is just
 * `claude --name <n>`.
 *
 * `model` arrives already RESOLVED — this function has no idea what a rung is, and that is the
 * point. Rung→model is `hooks/resolve-tier`'s single table; the caller (src/main) shells out to
 * it and passes the answer. Keeping the resolution out of here also keeps this module pure: it
 * cannot read a file or run a process, which is why the table was inlined in the first place.
 *
 * An EMPTY resolution is a real answer — `judgment` means "inherit the binary's frontier
 * default" — so an absent `model` must emit no flag at all. Never `--model ""`.
 */
/**
 * Reopen an existing session by its id, and deliver a first prompt (AI-149).
 *
 * WHY A SEPARATE BUILDER, when this is nearly buildSpawnCmd with a different flag: the two
 * commands mean opposite things, and the row exists because that difference was being lost.
 * `--name X` on a fresh process creates *a* session called X; `--resume <id>` reopens *the* one
 * that already holds the context. The operator's words when they asked for it: "not a new one
 * named aios-canonical — the same worker, already contextualized." A shared function with a
 * boolean would make the substitution a one-character mistake.
 *
 * No `--model` and no `--name`: a resumed session keeps the model and identity it already had,
 * and passing either would re-decide something the session has already settled.
 */
export function buildResumeCmd(
  claudeCmd: string,
  sessionId: string,
  opts: { prompt?: string; taskFile?: string; addDirs?: string[]; extraArgs?: string[] } = {},
): string {
  /* QUOTED, even though resumeTarget already refuses an unsafe id. The id is a FILENAME read
     off disk, and this string is typed into a live shell — one guard is a policy, two is a
     boundary. Quoting also keeps the command correct if the id format ever widens. */
  /* aios#231: --add-dir first, straight after the binary — it is variadic (see core/addDir.ts). */
  const parts = [claudeCmd || 'claude', ...launchAddDirArgs(opts.addDirs, opts.taskFile).map(shq), '--resume', shq(sessionId)];
  for (const a of opts.extraArgs ?? []) parts.push(shq(a));   // contract 4: --effort / --settings
  const prompt = opts.taskFile ? taskFileInstruction(opts.taskFile) : opts.prompt;
  if (prompt && prompt.trim()) parts.push(shq(prompt));
  return parts.join(' ');
}

export function buildSpawnCmd(
  claudeCmd: string,
  name: string,
  opts: { task?: string; model?: string; taskFile?: string; addDirs?: string[]; extraArgs?: string[] } = {},
): string {
  const model = opts.model && opts.model.trim() ? opts.model.trim() : undefined;
  const parts = [claudeCmd || 'claude', ...launchAddDirArgs(opts.addDirs, opts.taskFile).map(shq)];   // aios#231, variadic: first
  if (model) parts.push('--model', model);
  parts.push('--name', name);
  for (const a of opts.extraArgs ?? []) parts.push(shq(a));   // contract 4: --effort / --settings
  const prompt = opts.taskFile ? taskFileInstruction(opts.taskFile) : opts.task;
  if (prompt && prompt.trim()) parts.push(shq(prompt));
  return parts.join(' ');
}
