/**
 * Connectors — the operator-facing name for what the framework calls MCPs.
 *
 * WHY THE WORD. "MCP" is a protocol name. A first-time operator cannot evaluate it, and being asked
 * about one during setup is the single worst friction AI-122 measured. The card says "Google
 * Workspace", never "google-workspace-mcp".
 *
 * WHY THIS FILE HOLDS NO CONNECTOR LIST. Registration knowledge lives in canonical, beside the thing
 * it describes: `mcps/<id>-mcp/connector.json`. This module READS those manifests and nothing else.
 * A hardcoded table here would be a third copy of knowledge already in two places (the READMEs and
 * `mcps/_index.md`), and the App has already been bitten by exactly that shape — the handover prompt
 * carried its own copy of the interview's step count and drifted to "11 steps". If a manifest is
 * missing, the connector is NOT LISTED. Honest silence beats a guess that writes a broken
 * registration the operator then has to find and undo by hand.
 *
 * WHO ASKS. Not this card. The cold-start interview owns the ask, at its Step 11, in the same
 * conversation, right after a first `/aios:today` has shown the operator an empty calendar — so the
 * question lands with a reason attached. The card is an AFFORDANCE: somewhere to go afterward to see
 * status, connect what was skipped, or add something bundled nowhere. A card that greeted a freshly
 * onboarded operator with a prompt would be another thing firing after setup said goodbye, which is
 * the defect Front A just spent a whole pass removing three instances of.
 *
 * Contract: vault → reflections/masters/specs/2026-08-27-connector-manifest-contract.md
 */

/**
 * `drift` and `needs-install` are the two states that stop the card from lying.
 *
 * - `needs-install`: registered (or registerable) but the command points at a build artifact that
 *   does not exist yet — a `.venv/bin/python` `mcps/setup.sh` has not created. Without this state,
 *   Connect writes a registration that looks fine and fails at first use, which is the exact failure
 *   class AI-122 exists to remove.
 * - `drift`: the live registration and the manifest disagree. Real and unreported today — one
 *   bundled connector is registered with two permissions its own index calls "intentionally
 *   excluded", and its README predicted it: "no surface reporting the difference". This is that
 *   surface.
 */
export type ConnectorState =
  | 'connected' | 'drift' | 'needs-key' | 'needs-install' | 'available'
  /** Not a server at all — the capability ships another way (a bundled skill, a direct toolkit). */
  | 'provided';

export interface ConnectorRegister {
  transport: 'stdio' | 'http';
  command?: string;
  args?: readonly string[];
  env?: Readonly<Record<string, string>>;
  url?: string;
}

export interface ConnectorDef {
  id: string;
  service: string;
  value: string;
  infrastructure: boolean;
  /**
   * False = this folder is NOT a server and can never be registered — it ships a capability by
   * another route (a bundled skill, a toolkit invoked directly). Distinct from `infrastructure`,
   * which means "never offer this as a service": obsidian is a real server that happens to be
   * plumbing, while a `registers: false` folder has no server to point at. Conflating them makes
   * drift detection nonsensical, because the App would look for a registration that must never
   * exist. Defaults true — an ordinary connector says nothing.
   */
  registers: boolean;
  connect: 'one-click' | 'needs-key' | 'guided';
  requires: readonly string[];
  register?: ConnectorRegister;
  docs?: string;
}

/** A registration as it appears in `~/.claude.json`. */
export interface LiveEntry {
  command?: string;
  args?: readonly string[];
  env?: Readonly<Record<string, string>>;
  url?: string;
  type?: string;
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);

/**
 * Validate a manifest. Returns null rather than throwing or defaulting, because a malformed manifest
 * must drop its connector off the card — never render half a connector whose Connect button would
 * write an incomplete registration.
 */
