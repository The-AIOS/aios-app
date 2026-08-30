/**
 * Connectors — main-process side. Reads canonical's manifests, classifies against the live
 * registration, and registers through the sanctioned `claude mcp add` rather than by editing
 * `~/.claude.json`.
 *
 * WHY NOT WRITE ~/.claude.json DIRECTLY. It is Claude Code's own config, written by a process we do
 * not coordinate with — a read-modify-write from here races every running session and would silently
 * drop whatever they wrote in between. `claude mcp add` is the documented path in every bundled
 * README, so it is also the path whose behaviour canonical maintains.
 *
 * WHY LOCAL SCOPE FROM THE FRAMEWORK ROOT. `claude mcp add` defaults to local (per-directory) scope,
 * and that is where the working registrations already live — on a real machine, 14 of 16 sit under
 * `projects[<framework>]`. Registering anywhere else would create a second copy that drifts from the
 * one the sessions actually load, which is the defect described in
 * `mcps/google-workspace-mcp/README.md:32`.
 */
import { execFile, execFileSync } from 'child_process';
import { claudeLocation as aiosClaudeLocation } from './aios';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  parseManifest, substitute, classify, liveEntry, registeredNames, normaliseId, pendingKeys,
  sniffCustom, sanitiseId, unsubstituted,
  type ConnectorDef, type ConnectorState, type LiveEntry,
} from '../core/connectors';

export interface ConnectorRow {
  id: string;
  service: string;
  value: string;
  state: ConnectorState;
  /** Paths missing, keys pending, or how the live registration drifts — already operator-readable. */
  detail: string[];
  connect: ConnectorDef['connect'];
  /** False when the manifest carries no runnable registration, so the card offers docs instead. */
  canConnect: boolean;
  /** What Connect will run, with every secret value redacted. Shown as the button's tooltip. */
  hint?: string;
  /** Env keys the operator still has to supply, so the renderer can ask for them by name. */
  pending: string[];
  /** True when this connector's folder lives under `mcps/custom/` — i.e. the operator added it. */
  custom: boolean;
  /** True when the folder is committed, so deleting it is recoverable from git history. */
  tracked: boolean;
  docs?: string;
}

/** A server registered on this machine that no bundled manifest describes. */
export interface ForeignRow {
  id: string;
  /** True when a folder for it exists under `mcps/custom/` — so it can be deleted, not just unhooked. */
  custom: boolean;
  tracked: boolean;
}

/**
 * A bundled folder with NO manifest.
 *
 * The contract says a missing manifest means "not listed", and that IS the right outcome — but it
 * is the same outcome as `infrastructure: true`, so on its own it cannot tell "deliberately not a
 * service" apart from "nobody has written the manifest yet". Those need different responses, and
 * the second one is an authoring gap that otherwise has no reporting surface at all — the same
 * silent-hole shape as the registration drift this card exists to expose. Canonical's CI covers
 * their own eleven; this covers a company-distributed folder or a hand-added `custom/` one.
 */
export interface UnmanifestedRow { id: string; }

const claudeJsonPath = (): string => process.env.GLASS_CLAUDE_JSON || path.join(os.homedir(), '.claude.json');

function readJson(p: string): unknown {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; }
}

/** Every manifest under `<framework>/mcps/`, parsed and `{framework}`-substituted. */
export function manifests(framework: string | undefined): ConnectorDef[] {
  if (!framework) return [];
  const dir = path.join(framework, 'mcps');
  let entries: string[] = [];
  try { entries = fs.readdirSync(dir); } catch { return []; }

  const out: ConnectorDef[] = [];
  for (const name of entries) {
    const file = path.join(dir, name, 'connector.json');
    if (!fs.existsSync(file)) continue;
    const def = parseManifest(readJson(file), normaliseId(name));
    // A manifest that does not parse drops its connector rather than half-rendering it.
    if (def) out.push(substitute(def, framework, os.homedir()));
  }
  // Also read operator-added connectors, which live one level deeper.
  const customDir = path.join(dir, 'custom');
  let customs: string[] = [];
  try { customs = fs.readdirSync(customDir); } catch { customs = []; }
  for (const name of customs) {
    const file = path.join(customDir, name, 'connector.json');
    if (!fs.existsSync(file)) continue;
    const def = parseManifest(readJson(file), normaliseId(name));
    if (def) out.push(substitute(def, framework, os.homedir()));
  }
  return out;
}

