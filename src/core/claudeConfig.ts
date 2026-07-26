/**
 * The Claude-owned settings this app surfaces — one registry, so a row in Settings and
 * the file it writes can never drift apart.
 *
 * Glass, not engine: every value here lives in Claude Code's OWN config and is only
 * mirrored by our UI. Two stores, and the difference is not cosmetic:
 *
 *   'settings'  ~/.claude/settings.json — Claude's global settings schema. Small, ours to
 *               rewrite safely, and where `claude config` reports from.
 *   'user'      ~/.claude.json — user/machine state. LARGE, and live Claude sessions write
 *               it too, so a read-modify-write races them (see writeClaudeUserJson).
 *
 * Key names were read out of Claude's own binary string table rather than guessed — the
 * settings keys cluster together there, which is how `prefersReducedMotion` was caught
 * (the obvious `reduceMotion` also exists as a string, in an unrelated context, and
 * writing it would have silently done nothing).
 */

export type ClaudeStore = 'settings' | 'user';
export type ClaudeKind = 'bool' | 'enum';

export interface ClaudeKeySpec {
  /** Dot path inside the store's JSON. */
  path: string;
  store: ClaudeStore;
  kind: ClaudeKind;
  /** Value when the key is absent — Claude only writes a key once you change it. */
  fallback: boolean | string;
  /** True when the store is inferred rather than confirmed on disk. */
  storeUncertain?: boolean;
}

export const CLAUDE_KEYS: Record<string, ClaudeKeySpec> = {
  // ── confirmed present in ~/.claude/settings.json on a real machine ──
  model: { path: 'model', store: 'settings', kind: 'enum', fallback: '' },
  mode: { path: 'permissions.defaultMode', store: 'settings', kind: 'enum', fallback: 'default' },
  remoteControl: { path: 'remoteControlAtStartup', store: 'settings', kind: 'bool', fallback: true },
  switchModelsOnFlag: { path: 'switchModelsOnFlag', store: 'settings', kind: 'bool', fallback: false },
  // ── in the settings-key table, unset until changed ──
  outputStyle: { path: 'outputStyle', store: 'settings', kind: 'enum', fallback: 'default' },
  reduceMotion: { path: 'prefersReducedMotion', store: 'settings', kind: 'bool', fallback: false },
  // ── confirmed present in ~/.claude.json ──
  claudeInChrome: { path: 'claudeInChromeDefaultEnabled', store: 'user', kind: 'bool', fallback: false },
  /* copyOnSelect appears in Claude's /config option list beside claudeInChromeDefaultEnabled
     (which does live in ~/.claude.json) and is absent from the settings.json key table — so
     'user' is inferred, not proven. readStore() below prefers whichever file actually holds
     the key, so the moment Claude writes it we follow the truth instead of our guess. */
  copyOnSelect: { path: 'copyOnSelect', store: 'user', kind: 'bool', fallback: false, storeUncertain: true },
  /* Three more that a non-technical operator actually reaches for — all confirmed present
     in ~/.claude/settings.json on a real machine, so no inference here. */
  agentPushNotif: { path: 'agentPushNotifEnabled', store: 'settings', kind: 'bool', fallback: true },
  awaySummary: { path: 'awaySummaryEnabled', store: 'settings', kind: 'bool', fallback: false },
  autoCompact: { path: 'autoCompactEnabled', store: 'settings', kind: 'bool', fallback: true },
};

/** Read a dot path out of a parsed JSON object. */
export function readAt(obj: Record<string, unknown> | undefined, dotPath: string): unknown {
  let cur: unknown = obj;
  for (const seg of dotPath.split('.')) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** Write a dot path into a parsed JSON object, creating intermediate objects. */
export function setAt(obj: Record<string, unknown>, dotPath: string, value: unknown): void {
  const segs = dotPath.split('.');
  const last = segs.pop() as string;
  let cur = obj;
  for (const seg of segs) {
    const next = cur[seg];
    if (!next || typeof next !== 'object') cur[seg] = {};
    cur = cur[seg] as Record<string, unknown>;
  }
  if (value === undefined) delete cur[last];
  else cur[last] = value;
}

/**
 * Which store actually holds this key. A key PRESENT in either file wins over the
 * declared store — so an inferred store self-corrects as soon as Claude itself writes
 * the value, rather than leaving us reading one file and writing another forever.
 */
export function readStore(
  id: string,
  settings: Record<string, unknown>,
  user: Record<string, unknown>,
): ClaudeStore {
  const spec = CLAUDE_KEYS[id];
  if (!spec) return 'settings';
  if (readAt(settings, spec.path) !== undefined) return 'settings';
  if (readAt(user, spec.path) !== undefined) return 'user';
  return spec.store;
}

/** Current value for a key, from whichever store holds it, else its fallback. */
export function readValue(
  id: string,
  settings: Record<string, unknown>,
  user: Record<string, unknown>,
): boolean | string {
  const spec = CLAUDE_KEYS[id];
  if (!spec) return '';
  const raw = readAt(readStore(id, settings, user) === 'settings' ? settings : user, spec.path);
  if (raw === undefined) return spec.fallback;
  if (spec.kind === 'bool') return raw !== false;
  return typeof raw === 'string' ? raw : String(spec.fallback);
}

/**
 * Coerce a UI value for storage. An enum set back to its fallback is DELETED rather than
 * written: Claude treats absent as default, and a literal "default" string is not the same
 * thing (it would pin a value that should track Claude's own default).
 */
export function coerce(id: string, value: unknown): boolean | string | undefined {
  const spec = CLAUDE_KEYS[id];
  if (!spec) return undefined;
  if (spec.kind === 'bool') return !!value;
  const s = value == null ? '' : String(value);
  return s && s !== spec.fallback ? s : undefined;
}

/** Built-in output styles, plus any the operator has added under ~/.claude/output-styles/. */
export const BUILTIN_OUTPUT_STYLES = ['default', 'Explanatory', 'Learning'];