export function parseManifest(raw: unknown, fallbackId = ''): ConnectorDef | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  const id = str(m.id) || fallbackId;
  const service = str(m.service);
  if (!id || !service) return null;

  const connect = str(m.connect);
  const mode: ConnectorDef['connect'] =
    connect === 'one-click' || connect === 'needs-key' || connect === 'guided' ? connect : 'guided';

  let register: ConnectorRegister | undefined;
  const r = m.register;
  if (r && typeof r === 'object') {
    const rr = r as Record<string, unknown>;
    const transport = str(rr.transport) === 'http' ? 'http' : 'stdio';
    const env: Record<string, string> = {};
    if (rr.env && typeof rr.env === 'object') {
      for (const [k, v] of Object.entries(rr.env as Record<string, unknown>)) {
        if (typeof v === 'string') env[k] = v;
      }
    }
    register = {
      transport,
      command: str(rr.command) || undefined,
      args: strs(rr.args),
      env,
      url: str(rr.url) || undefined,
    };
    // An http manifest with no url, or a stdio one with no command, cannot be registered at all.
    if (transport === 'http' ? !register.url : !register.command) register = undefined;
  }

  return {
    id,
    service,
    value: str(m.value),
    infrastructure: m.infrastructure === true,
    registers: m.registers !== false,
    connect: mode,
    requires: strs(m.requires),
    register,
    docs: str(m.docs) || undefined,
  };
}

/**
 * Substitute `{framework}` with the RESOLVED framework root.
 *
 * Load-bearing. Every bundled README hardcodes `~/aios/mcps/...`, but `~/aios` is a symlink on at
 * least one real machine, so there the documented command and the working registration differ — and
 * they agree everywhere the clone happens to be `~/aios`, which is why it has never surfaced.
 * Manifests carry the placeholder; the caller passes `frameworkRoot()`, which already realpath's.
 *
 * `{home}` is the SECOND placeholder, and it was missed. This function replaced `{framework}` only,
 * so a manifest value of `{home}/.google_workspace_mcp/credentials` passed through LITERALLY into a
 * live registration — and the server then created a directory called `{home}` relative to its cwd,
 * inside the operator's framework, and wrote OAuth state into it. Handling one placeholder and
 * silently ignoring the rest is the whole defect: `unsubstituted()` below now makes any leftover
 * placeholder impossible to register, so the next placeholder canonical adds fails loudly instead of
 * quietly creating a folder named after itself.
 */
export function substitute(def: ConnectorDef, framework: string, home = ''): ConnectorDef {
  const sub = (s: string) => s.split('{framework}').join(framework).split('{home}').join(home);
  return {
    ...def,
    requires: def.requires.map(sub),
    register: def.register && {
      ...def.register,
      command: def.register.command ? sub(def.register.command) : undefined,
      args: (def.register.args ?? []).map(sub),
      env: Object.fromEntries(Object.entries(def.register.env ?? {}).map(([k, v]) => [k, sub(v)])),
      url: def.register.url ? sub(def.register.url) : undefined,
    },
  };
}

/**
 * Any `{placeholder}` still present after substitution — an `{ask:}` prompt excepted, since those
 * are resolved from operator answers at registration time.
 *
 * Exists because the alternative already happened. `substitute()` handled `{framework}` and passed
 * `{home}` through untouched, so a real registration was written with a literal `{home}` in it and
 * the server created that directory inside the framework. A value that still contains a placeholder
 * is never a valid thing to register, whatever the placeholder is — so this refuses ALL of them
 * rather than being taught about them one incident at a time.
 */
export function unsubstituted(values: readonly string[]): string[] {
  return values.filter((v) => /\{(?!ask:)[^}]+\}/.test(v ?? ''));
}

/** Registry names and folder ids disagree on the `-mcp` suffix; compare without it. */
export function normaliseId(v: string): string {
  return (v || '').toLowerCase().replace(/-mcp$/, '');
}