const exists = (p: string): boolean => { try { return fs.existsSync(p); } catch { return false; } };

/** Redact env values so a hint can be shown to the operator and logged safely. */
function hintFor(def: ConnectorDef): string | undefined {
  const r = def.register;
  if (!r) return undefined;
  if (r.transport === 'http') return `claude mcp add --transport http ${def.id} ${r.url}`;
  const env = Object.keys(r.env ?? {}).map((k) => `-e ${k}=•••`).join(' ');
  return `claude mcp add ${def.id} ${env} -- ${r.command} ${(r.args ?? []).join(' ')}`.replace(/\s+/g, ' ');
}

/** Folders following the `<name>-mcp` convention that carry no manifest. */
export function unmanifested(framework: string | undefined, described: ReadonlySet<string>): UnmanifestedRow[] {
  if (!framework) return [];
  const out: UnmanifestedRow[] = [];
  for (const rel of ['', 'custom']) {
    const dir = path.join(framework, 'mcps', rel);
    let names: string[] = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      // The `-mcp` suffix is the documented folder convention, so it is what distinguishes an MCP
      // folder from a company namespace (`mcps/<company>/`) or `custom/` itself — neither of which
      // is a missing manifest.
      if (!name.endsWith('-mcp')) continue;
      const id = normaliseId(name);
      if (described.has(id)) continue;
      if (!fs.existsSync(path.join(dir, name, 'connector.json'))) out.push({ id });
    }
  }
  return out;
}

/**
 * A folder under `mcps/custom/` for this id — MANIFEST OR NOT.
 *
 * Deliberately not `manifestDir`, which requires a `connector.json`. A hand-built connector
 * predates the manifest convention and has only a README, and its folder is still the operator's
 * to throw away: `mcps/custom/mint-mcp` was exactly that, and it was the one row in the card with
 * a real folder and no way to delete it. Ownership is decided by WHERE the folder lives, not by
 * whether we happen to have a description of it.
 */
export function customFolder(framework: string | undefined, id: string): string | undefined {
  if (!framework) return undefined;
  const want = normaliseId(id);
  if (!want) return undefined;
  const base = path.join(framework, 'mcps', 'custom');
  let names: string[] = [];
  try { names = fs.readdirSync(base); } catch { return undefined; }
  for (const n of names) {
    if (normaliseId(n) !== want) continue;
    const dir = path.join(base, n);
    try { if (fs.statSync(dir).isDirectory()) return dir; } catch { /* next */ }
  }
  return undefined;
}

/**
 * Where a connector's manifest lives, and whether the operator owns it.
 *
 * `custom` is what gates deletion. A bundled folder is canonical's content: removing it would be
 * deleting framework infra that `/aios:update` restores on the next sync anyway, so the button
 * would be a lie. Only `mcps/custom/` is the operator's to throw away.
 */
export function manifestDir(framework: string | undefined, id: string):
  { dir: string; custom: boolean } | undefined {
  if (!framework) return undefined;
  const want = normaliseId(id);
  for (const [rel, custom] of [['', false], ['custom', true]] as const) {
    const base = path.join(framework, 'mcps', rel);
    let names: string[] = [];
    try { names = fs.readdirSync(base); } catch { continue; }
    for (const n of names) {
      if (normaliseId(n) !== want) continue;
      const dir = path.join(base, n);
      if (fs.existsSync(path.join(dir, 'connector.json'))) return { dir, custom };
    }
  }
  return undefined;
}

/** Is this path committed? Decides whether deletion is recoverable, which decides how hard we ask. */
function isTracked(framework: string, dir: string): boolean {
  const rel = path.relative(framework, dir);
  try {
    execFileSync('git', ['-C', framework, 'ls-files', '--error-unmatch', '--', rel],
      { stdio: 'ignore', timeout: 4000 });
    return true;
  } catch { return false; }
}

/**
 * Keep `mcps/custom/_index.md`'s Registry table honest when the card adds or deletes a connector.
 *
 * The vault's index-maintenance rule says a folder with an `_index.md` gets updated whenever its
 * contents change — and two connectors were added and deleted through this card without it being
 * touched, because the rule lived in someone's memory rather than in the code doing the changing.
 *
 * Safe for the App to own: `/aios:update` explicitly EXCLUDES `mcps/custom/_index.md` from the Tier-1
 * sync ("canonical ships it as a seed, but an operator's copy carries their own registry rows"), so
 * this file is the operator's and nothing upstream will fight us for it.
 *
 * Deliberately narrow: it edits ONLY rows of the Registry table and never the prose above it, which
 * is canonical's guidance. A malformed or missing table is left completely alone rather than
 * rebuilt — a wrong index is recoverable, a clobbered one is not, and this is not important enough
 * to risk the file for.
 */
