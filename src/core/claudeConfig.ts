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

/* FOUR stores, because Claude resolves four. Its own launch args say so:
   `--setting-sources=user,project,local`, and LOCAL WINS.
     'settings'  ~/.claude/settings.json                     — user, global
     'user'      ~/.claude.json                              — user/machine state
     'project'   <root>/.claude/settings.json                — COMMITTED, so read-only for us
     'local'     <root>/.claude/settings.local.json          — machine-local project override
   The App used to know only the first two, which is why one row silently never worked: `/config`
   writes `prefersReducedMotion` to the LOCAL store, we read the global one, and the local copy is
   what every session launched from the vault actually gets. A settings panel whose writes do not
   reach the sessions its own app spawns is broken whichever single store it picks. */
export type ClaudeStore = 'settings' | 'user' | 'project' | 'local';
export type ClaudeKind = 'bool' | 'enum';

export interface ClaudeKeySpec {
  /** Dot path inside the store's JSON. */
  path: string;
  store: ClaudeStore;
  kind: ClaudeKind;
  /* THE VALUE WE SEED ON FIRST INSTALL — not a value we display.
     This was called `fallback`, and the name was the bug: it read as "what to show when the key
     is absent", so the UI asserted a value it had never read. `remoteControl` claimed `true`
     while Claude's real default is off, and the Settings toggle showed a tick over a false
     config for every operator who had never touched it (reported 2026-07-31).
     Under the current model the App SEEDS these once at first install and then only ever mirrors
     what is on disk — so this value is written, never inferred, and a key is absent only if we
     deliberately do not seed it. */
  seed: boolean | string;
  /** Seed this key on first install. False for enums where "unset" is a real, meaningful state. */
  seedOnInstall?: boolean;
  /** True when the store is inferred rather than confirmed on disk. */
  storeUncertain?: boolean;
  /* WHY this key has no Settings row. The registry↔UI invariant exists so a key cannot be orphaned
     by accident; a deliberate omission still has to say what it is, in code, or the next reader
     will "restore" the row and reintroduce whatever made it unsurfaceable. */
  notSurfaced?: string;
}

export const CLAUDE_KEYS: Record<string, ClaudeKeySpec> = {
  // ── confirmed present in ~/.claude/settings.json on a real machine ──
  /* model + outputStyle are NOT seeded: for these, absent genuinely means "not pinned", and
     writing a value would take a decision away from the operator rather than make one for them. */
  model: { path: 'model', store: 'settings', kind: 'enum', seed: '' },
  mode: { path: 'permissions.defaultMode', store: 'settings', kind: 'enum', seed: 'default', seedOnInstall: true },
  /* SEEDED TRUE, deliberately. Publishing App-launched sessions to the operator's account is the
     product default (it is what `spawn` has always done), and seeding makes the toggle honest by
     construction: after first install the key exists, so Settings renders a value it actually
     read. Turning it off writes `false`, which is respected and never silently re-seeded. */
  remoteControl: { path: 'remoteControlAtStartup', store: 'settings', kind: 'bool', seed: true, seedOnInstall: true },
  /* DEFAULT TRUE in Claude (`?? !0`). Seeding `false` would have turned it off for every new
     operator — verified against Claude's own source 2026-07-31, not inferred. */
  switchModelsOnFlag: { path: 'switchModelsOnFlag', store: 'settings', kind: 'bool', seed: true, seedOnInstall: true },
  // ── in the settings-key table, unset until changed ──
  outputStyle: { path: 'outputStyle', store: 'settings', kind: 'enum', seed: 'default' },
  /* SURFACED AGAIN once the App learned all four stores. `/config` writes this to the vault's
     LOCAL store, which outranks the global one for every session launched there — so a global-only
     write was silently overridden. Now read and written wherever the value actually lives. */
  reduceMotion: { path: 'prefersReducedMotion', store: 'settings', kind: 'bool', seed: false },
  // ── confirmed present in ~/.claude.json ──
  claudeInChrome: { path: 'claudeInChromeDefaultEnabled', store: 'user', kind: 'bool', seed: false, seedOnInstall: true },
  /* copyOnSelect appears in Claude's /config option list beside claudeInChromeDefaultEnabled
     (which does live in ~/.claude.json) and is absent from the settings.json key table — so
     'user' is inferred, not proven. readStore() below prefers whichever file actually holds
     the key, so the moment Claude writes it we follow the truth instead of our guess. */
  /* store CONFIRMED 2026-07-31: found in ~/.claude.json on a real machine, so the inference above
     was correct and `storeUncertain` is retired rather than carried as permanent doubt. */
  copyOnSelect: { path: 'copyOnSelect', store: 'user', kind: 'bool', seed: true, seedOnInstall: true },   // Claude default TRUE (`?? !0`)
  /* Three more that a non-technical operator actually reaches for — all confirmed present
     in ~/.claude/settings.json on a real machine, so no inference here.
     NOTE on agentPushNotif: the audit of 2026-07-31 found it present in BOTH stores. `readStore()`
     prefers settings.json, which is where we write, so the two cannot silently diverge from our
     side — but a value Claude writes to ~/.claude.json would be shadowed. Recorded rather than
     "fixed", because picking a winner without knowing which Claude reads would be a guess. */
  /* NOT SURFACED and NOT SEEDED (2026-07-31): kept as documentation of the key↔label mapping.
     Writing a key the UI does not show would mutate an operator's config invisibly.
     Claude calls this "Push when Claude decides" and defaults it FALSE (`?? !1`). Our label said
     "Notify me when a session needs me" — which describes the OTHER key below, so the row promised
     one behaviour and wrote another. Reported as "still confusing" by the operator, correctly. */
  agentPushNotif: { path: 'agentPushNotifEnabled', store: 'settings', kind: 'bool', seed: false,
    notSurfaced: 'Even with Claude\'s own wording, an operator could not predict what it changes — tested twice. /config owns it, beside the channel picker that gives it context.' },
  /* "Push when actions required" — the setting our notification label was actually describing.
     Surfaced as its own row rather than conflated with the one above. Claude default FALSE. */
  inputNeededNotif: { path: 'inputNeededNotifEnabled', store: 'settings', kind: 'bool', seed: false,
    notSurfaced: 'Indistinguishable from agentPushNotif in practice — the pair confused the operator more than their absence does.' },
  /* Claude's own words: "When false, the SESSION RECAP (shown when you return after being away
     for 5+ minutes) is disabled. When absent or true, recap is enabled." So the default is TRUE and
     seeding `false` would have switched off a feature Claude ships on. */
  awaySummary: { path: 'awaySummaryEnabled', store: 'settings', kind: 'bool', seed: true, seedOnInstall: true },
  /* autoCompact was the NEXT `remoteControl`: it claimed a `true` default with the key absent from
     both stores, so the toggle asserted a value nobody had read. Seeding it removes the claim. */
  /* NOT SEEDED: Claude's code reads this without a `??` default, so its absent-behaviour could not
     be verified. Under the write-through model an unverified seed is a behaviour change made on a
     guess — the exact class this audit exists to stop. It renders as UNSET until the operator or
     Claude writes it. (One machine already received a seeded `true` before this was caught.) */
  autoCompact: { path: 'autoCompactEnabled', store: 'settings', kind: 'bool', seed: true },
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
  project: Record<string, unknown> = {},
  local: Record<string, unknown> = {},
): ClaudeStore {
  const spec = CLAUDE_KEYS[id];
  if (!spec) return 'settings';
  /* PRECEDENCE ORDER, highest first — the same order Claude resolves in. The project/local stores
     are optional so every existing two-store caller keeps working unchanged. */
  if (readAt(local, spec.path) !== undefined) return 'local';
  if (readAt(project, spec.path) !== undefined) return 'project';
  if (readAt(settings, spec.path) !== undefined) return 'settings';
  if (readAt(user, spec.path) !== undefined) return 'user';
  return spec.store;
}