/**
 * Find the live registration for an id, searching top-level AND every per-project block.
 *
 * Both are searched because `claude mcp add` defaults to *local* (per-directory) scope: on a real
 * machine 14 of 16 registrations sit under `projects[<vault>].mcpServers` and only 2 at top level.
 * Reading only `mcpServers` would report almost everything as unconnected.
 */
export function liveEntry(claudeJson: unknown, id: string): LiveEntry | undefined {
  const cj = (claudeJson ?? {}) as {
    mcpServers?: Record<string, LiveEntry>;
    projects?: Record<string, { mcpServers?: Record<string, LiveEntry> }>;
  };
  const want = normaliseId(id);
  const blocks = [cj.mcpServers ?? {}, ...Object.values(cj.projects ?? {}).map((p) => p?.mcpServers ?? {})];
  for (const b of blocks) {
    for (const [name, entry] of Object.entries(b)) {
      if (normaliseId(name) === want && entry && typeof entry === 'object') return entry;
    }
  }
  return undefined;
}

/** Every registered server name, so the card can show what is connected but bundled nowhere. */
export function registeredNames(claudeJson: unknown): readonly string[] {
  const cj = (claudeJson ?? {}) as {
    mcpServers?: Record<string, unknown>;
    projects?: Record<string, { mcpServers?: Record<string, unknown> }>;
  };
  return [
    ...Object.keys(cj.mcpServers ?? {}),
    ...Object.values(cj.projects ?? {}).flatMap((p) => Object.keys(p?.mcpServers ?? {})),
  ];
}

/**
 * How a live registration differs from its manifest, in operator-readable terms.
 *
 * Env VALUES are never compared or reported — they are secrets. Only the key set is, because a
 * missing key is a real defect and its name is not sensitive.
 */
export function driftReasons(def: ConnectorDef, live: LiveEntry): string[] {
  const out: string[] = [];
  // Nothing that cannot be registered can drift from a registration.
  if (!def.registers) return out;
  const reg = def.register;
  if (!reg) return out;

  if (reg.transport === 'http') {
    if (reg.url && live.url && reg.url !== live.url) out.push(`endpoint is ${live.url}, expected ${reg.url}`);
    return out;
  }

  if (reg.command && live.command && reg.command !== live.command) {
    out.push(`runs ${live.command}, expected ${reg.command}`);
  }
  const want = reg.args ?? [];
  const got = live.args ?? [];
  if (want.length && got.length && want.join(' ') !== got.join(' ')) {
    const extra = got.filter((a) => !want.includes(a));
    const absent = want.filter((a) => !got.includes(a));
    if (extra.length) out.push(`extra: ${extra.join(' ')}`);
    if (absent.length) out.push(`missing: ${absent.join(' ')}`);
    if (!extra.length && !absent.length) out.push('arguments are in a different order');
  }
  const missingEnv = Object.keys(reg.env ?? {}).filter((k) => !(k in (live.env ?? {})));
  if (missingEnv.length) out.push(`no ${missingEnv.join(', ')}`);
  return out;
}