export function updateCustomIndex(
  framework: string | undefined, id: string, action: 'add' | 'remove', service?: string,
): void {
  if (!framework) return;
  const file = path.join(framework, 'mcps', 'custom', '_index.md');
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return; }

  const lines = text.split('\n');
  const sep = lines.findIndex((l) => /^\|\s*-+\s*\|/.test(l.replace(/\s/g, ' ')));
  if (sep < 1 || !/^\|/.test(lines[sep - 1] ?? '')) return;  // no table we recognise → leave it be

  let end = sep + 1;
  while (end < lines.length && /^\|/.test(lines[end])) end++;

  const folder = `${normaliseId(id)}-mcp/`;
  const mine = (l: string) => l.includes(folder);
  const body = lines.slice(sep + 1, end).filter((l) => !mine(l));

  if (action === 'add') {
    const name = (service || id).replace(/\|/g, '/');   // a pipe would split the cell
    body.push(`| **${name}** | \`${folder}\` | see the folder's README | Added from the AIOS App's Connectors card. |`);
  }
  const next = [...lines.slice(0, sep + 1), ...body, ...lines.slice(end)];
  try { fs.writeFileSync(file, next.join('\n')); } catch { /* the connector works; the index is a convenience */ }
}

/**
 * Delete an operator-added connector: unregister it, then remove its folder from the vault.
 *
 * The symmetric opposite of "add another", and it was missing — disconnecting left the folder
 * behind, so a connector the operator had finished with sat in the card forever as `available`,
 * re-connectable, with no way to be rid of it.
 *
 * Unregister FIRST. The other order leaves a registration pointing at a folder that is gone, which
 * is worse than either end state: the connector still loads, still fails, and the thing that would
 * have explained it no longer exists.
 */
export async function deleteCustom(
  framework: string | undefined, id: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!framework) return { ok: false, error: 'not-found' };
  /* Ownership by LOCATION. A bundled folder is Tier 1 in `/aios:update` (`mcps/*` except
     `mcps/custom/`), so Step 6.5's completeness reconcile restores it on the next sync — a delete
     button there would revert itself and teach the operator that the app lies. Verified in
     update.md: the reconcile exists to catch "genuinely-missing files". */
  const dir = customFolder(framework, id);
  if (!dir) return { ok: false, error: manifestDir(framework, id) ? 'bundled' : 'not-found' };

  /* Containment check against REAL paths, not the strings we built. Belt and braces: the id is
     already sanitised and matched against a directory listing, so traversal cannot reach here —
     but this function ends in a recursive delete, and that is not the place to rely on an
     invariant established three functions away. */
  const root = fs.realpathSync(path.join(framework, 'mcps', 'custom'));
  let real: string;
  try { real = fs.realpathSync(dir); } catch { return { ok: false, error: 'not-found' }; }
  if (real !== root && !real.startsWith(root + path.sep)) return { ok: false, error: 'outside' };
  if (real === root) return { ok: false, error: 'outside' };

  await run(['claude', 'mcp', 'remove', normaliseId(id)], framework);
  try { fs.rmSync(real, { recursive: true, force: true }); } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? 'failed').slice(0, 200) };
  }
  // Verify both halves rather than trusting either call.
  if (fs.existsSync(real)) return { ok: false, error: 'still-there' };
  if (liveEntry(readJson(claudeJsonPath()), normaliseId(id))) return { ok: false, error: 'still-registered' };
  updateCustomIndex(framework, id, 'remove');
  return { ok: true };
}