/** Where a CHANGE must be written so that it actually takes effect.
 *  Same as the store that holds it, with one exception: never the PROJECT store. That file is
 *  committed, and putting a personal preference into a shared repo is its own bug — so a value
 *  currently coming from `project` is overridden by writing `local`, which is what Claude reads
 *  first anyway. */
export function writeStore(
  id: string,
  settings: Record<string, unknown>,
  user: Record<string, unknown>,
  project: Record<string, unknown> = {},
  local: Record<string, unknown> = {},
): ClaudeStore {
  const held = readStore(id, settings, user, project, local);
  return held === 'project' ? 'local' : held;
}

/** Is this key actually PRESENT on disk? The UI needs the difference between "the operator
 *  chose this" and "nobody has chosen" — asserting the second as the first was the bug. */
function pick(
  store: ClaudeStore,
  settings: Record<string, unknown>,
  user: Record<string, unknown>,
  project: Record<string, unknown>,
  local: Record<string, unknown>,
): Record<string, unknown> {
  return store === 'local' ? local : store === 'project' ? project : store === 'user' ? user : settings;
}

export function isSet(
  id: string,
  settings: Record<string, unknown>,
  user: Record<string, unknown>,
  project: Record<string, unknown> = {},
  local: Record<string, unknown> = {},
): boolean {
  const spec = CLAUDE_KEYS[id];
  if (!spec) return false;
  const st = readStore(id, settings, user, project, local);
  return readAt(pick(st, settings, user, project, local), spec.path) !== undefined;
}

/** Current value for a key, from whichever store holds it. Falls back to the seed only when the
 *  key is genuinely absent — which, after first-install seeding, means a key we chose not to seed. */
export function readValue(
  id: string,
  settings: Record<string, unknown>,
  user: Record<string, unknown>,
  project: Record<string, unknown> = {},
  local: Record<string, unknown> = {},
): boolean | string {
  const spec = CLAUDE_KEYS[id];
  if (!spec) return '';
  const st = readStore(id, settings, user, project, local);
  const raw = readAt(pick(st, settings, user, project, local), spec.path);
  if (raw === undefined) return spec.seed;
  if (spec.kind === 'bool') return raw === true;   // only a real `true` is true — not merely "not false"
  return typeof raw === 'string' ? raw : String(spec.seed);
}

/** The keys the App writes once, on first install. */
export function seedableKeys(): string[] {
  return Object.keys(CLAUDE_KEYS).filter((k) => CLAUDE_KEYS[k].seedOnInstall);
}

/**
 * Coerce a UI value for storage. An enum set back to its seed value is DELETED rather than
 * written: Claude treats absent as default, and a literal "default" string is not the same
 * thing (it would pin a value that should track Claude's own default).
 */
export function coerce(id: string, value: unknown): boolean | string | undefined {
  const spec = CLAUDE_KEYS[id];
  if (!spec) return undefined;
  if (spec.kind === 'bool') return !!value;
  const s = value == null ? '' : String(value);
  return s && s !== spec.seed ? s : undefined;
}

/** Built-in output styles, plus any the operator has added under ~/.claude/output-styles/. */
export const BUILTIN_OUTPUT_STYLES = ['default', 'Explanatory', 'Learning'];