/** Which env keys the operator still has to supply. `{ask:…}` marks a value only they can give. */
export function pendingKeys(def: ConnectorDef, live: LiveEntry | undefined): string[] {
  const env = def.register?.env ?? {};
  return Object.keys(env).filter((k) => {
    if (!/^\{ask:/.test(env[k])) return false;
    const got = live?.env?.[k];
    return !got || /^\{ask:/.test(got);
  });
}

/**
 * Classify a connector. `def` must already be substituted; `exists` probes the filesystem.
 *
 * Order matters: `needs-install` is checked BEFORE anything else about the registration, because a
 * registered connector whose interpreter was never built is broken regardless of how correct its
 * arguments look — and reporting that as `connected` is the precise lie this card exists to stop.
 */
export function classify(
  def: ConnectorDef,
  live: LiveEntry | undefined,
  exists: (p: string) => boolean,
): { state: ConnectorState; detail: string[] } {
  // A folder that is not a server has no state to report about a registration. It is neither
  // available (you cannot connect it) nor broken (nothing is missing) — the capability arrives by
  // another route, so the honest answer is "provided", and the card offers docs, never Connect.
  if (!def.registers) return { state: 'provided', detail: [] };

  const missing = def.requires.filter((p) => !exists(p));
  if (missing.length) return { state: 'needs-install', detail: missing };

  if (!live) return { state: 'available', detail: [] };

  const pending = pendingKeys(def, live);
  if (pending.length) return { state: 'needs-key', detail: pending };

  const drift = driftReasons(def, live);
  if (drift.length) return { state: 'drift', detail: drift };

  return { state: 'connected', detail: [] };
}

export type CustomTarget =
  | { kind: 'http'; url: string; id: string }
  | { kind: 'npm'; pkg: string; id: string }
  | { kind: 'unsupported'; reason: 'local' | 'unrecognised'; input: string };

/**
 * Work out what the operator pasted. Deliberately conservative: anything not clearly an http(s)
 * endpoint or an npm package name is `unsupported` rather than guessed at, because a wrong guess
 * here writes a broken registration the operator then has to find and undo by hand.
 */
export function sniffCustom(input: string): CustomTarget {
  const s = (input || '').trim();
  if (!s) return { kind: 'unsupported', reason: 'unrecognised', input: s };

  if (/^https?:\/\//i.test(s)) {
    /* A GitHub *repo* URL is not an endpoint — it is a clone, which is the deferred case. Caught
       here because "paste a URL" invites exactly this, and registering a repo page as an HTTP MCP
       would produce a connector that fails on first use with an HTML parse error. */
    if (/^https?:\/\/(www\.)?(github|gitlab|bitbucket)\.com\//i.test(s)) {
      return { kind: 'unsupported', reason: 'local', input: s };
    }
    let host = '';
    try { host = new URL(s).hostname; } catch { return { kind: 'unsupported', reason: 'unrecognised', input: s }; }
    return { kind: 'http', url: s, id: slugFromHost(host) };
  }

  // A path, not a package: absolute, home-relative, or explicitly relative.
  if (/^[~./]/.test(s) || /^[a-zA-Z]:[\\/]/.test(s)) return { kind: 'unsupported', reason: 'local', input: s };

  // npm names: optional @scope/, then lowercase word chars, dots, dashes, underscores.
  if (/^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i.test(s)) return { kind: 'npm', pkg: s, id: slugFromPkg(s) };

  return { kind: 'unsupported', reason: 'unrecognised', input: s };
}

/** `mcp.mint.gg` → `mint`. The registry id an operator would recognise, not the whole host. */
export function slugFromHost(host: string): string {
  const parts = host.toLowerCase().replace(/^(www|api|mcp)\./, '').split('.');
  return sanitiseId(parts[0] || host.toLowerCase());
}

/**
 * `@vendor/mcp-thing` → `thing`; `mcp-server-foo` → `foo`. The service, not the packaging.
 *
 * Strips REPEATEDLY, because `mcp-server-<name>` is a documented convention (the reference servers
 * ship as `@modelcontextprotocol/server-*`), so a single pass leaves `server-foo` — a folder name
 * and a registry id naming the plumbing instead of the service. Bounded so a pathological
 * `mcp-mcp-mcp-…` terminates rather than looping.
 */
export function slugFromPkg(pkg: string): string {
  let bare = pkg.replace(/^@[^/]+\//, '');
  for (let i = 0; i < 4; i++) {
    const next = bare.replace(/^(mcp|server)[-_]/i, '').replace(/[-_](mcp|server)$/i, '');
    if (next === bare) break;
    bare = next;
  }
  return sanitiseId(bare);
}

/** Registry ids reach a shell command and a directory name, so keep them boring. */
export function sanitiseId(v: string): string {
  const s = v.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
  return s || 'connector';
}