export function listConnectors(framework: string | undefined):
  { rows: ConnectorRow[]; foreign: ForeignRow[]; unmanifested: UnmanifestedRow[]; other: ForeignRow[] } {
  const cj = readJson(claudeJsonPath());
  const defs = manifests(framework);

  const rows: ConnectorRow[] = defs
    /* Hide only a REAL SERVER acting as plumbing — that is `obsidian`, which is how the vault is
       edited at all; listing it would invite disconnecting the thing the whole AIOS runs on.
       A `registers: false` folder is a different animal and must stay VISIBLE. NotebookLM and
       browser automation are capabilities the operator HAS — they just arrive through a bundled
       skill or a toolkit invoked directly rather than a registration. Hiding them means nobody
       learns they exist, which is a worse failure than the clutter it avoids.
       This filter was `!d.infrastructure`, and that was my error, not the manifests': canonical
       flagged both folders because I told it `infrastructure: true` alone was enough to keep them
       out of the card. It was — and it also made the `provided` state unreachable, so a state, a
       button, three strings and a test all existed for something that could never render. The
       operator found it by asking why NotebookLM was missing.
       `registers` is a FACT about the thing; `infrastructure` is a presentation choice. The fact
       wins. */
    .filter((d) => !(d.infrastructure && d.registers))
    .map((d) => {
      const live = liveEntry(cj, d.id);
      const own = customFolder(framework, d.id);
      const { state, detail } = classify(d, live, exists);
      return {
        id: d.id, service: d.service, value: d.value, state, detail,
        connect: d.connect, canConnect: !!d.register, hint: hintFor(d),
        pending: pendingKeys(d, live), docs: d.docs,
        custom: !!own,
        tracked: !!own && !!framework && isTracked(framework, own),
      };
    })
    .sort((a, b) => order(a.state) - order(b.state) || a.service.localeCompare(b.service));

  const known = new Set(defs.map((d) => normaliseId(d.id)));
  const gaps = unmanifested(framework, known);

  /* A folder under `mcps/custom/` is the operator's connector even without a manifest — it is
     theirs by LOCATION. Listing it under "other connections on this computer" said the opposite:
     that the framework had nothing to do with it. `mint-mcp` is exactly that case — registered,
     working, documented in its own README, and filed with remote endpoints it has nothing in
     common with. So it gets a row in Custom, with what we can honestly say: whether it is
     registered, and that it can be deleted. */
  const adopted = new Set<string>();
  for (const g of gaps) {
    const dir = customFolder(framework, g.id);
    if (!dir) continue;
    adopted.add(g.id);
    const live = liveEntry(cj, g.id);
    rows.push({
      id: g.id, service: g.id, value: '',
      state: live ? 'connected' : 'available', detail: [],
      connect: 'guided', canConnect: false, pending: [],
      custom: true, tracked: !!framework && isTracked(framework, dir), docs: 'README.md',
    });
  }
  rows.sort((a, b) => order(a.state) - order(b.state) || a.service.localeCompare(b.service));

  // Only a BUNDLED folder with no manifest is still an orphan — that is an authoring gap in
  // canonical, not something the operator owns.
  const orphanGaps = gaps.filter((g) => !customFolder(framework, g.id));
  const gapIds = new Set(orphanGaps.map((g) => g.id));

  // A folder we can name is not "unknown", so it is reported as the authoring gap it is rather
  // than twice — once as foreign and once as unmanifested.
  const own = (id: string) => customFolder(framework, id);
  const flags = (id: string) => {
    const dir = own(id);
    return { custom: !!dir, tracked: !!dir && !!framework && isTracked(framework, dir) };
  };
  /* `adopted` matters: a custom folder that is ALSO registered would otherwise appear twice — once
     as its own row and once as an unknown connection — which is how `mint` first showed up in both
     places at the same time. */
  const foreign = [...new Set(registeredNames(cj).map(normaliseId))]
    .filter((n) => !known.has(n) && !gapIds.has(n) && !adopted.has(n))
    .map((id) => ({ id, ...flags(id) }));

  /* ONE list for the operator. "registered but not bundled" and "bundled but nobody wrote the
     manifest" are two of OUR categories — from the chair, both are just a connection on this
     computer that the framework has nothing to say about. Presenting them as separate mysteries
     is how a card stops being usable. The split stays in the payload for maintainer surfaces. */
  const other = [...foreign, ...orphanGaps.map((g) => ({ id: g.id, ...flags(g.id) }))]
    .sort((a, b) => a.id.localeCompare(b.id));

  return { rows, foreign, unmanifested: gaps, other };
}

// Anything needing attention first; connected last. A card sorted alphabetically buries the one
// row the operator can act on.
const order = (s: ConnectorState): number =>
  ({ drift: 0, 'needs-key': 1, 'needs-install': 2, available: 3, connected: 4, provided: 5 }[s] ?? 6);

