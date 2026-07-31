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

import { isSurface, type Surface } from './sendQueue';

export type BusAction = 'spawn' | 'kill' | 'send';

export interface BusRequest {
  action: BusAction;
  name: string;                 // sanitized kebab handle
  task?: string;                // spawn: the first prompt
  prompt?: string;              // send: text delivered into the live session
  model?: string;               // spawn: explicit model id (whitelisted)
  tier?: 'mechanical' | 'judgment'; // spawn: cognitive-load hint → model
  /* contract 2: which fulfiller may take this request. Absent = any, which is exactly
     contract-1 behaviour — the field is additive, never required. */
  surface?: Surface;
  /* how many times this request has been released for a sibling to try; bounded so two
     fulfillers cannot ping-pong it forever. */
  releases?: number;
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

export function whitelistTier(raw: unknown): 'mechanical' | 'judgment' | undefined {
  const s = String(raw ?? '').trim().toLowerCase();
  return s === 'mechanical' || s === 'judgment' ? s : undefined;
}

/**
 * Tier → model. A small LOCAL mirror of the `spawn` wrapper's tier map (the
 * wrapper owns the canonical mapping; the app launches `claude` directly, so it
 * can't defer to it). Mechanical = the fast/cheaper tier; judgment = frontier.
 * If the tier ladder's model ids change, update here. `model` always wins.
 */
const TIER_MODELS: Record<'mechanical' | 'judgment', string> = {
  mechanical: 'claude-sonnet-5',
  judgment: 'claude-opus-4-8',
};
export function tierToModel(tier: 'mechanical' | 'judgment'): string {
  return TIER_MODELS[tier];
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
  const a = typeof j.action === 'string' ? j.action.toLowerCase() : 'spawn';
  const action: BusAction = a === 'kill' ? 'kill' : a === 'send' ? 'send' : 'spawn';
  return {
    action,
    name,
    task: typeof j.task === 'string' ? j.task : undefined,
    prompt: typeof j.prompt === 'string' ? j.prompt : (typeof j.task === 'string' ? j.task : undefined),
    model: whitelistModel(j.model),
    tier: whitelistTier(j.tier),
    surface: isSurface(j.surface) ? j.surface : undefined,
    releases: typeof j.releases === 'number' && j.releases >= 0 ? j.releases : 0,
  };
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

/** POSIX single-quote (mirrors renderer app.js:1869 `shq`). */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The short prompt handed to a worker whose real task lives in a file. */
export function taskFileInstruction(file: string): string {
  return `Read ${file} and follow the instructions inside.`;
}

/**
 * Build the `claude --name …` command the app runs in a pane. `taskFile`, when
 * given, replaces the inline task with a read-the-file instruction (see
 * needsTaskFile). model beats tier; a bare spawn is just `claude --name <n>`.
 *
 * `remoteControl` (default true) adds --remote-control, which is what publishes the session
 * to the operator's own Anthropic account so claude.ai and the mobile app can attach to it.
 * The `spawn` wrapper passes it unconditionally; omitting it here is what made app-launched
 * sessions the only ones invisible from a phone. Pass false to opt out.
 */
export function buildSpawnCmd(
  claudeCmd: string,
  name: string,
  opts: { task?: string; model?: string; tier?: 'mechanical' | 'judgment'; taskFile?: string; remoteControl?: boolean } = {},
): string {
  const model = opts.model ?? (opts.tier ? tierToModel(opts.tier) : undefined);
  const parts = [claudeCmd || 'claude'];
  if (model) parts.push('--model', model);
  // Emitted BEFORE --name, which is the exact order the `spawn` wrapper has shipped for months
  // (`claude … --remote-control --name <n> <bootstrap>`). Worth pinning rather than leaving to
  // taste: --remote-control takes an OPTIONAL positional name of its own, so the ordering is
  // load-bearing and this is the arrangement with a track record.
  if (opts.remoteControl !== false) parts.push('--remote-control');
  parts.push('--name', name);
  const prompt = opts.taskFile ? taskFileInstruction(opts.taskFile) : opts.task;
  if (prompt && prompt.trim()) parts.push(shq(prompt));
  return parts.join(' ');
}