function run(argv: string[], cwd?: string): Promise<{ ok: boolean; out: string }> {
  return new Promise((res) => {
    let [cmd, ...args] = argv;
    /* RESOLVE `claude` — never invoke it by bare name from main.
       The App captures its environment at launch, and on a first install that launch happens
       BEFORE step 1 puts Claude Code on PATH — so `execFile('claude', …)` is ENOENT on precisely
       the machine that just finished installing it. Observed in the field: GitHub and Google
       Workspace connected fine because they are `needs-key` and hand off to a SESSION (a real
       login shell), while Stitch — the only `one-click` connector — failed silently, because it
       is the one path that runs from here. `claudeLocation()` already probes the way a terminal
       resolves, interactive zsh included, which is where the installer writes PATH. */
    if (cmd === 'claude') {
      const loc = aiosClaudeLocation();
      if (loc.bin) cmd = loc.bin;
    }
    execFile(cmd, args, { cwd, timeout: 60_000, windowsHide: true }, (err, stdout, stderr) => {
      res({ ok: !err, out: String(stdout || '') + String(stderr || '') });
    });
  });
}

/** Build the `claude mcp add` argv. Values stay in argv — never interpolated into a shell string. */
export function addArgv(def: ConnectorDef, answers: Record<string, string> = {}): string[] | null {
  const r = def.register;
  if (!r) return null;
  if (r.transport === 'http') return ['claude', 'mcp', 'add', '--transport', 'http', def.id, r.url ?? ''];

  const argv = ['claude', 'mcp', 'add', def.id];
  for (const [k, v] of Object.entries(r.env ?? {})) {
    const m = /^\{ask:(.*)\}$/.exec(v);
    const value = m ? (answers[k] ?? answers[m[1]] ?? '') : v;
    // An unanswered {ask:} would register an empty credential that fails at first use, silently.
    if (!value) return null;
    argv.push('-e', `${k}=${value}`);
  }
  argv.push('--', r.command ?? '', ...(r.args ?? []));
  /* Last line of defence, and it is not theoretical: a literal `{home}` reached a live registration
     and the server created that directory inside the framework. Refuse to hand a placeholder to
     `claude mcp add` at all — better no registration than a broken one that looks fine. */
  if (unsubstituted(argv).length) return null;
  return argv;
}

export async function connect(
  framework: string | undefined, id: string, answers: Record<string, string> = {},
): Promise<{ ok: boolean; error?: string; row?: ConnectorRow }> {
  const def = manifests(framework).find((d) => normaliseId(d.id) === normaliseId(id));
  if (!def) return { ok: false, error: 'no-manifest' };

  // Refuse before writing anything the operator would have to find and undo by hand.
  const missing = def.requires.filter((p) => !exists(p));
  if (missing.length) return { ok: false, error: 'needs-install' };

  const argv = addArgv(def, answers);
  if (!argv) return { ok: false, error: 'needs-key' };

  const { ok, out } = await run(argv, framework);
  // Re-read rather than trusting the exit code: the check that proves a fix is the same check that
  // found the problem.
  const row = listConnectors(framework).rows.find((r) => normaliseId(r.id) === normaliseId(id));
  if (!ok && row?.state !== 'connected') return { ok: false, error: out.trim().slice(0, 400) || 'failed', row };
  return { ok: true, row };
}

/**
 * Remove a registration by name. Works with or without a manifest.
 *
 * The no-manifest case is the one that matters: a machine accumulates connectors from other
 * projects and old experiments, and those rows had no control at all — the card listed them and
 * offered nothing, which reads as "I cannot delete this". They are ordinary registrations; the
 * only thing the framework lacks is a description of them.
 */
export async function disconnect(
  framework: string | undefined, id: string,
): Promise<{ ok: boolean; error?: string; row?: ConnectorRow }> {
  const name = normaliseId(id);
  const { ok, out } = await run(['claude', 'mcp', 'remove', name], framework);
  // Verify against the file rather than the exit code — the check that proves a fix is the one
  // that found the problem.
  const gone = !liveEntry(readJson(claudeJsonPath()), name);
  const row = listConnectors(framework).rows.find((r) => normaliseId(r.id) === name);
  if (!gone) return { ok: false, error: out.trim().slice(0, 400) || 'failed', row };
  return { ok: true, row };
}

/**
 * Re-register a drifting connector with the manifest's exact arguments.
 *
 * This is what makes `drift` worth showing an operator at all. Reporting "your registration differs
 * from the framework" is a maintainer's sentence; being able to press one button and have the extra
 * access removed is a reason to care. Free by design: the google-workspace README documents that
 * DROPPING a service needs no re-consent — the token keeps the scope Google granted, the tools just
 * stop being exposed. Adding scopes would cost a consent round-trip; this does not.
 *
 * Existing env VALUES are carried across, never re-asked. They are already on this machine, and
 * making someone re-paste a client secret to tidy a permission list would be a worse experience
 * than the drift.
 */
export async function fixDrift(
  framework: string | undefined, id: string,
): Promise<{ ok: boolean; error?: string; row?: ConnectorRow }> {
  const def = manifests(framework).find((d) => normaliseId(d.id) === normaliseId(id));
  if (!def) return { ok: false, error: 'no-manifest' };
  const live = liveEntry(readJson(claudeJsonPath()), def.id);
  if (!live) return { ok: false, error: 'not-registered' };

  const answers: Record<string, string> = {};
  for (const [k, v] of Object.entries(live.env ?? {})) {
    if (v && !/^\{ask:/.test(v)) answers[k] = v;
  }
  const argv = addArgv(def, answers);
  if (!argv) return { ok: false, error: 'needs-key' };

  // Remove first: `claude mcp add` on an existing name does not reliably replace it.
  await run(['claude', 'mcp', 'remove', normaliseId(def.id)], framework);
  const { ok, out } = await run(argv, framework);
  const row = listConnectors(framework).rows.find((r) => normaliseId(r.id) === normaliseId(id));
  if (row?.state === 'connected') return { ok: true, row };
  return { ok: !!ok, error: ok ? undefined : out.trim().slice(0, 400) || 'failed', row };
}

/**
 * Add a connector the framework does not bundle.
 *
 * The split follows the `mint-mcp` precedent exactly: the KNOWLEDGE (a README plus a manifest) is
 * written into `mcps/custom/<id>-mcp/`, which is git-tracked and survives `/aios:update`; the
 * REGISTRATION goes to `~/.claude.json`, which is per-machine by design — a registration in git
 * would auto-connect every machine that pulls.
 */
export async function addCustom(
  framework: string | undefined, input: string, service?: string,
): Promise<{ ok: boolean; error?: string; id?: string; row?: ConnectorRow }> {
  if (!framework) return { ok: false, error: 'no-framework' };
  const t = sniffCustom(input);
  if (t.kind === 'unsupported') return { ok: false, error: t.reason };

  const id = sanitiseId(t.id);
  const dir = path.join(framework, 'mcps', 'custom', `${id}-mcp`);
  const label = (service || id).trim();

  const base = { id, service: label, value: '', infrastructure: false, registers: true,
                 connect: 'one-click' as const, requires: [], docs: 'README.md' };
  const def: ConnectorDef = t.kind === 'http'
    ? { ...base, register: { transport: 'http', url: t.url } }
    : { ...base, register: { transport: 'stdio', command: 'npx', args: ['-y', t.pkg] } };

  const argv = addArgv(def);
  if (!argv) return { ok: false, error: 'unrecognised' };
  const { ok, out } = await run(argv, framework);
  if (!ok) return { ok: false, error: out.trim().slice(0, 400) || 'failed' };

  // Only write the knowledge once the registration succeeded — a README for a connector that does
  // not work is worse than no README, because it reads as a record that someone verified it.
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'connector.json'), JSON.stringify({
      id, service: label, value: '', connect: 'one-click',
      register: def.register, docs: 'README.md',
    }, null, 2) + '\n');
    fs.writeFileSync(path.join(dir, 'README.md'),
      `# ${label}\n\nAdded from the AIOS App's Connectors card.\n\n## Register\n\n\`\`\`bash\n` +
      `${(hintFor(def) ?? '').replace(/•••/g, '<value>')}\n\`\`\`\n\n` +
      `The registration itself is per-machine and lives in \`~/.claude.json\` — not in git, so\n` +
      `pulling this folder on another machine documents the connector without auto-connecting it.\n`);
  } catch { /* the connector works; the note is a convenience */ }

  updateCustomIndex(framework, id, 'add', label);
  const row = listConnectors(framework).rows.find((r) => normaliseId(r.id) === normaliseId(id));
  return { ok: true, id, row };
}
