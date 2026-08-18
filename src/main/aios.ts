import * as fs from 'fs';
import * as os from 'os';
import {
  CLAUDE_KEYS, BUILTIN_OUTPUT_STYLES, readStore, writeStore, readValue, coerce, setAt, isSet, seedableKeys,
} from '../core/claudeConfig';
import * as path from 'path';
import { execFile, execFileSync } from 'child_process';
import { parseFrontmatter } from '../core/frontmatter';
import { ttlMemo } from '../core/memo';
import { deriveOnboarding, type OnboardingDerived } from '../core/onboarding';
import { isWritten, isPersonalized, missingEvidence, hasPlaceholders, type PersonalizationEvidence } from '../core/personalized';
import { isInboxEntityDismissed, dismissInboxEntity, pruneInboxDismissals, type InboxDismissals } from '../core/inbox';
import personaPersonal from './personas/personal-family.json';
import personaFounder from './personas/founder-operator.json';
import { FOLDER_SORT_KEY, MASTER_SORT_KEY, normalizeSortMode, setFolderSort, type FolderSortMap, type SortMode } from '../core/sort';
import { t, setLocale, normalizeLocale, normalizeLocalePref, type Locale, type LocalePref } from '../i18n';

/**
 * The shell's AIOS data layer — faithful ports of the extension's fs-only
 * logic (vault roots, discovery, running sessions, quota, nudge, learnings,
 * outputs, reports, calendar, companies). NO vscode, NO electron: pure Node,
 * unit-testable, and the second consumer that proves the logic belongs in a
 * shared package (the monorepo gate).
 *
 * Glass, not engine: everything here READS the AIOS's own files.
 */

// ── roots ────────────────────────────────────────────────────────────────────

export function frameworkRoot(): string | undefined {
  // Precedence: what the operator set in Settings → the env override → the default.
  // Settings wins because it is the surface they can actually reach; the env var stays
  // for scripted/CI runs. Read lazily each call, so editing the row takes effect without
  // a restart for everything that resolves paths on demand.
  const configured = storedFrameworkPath() || process.env.GLASS_FRAMEWORK_PATH || path.join(os.homedir(), 'aios');
  try { return fs.realpathSync(configured); } catch { return undefined; }
}

/**
 * Where the framework-path override lives — machine-local, OUTSIDE the framework.
 * It cannot live in `.glass/shell.json` like every other app setting: that file is read
 * from INSIDE the framework root, so a setting that tells us where the framework is
 * would be unreachable until we already knew. Bootstrap settings need their own home.
 */
const appLocalPath = (): string => path.join(os.homedir(), '.aios', 'app.json');

/** Operator-set framework path (empty = not overridden). */
function storedFrameworkPath(): string {
  try {
    const raw = JSON.parse(fs.readFileSync(appLocalPath(), 'utf8')) as { frameworkPath?: unknown };
    return typeof raw.frameworkPath === 'string' ? raw.frameworkPath.trim() : '';
  } catch { return ''; }
}

/** Set (or clear, with '') the framework path. Empty falls back to env, then ~/aios. */
export function setFrameworkPath(value: string): void {
  const p = appLocalPath();
  let j: Record<string, unknown> = {};
  try { j = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { /* first write */ }
  const v = String(value || '').trim();
  if (v) j.frameworkPath = v; else delete j.frameworkPath;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(j, null, 2) + '\n');
  fs.renameSync(tmp, p);
}

/** What Settings shows in the row: the override if set, else where we resolved to. */
export function frameworkPathSetting(): { value: string; resolved: string; source: 'setting' | 'env' | 'default' } {
  const stored = storedFrameworkPath();
  return {
    value: stored,
    resolved: frameworkRoot() || '',
    source: stored ? 'setting' : process.env.GLASS_FRAMEWORK_PATH ? 'env' : 'default',
  };
}

export function vaultRoot(): string | undefined {
  const r = frameworkRoot();
  if (!r) return undefined;
  const v = path.join(r, 'vault');
  try { return fs.statSync(v).isDirectory() ? v : r; } catch { return r; }
}

/* WHO IS THE OPERATOR — and it must not depend on which language they write in.
   Reported 2026-07-30 by an operator whose `about_me.md` says "Me llamo Ignacio Indaco.": the
   panel greeted him as a brand-new vault. This function matched `my name is` and nothing else,
   so a fully personalised Spanish vault looked identical to an untouched one — while the app
   ships complete es / es-419 / pt-BR translations and actively invites operating in your own
   language. It then failed SILENTLY: no error, no hint, and the operator reasonably concludes
   their own file is malformed.
   Resolution order, most structured first — the reporter's own preference, and correct:
     1. frontmatter `aliases:` — declarative, already in the shipped template, and
        LANGUAGE-AGNOSTIC, so it needs no phrase list and cannot rot as languages are added.
     2. a quoted nickname on an identity line — an explicit "call me this" beats any parse.
     3. the word following an identity phrase, in the languages the app itself speaks.
   A regex list is a maintenance burden by nature; it is the FALLBACK precisely so that adding
   a locale does not require remembering to extend it. */
const IDENTITY_PHRASE = /(?:my name is|i am called|me llamo|mi nombre es|meu nome é|meu nome e)/i;

/** First `aliases:` value — supports a block list, an inline `[a, b]` list, and a bare scalar. */
function aliasFromFrontmatter(text: string): string {
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return '';
  const lines = fm[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^aliases:\s*(.*)$/i);
    if (!m) continue;
    const inline = m[1].trim();
    if (inline) {
      const first = inline.replace(/^\[|\]$/g, '').split(',')[0];
      return stripWrapping(first);
    }
    // block form: the following indented `- item` lines
    for (let j = i + 1; j < lines.length; j++) {
      const item = lines[j].match(/^\s*-\s+(.+)$/);
      if (item) return stripWrapping(item[1]);
      if (lines[j].trim() && !/^\s/.test(lines[j])) break;   // next top-level key
    }
  }
  return '';
}

function stripWrapping(v: string): string {
  return v.trim().replace(/^["“”'\`]+|["“”'\`]+$/g, '').trim();
}

/* DISPLAY FORM. A name reaches us from three places and only one of them is reliably cased:
   `aliases:` carries link slugs (`chuy`), prose carries display names (`Chuy`), and a shouty
   line can carry `CHUY`. Greeting somebody by their slug reads as a bug even when the string is
   genuinely theirs, so the value is normalised before it is ever shown.
   ONLY when there is no internal casing worth keeping — an all-lowercase or all-uppercase
   string. `McDonald`, `O'Brien` and `van Gogh` already carry deliberate casing and are returned
   untouched, because "fixing" them would be the same insult in the other direction.
   Segments split on hyphen and apostrophe, so `jean-luc` → `Jean-Luc` and `o'brien` → `O'Brien`.
   Locale-aware case conversion, or accented names come back wrong (`JOSÉ` → `José`). */
function displayName(v: string): string {
  const s = v.trim();
  if (!s) return '';
  const hasLower = s !== s.toLocaleUpperCase();
  const hasUpper = s !== s.toLocaleLowerCase();
  if (hasLower && hasUpper) return s;          // already deliberately cased — leave it alone
  return s.toLocaleLowerCase().replace(/(^|[-'\u2019])(\p{L})/gu,
    (_m, sep: string, ch: string) => sep + ch.toLocaleUpperCase());
}

export function operatorName(): string {
  const v = vaultRoot();
  if (!v) return '';
  let text = '';
  try {
    text = fs.readFileSync(path.join(v, '00 - notes', 'context', 'declared', 'about_me.md'), 'utf8');
  } catch { return ''; }        // absent is fine — a vault with no about_me has no name yet

  /* CANDIDATES, best-signal first. The order was `aliases:` first, on the reasoning that it is
     structured and language-agnostic — sound in theory, wrong in practice, and one operator's
     real vault proved it within the hour: his `aliases:` are `chuy` / `chuycepeda`, because in
     Obsidian that field exists to make LINKS resolve, so lowercase slugs are the norm there. The
     app greeted him in lowercase off his own link aliases while his prose said
     `My name is Jesús "Chuy" Cepeda.`
     So: an explicit quoted nickname is the strongest "call me this", the identity phrase is next,
     and `aliases:` stays as the language-agnostic NET for a vault whose prose we cannot parse. */
  const cands: string[] = [];
  const line = text.split(/\r?\n/).find((l) => IDENTITY_PHRASE.test(l));
  if (line) {
    const nick = line.match(/["“”']([^"“”']+)["“”']/);
    if (nick) cands.push(stripWrapping(nick[1]));
    const m = line.match(new RegExp(IDENTITY_PHRASE.source + '\\s+([A-Za-zÀ-ÿ]+)', 'i'));
    if (m) cands.push(m[1]);
  }
  const alias = aliasFromFrontmatter(text);
  if (alias) cands.push(alias);

  /* DROP TEMPLATE PLACEHOLDERS — they are not names, and one of them greeted two real people.
   *
   * Reported 2026-08-15 on a Mac AND a Windows machine: the App said `{{first-Name}}` to two
   * operators on their first run. The path, reproduced exactly rather than guessed at:
   * `about_me-template.md` ships `aliases: ["{{first-name}}", "{{handle}}"]`, so
   * `aliasFromFrontmatter` hands back the placeholder as a legitimate candidate; it has no
   * whitespace so the first-word split preserves it; and `displayName` then lowercases it and
   * capitalises the letter after the hyphen — turning `{{first-name}}` into `{{first-Name}}`.
   *
   * That capital N is the fingerprint. The operator reported it with the capital and I initially
   * dismissed it as a transcription slip; it was the evidence identifying the exact code path.
   *
   * Filtered per CANDIDATE rather than per FILE on purpose: someone who has written their name
   * but left the credential and role lines templated has personalized the thing that matters, and
   * refusing to greet them would trade one wrong behaviour for another. `hasPlaceholders` already
   * existed in core/personalized for precisely this question — `operatorName` simply never asked
   * it, which is why a check that was right about a template passing as personalized could sit
   * beside a greeting that rendered one. */
  const named = cands.filter((c) => !hasPlaceholders(c));
  // First word only: a greeting wants a first name, not "Ignacio Indaco".
  const first = named.map((c) => c.split(/\s+/)[0]).filter(Boolean);
  if (!first.length) return '';
  /* Prefer something that LOOKS like a display name. A lowercase-only candidate is usually a
     slug, and greeting someone by their slug reads as a bug even when the string is technically
     theirs. But never force-capitalise: if every candidate is lowercase, that may be exactly how
     the operator writes their own name, and rewriting it would be its own insult. */
  return displayName(first.find((c) => /[A-ZÀ-Þ]/.test(c)) || first[0]);
}

/* THE GAP BETWEEN TWO READINGS OF ONE FILE. `hasIdentity()` asks "has this been written?"
   (length + no placeholders) while `operatorName()` asks "what is the name?" — and they can
   disagree. When they do, the app has a personalised vault it cannot read a name out of, which
   is NOT a brand-new vault and must not be greeted like one silently. Surfacing it is the whole
   point: the reporter spent his time diagnosing what a one-line hint would have told him. */
export function identityNameGap(): boolean {
  return hasIdentity() && !operatorName();
}

/** True when the vault already carries operator identity — about_me.md exists
 *  with a real name line. Lets first-run skip the interview for a cloned vault
 *  (identity arrives WITH the vault) while a fresh vault still gets the gate. */
export function hasIdentity(): boolean {
  const v = vaultRoot();
  if (!v) return false;
  try {
    const text = fs.readFileSync(path.join(v, '00 - notes', 'context', 'declared', 'about_me.md'), 'utf8');
    /* The template opens with `My name is {{full name}}.`, so the old test — "my name is" plus
       40 characters — passed on a vault nobody had touched. isWritten() rejects any file that
       still carries mustache placeholders. */
    return isWritten(text);
  } catch { return false; }
}

/**
 * Read the three pieces of evidence that this AIOS belongs to someone. See
 * src/core/personalized.ts for why this is read from the vault rather than recorded as a flag.
 */
export function personalization(): PersonalizationEvidence & { ok: boolean; missing: string[] } {
  const v = vaultRoot();
  let declared = false;
  if (v) {
    try { declared = isWritten(fs.readFileSync(path.join(v, '00 - notes', 'context', 'declared', 'about_me.md'), 'utf8')); }
    catch { declared = false; }
  }
  const named = !!primaryNameRaw();
  /* A remote of their own — NOT the framework repo. Someone who cloned The-AIOS/aios and never
     made their own repo has a remote, but pushing their private vault there is exactly what
     setup is supposed to prevent, so it does not count as evidence. */
  let remote = false;
  const root = frameworkRoot();
  if (root) {
    try {
      const url = execFileSync('git', ['-C', root, 'remote', 'get-url', 'origin'], { encoding: 'utf8', timeout: 4000 }).trim();
      remote = !!url && !/[/:]The-AIOS\/aios(\.git)?$/i.test(url);
    } catch { remote = false; }
  }
  const e = { declared, named, remote };
  return { ...e, ok: isPersonalized(e), missing: missingEvidence(e) };
}

/**
 * The operator's primary-session name, or '' when USER.md does not declare one.
 *
 * Split out from primaryName() because that function falls back to 'aios' and therefore never
 * reports "unknown" — which made `!!primaryName()` unconditionally true and quietly reduced the
 * three-way personalization evidence to a single check. A default that cannot be distinguished
 * from an answer is unusable as evidence.
 */
export function primaryNameRaw(): string {
  const root = frameworkRoot();
  if (root) {
    try {
      const lines = fs.readFileSync(path.join(root, 'USER.md'), 'utf8').split(/\r?\n/);
      let inSection = false;
      for (const line of lines) {
        if (/^##\s+Identity/.test(line)) { inSection = true; continue; }
        if (inSection && /^##\s/.test(line)) break;
        if (inSection && line.startsWith('|')) {
          const raw = (line.split('|')[1] ?? '').replace(/`/g, '').trim();
          if (raw && raw !== 'Name' && !/^[ -]+$/.test(raw)) return raw;
        }
      }
    } catch { /* fall through */ }
  }
  return '';
}

/** As above, with the shipped default applied — for display, where something must be shown. */
export function primaryName(): string {
  return primaryNameRaw() || 'aios';
}

// ── discovery (agents / commands / skills) ──────────────────────────────────

export interface Agent { name: string; description: string; group: string; icon?: string; keywords?: string; filePath: string; }

function discoverAgentsUncached(): Agent[] {
  const root = frameworkRoot();
  if (!root) return [];
  const base = path.join(root, 'agents');
  let rels: string[] = [];
  try { rels = fs.readdirSync(base, { recursive: true }) as string[]; } catch { return []; }
  const out: Agent[] = [];
  for (const rel of rels) {
    const b = path.basename(rel);
    if (!b.endsWith('.md') || b === '_index.md' || b.startsWith('_')) continue;
    const filePath = path.join(base, rel);
    try { if (!fs.statSync(filePath).isFile()) continue; } catch { continue; }
    let fm;
    try { fm = parseFrontmatter(fs.readFileSync(filePath, 'utf8')); } catch { continue; }
    if (!fm.tags.map((t) => t.toLowerCase()).includes('agent')) continue;
    const dirName = path.basename(path.dirname(rel)) || 'agents';
    out.push({ name: fm.name || b.replace(/\.md$/, ''), description: fm.description ?? '', group: dirName, icon: fm.icon, keywords: fm.keywords, filePath });
  }
  return out.sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name));
}
export const discoverAgents = ttlMemo(discoverAgentsUncached, 5000);

export interface AiosCommand { name: string; description: string; argumentHint?: string; filePath: string; }

function discoverCommandsUncached(): AiosCommand[] {
  const root = frameworkRoot();
  if (!root) return [];
  const dir = path.join(root, 'plugins', 'aios', 'commands');
  let entries: string[] = [];
  try { entries = fs.readdirSync(dir); } catch { return []; }
  const out: AiosCommand[] = [];
  for (const e of entries) {
    if (!e.endsWith('.md') || e === '_index.md') continue;
    const filePath = path.join(dir, e);
    try {
      const fm = parseFrontmatter(fs.readFileSync(filePath, 'utf8'));
      out.push({ name: e.replace(/\.md$/, ''), description: fm.description ?? '', argumentHint: fm.argumentHint, filePath });
    } catch { out.push({ name: e.replace(/\.md$/, ''), description: '', filePath }); }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
export const discoverCommands = ttlMemo(discoverCommandsUncached, 5000);

export interface Skill { name: string; description: string; group: string; filePath: string; }

function discoverSkillsUncached(): Skill[] {
  const root = frameworkRoot();
  if (!root) return [];
  const base = path.join(root, 'skills');
  let groups: string[] = [];
  try { groups = fs.readdirSync(base).filter((d) => { try { return fs.statSync(path.join(base, d)).isDirectory(); } catch { return false; } }); } catch { return []; }
  const out: Skill[] = [];
  for (const g of groups) {
    let names: string[] = [];
    try { names = fs.readdirSync(path.join(base, g)); } catch { continue; }
    for (const n of names) {
      const sk = path.join(base, g, n, 'SKILL.md');
      try {
        if (!fs.statSync(sk).isFile()) continue;
        const fm = parseFrontmatter(fs.readFileSync(sk, 'utf8'));
        out.push({ name: fm.name || n, description: fm.description ?? '', group: g, filePath: sk });
      } catch { /* not a skill dir */ }
    }
  }
  return out.sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name));
}
export const discoverSkills = ttlMemo(discoverSkillsUncached, 5000);

export function countNotes(kind: 'declared' | 'observed' | 'projects'): number {
  const v = vaultRoot();
  if (!v) return 0;
  const dir = kind === 'projects'
    ? path.join(v, '00 - notes', 'projects')
    : path.join(v, '00 - notes', 'context', kind);
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.md') && f !== '_index.md').length;
  } catch { return 0; }
}

// ── running sessions (Claude Code's own registry) ───────────────────────────

export interface RunningAgent { pid: number; name: string; status: string; sessionId: string; cwd: string; startedAt: number; updatedAt: number; }

export function listRunningAgents(): RunningAgent[] {
  const dir = path.join(os.homedir(), '.claude', 'sessions');
  let files: string[] = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return []; }
  const out: RunningAgent[] = [];
  for (const f of files) {
    let d: { pid?: number; name?: string; status?: string; sessionId?: string; cwd?: string; startedAt?: number; updatedAt?: number };
    try { d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    const pid = Number(d?.pid ?? path.basename(f, '.json'));
    if (!Number.isInteger(pid) || pid <= 0 || !isAlive(pid)) continue;
    out.push({
      pid,
      name: String(d?.name ?? '').trim() || '(unnamed)',
      status: String(d?.status ?? '').trim(),
      sessionId: String(d?.sessionId ?? ''),
      cwd: String(d?.cwd ?? ''),
      startedAt: Number(d?.startedAt) || 0,
      updatedAt: Number(d?.updatedAt) || 0,
    });
  }
  const seen = new Set<number>();
  return out.filter((a) => (seen.has(a.pid) ? false : (seen.add(a.pid), true)));
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return !!e && (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/**
 * The Windows stand-in for `ps`. Win32_Process carries the same three fields (pid, ppid, RSS in
 * bytes), printed in the same `pid ppid kb` shape, so the tree walk below is shared and only the
 * harvest differs — without it the whole call threw ENOENT and every session showed no memory.
 *
 * Memoized, and that part is not cosmetic: this is execFileSync, which BLOCKS the main thread,
 * and the panel re-reads memory on every poll. A full CIM enumeration costs hundreds of
 * milliseconds, so an unmemoized call meant the UI stuttering once per poll forever. The TTL is
 * shorter than the poll, so the reading stays live while repeat calls within one tick are free.
 */
const winProcTable = ttlMemo((): string => {
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $([math]::Round($_.WorkingSetSize/1024))" }'],
    { encoding: 'utf8', timeout: 8000 });
  } catch { return ''; }
}, 4000);

/** Process-tree RSS (MB) for each given pid — one `ps` scan, summed over each
 *  session's descendants (the Glass "… ready 1h · 1.6 GB" token). Best-effort. */
export function sessionMemoryMB(pids: number[]): Record<number, number> {
  const out: Record<number, number> = {};
  if (!pids.length) return out;
  try {
    const txt = process.platform === 'win32'
      ? winProcTable()
      : execFileSync('ps', ['-axo', 'pid=,ppid=,rss='], { encoding: 'utf8', timeout: 4000 });
    const rss = new Map<number, number>();
    const kids = new Map<number, number[]>();
    for (const line of txt.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)$/);
      if (!m) continue;
      const pid = Number(m[1]), ppid = Number(m[2]), r = Number(m[3]);
      rss.set(pid, r);
      (kids.get(ppid) ?? kids.set(ppid, []).get(ppid)!).push(pid);
    }
    for (const root of pids) {
      let total = 0;
      const stack = [root];
      const seen = new Set<number>();
      while (stack.length) {
        const p = stack.pop() as number;
        if (seen.has(p)) continue;
        seen.add(p);
        total += rss.get(p) ?? 0;
        for (const c of kids.get(p) ?? []) stack.push(c);
      }
      if (total > 0) out[root] = Math.round(total / 1024); // KB → MB
    }
  } catch { /* ps unavailable */ }
  return out;
}

// ── quota (statusline cache) ────────────────────────────────────────────────

export interface RateLimit { fiveHourPct: number; sevenDayPct: number; fiveHourResetsAt: number; sevenDayResetsAt: number; }

export function rateLimit(): RateLimit | undefined {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'rate-limit-cache.json'), 'utf8'));
    return {
      fiveHourPct: Number(d.five_hour_pct) || 0,
      sevenDayPct: Number(d.seven_day_pct) || 0,
      fiveHourResetsAt: Number(d.five_hour_resets_at) || 0,
      sevenDayResetsAt: Number(d.seven_day_resets_at) || 0,
    };
  } catch { return undefined; }
}

// ── daily note + nudge (ported incl. the 0.1.7 today-cap fix) ───────────────

function todayLocalIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function latestDailyNote(): string | undefined {
  const v = vaultRoot();
  if (!v) return undefined;
  const cal = path.join(v, '01 - calendar');
  const today = todayLocalIso();
  try {
    const months = fs.readdirSync(cal).filter((d) => /^\d{4}-\d{2}$/.test(d)).sort();
    for (const mo of months.reverse()) {
      if (mo > today.slice(0, 7)) continue;
      const files = fs.readdirSync(path.join(cal, mo))
        .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f) && f.slice(0, 10) <= today)
        .sort();
      if (files.length) return path.join(cal, mo, files[files.length - 1]);
    }
  } catch { /* ignore */ }
  return undefined;
}

export interface Nudge { kind: string; icon: string; label: string; command?: string; cmdLabel?: string; }

function suggestedRitual(md: string): { command: string; short: string; desc: string } | null {
  for (const line of md.split(/\r?\n/)) {
    if (!/^\s*>?\s*💡/.test(line)) continue;
    if (/~~|✅/.test(line)) continue;
    const m = line.match(/`(\/[^`]+)`/);
    if (!m) continue;
    const command = m[1].trim();
    if (/close-?day|close-?session/i.test(command)) continue;
    const short = command.replace(/^\/(?:aios:|vault-commands:)?/, '').split(/\s/)[0];
    let desc = '';
    for (const im of line.matchAll(/_([^_]+)_/g)) {
      const cand = im[1].trim();
      if (/^\(?\s*suggested\s*\)?$/i.test(cand)) continue;
      desc = cand;
      break;
    }
    return { command, short, desc };
  }
  return null;
}

function isoWeek(d: Date): { year: number; week: number } {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  date.setUTCDate(date.getUTCDate() + 3 - ((date.getUTCDay() + 6) % 7));
  const week1 = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((date.getTime() - week1.getTime()) / 86400000 - 3 + ((week1.getUTCDay() + 6) % 7)) / 7);
  return { year: date.getUTCFullYear(), week };
}

function weeklyPlanExists(): boolean {
  const v = vaultRoot();
  if (!v) return false;
  const { year, week } = isoWeek(new Date());
  const name = `${year}-W${String(week).padStart(2, '0')}-plan.md`;
  const cal = path.join(v, '01 - calendar');
  try {
    for (const mo of fs.readdirSync(cal).filter((d) => /^\d{4}-\d{2}$/.test(d))) {
      if (fs.existsSync(path.join(cal, mo, name))) return true;
    }
  } catch { /* ignore */ }
  return false;
}

export function nudgeState(hour: number, weekday: number, runningCount: number): Nudge | null {
  const note = latestDailyNote();
  const isToday = !!note && path.basename(note, '.md') === todayLocalIso();
  if (!isToday) return { kind: 'plan', icon: '☀️', label: t('nudge.plan'), command: '/aios:today' };
  let md = '';
  try { md = fs.readFileSync(note as string, 'utf8'); } catch { return null; }
  const isClosed = /close[\s-]?of[\s-]?day|^#{1,4}.*\bclose\b.*\bday\b/im.test(md);
  if (hour >= 17 && !isClosed) {
    return { kind: 'close', icon: '🌙', label: t('nudge.closeDay'), command: '/aios:close-day' };
  }
  if ((weekday === 1 || weekday === 2) && hour >= 6 && hour < 17 && !weeklyPlanExists()) {
    const r = suggestedRitual(md);
    // command-frontmatter desc stays as authored (vault content); the static fallback is localized
    const desc = r && r.short === '7plan' && r.desc ? r.desc.charAt(0).toUpperCase() + r.desc.slice(1) : t(weekday === 1 ? 'nudge.planWeekMon' : 'nudge.planWeekTue');
    return { kind: 'week', icon: '🗓️', cmdLabel: t('nudge.runCmd', { short: '7plan' }), label: desc, command: '/aios:7plan' };
  }
  if (hour < 12) {
    const r = suggestedRitual(md);
    if (r) {
      const label = r.desc ? r.desc.charAt(0).toUpperCase() + r.desc.slice(1) : '';
      return { kind: 'plan', icon: '💡', cmdLabel: t('nudge.runCmd', { short: r.short }), label, command: r.command };
    }
  }
  if (hour < 17 && runningCount > 0) {
    return { kind: 'sessions', icon: '💬', label: t('nudge.sessions'), command: '/aios:close-session' };
  }
  return null;
}

// ── learnings / outputs / reports ───────────────────────────────────────────

export interface Learning { title: string; date: string; source: string; file: string; line: number; }

const SOURCES = [
  { file: 'session-insights.md', label: 'noticed' },
  { file: 'growth.md', label: 'growth' },
  { file: 'antifragile.md', label: 'rule' },
];

export function observedDirPath(): string | undefined {
  const v = vaultRoot();
  return v ? path.join(v, '00 - notes', 'context', 'observed') : undefined;
}

export function recentLearnings(limit = 4): Learning[] {
  const dir = observedDirPath();
  if (!dir) return [];
  const out: Learning[] = [];
  for (const s of SOURCES) {
    const fpath = path.join(dir, s.file);
    let md: string;
    try { md = fs.readFileSync(fpath, 'utf8'); } catch { continue; }
    md.split(/\r?\n/).forEach((line, idx) => {
      const m = line.match(/^###\s+(.+)$/);
      if (!m) return;
      const dates = m[1].match(/20\d\d-\d\d-\d\d/g);
      if (!dates) return;
      const date = dates.slice().sort()[dates.length - 1];
      const title = m[1].replace(/^\d+\.\s*/, '').replace(/\s*\((?:new[^)]*|[^)]*20\d\d[^)]*)\)\s*$/i, '').replace(/[#*_`]/g, '').trim();
      if (title) out.push({ title: title.slice(0, 96), date, source: s.label, file: fpath, line: idx });
    });
  }
  return out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)).slice(0, limit);
}

export interface OutputFile { name: string; group: string; path: string; mtime: number; }

export function recentOutputs(limit = 6): OutputFile[] {
  const v = vaultRoot();
  if (!v) return [];
  const root = path.join(v, '03 - export');
  const out: OutputFile[] = [];
  const walk = (dir: string, group: string, depth: number) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === '_index.md') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth < 2) walk(p, group || e.name, depth + 1); continue; }
      let m = 0;
      try { m = fs.statSync(p).mtimeMs; } catch { /* ignore */ }
      if (m > 0) out.push({ name: e.name, group: group || 'export', path: p, mtime: m });
    }
  };
  walk(root, '', 0);
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, limit).sort((a, b) => b.name.localeCompare(a.name));
}

export interface ReportFile { name: string; path: string; }

export function recentReports(limit = 5): ReportFile[] {
  const v = vaultRoot();
  if (!v) return [];
  const dir = path.join(v, '03 - export', 'reports');
  const out: { name: string; path: string; mtime: number }[] = [];
  const walk = (d: string, depth: number) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === '_index.md') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (depth < 1) walk(p, depth + 1); continue; }
      let m = 0;
      try { m = fs.statSync(p).mtimeMs; } catch { /* ignore */ }
      out.push({ name: e.name, path: p, mtime: m });
    }
  };
  walk(dir, 0);
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, limit).sort((a, b) => b.name.localeCompare(a.name)).map((o) => ({ name: o.name, path: o.path }));
}

// ── go-with-agents parsing (Glass-parity: pure, list-item guarded) ──────────
//
// Ported verbatim from aios-glass `src/tasks/agentParse.ts` so the desktop badge
// count and the picker match the extension exactly (zero-drift). Both the bubble
// (countAgentSuggestions) and the picker (listAgentSuggestions) derive from this
// ONE parser, so they can no longer disagree, and both inherit the two guards the
// desktop was missing: the list-item guard (a routed task is always a `- `/`* `
// line — so the section's prose count-header/footer no longer over-count just for
// mentioning a backticked `/command`) and cross-section done-matching (a
// suggestion whose canonical task is checked/struck elsewhere drops out).

export interface ParsedSuggestion { task: string; agents: string[]; command?: string; arg?: string; raw: string; }

/** Reduce a task line to its core identity for cross-section done-matching. */
export function taskIdentity(s: string): string {
  return s
    .replace(/^\s*[-*]\s*/, '')
    .replace(/\[[ xX]\]/g, '')
    .replace(/~~/g, '')
    .replace(/\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]/g, (_, a, b) => b || a)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*_#>]/g, '')
    .replace(/\b\d{1,2}:\d{2}\b/g, '')
    .replace(/\b\d{1,2}\s?(?:am|pm)\b/gi, '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Identities of every task the note marks done anywhere (`[x]` or ~~struck~~). */
export function doneIdentities(md: string): string[] {
  const out: string[] = [];
  for (const line of md.split(/\r?\n/)) {
    if (!(/^\s*[-*]\s*\[[xX]\]/.test(line) || /~~[^~]+~~/.test(line))) continue;
    const id = taskIdentity(line);
    if (id.length >= 4) out.push(id);
  }
  return out;
}

/** Extract the "Agents can handle" section's open, routed suggestions. */
export function parseAgentSection(md: string): ParsedSuggestion[] {
  const lines = md.split(/\r?\n/);
  const done = doneIdentities(md);
  const out: ParsedSuggestion[] = [];
  let inSection = false;
  for (const line of lines) {
    if (/^##\s+.*Agents can handle/i.test(line)) { inSection = true; continue; }
    if (inSection && /^##\s/.test(line)) break;
    if (!inSection) continue;
    // A routed task is ALWAYS a list item — this excludes the section's prose
    // (the count header + the `go with agents`/`/ghost` footer) that would
    // otherwise be mis-read as a task purely for mentioning a backticked
    // `/command` in passing (the over-count bug behind the bubble).
    if (!/^\s*[-*]\s/.test(line)) continue;
    if (/^\s*[-*]\s*\[[xX]\]/.test(line)) continue;             // done: checkbox form
    if (/^\s*[-*]\s*(?:\u{1F916}\s*)*~~/u.test(line)) continue; // done: struck-title form
    if (line.includes('\u{1F680}')) continue;                  // 🚀 already spawned (in flight)
    const agents = [...line.matchAll(/\[\[([^\]|]+?)(?:\|[^\]]+)?\]\]/g)].map((m) => m[1].trim());
    const cmd = line.match(/`(\/[a-z][\w:-]*)`/i);             // backticked `/aios:ingest` etc.
    if (!agents.length && !cmd) continue;                      // not a routed task
    const bold = line.match(/\*\*(.+?)\*\*/);
    const task = (bold ? bold[1] : line.replace(/[-*\u{1F916}_]/gu, '')).trim();
    // Done elsewhere? Canonical task checked/struck in another section → skip.
    const sId = taskIdentity(task);
    if (sId.length >= 6 && done.some((d) => d === sId || d.includes(sId))) continue;
    const sug: ParsedSuggestion = { task, agents, raw: line.trim() };
    if (!agents.length && cmd) {
      sug.command = cmd[1];
      const mdLink = line.match(/\]\((https?:\/\/[^)]+)\)/);
      sug.arg = mdLink ? mdLink[1] : line.match(/https?:\/\/\S+/)?.[0]?.replace(/[)*_.,]+$/, '');
    }
    out.push(sug);
  }
  return out;
}

export function countAgentSuggestions(): number {
  const note = latestDailyNote();
  if (!note) return 0;
  let md = '';
  try { md = fs.readFileSync(note, 'utf8'); } catch { return 0; }
  return parseAgentSection(md).length;
}

// ── glass state (.glass/state.json — the App-owned glass-UI namespace) ──────
// Roams via git with the vault, shared with the Glass extension (AI-58 &c.).

function glassState(): Record<string, unknown> {
  const r = frameworkRoot();
  if (!r) return {};
  try {
    const st = JSON.parse(fs.readFileSync(path.join(r, '.glass', 'state.json'), 'utf8'));
    return st && typeof st === 'object' ? st : {};
  } catch { return {}; }
}

function setGlassState(key: string, value: unknown): void {
  const r = frameworkRoot();
  if (!r) return;
  const p = path.join(r, '.glass', 'state.json');
  const cur = glassState();
  cur[key] = value;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cur, null, 2) + '\n');
  fs.renameSync(tmp, p);
}

// ── session post-its (AI-18 parity — .glass/state.json → sessionNotes, keyed by
//    session name; roams with the vault, shared with the Glass extension). The
//    human jots "what did I want to do here next" on a live session. ──
export interface SessionNote { t: string; ts: number; }
function notesMap(): Record<string, unknown> {
  const raw = glassState().sessionNotes;
  return raw && typeof raw === 'object' ? { ...(raw as Record<string, unknown>) } : {};
}
export function sessionNotes(name: string): SessionNote[] {
  const arr = notesMap()[name];
  if (!Array.isArray(arr)) return [];
  return arr
    .map((n) => (typeof n === 'string'
      ? { t: n, ts: 0 }
      : (n && typeof n === 'object'
        ? { t: String((n as { t?: unknown }).t ?? ''), ts: Number((n as { ts?: unknown }).ts ?? 0) }
        : { t: '', ts: 0 })))
    .filter((x) => x.t.trim().length > 0);
}
/**
 * Rename the PRIMARY session in USER.md's `## Identity` table (the first data row's
 * backticked Name cell) — the same cell primaryName() reads, so the setting and the
 * reader can never disagree. Everything downstream (the Launch button, runInPrimary,
 * close-all's spare-the-primary rule, the panel greeting) resolves through
 * primaryName(), so this one edit moves them all. Only the name cell is touched; the
 * row's Role/Greeting prose is preserved.
 */
export function setPrimaryName(name: string): { ok: boolean; name: string } {
  const root = frameworkRoot();
  const clean = String(name || '').trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  if (!root || !clean) return { ok: false, name: primaryName() };
  const p = path.join(root, 'USER.md');
  let lines: string[];
  try { lines = fs.readFileSync(p, 'utf8').split(/\r?\n/); } catch { return { ok: false, name: primaryName() }; }
  let inSection = false, done = false;
  for (let i = 0; i < lines.length && !done; i++) {
    const line = lines[i];
    if (/^##\s+Identity/.test(line)) { inSection = true; continue; }
    if (inSection && /^##\s/.test(line)) break;
    if (!inSection || !line.startsWith('|')) continue;
    const cells = line.split('|');
    const raw = (cells[1] ?? '').replace(/`/g, '').trim();
    if (!raw || raw === 'Name' || /^[ -]+$/.test(raw)) continue; // header + separator
    cells[1] = ` \`${clean}\` `;
    lines[i] = cells.join('|');
    done = true;
  }
  if (!done) return { ok: false, name: primaryName() };
  const tmp = p + '.tmp';
  try {
    fs.writeFileSync(tmp, lines.join('\n'));
    fs.renameSync(tmp, p);
  } catch { return { ok: false, name: primaryName() }; }
  return { ok: true, name: clean };
}

// ── Anthropic accounts (#32 — quota rotation, Glass launchAccountSwap parity) ──
// USER.md carries a numbered list of backticked emails under the "Anthropic accounts"
// heading; `hooks/claude-identity/claude-identity.sh switch <email>` swaps the Keychain
// credentials + ~/.claude.json atomically. We read the roster and shell the script —
// never reimplement the swap.
export interface AnthropicAccount { email: string; note: string; current: boolean; }
export function anthropicAccounts(): AnthropicAccount[] {
  const r = frameworkRoot();
  if (!r) return [];
  let md = '';
  try { md = fs.readFileSync(path.join(r, 'USER.md'), 'utf8'); } catch { return []; }
  const start = md.search(/^##\s+Anthropic accounts/im);
  if (start < 0) return [];
  const rest = md.slice(start);
  const end = rest.search(/^##\s+(?!Anthropic)/im);
  const block = end > 0 ? rest.slice(0, end) : rest;
  const active = claudeConfig().account;
  const out: AnthropicAccount[] = [];
  for (const line of block.split('\n')) {
    const m = /^\s*\d+\.\s*`([^`]+@[^`]+)`\s*(?:—|-)?\s*(.*)$/.exec(line);
    if (!m) continue;
    const email = m[1].trim();
    out.push({ email, note: (m[2] || '').trim().replace(/\.$/, ''), current: !!active && active === email });
  }
  return out;
}
export function swapAccount(email: string): Promise<{ ok: boolean; message: string }> {
  const r = frameworkRoot();
  if (!r) return Promise.resolve({ ok: false, message: 'framework path not found' });
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) return Promise.resolve({ ok: false, message: 'invalid email' });
  const known = anthropicAccounts().some((a) => a.email === email);
  if (!known) return Promise.resolve({ ok: false, message: 'not a USER.md account' }); // never pass arbitrary input to the shell
  const script = path.join(r, 'hooks', 'claude-identity', 'claude-identity.sh');
  if (process.platform === 'win32') {
    /* There is no bash on Windows, and shelling the .sh anyway fails in a way that READS LIKE
       the swap ran — the worst outcome for a step whose whole job is swapping credentials.
       So: run the PowerShell sibling if the framework ships one, otherwise say plainly that
       this is not supported yet.
       TODO(windows): needs hooks/claude-identity/claude-identity.ps1 in the framework (the
       Windows analogue of the Keychain + ~/.claude.json swap, via Credential Manager). */
    const ps = script.replace(/\.sh$/i, '.ps1');
    if (!fs.existsSync(ps)) return Promise.resolve({ ok: false, message: 'account switch is not supported on Windows yet' });
    return new Promise((res) => {
      execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps, 'switch', email], { timeout: 20000 }, (err, _out, stderr) => {
        if (err) return res({ ok: false, message: String(stderr || err.message).slice(0, 160) });
        res({ ok: true, message: email });
      });
    });
  }
  return new Promise((res) => {
    execFile('bash', [script, 'switch', email], { timeout: 20000 }, (err, _out, stderr) => {
      if (err) return res({ ok: false, message: String(stderr || err.message).slice(0, 160) });
      res({ ok: true, message: email });
    });
  });
}

/** Per-session note counts — the Running card shows a persistent badge (Glass parity). */
export function sessionNoteCounts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const name of Object.keys(notesMap())) { const n = sessionNotes(name).length; if (n) out[name] = n; }
  return out;
}
export function addSessionNote(name: string, note: string): SessionNote[] {
  const text = (note || '').trim();
  if (!name || !text) return sessionNotes(name);
  const map = notesMap();
  const arr = Array.isArray(map[name]) ? (map[name] as unknown[]).slice() : [];
  arr.push({ t: text, ts: Date.now() });
  map[name] = arr;
  setGlassState('sessionNotes', map);
  return sessionNotes(name);
}
export function deleteSessionNote(name: string, index: number): SessionNote[] {
  const map = notesMap();
  const arr = Array.isArray(map[name]) ? (map[name] as unknown[]).slice() : [];
  if (Number.isInteger(index) && index >= 0 && index < arr.length) {
    arr.splice(index, 1);
    if (arr.length) map[name] = arr; else delete map[name];
    setGlassState('sessionNotes', map);
  }
  return sessionNotes(name);
}

// ── explorer sort prefs (AI-58 v2 — shared shape with Glass via src/core/sort) ──

/** The persisted per-folder sort map (`.glass/state.json` → `filesFolderSort`). */
export function folderSorts(): FolderSortMap {
  const raw = glassState()[FOLDER_SORT_KEY];
  return raw && typeof raw === 'object' ? (raw as FolderSortMap) : {};
}

/** The global default sort — folders without a per-folder override follow it. */
export function masterSort(): SortMode {
  return normalizeSortMode(glassState()[MASTER_SORT_KEY]);
}

/** Per-folder override at ANY depth (closest-ancestor wins in the renderer). */
export function setFolderSortPref(folder: string, mode: unknown): { master: SortMode; overrides: FolderSortMap } {
  setGlassState(FOLDER_SORT_KEY, setFolderSort(folderSorts(), folder, normalizeSortMode(mode)));
  return { master: masterSort(), overrides: folderSorts() };
}

/** The master default: set it AND clear every per-folder override — "make them
 *  all sort this way" (Glass setMaster contract). */
export function setMasterSortPref(mode: unknown): { master: SortMode; overrides: FolderSortMap } {
  setGlassState(MASTER_SORT_KEY, normalizeSortMode(mode));
  setGlassState(FOLDER_SORT_KEY, {});
  return { master: masterSort(), overrides: folderSorts() };
}

// ── frequent tasks count (.glass/state.json + defaults) ────────────────────

const DEFAULT_TASK_IDS = ['email', 'post', 'deck', 'research', 'meeting', 'clarity', 'ingest', 'infographic', 'bio-event', 'infographic-me', 'infographic-become', 'who-for-audience', 'elevator-pitch', 'whats-changed', 'podcast-intro', 'values'];

export function frequentTaskCount(): number {
  const r = frameworkRoot();
  let saved: { id: string }[] | undefined;
  let removed: string[] = [];
  if (r) {
    try {
      const st = JSON.parse(fs.readFileSync(path.join(r, '.glass', 'state.json'), 'utf8'));
      saved = st['aios.frequentTasks.v1'];
      removed = st['aios.frequentTasks.removed.v1'] || [];
    } catch { /* no state yet */ }
  }
  const rm = new Set(removed);
  if (!saved) return DEFAULT_TASK_IDS.filter((id) => !rm.has(id)).length;
  const have = new Set(saved.map((t) => t.id));
  return saved.length + DEFAULT_TASK_IDS.filter((id) => !have.has(id) && !rm.has(id)).length;
}

// ── companies / collab / framework status ───────────────────────────────────

export interface Company { name: string; substrate: string; source: string; lastSync: string; }

export function readCompanies(): Company[] {
  const root = frameworkRoot();
  if (!root) return [];
  let text = '';
  try { text = fs.readFileSync(path.join(root, 'USER.md'), 'utf8'); } catch { return []; }
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+Companies \(mounted\)/.test(l));
  if (start < 0) return [];
  const out: Company[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s/.test(line)) break;
    if (!line.trim().startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map((s) => s.trim().replace(/^`|`$/g, '').trim());
    if (cells.length < 5) continue;
    const [company, substrate, source, , lastSync] = cells;
    if (!company || company.toLowerCase() === 'company' || /^-+$/.test(company)) continue;
    out.push({ name: company, substrate, source, lastSync });
  }
  return out;
}

export interface CollabSpace { name: string; filePath: string; }

export function readCollabSpaces(): CollabSpace[] {
  const v = vaultRoot();
  if (!v) return [];
  const dir = path.join(v, '00 - notes', 'projects');
  let entries: string[] = [];
  try { entries = fs.readdirSync(dir); } catch { return []; }
  return entries
    .filter((f) => f.startsWith('space-') && f.endsWith('.md'))
    .map((f) => ({ name: f.replace(/^space-/, '').replace(/\.md$/, ''), filePath: path.join(dir, f) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export interface FrameworkStatus { repo: string; hash: string; synced: string; }

export function readFrameworkStatus(): FrameworkStatus | undefined {
  const root = frameworkRoot();
  if (!root) return undefined;
  let text = '';
  try { text = fs.readFileSync(path.join(root, '.aios-update'), 'utf8'); } catch { return undefined; }
  const kv: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([a-z]+)=(.*)$/i);
    if (m) kv[m[1]] = m[2].trim();
  }
  return { repo: kv.repo ?? '', hash: kv.hash ?? '', synced: kv.synced ?? '' };
}

export function checkForUpdates(): Promise<'up-to-date' | 'available' | 'unknown'> {
  const status = readFrameworkStatus();
  if (!status || !status.repo || !status.hash) return Promise.resolve('unknown');
  /* The hash must LOOK like a commit before it is compared. A freshly written tracker can carry
     a placeholder (`hash=initial`) until the first real sync fills it in, and
     `remote.startsWith('initial')` is false — which reported "update available" on a vault that
     had just synced, then silently corrected itself when the real sha landed. Observed exactly
     that. An unusable hash means "cannot tell", not "you are behind": a false alarm that
     resolves on its own teaches the operator to ignore the pill. */
  if (!/^[0-9a-f]{7,40}$/i.test(status.hash)) return Promise.resolve('unknown');
  return new Promise((resolve) => {
    // SSH remotes need an agent the GUI process may not have — public repo, use https
    const url = status.repo.replace(/^git@github\.com:/, 'https://github.com/');
    execFile('git', ['ls-remote', url, 'HEAD'], { timeout: 8000 }, (err, stdout) => {
      if (err || !stdout) return resolve('unknown');
      const remote = stdout.trim().split(/\s+/)[0];
      if (!remote) return resolve('unknown');
      resolve(remote.startsWith(status.hash) ? 'up-to-date' : 'available');
    });
  });
}

// ── calendar grid (ported verbatim semantics) ───────────────────────────────

export interface DayCell { date: string | null; day: number | null; hasNote: boolean; isToday: boolean; }
/** `weekNums` — ISO 8601 week number per week row (parallel to `weeks`). */
export interface MonthData { year: number; month: number; label: string; weekdays: string[]; weeks: DayCell[][]; weekNums: number[]; }

export function getMonthData(year: number, month: number): MonthData {
  const v = vaultRoot();
  const notes = new Set<string>();
  if (v) {
    try {
      const dir = path.join(v, '01 - calendar', `${year}-${String(month).padStart(2, '0')}`);
      for (const f of fs.readdirSync(dir)) {
        const m = f.match(/^(\d{4}-\d{2}-\d{2})\.md$/);
        if (m) notes.add(m[1]);
      }
    } catch { /* month dir may not exist */ }
  }
  const today = todayLocalIso();
  const daysInMonth = new Date(year, month, 0).getDate();
  const lead = (new Date(year, month - 1, 1).getDay() + 6) % 7;
  const cells: DayCell[] = [];
  for (let i = 0; i < lead; i++) cells.push({ date: null, day: null, hasNote: false, isToday: false });
  for (let d = 1; d <= daysInMonth; d++) {
    const iso = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    cells.push({ date: iso, day: d, hasNote: notes.has(iso), isToday: iso === today });
  }
  while (cells.length % 7 !== 0) cells.push({ date: null, day: null, hasNote: false, isToday: false });
  const weeks: DayCell[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  // ISO week number per row — reuse the same isoWeek the weekly-plan nudge uses
  const weekNums = weeks.map((w) => {
    const c = w.find((x) => x.date);
    if (!c || !c.date) return 0;
    const [y2, m2, d2] = c.date.split('-').map(Number);
    return isoWeek(new Date(y2, m2 - 1, d2)).week;
  });
  const weekdays = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => t('weekday.' + d));
  return { year, month, label: `${t('month.' + month)} ${year}`, weekdays, weeks, weekNums };
}

export function dailyNotePath(iso: string): string | undefined {
  const v = vaultRoot();
  if (!v) return undefined;
  return path.join(v, '01 - calendar', iso.slice(0, 7), `${iso}.md`);
}

// ── shell settings (.glass/shell.json — synced beside state.json) ───────────

export interface ShellSettings { claudeCmd: string; showHints: boolean; showNudges: boolean; showMemory: boolean; theme: string; termFontSize: number; appFontSize: number; hiddenCards: string[]; showHidden: boolean; fileIcons: boolean; autoReveal: boolean; showWeekNumbers: boolean; killBehavior: 'ask' | 'kill' | 'capture'; terminalMode: 'auto' | 'ask'; openNotesIn: 'rendered' | 'source'; ignorePaths: string[]; locale: LocalePref; }

/** Operator-defined names/globs the explorer hides AND git status ignores
 *  (no pending-commit bubble) — the desktop analog of VS Code's `files.exclude`
 *  that aios-glass reads. Seeded with the common scratch-folder convention. */
const DEFAULT_IGNORE_PATHS = ['_archive', '_workspaces'];

export function shellSettings(): ShellSettings {
  const r = frameworkRoot();
  let raw: Partial<ShellSettings> = {};
  if (r) {
    try { raw = JSON.parse(fs.readFileSync(path.join(r, '.glass', 'shell.json'), 'utf8')); } catch { /* defaults */ }
  }
  return {
    claudeCmd: typeof raw.claudeCmd === 'string' && raw.claudeCmd.trim() ? raw.claudeCmd.trim() : 'claude',
    showHints: raw.showHints !== false,
    showNudges: raw.showNudges !== false,
    showMemory: raw.showMemory !== false,     // default on (Sessions card shows process-tree RAM)
    theme: raw.theme === 'light' ? 'light' : 'dark',
    termFontSize: Number(raw.termFontSize) || 12.5,
    // interface scale, in the same "font size" language as the terminal's — 13 is 100%.
    // Applied as a real zoom factor (crisp text) rather than restyling every rule.
    appFontSize: Math.min(18, Math.max(10, Number(raw.appFontSize) || 13)),
    // pulse cards the operator switched off (ids: pDaily, pCal, …) — hidden, not deleted
    hiddenCards: Array.isArray(raw.hiddenCards) ? raw.hiddenCards.filter((x): x is string => typeof x === 'string') : [],
    showHidden: raw.showHidden === true,      // default off
    fileIcons: raw.fileIcons !== false,       // default on (enhanced)
    autoReveal: raw.autoReveal !== false,     // default on
    showWeekNumbers: raw.showWeekNumbers !== false, // default on (Glass parity)
    ignorePaths: Array.isArray(raw.ignorePaths)
      ? raw.ignorePaths.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim())
      : DEFAULT_IGNORE_PATHS,                 // absent → seed defaults; [] → operator cleared it
    locale: normalizeLocalePref(raw.locale),  // 'auto' (default) | 'en' | 'es' | 'pt-br'
    killBehavior: raw.killBehavior === 'kill' || raw.killBehavior === 'capture' ? raw.killBehavior : 'ask', // Glass parity; default confirm
    terminalMode: raw.terminalMode === 'auto' ? 'auto' : 'ask', // #6: ask where to run (only when live sessions exist); auto = primary/new
    openNotesIn: raw.openNotesIn === 'source' ? 'source' : 'rendered', // Glass "Open files in": rendered preview (default) or raw source
  };
}

// ── ignore matching (explorer hide + git-status skip; Glass files.exclude parity) ──

/** Compile ignore patterns (basename globs: `_archive`, `*.tmp`, `**​/x`) to matchers. */
function ignoreMatchers(patterns: string[]): RegExp[] {
  const res: RegExp[] = [];
  for (const raw of patterns) {
    let g = raw.trim().replace(/^(\*\*\/)+/, '').replace(/\/+$/, '');
    if (g.includes('/')) g = g.split('/').pop() || g; // approximate path globs by basename
    if (!g) continue;
    const src = '^' + [...g].map((c) => (c === '*' ? '[^/]*' : c === '?' ? '.' : '.+^${}()|[]\\'.includes(c) ? '\\' + c : c)).join('') + '$';
    try { res.push(new RegExp(src)); } catch { /* skip an unparseable glob */ }
  }
  return res;
}

/** True if an entry name matches any operator ignore pattern (explorer hide). */
export function isIgnoredName(name: string): boolean {
  return ignoreMatchers(shellSettings().ignorePaths).some((re) => re.test(name));
}

// The OS display language, captured once at boot from Electron's `app.getLocale()`
// (only the main process can read it). `auto` resolves against this.
let _systemLocale: Locale = 'en';

/** Record the OS display language. Call once at activation, before applyLocale(). */
export function setSystemLocale(tag: string | undefined): Locale {
  _systemLocale = normalizeLocale(tag);
  return _systemLocale;
}

/** The concrete locale the UI should render in — resolves `auto` to the OS language. */
export function resolvedLocale(): Locale {
  const pref = shellSettings().locale;
  return pref === 'auto' ? _systemLocale : pref;
}

/** Load the resolved UI locale into the i18n module. Call on boot + on change. */
export function applyLocale(): Locale {
  return setLocale(resolvedLocale());
}

export function setShellSetting(key: string, value: unknown): void {
  const r = frameworkRoot();
  if (!r) return;
  const p = path.join(r, '.glass', 'shell.json');
  let cur: Record<string, unknown> = {};
  try { cur = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { /* fresh */ }
  cur[key] = value;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cur, null, 2) + '\n');
  fs.renameSync(tmp, p);
}

// ── the doctor: repairable environment checks (setup wizard + Health card) ──
//
// Every check answers "is this wired?" with pass / warn / fail, and — when it
// knows how — carries a repair. The loop is honest by construction: run the
// check → run the fix → RE-RUN THE SAME CHECK to prove it (repairCheck below).
// Two repair grades:
//   • canRepair: true  → the doctor runs a headless, idempotent script itself
//                        (repairCheck), then re-runs the check as proof.
//   • repairCmd        → the fix needs the operator (login, tokens, interview);
//                        the renderer opens it in a VISIBLE terminal, then
//                        re-checks when that terminal exits. Never silent.
// `fail` = the AIOS can't run at all (CLI, framework, account). `warn` =
// degraded (skills, spawn wrapper, MCP, identity, gh) — amber, not red.

export interface CheckResult {
  id: string;
  label: string;
  status: 'pass' | 'warn' | 'fail';
  /** One-line current state (version found, account email, count, …). */
  message: string;
  /** What the fix will run — shown as a tooltip so the operator sees everything. */
  repairHint?: string;
  /** Overrides the fix button label when the remedy is not what the button usually says. */
  repairLabel?: string;
  /** Operator-in-the-loop fix: a command the renderer opens in a visible terminal. */
  repairCmd?: string;
  /** True → repairCheck(id) can run the headless repair + prove it. */
  canRepair: boolean;
}

interface DoctorCheck {
  id: string;
  severity: 'fail' | 'warn';
  run(): Promise<CheckResult>;
  /** Headless, idempotent repair (only when canRepair is true in run()'s result). */
  repair?: () => Promise<void>;
}

/** Run a snippet through a login zsh (PATH as the operator's shell sees it). */
/**
 * Single-quote a path for a shell command.
 *
 * Found by auditing for siblings of the app.asar bug — the same family: a string that looks
 * correct until a real shell touches it. `bash ${script}` is fine for every path on the machine
 * that wrote it and breaks the moment a framework lives at "/Users/Jane Doe/aios" or under a
 * Drive mount, which is exactly the newcomer we are building for. Single quotes, not
 * JSON.stringify: double quotes still expand `$`, so a path containing one would be rewritten by
 * the shell rather than read.
 */
function shq(p: string): string {
  return `'${String(p).replace(/'/g, `'\\''`)}'`;
}

/**
 * The same job for PowerShell, which is NOT the same idiom — and reaching for shq here produces
 * a string that looks quoted and is not.
 *
 * PowerShell's escape character is the BACKTICK, not the backslash, so shq's POSIX `'\''` dance
 * emits a literal backslash and leaves the quote unbalanced: an operator named O'Brien, with a
 * framework under C:\Users\O'Brien\aios, gets an invocation that cannot parse. In PowerShell a
 * single quote is escaped by DOUBLING it, and inside single quotes nothing else expands at all —
 * which is the second thing this has to guarantee. Double quotes would leave `$` live, and these
 * strings include LOCALIZED text: a translation containing a `$` would be silently rewritten as
 * a variable (usually to empty) before the operator ever saw it.
 *
 * Single-quoted and doubled is the only form that is inert in both dimensions.
 */
function psq(s: string): string {
  return `'${String(s).replace(/'/g, "''")}'`;
}

function zshOnce(snippet: string, flags: string): Promise<string | null> {
  return new Promise((res) => {
    execFile('/bin/zsh', [flags, snippet], { timeout: 8000 }, (err, out) => res(err ? null : String(out).trim()));
  });
}
/**
 * Run a probe the way the OPERATOR'S TERMINAL would resolve it — which means both a login shell
 * and an interactive one, because zsh reads ~/.zshrc only when interactive.
 *
 * This is the same trap that made the Claude check contradict the terminal beside it, and it bit
 * a second time before being generalised: `gh` was installed at /opt/homebrew/bin/gh and worked
 * perfectly in a terminal, but /opt/homebrew/bin reaches PATH through a profile line, so a
 * non-interactive probe could not see it. The doctor concluded gh was missing and offered
 * `brew install gh` — on a shared Mac where Homebrew belongs to another account and the install
 * cannot succeed. A newcomer was handed an impossible instruction for a tool they already had.
 *
 * BOTH outputs are returned, joined, so a caller can rank answers rather than trust whichever
 * shell happened to run first.
 */
async function zshOut(snippet: string, flags = '-lc'): Promise<string | null> {
  const a = await zshOnce(snippet, flags);
  const b = flags.includes('i') ? null : await zshOnce(snippet, flags.replace('-l', '-il'));
  const joined = [a, b].filter(Boolean).join('\n');
  return joined || null;
}

// ── the Windows probe lane ──────────────────────────────────────────────────
//
// Every probe above speaks POSIX to a zsh that does not exist on Windows. The
// mirror is PowerShell: `psOnce` is zshOnce's counterpart (no profile — a fast,
// predictable probe), `psProfileOnce` is the interactive-zsh counterpart for the
// one thing that genuinely lives in the operator's profile (the spawn wrapper).

/** Run a snippet through PowerShell — the Windows counterpart of zshOnce. */
function psOnce(snippet: string): Promise<string | null> {
  return new Promise((res) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', snippet], { timeout: 8000 },
      (err, out) => res(err ? null : String(out).trim() || null));
  });
}

/**
 * Same, but WITH the operator's PowerShell profile loaded — the Windows analogue of needing an
 * interactive zsh on POSIX, and for the same reason: the `spawn` wrapper is a function defined
 * in `$PROFILE`, so a profile-less probe cannot see a wrapper that is genuinely installed.
 * ExecutionPolicy is bypassed for the probe only: an unsigned profile is the normal case, and a
 * blocked profile would otherwise read as "wrapper missing".
 */
function psProfileOnce(snippet: string): Promise<string | null> {
  return new Promise((res) => {
    execFile('powershell.exe', ['-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', snippet], { timeout: 8000 },
      (err, out) => res(err ? null : String(out).trim() || null));
  });
}

/** Where a PowerShell profile can live — both hosts, and a OneDrive-redirected Documents. */
function psProfileFiles(): string[] {
  const home = os.homedir();
  const out: string[] = [];
  for (const docs of [process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'Documents') : path.join(home, 'Documents'), path.join(home, 'OneDrive', 'Documents')]) {
    for (const host of ['WindowsPowerShell', 'PowerShell']) {
      out.push(path.join(docs, host, 'Microsoft.PowerShell_profile.ps1'));
      out.push(path.join(docs, host, 'profile.ps1'));
    }
  }
  return out;
}

/**
 * "Is this command runnable, and what is its version?" — resolved the way the OPERATOR'S OWN
 * shell would. POSIX keeps the login+interactive zsh probe verbatim; Windows asks PowerShell,
 * falling back to the resolved location when the tool prints no version (a tool that answers
 * nothing is still installed, and reporting it missing sends someone to reinstall what they have).
 */
async function cmdCheck(cmd: string): Promise<string | null> {
  if (process.platform === 'win32') {
    return psOnce(`$c = Get-Command ${cmd} -ErrorAction SilentlyContinue; `
      + `if ($c) { $v = ''; try { $v = (& ${cmd} --version 2>$null | Select-Object -First 1) } catch { }; if (-not $v) { $v = $c.Source }; $v }`);
  }
  return zshOut(`command -v ${cmd} && ${cmd} --version 2>/dev/null | head -1`);
}

/** How a PowerShell repair script is invoked, verbatim — shown to the operator, and run as-is.
 *  psq, not shq: this string is handed to PowerShell, where the POSIX quote idiom is malformed. */
const psRunHint = (script: string): string => `powershell -NoProfile -ExecutionPolicy Bypass -File ${psq(script)}`;

/** Run a repair script headless (bash, generous timeout, output discarded). */
function runScript(script: string, cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    /* Windows has no bash, so a `.ps1` goes through PowerShell with the policy bypassed — the
       framework's own installers are unsigned, and the default policy would refuse them. `.sh`
       keeps the POSIX path exactly; on win32 a `.sh` never reaches here (see repairScript). */
    const isPs = process.platform === 'win32' && /\.ps1$/i.test(script);
    const bin = isPs ? 'powershell.exe' : 'bash';
    const args = isPs ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script] : [script];
    execFile(bin, args, { timeout: 120000, cwd }, (err) => (err ? reject(err) : resolve()));
  });
}

/**
 * AI-111 — on Windows, "not found" and "installed, but I cannot see it yet" are the same string.
 *
 * Measured 2026-08-15 on a clean Windows machine: the wizard installed Claude Code correctly and
 * the very next check reported it missing. The App captured its environment when it launched, so a
 * tool installed afterwards is invisible to it until the process restarts. git survived because
 * its installer writes the SYSTEM PATH; Claude lands in npm's user prefix, the newest and least
 * propagated entry.
 *
 * NOT OUR DEFECT, and that shaped the fix: the Claude desktop app required the same
 * open-close-open on the same machine, so this is how Windows propagates environment changes to
 * running processes. Re-reading PATH at check time would make us behave differently from the
 * Claude app sitting beside us and would still leave every already-spawned terminal stale. So the
 * honest fix is to say so — this arrives right after a SmartScreen warning and two elevation
 * prompts, at the moment the operator expects success, and "it failed" is the wrong reading.
 *
 * Appended unconditionally on win32 rather than gated on "did we just install it": the sentence is
 * true either way, and tracking install state would add machinery to earn a marginally quieter
 * message on the one platform where the confusion is guaranteed.
 */
function winRestartNote(): string {
  return process.platform === 'win32' ? ' ' + t('setupCheck.winRestartHint') : '';
}

function whichCheck(id: string, cmd: string, severity: 'fail' | 'warn', missingKey: string, repairCmd?: string): DoctorCheck {
  return {
    id, severity,
    run: async (): Promise<CheckResult> => {
      const d = await cmdCheck(cmd);
      return d
        ? { id, label: t('setupCheck.' + id), status: 'pass', message: d.split('\n').pop() || '', canRepair: false }
        : { id, label: t('setupCheck.' + id), status: severity, message: t(missingKey) + winRestartNote(), repairCmd, repairHint: repairCmd, canRepair: false };
    },
  };
}

/**
 * The gh check, Windows lane — same four verdicts as the POSIX one (authed / stored-token /
 * installed-but-not-authed / absent), reached with tools that exist here.
 *
 * It inherits the POSIX rule that a probe must NEVER be able to interrupt the operator: this
 * runs on a 5-second poll while Setup is open, so no `git credential fill` (Git Credential
 * Manager can raise a browser/consent window). `cmdkey /list:` reads Credential Manager without
 * prompting, and ~/.git-credentials covers the plain `store` helper — the two places a PAT can
 * actually be on Windows.
 * TODO(windows): 'ghWinNotInstalled' / 'ghWinNoWinget' have no i18n key yet (locales are outside
 * this change's scope), and a missing key renders as the key itself.
 */
async function ghCheckWin(): Promise<CheckResult> {
  const probe = 'if (Get-Command gh -ErrorAction SilentlyContinue) { '
    + 'gh auth status *> $null; if ($?) { "AUTHED" } '
    + 'elseif ((cmdkey /list:git:https://github.com 2>$null | Out-String) -match "github") { "PATOK" } '
    + 'elseif ((Test-Path "$HOME\\.git-credentials") -and (Select-String -Quiet -Path "$HOME\\.git-credentials" -Pattern "github.com")) { "PATOK" } '
    + 'else { "NOAUTH" } } '
    + 'elseif ((cmdkey /list:git:https://github.com 2>$null | Out-String) -match "github") { "PATOK" } '
    + 'else { "NOGH" }';
  const out = await psOnce(probe);
  const loginCmd = 'gh auth login --web --git-protocol https';
  if (out?.includes('AUTHED')) return { id: 'gh', label: t('setupCheck.gh'), status: 'pass', message: t('setupCheck.ghOk'), canRepair: false };
  if (out?.includes('PATOK')) return { id: 'gh', label: t('setupCheck.gh'), status: 'pass', message: t('setupCheck.ghPat'), canRepair: false };
  if (out?.includes('NOAUTH')) return { id: 'gh', label: t('setupCheck.gh'), status: 'warn', message: t('setupCheck.ghNoAuth'), repairCmd: loginCmd, repairHint: loginCmd, canRepair: false };
  /* gh genuinely absent. winget is Windows' own package manager and needs no admin rights for
     a user-scope install — the counterpart of the POSIX branch's rule that a command we offer
     must actually be able to succeed. Without winget there IS no command this app can honestly
     run, so it names the download page instead of printing something that will fail. */
  const hasWinget = !!(await psOnce('if (Get-Command winget -ErrorAction SilentlyContinue) { "YES" }'))?.includes('YES');
  if (hasWinget) {
    const install = `winget install --id GitHub.cli -e --source winget; ${loginCmd}`;
    return { id: 'gh', label: t('setupCheck.gh'), status: 'warn', message: 'not installed — winget install GitHub.cli' + winRestartNote(), repairCmd: install, repairHint: install, canRepair: false };
  }
  return {
    id: 'gh', label: t('setupCheck.gh'), status: 'warn',
    message: "GitHub CLI isn't installed, and this machine has no winget to install it with — get it from cli.github.com.",
    repairHint: 'https://cli.github.com/', canRepair: false,
  };
}

function doctorChecks(): DoctorCheck[] {
  const claudeCmd = shellSettings().claudeCmd;
  const root = frameworkRoot();
  const scriptIf = (rel: string): string | undefined => {
    if (!root) return undefined;
    const p = path.join(root, rel);
    return fs.existsSync(p) ? p : undefined;
  };
  /* A headless repair on Windows may ONLY be offered when the framework ships a PowerShell
     sibling next to the `.sh` (install-wrappers.ps1 beside install-wrappers.sh). Running the
     `.sh` through bash instead is the failure mode this guards: it errors in a way that reads
     like the repair ran, and the row goes on being amber with no explanation. No sibling → no
     repair button, and the message says why. */
  const repairScript = (rel: string): string | undefined =>
    (process.platform === 'win32' ? scriptIf(rel.replace(/\.sh$/i, '.ps1')) : scriptIf(rel));
  /* TODO(windows): these strings have no i18n key yet (src/i18n/locales/*.json is outside this
     change's scope), and t() renders a missing key as the key itself — which is worse than
     English on a Spanish machine. */
  const winNoRepair = (rel: string): string => `not set up — Windows support for this repair needs ${rel} in the framework (not shipped yet)`;
  return [
    // ── the plumbing (fail = nothing runs) ──
    // git's repair is the native Xcode CLT dialog (macOS); Claude Code's is the
    // NATIVE installer — it needs neither node nor npm, which is why node is
    // demoted to warn-only (nothing in the base flow requires it anymore).
    /* Windows gets a repairCmd of its own because the RENDERER falls back to
       `xcode-select --install` when this is undefined (setup's Advanced lane) — a macOS command
       offered on Windows is exactly the impossible instruction the gh check learned not to give. */
    whichCheck('git', 'git', 'fail', 'setupCheck.gitMissing',
      process.platform === 'darwin' ? 'xcode-select --install'
        : process.platform === 'win32' ? 'winget install --id Git.Git -e --source winget' : undefined),
    whichCheck('node', 'node', 'warn', 'setupCheck.nodeMissing'),
    /* Three states, not two. Observed on a real newcomer machine: the official installer
       SUCCEEDS, puts the binary at ~/.local/bin/claude, and then asks the operator to add
       ~/.local/bin to PATH themselves. Reporting that as "missing" sent someone who had just
       installed Claude back to install it again, and the only way forward was pasting a shell
       line — which is exactly the knowledge this app exists to not require. */
    {
      id: 'claude', severity: 'fail',
      run: async (): Promise<CheckResult> => {
        const loc = claudeLocation();
        if (loc.where === 'path') {
          const v = process.platform === 'win32'
            ? await cmdCheck(claudeCmd)
            : await zshOut(`${claudeCmd} --version 2>/dev/null | head -1`);
          return { id: 'claude', label: t('setupCheck.claude'), status: 'pass', message: v || loc.bin, canRepair: false };
        }
        if (loc.where === 'disk') {
          const cmd = pathFixSnippet();
          return {
            id: 'claude', label: t('setupCheck.claude'), status: 'fail',
            /* Name the ACTUAL obstacle when we know it. "Not on your PATH" is true but useless
               when the reason is that the operator's own .zshrc aborts partway: they will keep
               pressing a PATH-fix button that appends a line the file never reaches. Naming the
               file and line turns an unfixable-looking loop into a one-line edit. */
            message: loc.rcBroken
              ? t('setupCheck.claudeRcBroken', { rc: loc.rcBroken })
              : t('setupCheck.claudeOffPath', { bin: loc.bin.replace(os.homedir(), '~') }),
            repairCmd: cmd, repairHint: t('setupCheck.claudeOffPathHint'),
            // the usual button says "Install Claude Code", which is wrong for someone who
            // just did exactly that — the button must name what it will actually do
            repairLabel: t('setup.addClaudeToPath'), canRepair: false,
          };
        }
        /* Install AND put it on PATH in one action. The official installer deliberately does
           not touch PATH, so leaving them as two steps meant the operator finished the step
           the app asked for and was told Claude was still missing.
           Windows gets Anthropic's own documented PowerShell one-liner rather than
           `npm install -g @anthropic-ai/claude-code`, for the same reason the POSIX branch
           prefers the native installer: it needs neither node nor npm — which is precisely why
           the node check is only a warning — and the setup pane it runs in IS a PowerShell. */
        return {
          id: 'claude', label: t('setupCheck.claude'), status: 'fail',
          message: t('setupCheck.claudeMissing') + winRestartNote(),
          repairCmd: process.platform === 'win32'
            ? `irm https://claude.ai/install.ps1 | iex\n${pathFixSnippet()}`
            : `curl -fsSL https://claude.ai/install.sh | bash\n${pathFixSnippet()}`,
          repairHint: t('setupCheck.claudeInstallHint'), canRepair: false,
        };
      },
    },
    {
      id: 'framework', severity: 'fail',
      run: async (): Promise<CheckResult> => {
        const ok = !!root && fs.existsSync(path.join(root, 'CLAUDE.md'));
        return ok
          ? { id: 'framework', label: t('setupCheck.framework'), status: 'pass', message: root as string, canRepair: false }
          : { id: 'framework', label: t('setupCheck.framework'), status: 'fail', message: t('setupCheck.frameworkMissing'), canRepair: false };
      },
    },
    {
      id: 'vault', severity: 'fail',
      run: async (): Promise<CheckResult> => {
        const v = vaultRoot();
        const ok = !!v && fs.existsSync(path.join(v, '00 - notes'));
        return ok
          ? { id: 'vault', label: t('setupCheck.vault'), status: 'pass', message: v as string, canRepair: false }
          : { id: 'vault', label: t('setupCheck.vault'), status: 'fail', message: t('setupCheck.vaultMissing'), canRepair: false };
      },
    },
    {
      // THE auth check, fixed: ~/.claude existing is NOT "signed in" (the old
      // false positive — the dir appears on first launch, before any login).
      // The real signal is the OAuth account Claude Code itself recorded.
      id: 'account', severity: 'fail',
      run: async (): Promise<CheckResult> => {
        const acct = claudeConfig().account;
        const onboarded = (readJson(claudeJsonPath()) as { hasCompletedOnboarding?: boolean })?.hasCompletedOnboarding === true;
        if (!acct) {
          /* PLAIN `claude` for a first run, `/login` only to switch accounts.
             `claude /login` on a machine that has never been set up asks for the login TWICE:
             the slash command runs the browser round trip, and then Claude's own first-run
             sequence starts — which opens with its login screen again. The operator authorises,
             sees the same question immediately, and reasonably wonders whether it worked.
             A bare `claude` does login and onboarding once, in one pass. `/login` is correct only
             where onboarding is already done and the operator is genuinely changing accounts. */
          const cmd = onboarded ? `${claudeCmd} /login` : claudeCmd;
          return { id: 'account', label: t('setupCheck.account'), status: 'fail', message: t('setupCheck.accountMissing'), repairCmd: cmd, repairHint: cmd, canRepair: false };
        }
        /* SIGNED IN IS NOT THE SAME AS FINISHED. Claude Code's first run has more to it than the
           browser round trip — theme, tips, the rest — and it records completion separately in
           `hasCompletedOnboarding`. An operator who authorises in the browser and closes the
           terminal has an account on file and an unfinished first run, so the NEXT session opens
           on the onboarding screen again. That is precisely what happened: login, GitHub, then
           the setup session asking to log in a second time, which reads as the app forgetting
           what it just did. The step stays open until the first run is genuinely complete. */
        if (!onboarded) {
          return {
            id: 'account', label: t('setupCheck.account'), status: 'fail',
            message: t('setupCheck.accountUnfinished', { acct }),
            repairCmd: claudeCmd, repairHint: claudeCmd, canRepair: false,
          };
        }
        return { id: 'account', label: t('setupCheck.account'), status: 'pass', message: acct, canRepair: false };
      },
    },
    // ── the wiring (warn = degraded, each row knows its fix) ──
    {
      id: 'skills', severity: 'warn',
      run: async (): Promise<CheckResult> => {
        let n = 0;
        try { n = fs.readdirSync(path.join(claudeDir(), 'skills')).filter((f) => !f.startsWith('.')).length; } catch { n = 0; }
        if (n > 0) return { id: 'skills', label: t('setupCheck.skills'), status: 'pass', message: t('setupCheck.skillsOk', { n }), canRepair: false };
        const script = repairScript(path.join('skills', 'setup.sh'));
        return {
          id: 'skills', label: t('setupCheck.skills'), status: 'warn',
          message: !script && process.platform === 'win32' ? winNoRepair('skills/setup.ps1') : t('setupCheck.skillsMissing'),
          repairHint: script && (/\.ps1$/i.test(script) ? psRunHint(script) : `bash ${shq(script)}`),
          canRepair: !!script,
        };
      },
      repair: async () => {
        const script = repairScript(path.join('skills', 'setup.sh'));
        if (script) await runScript(script, root);
      },
    },
    {
      id: 'plugin', severity: 'warn',
      run: async (): Promise<CheckResult> => {
        const p = installedPlugins().find((x) => x.name === 'aios');
        if (p) return { id: 'plugin', label: t('setupCheck.plugin'), status: 'pass', message: t('setupCheck.pluginOk', { v: p.version !== 'unknown' ? 'v' + p.version : '@' + p.marketplace }), canRepair: false };
        // the marketplace source is the local framework checkout (directory
        // source) — the vault the operator just cloned IS the marketplace
        const src = root ?? path.join(os.homedir(), 'aios');
        const cmd = `${claudeCmd} plugin marketplace add '${src.replace(/'/g, `'\\''`)}' && ${claudeCmd} plugin install aios@the-aios`;
        return { id: 'plugin', label: t('setupCheck.plugin'), status: 'warn', message: t('setupCheck.pluginMissing'), repairCmd: cmd, repairHint: cmd, canRepair: false };
      },
    },
    {
      id: 'spawn', severity: 'warn',
      run: async (): Promise<CheckResult> => {
        // `type spawn` needs an INTERACTIVE zsh (the wrapper lives in ~/.zshrc);
        // fall back to reading the rc file when -ic is blocked (no tty).
        /* On Windows the same wrapper is a PowerShell FUNCTION in the operator's $PROFILE, so
           the probe has to load that profile (psProfileOnce) and the fallback reads the profile
           files instead of ~/.zshrc — same two-step shape, different shell. */
        let ok = process.platform === 'win32'
          ? !!(await psProfileOnce('if (Get-Command spawn -ErrorAction SilentlyContinue) { "HAVESPAWN" }'))?.includes('HAVESPAWN')
          : !!(await zshOut('type spawn >/dev/null 2>&1 && echo HAVESPAWN', '-ic'))?.includes('HAVESPAWN');
        if (!ok && process.platform === 'win32') {
          ok = psProfileFiles().some((f) => {
            try { return /(^|\n)\s*function\s+spawn\b/i.test(fs.readFileSync(f, 'utf8')); } catch { return false; }
          });
        } else if (!ok) {
          try { ok = /(^|\n)\s*(function\s+spawn\b|spawn\s*\(\))/.test(fs.readFileSync(path.join(os.homedir(), '.zshrc'), 'utf8')); } catch { /* absent */ }
        }
        if (ok) return { id: 'spawn', label: t('setupCheck.spawn'), status: 'pass', message: t('setupCheck.spawnOk'), canRepair: false };
        const script = repairScript(path.join('hooks', 'claude-identity', 'install-wrappers.sh'));
        return {
          id: 'spawn', label: t('setupCheck.spawn'), status: 'warn',
          message: !script && process.platform === 'win32' ? winNoRepair('hooks/claude-identity/install-wrappers.ps1') : t('setupCheck.spawnMissing'),
          repairHint: script && (/\.ps1$/i.test(script) ? psRunHint(script) : `bash ${shq(script)}`),
          canRepair: !!script,
        };
      },
      repair: async () => {
        const script = repairScript(path.join('hooks', 'claude-identity', 'install-wrappers.sh'));
        if (script) await runScript(script, root);
      },
    },
    {
      id: 'mcpObsidian', severity: 'warn',
      run: async (): Promise<CheckResult> => {
        const cj = readJson(claudeJsonPath()) as { mcpServers?: Record<string, unknown>; projects?: Record<string, { mcpServers?: Record<string, unknown> }> };
        const names = [
          ...Object.keys(cj.mcpServers ?? {}),
          ...Object.values(cj.projects ?? {}).flatMap((p) => Object.keys(p?.mcpServers ?? {})),
        ];
        const hit = names.find((n) => /obsidian/i.test(n));
        if (hit) return { id: 'mcpObsidian', label: t('setupCheck.mcpObsidian'), status: 'pass', message: t('setupCheck.mcpObsidianOk', { name: hit }), canRepair: false };
        /* The repair used to be `bash mcps/setup.sh`, which cannot possibly fix this check:
           there is no obsidian-mcp in mcps/ — it is a published package registered directly
           with Claude (SETUP.md line 225). So the button ran a ten-MCP install (three Chrome
           downloads, a pip build that fails on this repo's own layout, several minutes) and
           the Obsidian check stayed red at the end of it. Pointing a repair at the wrong
           script is worse than having no repair, because the operator concludes the product
           is broken rather than that the button was wrong.
           This is the actual one-line registration, and it needs the vault path. */
        const v = vaultRoot();
        const cmd = v
          ? `${claudeCmd} mcp add obsidian -- npx -y @mauricio.wolff/mcp-obsidian@latest ${shq(v)}`
          : undefined;
        return { id: 'mcpObsidian', label: t('setupCheck.mcpObsidian'), status: 'warn', message: t('setupCheck.mcpObsidianMissingHint'), repairCmd: cmd, repairHint: cmd, canRepair: false };
      },
    },
    {
      // The starter step: has the operator picked a persona (or curated their
      // own frequent tasks)? A cloned vault whose state.json already carries
      // saved tasks passes itself — identity arrives WITH the vault.
      id: 'starter', severity: 'warn',
      run: async (): Promise<CheckResult> => {
        const st = starterPackState();
        const curated = !!glassState()['aios.frequentTasks.v1'];
        return (st || curated)
          ? { id: 'starter', label: t('setupCheck.starter'), status: 'pass', message: st ? t('setupCheck.starterOk', { id: st.id }) : t('setupCheck.starterCurated'), canRepair: false }
          : { id: 'starter', label: t('setupCheck.starter'), status: 'warn', message: t('setupCheck.starterMissing'), canRepair: false };
      },
    },
    {
      id: 'gh', severity: 'warn',
      run: async (): Promise<CheckResult> => {
        if (process.platform === 'win32') return ghCheckWin();
        // Two honest ways to be connected: `gh auth status` (the device/web
        // flow), or a stored HTTPS credential for github.com in git's own
        // credential helper (the PAT lane). The probe never prompts:
        // GIT_TERMINAL_PROMPT=0 + a no-op askpass make `credential fill`
        // answer only from what's already stored.
        /* NO `git credential fill` here. It invokes git-credential-osxkeychain, which asks macOS
           for keychain access — and this check runs on a 5-second poll while Setup is open, so it
           produced an endless stream of "git-credential-osxkeychain wants to use your confidential
           information" modals that no password would dismiss, because each poll raised a fresh
           one. A probe must never be able to interrupt the operator. The PAT lane is now detected
           from ~/.git-credentials, which the `store` helper writes in plain text and which costs
           nothing to read; an osxkeychain-only PAT will read as "not authenticated", a
           false-negative that is merely a redundant login rather than a modal loop. */
        const probe =
          'if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then echo AUTHED; ' +
          "elif grep -qs 'github\\.com' \"$HOME/.git-credentials\"; then echo PATOK; " +
          'elif command -v gh >/dev/null 2>&1; then echo NOAUTH; else echo NOGH; fi';
        const out = await zshOut(probe);
        const loginCmd = 'gh auth login --web --git-protocol https';
        // rank the answers: both shells reply, and the BEST answer wins. Without this, a
        // non-interactive "NOGH" would outrank the interactive shell's "NOAUTH" and send someone
        // to install a tool they already have.
        if (out?.includes('AUTHED')) return { id: 'gh', label: t('setupCheck.gh'), status: 'pass', message: t('setupCheck.ghOk'), canRepair: false };
        if (out?.includes('PATOK')) return { id: 'gh', label: t('setupCheck.gh'), status: 'pass', message: t('setupCheck.ghPat'), canRepair: false };
        if (out?.includes('NOAUTH')) return { id: 'gh', label: t('setupCheck.gh'), status: 'warn', message: t('setupCheck.ghNoAuth'), repairCmd: loginCmd, repairHint: loginCmd, canRepair: false };
        /* gh genuinely absent. `brew install gh` is only offered when brew can actually WRITE:
           on a shared Mac, Homebrew belongs to whoever installed it, and a standard user gets
           "/opt/homebrew/Cellar is not writable" followed by a wall of chown instructions that
           end in sudo. Offering an impossible command is worse than offering none — it reads as
           the product being broken. `gh`'s own installer needs no admin rights. */
        const brewWritable = 'test -w /opt/homebrew/Cellar 2>/dev/null || test -w /usr/local/Cellar 2>/dev/null';
        const canBrew = !!(await zshOut(`if command -v brew >/dev/null 2>&1 && { ${brewWritable}; }; then echo YES; fi`))?.includes('YES');
        if (canBrew) {
          const install = `brew install gh && ${loginCmd}`;
          return { id: 'gh', label: t('setupCheck.gh'), status: 'warn', message: t('setupCheck.ghNotInstalled'), repairCmd: install, repairHint: install, canRepair: false };
        }
        /* Brew cannot write, so there is no command this app can honestly run. Say that, and say
           who can fix it — rather than printing a command that ends in a chown wall and sudo. A
           dead end named as one costs a minute; a dead end disguised as a button costs trust. */
        return {
          id: 'gh', label: t('setupCheck.gh'), status: 'warn',
          message: t('setupCheck.ghNoBrew'), repairHint: 'https://cli.github.com/', canRepair: false,
        };
      },
    },
    {
      /* The finale: has this AIOS actually become theirs?
         It used to look for a daily note — /aios:today's own artifact. That answered "was a
         command run once", which a template vault can satisfy: `/aios:today` will happily plan
         a day for a person it knows nothing about, write the note, and turn this step green.
         The honest question is whether the personalization exists, so the check reads the
         evidence (see src/core/personalized.ts) and the repair is the setup session itself. */
      id: 'personalized', severity: 'warn',
      run: async (): Promise<CheckResult> => {
        const p = personalization();
        if (p.ok) return { id: 'personalized', label: t('setupCheck.personalized'), status: 'pass', message: t('setupCheck.personalizedOk'), canRepair: false };
        const detail = p.declared ? t('setupCheck.personalizedNoOwner') : t('setupCheck.personalizedTemplate');
        return { id: 'personalized', label: t('setupCheck.personalized'), status: 'warn', message: detail, canRepair: false };
      },
    },
  ];
}

/** Run every doctor check (display order). The setup wizard shows all of them. */
export function setupChecks(): Promise<CheckResult[]> {
  return Promise.all(doctorChecks().map((c) => c.run()));
}

/** The repair loop: run the check's fix, then RE-RUN the same check as proof.
 *  Returns the re-checked result (never the optimistic assumption); a failed
 *  repair simply comes back still-warn/fail — the row stays honest. */
export async function repairCheck(id: string): Promise<CheckResult | null> {
  const check = doctorChecks().find((c) => c.id === id);
  if (!check) return null;
  if (check.repair) {
    try { await check.repair(); } catch { /* the re-run below reports the truth */ }
  }
  return check.run();
}

/** AI-18 Health card (ported from aios-glass computeHealth, doctor-backed):
 *  the ongoing "is my AIOS wired?" readout — Setup is day one, this is every
 *  day after. Order = display order on the pulse card. */
export const HEALTH_IDS = ['framework', 'vault', 'account', 'skills', 'claude', 'gh'] as const;

export async function computeHealth(): Promise<CheckResult[]> {
  const all = await setupChecks();
  return HEALTH_IDS.map((id) => all.find((c) => c.id === id)).filter((c): c is CheckResult => !!c);
}

// ── the Onboarding flow (sequenced onboarding stepper — model in src/core/onboarding.ts) ──

/** One battery of doctor checks → the gated stepper (done/active/locked). */
export async function onboardingState(): Promise<OnboardingDerived<CheckResult>> {
  return deriveOnboarding(await setupChecks());
}

/**
 * The PAT lane of the GitHub step: store a personal access token in git's OWN
 * credential machinery (`git credential approve` routes to the configured
 * helper — Keychain on macOS). Nothing is echoed to a terminal, nothing is
 * logged; the gh check's `credential fill` probe then verifies it for real.
 */
export function storeGitHubPat(pat: string): boolean {
  const token = (pat || '').trim();
  if (!token || /\s/.test(token)) return false;
  try {
    let helper = '';
    try { helper = execFileSync('git', ['config', '--get', 'credential.helper'], { encoding: 'utf8', timeout: 4000 }).trim(); } catch { helper = ''; }
    if (!helper) {
      // no helper anywhere → give git one (Keychain on macOS, plain store elsewhere)
      /* Windows has an OS credential vault too, and Git for Windows ships the helper for it, so
         `manager` (Git Credential Manager) is the honest equivalent of osxkeychain. `store`
         would write the PAT to ~/.git-credentials in PLAIN TEXT — acceptable as a last resort on
         a Linux box with no vault, never the default on a machine that has one. */
      const fallback = process.platform === 'win32' ? 'manager' : 'store';
      execFileSync('git', ['config', '--global', 'credential.helper', process.platform === 'darwin' ? 'osxkeychain' : fallback], { encoding: 'utf8', timeout: 4000 });
    }
    execFileSync('git', ['credential', 'approve'], {
      input: `protocol=https\nhost=github.com\nusername=x-access-token\npassword=${token}\n\n`,
      encoding: 'utf8', timeout: 8000,
    });
    return true;
  } catch { return false; }
}

// ── Claude Code global config (ported from the extension — all fs-only) ─────

/** Claude Code's home dir (~/.claude) + global config (~/.claude.json).
 *  Env-overridable (GLASS_CLAUDE_HOME / GLASS_CLAUDE_JSON) so the doctor's
 *  account/skills/plugin checks are testable against a fixture, not the
 *  developer's real machine state. Production never sets these. */
export const claudeDir = () => process.env.GLASS_CLAUDE_HOME || path.join(os.homedir(), '.claude');
const claudeSettingsPath = () => path.join(claudeDir(), 'settings.json');
const claudeJsonPath = () => process.env.GLASS_CLAUDE_JSON || path.join(os.homedir(), '.claude.json');

export const MODEL_OPTIONS = [
  { label: 'Opus 4.8 — 1M context', value: 'claude-opus-4-8[1m]' },
  { label: 'Opus 4.8', value: 'claude-opus-4-8' },
  { label: 'Sonnet 4.6', value: 'claude-sonnet-4-6' },
  { label: 'Haiku 4.5', value: 'claude-haiku-4-5' },
  { label: 'Default (clear the override)', value: '' },
];
export const MODE_OPTIONS = ['default', 'auto', 'acceptEdits', 'plan', 'bypassPermissions'];

function readJson(p: string): Record<string, unknown> {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; }
}
/* The framework root's own Claude stores. `<root>/.claude/settings.json` is COMMITTED, so it is
   read and never written — a personal preference does not belong in a shared repo.
   `<root>/.claude/settings.local.json` is machine-local, and it is what `/config` writes and what
   every session launched from the vault reads FIRST. */
function claudeProjectSettingsPath(): string | null {
  const r = frameworkRoot();
  return r ? path.join(r, '.claude', 'settings.json') : null;
}
function claudeLocalSettingsPath(): string | null {
  const r = frameworkRoot();
  return r ? path.join(r, '.claude', 'settings.local.json') : null;
}

/** All four stores, in one read, so every consumer resolves the same chain. */
function claudeStores(): [Record<string, unknown>, Record<string, unknown>, Record<string, unknown>, Record<string, unknown>] {
  const pp = claudeProjectSettingsPath();
  const lp = claudeLocalSettingsPath();
  return [readJson(claudeSettingsPath()), readJson(claudeJsonPath()), pp ? readJson(pp) : {}, lp ? readJson(lp) : {}];
}

function writeClaudeLocalSettings(mutate: (j: Record<string, unknown>) => void): void {
  const p = claudeLocalSettingsPath();
  if (!p) return;
  const j = readJson(p);
  mutate(j);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(j, null, 2) + '\n');
  fs.renameSync(tmp, p);
}

function writeClaudeSettings(mutate: (j: Record<string, unknown>) => void): void {
  const p = claudeSettingsPath();
  const j = readJson(p);
  mutate(j);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(j, null, 2) + '\n');
  fs.renameSync(tmp, p);
}

/**
 * ~/.claude.json is LARGE and live Claude sessions write it too, so a read-modify-write
 * races them. Mitigations: re-read immediately before mutating (shrinking the window to
 * the mutate itself), and write atomically via tmp+rename so a crash can't truncate the
 * operator's session state. A lost update is still possible in principle — which is why
 * only the two keys that genuinely live here are written here.
 */
function writeClaudeUserJson(mutate: (j: Record<string, unknown>) => void): void {
  const p = claudeJsonPath();
  const j = readJson(p);
  if (!Object.keys(j).length) return;   // absent/unparseable: never replace it with a stub
  mutate(j);
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(j, null, 2) + '\n');
  fs.renameSync(tmp, p);
}

/**
 * The model picker's options. A hardcoded list goes stale the moment Anthropic ships a
 * model — Fable was missing here while Claude itself already offered it. So: our curated
 * base, PLUS whatever Claude has cached as additional options (that is where Fable lives),
 * PLUS the configured value if it is none of those, so opening Settings can never silently
 * reset a model set elsewhere or newer than this build.
 */
export function modelOptions(): { label: string; value: string }[] {
  const base = [
    { label: 'Opus 5 — 1M context', value: 'claude-opus-5[1m]' },
    { label: 'Opus 5', value: 'claude-opus-5' },
    { label: 'Sonnet 5', value: 'claude-sonnet-5' },
    { label: 'Haiku 4.5', value: 'claude-haiku-4-5-20251001' },
  ];
  const out = [...base];
  const cj = readJson(claudeJsonPath()) as { additionalModelOptionsCache?: unknown };
  const extra = Array.isArray(cj.additionalModelOptionsCache) ? cj.additionalModelOptionsCache : [];
  for (const o of extra) {
    const v = (o as { value?: unknown }).value;
    const l = (o as { label?: unknown }).label;
    if (typeof v === 'string' && !out.some((m) => m.value === v)) {
      out.push({ label: typeof l === 'string' && l ? `${l} — ${v.includes('[1m]') ? '1M context' : v}` : v, value: v });
    }
  }
  const current = String(readValue('model', readJson(claudeSettingsPath()), cj as Record<string, unknown>) || '');
  if (current && !out.some((m) => m.value === current)) out.unshift({ label: current, value: current });
  return out;
}

/**
 * Permission modes Claude currently accepts. All five are real (confirmed in Claude's own
 * binary), but bypassPermissions can be switched OFF server-side — offering a mode the
 * operator's account cannot use is worse than not listing it.
 */
export function permissionModes(): string[] {
  const modes = ['default', 'auto', 'acceptEdits', 'plan', 'bypassPermissions'];
  const cj = readJson(claudeJsonPath()) as { cachedStatsigGates?: Record<string, unknown> };
  if (cj.cachedStatsigGates?.tengu_disable_bypass_permissions_mode === true) {
    return modes.filter((m) => m !== 'bypassPermissions');
  }
  return modes;
}

/** The output styles the picker offers: Claude's built-ins + the operator's own. */
export function outputStyleOptions(): string[] {
  const own: string[] = [];
  try {
    for (const f of fs.readdirSync(path.join(claudeDir(), 'output-styles'))) {
      if (f.endsWith('.md')) own.push(f.replace(/\.md$/, ''));
    }
  } catch { /* none defined */ }
  return [...BUILTIN_OUTPUT_STYLES, ...own.filter((o) => !BUILTIN_OUTPUT_STYLES.includes(o))];
}

export interface ClaudeConfig {
  account: string; model: string; mode: string; remoteControl: boolean; autoUpdates: boolean;
  // Claude-owned toggles surfaced in Settings (see src/core/claudeConfig.ts for the stores)
  outputStyle: string; reduceMotion: boolean; switchModelsOnFlag: boolean;
  claudeInChrome: boolean; copyOnSelect: boolean;
  agentPushNotif: boolean; inputNeededNotif: boolean; awaySummary: boolean; autoCompact: boolean;
}

export function claudeConfig(): ClaudeConfig {
  const st = readJson(claudeSettingsPath());
  const cj = readJson(claudeJsonPath()) as { oauthAccount?: { emailAddress?: string } };
  let autoUpdates = true;
  const r = frameworkRoot();
  if (r) {
    try {
      const md = fs.readFileSync(path.join(r, 'USER.md'), 'utf8');
      const m = md.match(/automatic updates:\s*\**\s*(yes|no|on|off|true|false)/i);
      if (m) autoUpdates = /^(yes|on|true)$/i.test(m[1]);
    } catch { /* default */ }
  }
  const user = cj as unknown as Record<string, unknown>;
  /* ALL FOUR STORES. These helpers read two, which was invisible for every key that lives in only
     one place — and wrong for the single key that lives in two. `prefersReducedMotion` exists in
     BOTH the global store and the vault's local one, so reading the wrong file was the only case
     where the wrong file gave a different answer. Everything else agreed by accident.
     The symptom was surgical: one row that would not follow `/config`, while `readStore` reported
     'local' correctly right beside it — the resolver and the reader disagreeing inside one
     module. */
  const [, , pj, lc] = claudeStores();
  const str = (id: string): string => String(readValue(id, st, user, pj, lc));
  const bool = (id: string): boolean => readValue(id, st, user, pj, lc) === true;
  return {
    account: cj?.oauthAccount?.emailAddress || '',
    // every one of these reads through the registry, so the row and the file agree
    model: str('model'),
    mode: str('mode'),
    remoteControl: bool('remoteControl'),
    outputStyle: str('outputStyle'),
    reduceMotion: bool('reduceMotion'),
    switchModelsOnFlag: bool('switchModelsOnFlag'),
    claudeInChrome: bool('claudeInChrome'),
    copyOnSelect: bool('copyOnSelect'),
    agentPushNotif: bool('agentPushNotif'),
    inputNeededNotif: bool('inputNeededNotif'),
    awaySummary: bool('awaySummary'),
    autoCompact: bool('autoCompact'),
    autoUpdates,
  };
}

export type ClaudeConfigKey = keyof typeof CLAUDE_KEYS;

/**
 * SEED CLAUDE'S CONFIG ONCE, at first install. Never on update.
 *
 * The App's Settings panel is a MIRROR of Claude's own config — it reads Claude's files and writes
 * them back. That model only tells the truth when the keys exist: Claude writes a key only once
 * you change it, so a fresh machine has almost none of them, and anything the UI displayed for an
 * absent key was an assertion nobody had verified. That is how the Remote Control toggle showed a
 * tick over a `false` config for every operator who never touched it (2026-07-31).
 *
 * So the App states its opinion ONCE, in writing, and from then on only mirrors. After seeding
 * there is no "absent" case left to guess about for any key we seed.
 *
 * NOT ON UPDATE, and the marker is what guarantees it: re-seeding every launch would silently
 * undo the operator's own choices — turning Remote Control off would come back on at the next
 * start, which is worse than the bug this fixes. The marker lives in OUR settings, never in
 * Claude's: Claude's files belong to Claude, and a flag of ours in there would be a foreign key
 * in someone else's schema.
 */
export function seedClaudeDefaults(): { seeded: string[]; already: boolean } {
  /* The marker is read RAW from .glass/shell.json rather than through shellSettings(), which
     normalises to a typed shape and would drop a key it does not declare. */
  const r = frameworkRoot();
  let raw: Record<string, unknown> = {};
  if (r) { try { raw = JSON.parse(fs.readFileSync(path.join(r, '.glass', 'shell.json'), 'utf8')); } catch { raw = {}; } }
  if (raw.claudeDefaultsSeeded) return { seeded: [], already: true };
  const [settings, user, project, local] = claudeStores();
  const seeded: string[] = [];
  for (const id of seedableKeys()) {
    // Only keys with NOTHING on disk. An existing value is the operator's (or Claude's) and is
    // never overwritten — seeding fills gaps, it does not impose.
    if (isSet(id, settings, user, project, local)) continue;
    try { setClaudeConfig(id as ClaudeConfigKey, CLAUDE_KEYS[id].seed); seeded.push(id); } catch { /* skip */ }
  }
  setShellSetting('claudeDefaultsSeeded', true);
  return { seeded, already: false };
}

/** Which Claude keys are actually PRESENT on disk. The UI needs this to tell "the operator chose
 *  this" from "nobody has chosen" — a distinction that vanished when a seeded key was later RESET
 *  by `/config`, putting the App back to displaying a value it had never read. */
export function claudeConfigSetKeys(): Record<string, boolean> {
  const [settings, user, project, local] = claudeStores();
  const out: Record<string, boolean> = {};
  for (const id of Object.keys(CLAUDE_KEYS)) out[id] = isSet(id, settings, user, project, local);
  return out;
}

/** Which store each value is resolved FROM. The operator needs this: a value set for this vault
 *  behaves differently from a global one, and without saying so a global change that gets
 *  overridden locally looks like a broken toggle — which is exactly how this was discovered. */
export function claudeConfigStores(): Record<string, string> {
  const [settings, user, project, local] = claudeStores();
  const out: Record<string, string> = {};
  for (const id of Object.keys(CLAUDE_KEYS)) {
    out[id] = isSet(id, settings, user, project, local) ? readStore(id, settings, user, project, local) : '';
  }
  return out;
}

export function setClaudeConfig(key: ClaudeConfigKey, value: unknown): void {
  const spec = CLAUDE_KEYS[key as string];
  if (spec) {
    // Write to whichever store already holds the key, so an inferred store self-corrects
    // once Claude has written the value itself.
    /* Write where the value ACTUALLY lives, across all four stores — otherwise a change can be
       silently overridden by a higher-precedence store and the toggle appears to do nothing. */
    const [st, uj, pj, lc] = claudeStores();
    const store = writeStore(key as string, st, uj, pj, lc);
    const v = coerce(key as string, value);
    const mutate = (j: Record<string, unknown>) => setAt(j, spec.path, v);
    if (store === 'local') writeClaudeLocalSettings(mutate);
    else if (store === 'user') writeClaudeUserJson(mutate);
    else writeClaudeSettings(mutate);
    return;
  }
  // 'autoUpdates' is NOT Claude's — see setAutoUpdates below.
}

/**
 * Mark a directory as trusted for Claude Code, so a session launched there opens on its composer
 * instead of "Do you trust the files in this folder?".
 *
 * That dialog is why the handover looked broken. A positional prompt IS submitted when the session
 * opens straight onto its composer — but a first-run screen swallows it, and the operator lands on
 * an idle-looking session with their instruction gone. Theirs was the diagnostic detail: pressing
 * ↑ then Enter brought it back, so it had been typed into a dialog rather than sent. Nobody
 * non-technical discovers that.
 *
 * I tried watching the terminal for the composer instead, and stopped: it is a regex against
 * another product's UI, it read scrollback as if it were current state, and I could not simulate
 * it faithfully enough to trust the result. Removing the screen is deterministic where guessing at
 * it is not.
 *
 * NARROW ON PURPOSE. This is a security prompt, and it is only pre-accepted for the ONE directory
 * the operator just asked us to set up, at the moment they click the button — their own vault,
 * created by this flow. Nothing else is trusted on their behalf, and nothing happens without the
 * click.
 */
export function trustDirForClaude(dir: string): void {
  if (!dir) return;
  writeClaudeUserJson((j) => {
    const projects = (j.projects && typeof j.projects === 'object' ? j.projects : {}) as Record<string, Record<string, unknown>>;
    const entry = (projects[dir] && typeof projects[dir] === 'object' ? projects[dir] : {}) as Record<string, unknown>;
    entry.hasTrustDialogAccepted = true;
    projects[dir] = entry;
    j.projects = projects;
  });
}

/**
 * Automatic framework updates — an AIOS setting, written to USER.md → ## Settings, which
 * `/today` and `/close-day` read to decide whether to auto-pull when the vault is behind.
 * Nothing to do with Claude's config, which is why it is not in the CLAUDE_KEYS registry.
 *
 * The block matches what the Glass extension writes, including inserting BEFORE
 * `## Session cascade`: both surfaces edit this same file, and whichever one creates the
 * section first decides what the operator reads there forever.
 */
export function setAutoUpdates(on: boolean): void {
  const r = frameworkRoot();
  if (!r) return;
  const p = path.join(r, 'USER.md');
  let md = '';
  try { md = fs.readFileSync(p, 'utf8'); } catch { return; }
  const val = on ? 'yes' : 'no';
  if (/automatic updates:/i.test(md)) {
    md = md.replace(/(automatic updates:\**\s*)(yes|no|on|off|true|false)/i, `$1${val}`);
  } else {
    const block = `## Settings\n\n> Operator preferences Claude and AIOS read every session. Toggle them from the app's Settings.\n\n- **Automatic updates:** ${val} — when \`yes\`, \`/today\` and \`/close-day\` auto-pull framework updates when your vault is BEHIND; \`no\` = nudge only.\n\n`;
    if (/^## Session cascade/m.test(md)) md = md.replace(/^## Session cascade/m, block + '## Session cascade');
    else md = md.replace(/\s*$/, '\n') + '\n' + block;
  }
  fs.writeFileSync(p, md);
}

export function modelLabel(value: string): string {
  return MODEL_OPTIONS.find((m) => m.value === value)?.label ?? (value || 'Default');
}

// ── workspace folders (operator-added roots beside the vault) ───────────────

export function workspaceFolders(): string[] {
  const r = frameworkRoot();
  if (!r) return [];
  try {
    const j = JSON.parse(fs.readFileSync(path.join(r, '.glass', 'shell.json'), 'utf8'));
    const arr = Array.isArray(j.workspaceFolders) ? j.workspaceFolders : [];
    return arr.filter((p: unknown): p is string => typeof p === 'string' && fs.existsSync(p));
  } catch { return []; }
}
export function addWorkspaceFolder(p: string): void {
  const cur = workspaceFolders();
  if (!cur.includes(p)) setShellSetting('workspaceFolders' as never, [...cur, p] as never);
}
export function removeWorkspaceFolder(p: string): void {
  setShellSetting('workspaceFolders' as never, workspaceFolders().filter((x) => x !== p) as never);
}

/**
 * Is the app ready to RUN something? Cheap enough to call before every action — a PATH probe
 * plus three existence checks, memoized for a few seconds — because the full doctor pass is
 * far too heavy for a button click.
 *
 * This exists because an action whose prerequisite is missing used to fail in a terminal:
 * "Launch AIOS" spawned `claude …` on a machine with no Claude, and the operator got
 * `command not found` instead of being taken somewhere that could fix it.
 */
export interface Readiness {
  claude: boolean; framework: boolean; vault: boolean; signedIn: boolean; ready: boolean;
  /** 'disk' means installed but unreachable — a different problem from 'none'. */
  claudeWhere: 'path' | 'disk' | 'none';
  /** Evidence that this vault is someone's, not the shipped template. */
  personalized: boolean;
}

/** Phase 1 lives in the bundle, so a dmg install carries it. */
/**
 * Materialise the completion-banner helper and return its path.
 *
 * The banner used to be inlined into every command, so the operator's terminal opened with a
 * 700-character wall of `printf '\n\033[32m%s…'` before anything ran. It worked, and it looked
 * alarming — "intimidating" was the word, and a newcomer deciding whether to trust this thing is
 * reading that wall. A command they can recognise (`gh auth login --web`) followed by one short
 * tail is the same behaviour without the intimidation.
 */
export function bannerScript(ok: string, okSub: string, fail: string, failSub: string): string {
  const bar = '='.repeat(58);
  if (process.platform === 'win32') {
    /* No shebang and no 0o700: Windows has neither, and a `#!` line would be executed as a
       comment at best. Unlike POSIX this returns a full INVOCATION rather than a path: there is
       no `bash` to prefix it with, and a bare `.ps1` path is not universally runnable under the
       default execution policy.

       THE ARGUMENT CONTRACT, and it differs from POSIX by dialect, not by accident. The renderer
       emits `<cmd> ; <this invocation> $?` on win32 (sequential `;`, no `{ }` grouping — a brace
       group in PowerShell defines a script block and runs nothing). PowerShell's `$?` is a
       BOOLEAN, not an exit code, so the first positional argument arrives as the string 'True'
       or 'False' — never '0'. Success is therefore 'True' and everything else is failure, which
       also makes a missing or malformed argument fail safe rather than announcing a false
       victory. Boolean.ToString() is culture-invariant, so 'True' holds on a Spanish machine
       too, and PowerShell's `-eq` on strings is case-insensitive, so 'true' passes as well.
       POSIX's done.sh keeps reading `$1` as the numeric exit code, unchanged.
       The renderer half of this contract is owned elsewhere (renderer/app.js:withDoneBanner);
       this side owns the script body and its argument parsing. */
    /* psq, never JSON.stringify. These four strings are LOCALIZED and therefore adversarial in
       two separate ways, both of which a JSON double-quoted literal gets wrong: a translation
       containing `$` would be variable-expanded by PowerShell (silently, usually to nothing),
       and JSON's `\"` escaping is meaningless here — PowerShell escapes with a backtick, so an
       embedded quote would close the string early and the banner would fail to parse. Single
       quotes with the quote doubled are inert against both. */
    const psBody = `# Written by AIOS. Prints the verdict of the step that just ran.
# $Ok is PowerShell's $? for that step: 'True' when it succeeded, 'False' otherwise.
# Declared as a param so it binds the FIRST POSITIONAL ARGUMENT; do not read $args here,
# which a param block leaves empty. Defaults to 'False' so a missing verdict fails safe.
param([string]$Ok = 'False')
$bar = ${psq(bar)}
if ($Ok -eq 'True') {
  Write-Host ""; Write-Host $bar -ForegroundColor Green; Write-Host ""
  Write-Host ('   ' + ${psq(ok)}) -ForegroundColor Green; Write-Host ""
  Write-Host ('   ' + ${psq(okSub)}) -ForegroundColor Green
  Write-Host $bar -ForegroundColor Green; Write-Host ""
} else {
  Write-Host ""; Write-Host $bar -ForegroundColor Yellow; Write-Host ""
  Write-Host ('   ' + ${psq(fail)}) -ForegroundColor Yellow; Write-Host ""
  Write-Host ('   ' + ${psq(failSub)}) -ForegroundColor Yellow
  Write-Host $bar -ForegroundColor Yellow; Write-Host ""
}
`;
    try {
      const out = path.join(os.tmpdir(), 'aios-setup', 'done.ps1');
      fs.mkdirSync(path.dirname(out), { recursive: true });
      /* A BOM, and it is load-bearing. These four strings are LOCALIZED, so they carry em
         dashes and accents the moment the operator is on Spanish or Portuguese — and Windows
         PowerShell 5.1 decodes a BOM-less file as the ANSI codepage, where an em dash's third
         UTF-8 byte (0x94) becomes CP1252's RIGHT DOUBLE QUOTATION MARK, which PowerShell honours
         as a string DELIMITER. Without the BOM a Spanish banner does not merely look wrong, it
         fails to parse, and the operator's step ends in a red wall instead of a verdict. */
      fs.writeFileSync(out, String.fromCharCode(0xFEFF) + psBody, 'utf8');
      return psRunHint(out);
    } catch { return ''; }
  }
  const body = `#!/bin/bash
# Written by AIOS. Prints the verdict of the step that just ran; \$1 is its exit code.
if [ "\${1:-1}" -eq 0 ]; then
  printf '\\n\\033[32m%s\\n\\n   %s\\n\\n   %s\\n%s\\033[0m\\n\\n' ${JSON.stringify(bar)} ${JSON.stringify(ok)} ${JSON.stringify(okSub)} ${JSON.stringify(bar)}
else
  printf '\\n\\033[33m%s\\n\\n   %s\\n\\n   %s\\n%s\\033[0m\\n\\n' ${JSON.stringify(bar)} ${JSON.stringify(fail)} ${JSON.stringify(failSub)} ${JSON.stringify(bar)}
fi
`;
  try {
    const out = path.join(os.tmpdir(), 'aios-setup', 'done.sh');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, body, { mode: 0o700 });
    return out;
  } catch { return ''; }
}

/**
 * What the caller receives. POSIX hands out the PATH — the renderer prefixes `bash` itself.
 * Windows has no bash to prefix, so it hands out a ready-to-run PowerShell invocation.
 * TODO(windows): renderer/app.js's phase-1 button still builds `bash ${xQuote(script)}`; it
 * needs a win32 branch that runs this string as-is. Out of scope here (renderer/ is not this
 * change's to touch), so the Windows button stays wired only once that lands.
 */
const phase1Invocation = (p: string): string => (process.platform === 'win32' ? psRunHint(p) : p);

export function phase1Script(): string {
  /* app.asar is an ARCHIVE, not a directory. Node's fs is shimmed to read inside it, so
     statSync said the script was there and the path looked perfectly good — but the moment it
     was handed to a real `bash`, the OS answered "Not a directory" and the whole install step
     did nothing. The one button a newcomer must be able to press.
     So the script is MATERIALISED to a real file on disk before its path is handed out. Reading
     it works (that is the shim); executing it does not. Copying costs a few kilobytes and is
     independent of electron-builder's asarUnpack config, which would otherwise have to stay in
     sync with this path forever. */
  // Windows runs the PowerShell provisioner; everything else keeps the bash one.
  const file = process.platform === 'win32' ? 'phase1-prerequisites.ps1' : 'phase1-prerequisites.sh';
  const dev = path.join(__dirname, '..', '..', 'scripts', 'setup', file);
  const packaged = path.join(process.resourcesPath || '', 'app.asar', 'scripts', 'setup', file);
  const unpacked = packaged.replace('app.asar', 'app.asar.unpacked');
  for (const p of [dev, unpacked]) {
    // a REAL path on disk — usable directly
    try { if (fs.statSync(p).isFile() && !p.includes('app.asar' + path.sep)) return phase1Invocation(p); } catch { /* next */ }
  }
  try {
    const body = fs.readFileSync(packaged, 'utf8');       // works: fs is shimmed for asar
    /* os.tmpdir(), not app.getPath('userData'): this module is deliberately electron-free so
       the doctor suite can import it outside an Electron process, and the compiler caught the
       import the moment I reached for it. A transient, idempotent script is exactly what a temp
       dir is for. */
    const out = path.join(os.tmpdir(), 'aios-setup', file);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, body, { mode: 0o700 });
    return phase1Invocation(out);
  } catch { return ''; }
}

/** The shell the operator actually uses — and the one pty:spawn launches, so probes agree
 *  with what a real terminal will do. */
function operatorShell(): string {
  // Windows has no $SHELL, and %ComSpec% is cmd.exe — which none of the probes above speak.
  // PowerShell is both what this app's panes launch and what every Windows branch here assumes.
  if (process.platform === 'win32') return 'powershell.exe';
  const sh = process.env.SHELL;
  return sh && fs.existsSync(sh) ? sh : '/bin/zsh';
}

/**
 * Put ~/.local/bin on PATH, idempotently, and then PROVE the result.
 *
 * Two things this has to get right. It must not append the line twice (an operator who runs
 * a remedy twice should not end up with a duplicated profile), and it must finish by saying
 * whether the thing now works — a remedy that succeeds silently leaves the operator staring
 * at a terminal wondering whether to click the button again.
 */
function pathFixSnippet(): string {
  if (process.platform === 'win32') {
    /* The Windows remedy, same contract as the POSIX one: find where claude actually is, make a
       NEW terminal able to reach it, then PROVE it — a remedy that succeeds silently leaves the
       operator wondering whether to press the button again.
       "A new terminal" is the USER-scoped environment block in the registry, not this process's
       inherited copy, so the write goes through [Environment]::SetEnvironmentVariable(…,'User').
       Idempotent by membership, not by substring: an operator who runs it twice must not end up
       with a duplicated PATH entry (the same trap the POSIX branch's grep fell into).
       Each line is a COMPLETE statement — this is typed into a live pane, and a block split
       across lines would leave PowerShell sitting at a continuation prompt.
       ASCII ONLY, deliberately. Windows PowerShell 5.1 decodes input as the ANSI codepage, and
       an em dash's third UTF-8 byte (0x94) lands on CP1252's RIGHT DOUBLE QUOTATION MARK — which
       PowerShell accepts as a string DELIMITER. So one prose em dash silently ends a string
       early and the rest of the remedy fails to parse. Measured, not theorised. A file can carry
       a BOM to say otherwise (see bannerScript); text typed into a live pane cannot. */
    /* The directory list and the launcher names come from winClaudeDirs/WIN_CLAUDE_NAMES — the
       SAME source the doctor's disk probe reads. When these were written out by hand they drifted
       (the probe knew %LOCALAPPDATA%\Programs\claude, the remedy did not), and the operator got a
       check saying "installed but off your PATH" whose fix answered "could not find claude".
       Emitted as psq literals so a path containing an apostrophe survives. */
    const dirList = winClaudeDirs().map(psq).join(', ');
    const nameTest = WIN_CLAUDE_NAMES.map((n) => `(Test-Path (Join-Path $_ ${psq(n)}))`).join(' -or ');
    return [
      `$dirs = @(${dirList})`,
      `$dir = $dirs | Where-Object { ${nameTest} } | Select-Object -First 1`,
      `$u = [Environment]::GetEnvironmentVariable("Path","User"); if (-not $u) { $u = "" }`,
      `if (-not $dir) { Write-Host "Could not find claude on this machine - install it first, then run this again." }`
      + ` elseif (($u -split ";") -contains $dir) { Write-Host "$dir is already on your PATH" }`
      + ` else { [Environment]::SetEnvironmentVariable("Path", (($u.TrimEnd(";") + ";" + $dir).Trim(";")), "User"); Write-Host "Added $dir to your PATH" }`,
      // this pane only — the persisted write above is what a NEW terminal will read
      `if ($dir) { $env:Path = "$env:Path;$dir" }`,
      `if (Get-Command claude -ErrorAction SilentlyContinue) { Write-Host ""; Write-Host ("A new terminal can now run claude: " + (claude --version 2>$null | Select-Object -First 1)); Write-Host "Go back to Setup - this check will pass." }`
      + ` else { Write-Host ""; Write-Host "A new terminal still cannot run claude - the AIOS App's Setup will keep offering this fix." }`,
    ].join('\n');
  }
  /* Same correction as phase 1's claude_path_fix, for the same reason: this used to skip when
     `grep '.local/bin'` matched ANYTHING in the rc. On an operator with 485 lines of accumulated
     config it matched something unrelated, reported "PATH line already present", wrote nothing,
     and left claude unreachable — a true sentence and a wrong conclusion. What matters is whether
     a NEW TERMINAL can run claude, so that is what it tests, before and after.
     .zprofile is preferred: every login shell reads it, it is short, and it is where Homebrew's
     own installer writes, so it stays clear of whatever the .zshrc has accumulated. */
  const bashy = process.env.SHELL?.includes('bash');
  const rc = bashy ? '$HOME/.bash_profile' : '$HOME/.zprofile';
  const probe = bashy ? "bash -lc 'command -v claude'" : "zsh -ilc 'command -v claude'";
  return [
    `if ${probe} >/dev/null 2>&1; then echo "A new terminal can already run claude — nothing to change."; else`,
    `  if grep -qs 'export PATH=.*\.local/bin' "${rc}"; then echo "The PATH export is already in ${rc}";`,
    `  else printf '\\nexport PATH="$HOME/.local/bin:$PATH"\\n' >> "${rc}" && echo "Added ~/.local/bin to ${rc}"; fi`,
    `fi`,
    `export PATH="$HOME/.local/bin:$PATH"`,
    // prove it against a FRESH shell — this one was fixed by the export above no matter what
    // landed in any file, so testing here would always say yes
    `if ${probe} >/dev/null 2>&1; then`,
    `  echo ""; echo "A new terminal can now run claude: $(claude --version 2>/dev/null | head -1)";`,
    `  echo "Go back to Setup — this check will pass.";`,
    `else`,
    `  echo ""; echo "A new terminal still cannot run claude.";`,
    `  ${bashy ? 'bash -lc true' : 'zsh -ilc true'} 2>&1 >/dev/null | grep -m1 -E '\\.(zshrc|zprofile):[0-9]+' && echo "^ your shell startup reports this — fix that line";`,
    `fi`,
  ].join('\n');
}

/**
 * The PERSISTED PATH — Machine + User, as a NEW terminal would assemble it.
 *
 * This is the Windows shape of the POSIX lesson that a check must never out-claim the terminal
 * beside it. `process.env.Path` is the copy this app inherited at launch; an installer that ran
 * afterwards (or our own PATH remedy) writes the registry, and the running app never sees it —
 * so Setup would go on reporting "not on PATH" for a fix that had genuinely worked. .NET expands
 * the REG_EXPAND_SZ entries for us, so `%USERPROFILE%\…` arrives resolved. Short TTL because it
 * is read on the readiness poll and it costs a PowerShell launch.
 */
const winPersistedPath = ttlMemo((): string[] => {
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')"],
    { encoding: 'utf8', timeout: 6000, stdio: ['ignore', 'pipe', 'ignore'] });
    const dirs = out.split(';').map((s) => s.trim().replace(/^"|"$/g, '')).filter(Boolean);
    if (dirs.length) return dirs;
  } catch { /* fall back to this process's copy — stale, but better than nothing */ }
  return (process.env.Path || process.env.PATH || '').split(';').map((s) => s.trim()).filter(Boolean);
}, 10000);

/**
 * Every directory a Windows claude install lands in — ONE list, because two lists drift.
 *
 * They did: the disk probe knew about %LOCALAPPDATA%\Programs\claude and the PATH remedy did
 * not, so a claude installed there produced "installed but not on your PATH" from the check and
 * "could not find claude on this machine" from the fix offered to repair it. A dead loop with no
 * way forward, which is the exact shape of failure the POSIX branches were hardened against.
 * Both callers derive from here now, so the disagreement cannot come back.
 */
function winClaudeDirs(): string[] {
  const home = os.homedir();
  const appdata = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const localApp = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  return [
    path.join(home, '.local', 'bin'),                 // the native install.ps1
    path.join(home, '.claude', 'local'),              // claude's own local dir
    path.join(appdata, 'npm'),                        // npm -g (the usual case)
    path.join(localApp, 'Programs', 'claude'),        // per-user program install
  ];
}

/**
 * The launcher names Windows can actually EXECUTE, in PATHEXT order.
 *
 * Extensionless `claude` is deliberately absent. npm drops `claude`, `claude.cmd` and
 * `claude.ps1` side by side, and the bare one is a POSIX shim for Git Bash that powershell.exe
 * cannot run — so accepting it reported a green "Claude Code: installed" for a machine where
 * every pane this app opens would answer "not recognized". A location we cannot hand to a pane
 * is not a location.
 */
const WIN_CLAUDE_NAMES = ['claude.exe', 'claude.cmd', 'claude.bat', 'claude.ps1'];

function winClaudeCandidates(): string[] {
  return winClaudeDirs().flatMap((d) => WIN_CLAUDE_NAMES.map((n) => path.join(d, n)));
}

/**
 * claudeLocation, Windows lane. Same three states with the same meanings — the difference is
 * only in what "on PATH" is made of: a PATHEXT-style name sweep over the persisted PATH rather
 * than a shell probe, because there is no rc file to source and no interactive-vs-login split.
 * A binary on disk whose directory IS in the persisted PATH counts as reachable, for exactly the
 * POSIX reason: a NEW TERMINAL WILL RUN IT, which is the only thing "on PATH" promises.
 */
function claudeLocationWin(cmd: string): { where: 'path' | 'disk' | 'none'; bin: string } {
  const dirs = winPersistedPath();
  /* PATHEXT order, and EXECUTABLE EXTENSIONS ONLY — no extensionless fallback. npm installs
     `claude`, `claude.cmd` and `claude.ps1` side by side, and the bare one is a bash shim that
     powershell.exe cannot execute; accepting it turned a machine where no pane can run claude
     into a green PASS. `claude` typed at a prompt resolves through PATHEXT to the .cmd, so that
     is what "where claude is" has to mean. */
  const exts = ['.exe', '.cmd', '.bat', '.ps1'];
  for (const d of dirs) {
    for (const e of exts) {
      const p = path.join(d, cmd + e);
      try { if (fs.statSync(p).isFile()) return { where: 'path', bin: p }; } catch { /* next */ }
    }
  }
  const onPath = new Set(dirs.map((d) => d.replace(/[\\/]+$/, '').toLowerCase()));
  for (const p of winClaudeCandidates()) {
    try { if (!fs.statSync(p).isFile()) continue; } catch { continue; }
    return onPath.has(path.dirname(p).toLowerCase()) ? { where: 'path', bin: p } : { where: 'disk', bin: p };
  }
  return { where: 'none', bin: '' };
}

/**
 * Where Claude Code actually is. Observed on a real newcomer machine: the official installer
 * SUCCEEDS, puts the binary at ~/.local/bin/claude, and then prints a shell one-liner for the
 * operator to paste because it does not add ~/.local/bin to PATH itself.
 *
 * So "not on PATH" and "not installed" are different states with different fixes, and
 * conflating them told an operator who had just installed Claude that Claude was missing.
 */
export function claudeLocation(): { where: 'path' | 'disk' | 'none'; bin: string; rcBroken?: string } {
  const cmd = shellSettings().claudeCmd;
  if (process.platform === 'win32') return claudeLocationWin(cmd);
  let rcBroken = '';
  try {
    /* Probe the way a REAL TERMINAL resolves commands, which is not the same as a login shell.
       Measured, after the earlier note here got it wrong: zsh reads ~/.zshrc only for
       INTERACTIVE shells, and .zshrc is exactly where Claude's installer and our own PATH
       remedy write. So `zsh -lc` could not see a fix that had genuinely worked — the remedy
       printed "Claude is ready", a new terminal ran claude fine, and the doctor went on
       reporting "not on PATH" with no way forward. A check that contradicts the terminal beside
       it is worse than no check: the operator is told the thing they just fixed is still broken.
         zsh -lc  'command -v aiosmarker' → not found
         zsh -ilc 'command -v aiosmarker' → ~/bin/aiosmarker
       Non-interactive first because it is faster and catches a system-PATH install; interactive
       second because it is what the pty actually is. */
    const sh = operatorShell();
    /* THREE forms, because one of them keeps being wrong on somebody else's machine. The rule the
       operator sees is simple — "a new terminal can run claude" — and each form fails differently:
         -lc            misses ~/.zshrc entirely (zsh reads it only when interactive)
         -lc + source   reads it WITHOUT needing a tty, which an -i shell can require
         -ilc           closest to a real terminal, but an interactive shell with no tty can exit
                        non-zero on some rc files, and a throw here reads as "not installed"
       Reported twice now as "the terminal found claude, Setup still says it is not on PATH" —
       which is the worst shape a check can take: it contradicts the evidence in front of the
       operator and leaves no way forward. */
    const rc = process.env.SHELL?.includes('bash') ? '~/.bash_profile' : '~/.zshrc';
    for (const args of [
      ['-lc', `command -v ${cmd}`],
      ['-lc', `[ -f ${rc} ] && . ${rc} >/dev/null 2>&1; command -v ${cmd}`],
      ['-ilc', `command -v ${cmd}`],
    ]) {
      try {
        const found = execFileSync(sh, args, { encoding: 'utf8', timeout: 6000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        const hit = found.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('/')).pop();
        if (hit) return { where: 'path', bin: hit };
      } catch { /* try the next form */ }
    }
    /* Is the operator's own shell startup BROKEN? This is not a corner case: an accumulated
       .zshrc is often hundreds of lines, and zsh treats an unmatched glob as fatal — one bad
       line discards everything after it. Observed as `.zshrc:485: no matches found: *buddy*`,
       which silently threw away the PATH export appended at the end of that same file.
       It matters here because it decides whether the rc scan below can be trusted at all. */
    try {
      const errOut = execFileSync(sh, ['-ilc', 'true'], { encoding: 'utf8', timeout: 6000, stdio: ['ignore', 'ignore', 'pipe'] });
      void errOut;
    } catch (e) {
      const msg = String((e as { stderr?: Buffer }).stderr ?? '');
      const m = /(\.[a-z_]+):(\d+):(.*)/.exec(msg);
      if (m) rcBroken = `${m[1]}:${m[2]}${m[3] ? ' —' + m[3].slice(0, 60) : ''}`;
    }
  } catch { /* fall through to the disk probe */ }
  for (const p of [
    path.join(os.homedir(), '.local', 'bin', 'claude'),
    path.join(os.homedir(), '.claude', 'local', 'claude'),
  ]) {
    try {
      if (!fs.statSync(p).isFile()) continue;
      /* On disk. Before calling it unreachable — the verdict that stalls setup — check whether the
         operator's own shell startup files put its directory on PATH. If they do, a new terminal
         WILL run claude, which is the only thing "on PATH" is meant to mean. Every probe above
         spawns a shell and can be defeated by that shell's environment; this reads the file the
         installer actually wrote, so it cannot disagree with the terminal the operator is looking
         at. Reported twice as "the terminal says found, Setup says not on PATH". */
      const dir = path.dirname(p);
      const rel = dir.replace(os.homedir(), '$HOME');
      for (const f of ['.zshrc', '.zprofile', '.bash_profile', '.profile']) {
        try {
          const text = fs.readFileSync(path.join(os.homedir(), f), 'utf8');
          if (!text.includes(dir) && !text.includes(rel)) continue;
          /* The directory IS named in a startup file — but only trust that if the file actually
             runs to completion. This is the correction to my own fix: scanning the rc turned a
             false negative into a FALSE POSITIVE on the one machine that mattered, reporting
             "on PATH" while the terminal beside it said "command not found", because the rc
             died at line 485 and never reached the export. An rc that aborts is worse than one
             that says nothing, and a check must not out-claim the shell it describes. */
          if (rcBroken) return { where: 'disk', bin: p, rcBroken };
          return { where: 'path', bin: p };
        } catch { /* no such rc */ }
      }
      return rcBroken ? { where: 'disk', bin: p, rcBroken } : { where: 'disk', bin: p };
    } catch { /* next */ }
  }
  return { where: 'none', bin: '' };
}

function readinessUncached(): Readiness {
  const loc = claudeLocation();
  // on disk but not on PATH is NOT ready: a spawned login shell still cannot run `claude`
  const claude = loc.where === 'path';
  const r = frameworkRoot();
  const v = vaultRoot();
  const vault = !!v && v !== r;   // vaultRoot() falls back to the framework root when absent
  const cj = readJson(claudeJsonPath()) as { oauthAccount?: { emailAddress?: string } };
  const signedIn = !!cj?.oauthAccount?.emailAddress;
  /* Reported ALONGSIDE `ready`, deliberately not folded into it. `ready` answers "can a claude
     command run at all" — the four mechanical facts. `personalized` answers "should it" — a
     ritual on a template vault runs perfectly and produces a plan for a person who does not
     exist yet. Two different questions, so two fields: the gate can refuse a ritual while the
     setup session itself, which needs the same four facts, still passes. */
  const personalized = personalization().ok;
  return { claude, claudeWhere: loc.where, framework: !!r, vault, signedIn, personalized, ready: claude && !!r && vault && signedIn };
}
export const readiness = ttlMemo(readinessUncached, 4000);

// ── frequent tasks (defaults ported from the extension + vault state merge) ──

export interface FreqTaskLite { id: string; label: string; kind: string; target: string; hint: string; assignment?: string; }

// Labels/hints localized at call time (see frequentTasks()); targets stay literal.
const DEFAULT_TASK_SPECS: { id: string; kind: string; target: string }[] = [
  { id: 'email', kind: 'agent', target: 'email-drafter' },
  { id: 'post', kind: 'agent', target: 'content-writer' },
  { id: 'deck', kind: 'agent', target: 'deck-builder' },
  { id: 'research', kind: 'agent', target: 'market-researcher' },
  { id: 'meeting', kind: 'agent', target: 'meeting-prepper' },
  { id: 'clarity', kind: 'agent', target: 'decision-journaler' },
  { id: 'ingest', kind: 'command', target: 'ingest' },
  { id: 'infographic', kind: 'skill', target: 'infographic-builder' },
];
function defaultTasks(): FreqTaskLite[] {
  return DEFAULT_TASK_SPECS.map((s) => ({ ...s, label: t('freq.' + s.id), hint: t('freq.' + s.id + 'Hint') }));
}

export function frequentTasks(): FreqTaskLite[] {
  const r = frameworkRoot();
  let saved: FreqTaskLite[] | undefined;
  let removed: string[] = [];
  if (r) {
    try {
      const st = JSON.parse(fs.readFileSync(path.join(r, '.glass', 'state.json'), 'utf8'));
      saved = st['aios.frequentTasks.v1'];
      removed = st['aios.frequentTasks.removed.v1'] || [];
    } catch { /* none */ }
  }
  const rm = new Set(removed);
  const base = saved ? [...saved] : [];
  const have = new Set(base.map((x) => x.id));
  for (const d of defaultTasks()) if (!have.has(d.id) && !rm.has(d.id)) base.push(d);
  return base;
}

/**
 * Add and remove frequent tasks. Both write the SAME two keys the Glass extension uses in
 * `.glass/state.json`, so the two surfaces share one list rather than each keeping its own:
 * edit it here and it is there, and vice versa.
 *
 * `removed` matters more than it looks: deleting a DEFAULT has to be recorded, or the merge
 * in frequentTasks() helpfully puts it back on the next read and the delete looks broken.
 */
export function addFrequentTask(task: { label: string; kind: string; target: string; hint?: string; assignment?: string }): FreqTaskLite[] {
  const label = String(task.label || '').trim();
  const target = String(task.target || '').trim();
  if (!label || !target) return frequentTasks();
  const list = frequentTasks();
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'task';
  list.push({
    id: `u-${slug}-${list.length}`,          // the same id shape Glass writes
    label, kind: String(task.kind || 'prompt'), target,
    hint: String(task.hint || task.assignment || target).slice(0, 70),
    ...(task.assignment ? { assignment: String(task.assignment) } : {}),
  });
  setGlassState('aios.frequentTasks.v1', list);
  return frequentTasks();
}

export function removeFrequentTask(id: string): FreqTaskLite[] {
  const keep = frequentTasks().filter((x) => x.id !== id);
  setGlassState('aios.frequentTasks.v1', keep);
  // record it, so a removed DEFAULT is not re-merged on the next read
  const removed: string[] = (glassState()['aios.frequentTasks.removed.v1'] as string[] | undefined) || [];
  if (!removed.includes(id)) setGlassState('aios.frequentTasks.removed.v1', [...removed, id]);
  return frequentTasks();
}

// ── agent suggestions (ported from goWithAgents — both agent- and command-routed) ──

export interface AgentSuggestion { task: string; agent?: string; command?: string; url?: string; raw: string; }

export function listAgentSuggestions(): AgentSuggestion[] {
  const note = latestDailyNote();
  if (!note) return [];
  let md = '';
  try { md = fs.readFileSync(note, 'utf8'); } catch { return []; }
  // Same parser as the badge count — they cannot disagree. Map the Glass-shaped
  // suggestion to the renderer's contract (single agent + url alias).
  return parseAgentSection(md).map((s) => ({
    task: s.task.slice(0, 120),
    agent: s.agents[0],
    command: s.command,
    url: s.arg,
    raw: s.raw,
  }));
}

// ── the "Needs you" inbox — consolidated attention + STATEFUL dismissal ──────
//
// One pulse card gathers everything waiting on the operator: sessions blocked
// on input, open go-with-agents suggestions, the active nudge, and (composed
// async by panelHost) the framework-update badge. Dismissal is stateful via
// the pure keying model in src/core/inbox.ts: dismissing hides an item UNTIL
// it changes again (the dismissal stores the item's change signature and
// auto-expires the moment the live signature differs). Persisted in
// `.glass/state.json`, so it roams with the vault like the sort prefs.

const INBOX_DISMISS_KEY = 'aios.inbox.dismissed.v1';

export interface InboxItem {
  key: string;
  kind: 'session' | 'suggestion' | 'nudge' | 'update';
  icon: string;
  label: string;
  detail?: string;
  /** Change signature — dismissal hides the item until this changes again. */
  sig: string;
  /** session items: the registry name (the renderer focuses/resumes by it). */
  name?: string;
  /** nudge items: the slash command a click runs. */
  command?: string;
  nudgeKind?: string;
}

export function inboxDismissals(): InboxDismissals {
  const raw = glassState()[INBOX_DISMISS_KEY];
  return raw && typeof raw === 'object' ? (raw as InboxDismissals) : {};
}

export function dismissInboxItem(key: string, sig: string): void {
  if (!key) return;
  setGlassState(INBOX_DISMISS_KEY, dismissInboxEntity(inboxDismissals(), key, sig));
}

// The same "waiting on the operator" signal the renderer's blue dot uses.
const NEEDS_INPUT_RE = /wait|input|prompt|\bask\b|attention|approv|permission|block/;

/** The synchronous inbox battery (sessions · suggestions · nudge), already
 *  filtered by dismissals. `running`/`hour`/`weekday` are injectable so tests
 *  never depend on this machine's live sessions or the wall clock. */
export function inboxItems(
  running: RunningAgent[] = listRunningAgents(),
  hour = new Date().getHours(),
  weekday = new Date().getDay(),
): InboxItem[] {
  const all: InboxItem[] = [];
  // 1 · sessions blocked on the operator
  for (const a of running) {
    if (!NEEDS_INPUT_RE.test((a.status || '').toLowerCase())) continue;
    all.push({ key: 'session:' + a.name, kind: 'session', icon: '💬', label: t('inbox.sessionNeedsInput', { name: a.name }), detail: a.status, sig: a.status, name: a.name });
  }
  // 2 · open go-with-agents suggestions from today's note (per-item dismissal;
  //     the raw line is the signature — edit the task, it resurfaces)
  for (const s of listAgentSuggestions().slice(0, 4)) {
    all.push({ key: 'suggestion:' + taskIdentity(s.raw), kind: 'suggestion', icon: '🤖', label: s.task, detail: s.agent ? '→ ' + s.agent : s.command, sig: s.raw });
  }
  // 3 · the active nudge (the standalone whisper hides while the inbox shows it)
  if (shellSettings().showNudges) {
    const n = nudgeState(hour, weekday, running.length);
    if (n) all.push({ key: 'nudge:' + n.kind, kind: 'nudge', icon: n.icon, label: (n.cmdLabel ? n.cmdLabel + ' — ' : '') + (n.label || ''), sig: n.kind + '|' + (n.label || ''), command: n.command, nudgeKind: n.kind });
  }
  const dismissed = inboxDismissals();
  const items = all.filter((i) => !isInboxEntityDismissed(dismissed, i.key, i.sig));
  // prune dismissals whose item no longer exists ('update' is always live-able —
  // it is composed async by panelHost, so its key is kept)
  const pruned = pruneInboxDismissals(dismissed, all.map((i) => i.key).concat('update'));
  if (JSON.stringify(pruned) !== JSON.stringify(dismissed)) setGlassState(INBOX_DISMISS_KEY, pruned);
  return items;
}

/** The framework-update inbox row — composed by panelHost AFTER its async
 *  checkForUpdates(). The signature is the LOCAL hash: running the update
 *  moves the hash, which auto-expires the dismissal. */
export function updateInboxItem(state: 'up-to-date' | 'available' | 'unknown'): InboxItem | null {
  if (state !== 'available') return null;
  const hash = readFrameworkStatus()?.hash || '';
  const item: InboxItem = { key: 'update', kind: 'update', icon: '↓', label: t('inbox.updateAvailable'), detail: t('inbox.updateDetail'), sig: hash };
  return isInboxEntityDismissed(inboxDismissals(), item.key, item.sig) ? null : item;
}

// ── starter packs (persona → a preseeded Home) ──────────────────────────────
//
// The Onboarding "starter" step: pick who you are — personal/family vs
// founder/operator — and the pack preselects frequent tasks (from
// DEFAULT_TASK_SPECS, so labels stay localized) + suggests 2–3 agents + seeds
// `.glass/state.json`, so a fresh Home shows the operator's buttons on day
// one. Persona content lives as a small JSON per persona (src/main/personas/).

export interface StarterPack { id: string; tasks: string[]; agents: string[]; }

const STARTER_PACKS: StarterPack[] = [personaPersonal as StarterPack, personaFounder as StarterPack];
const STARTER_KEY = 'aios.starterPack.v1';

export function starterPacks(): StarterPack[] {
  return STARTER_PACKS.map((p) => ({ id: p.id, tasks: [...p.tasks], agents: [...p.agents] }));
}

export function starterPackState(): { id: string; at: string; agents?: string[] } | null {
  const raw = glassState()[STARTER_KEY];
  return raw && typeof raw === 'object' ? (raw as { id: string; at: string; agents?: string[] }) : null;
}

/** Apply a persona: seed the frequent-task state so Home shows the operator's
 *  buttons. `skip` records the choice without seeding (the step passes empty).
 *  Idempotent — re-applying re-seeds. Returns what was seeded, or null for an
 *  unknown id. */
export function applyStarterPack(id: string): { id: string; tasks: number; agents: string[] } | null {
  const iso = todayLocalIso();
  if (id === 'skip') {
    setGlassState(STARTER_KEY, { id: 'skipped', at: iso });
    return { id: 'skipped', tasks: 0, agents: [] };
  }
  const pack = STARTER_PACKS.find((p) => p.id === id);
  if (!pack) return null;
  const byId = new Map(defaultTasks().map((d) => [d.id, d]));
  const tasks = pack.tasks.map((tid) => byId.get(tid)).filter((x): x is FreqTaskLite => !!x);
  setGlassState('aios.frequentTasks.v1', tasks);
  // remove every non-pack default — across BOTH default lists (the merge list
  // in frequentTasks and the wider badge list in frequentTaskCount), so the
  // Home badge and the picker agree on the persona's set
  const allDefaults = [...new Set([...DEFAULT_TASK_IDS, ...DEFAULT_TASK_SPECS.map((s) => s.id)])];
  setGlassState('aios.frequentTasks.removed.v1', allDefaults.filter((tid) => !pack.tasks.includes(tid)));
  setGlassState(STARTER_KEY, { id: pack.id, at: iso, agents: [...pack.agents] });
  return { id: pack.id, tasks: tasks.length, agents: [...pack.agents] };
}

// ── Agent/Skill Designer (compose in src/core/designer.ts — this is the fs glue) ──

export interface DesignerEntry { name: string; description: string; group: string; path: string; custom: boolean; }

/**
 * Read one of the operator's own units back into the Designer's fields, so "update mine"
 * starts from what's actually there instead of a blank Instructions box (the catalog only
 * carries name + description — the body lives in the file).
 *
 * agent/skill → the markdown BELOW the frontmatter is the instruction text.
 * plugin      → a folder, so there is no single body: summarise the manifest + the
 *               commands it ships, which is what an operator would want to amend.
 */
export function designerRead(relPath: string): { description: string; body: string } | null {
  const root = frameworkRoot();
  if (!root || !relPath || relPath.includes('..')) return null;
  const abs = path.join(root, relPath);
  if (!abs.startsWith(root)) return null;             // never read outside the framework
  try {
    if (fs.statSync(abs).isDirectory()) {             // a plugin
      let description = '';
      try {
        const man = JSON.parse(fs.readFileSync(path.join(abs, '.claude-plugin', 'plugin.json'), 'utf8'));
        description = String(man?.description || '');
      } catch { /* manifest may be absent */ }
      let cmds: string[] = [];
      try { cmds = fs.readdirSync(path.join(abs, 'commands')).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, '')); } catch { /* none */ }
      const body = cmds.length ? `Commands it ships: ${cmds.join(', ')}.` : '';
      return { description, body };
    }
    const raw = fs.readFileSync(abs, 'utf8');
    const fm = parseFrontmatter(raw);
    // drop the leading --- … --- block; what remains is the instruction body
    const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
    return { description: String(fm.description || ''), body };
  } catch { return null; }
}

/**
 * The Designer's catalog for one kind: every unit the operator can borrow the SHAPE of
 * (bundled) or UPDATE (their own, under `custom/`). The app reads; `aios-builder` writes.
 * Paths come back relative to the framework root — that's what the brief quotes.
 */
export function designerCatalog(kind: string): DesignerEntry[] {
  const root = frameworkRoot();
  if (!root) return [];
  const rel = (abs: string) => (abs.startsWith(root) ? abs.slice(root.length).replace(/^\/+/, '') : abs);
  const isCustom = (p: string) => /(^|\/)custom(\/|$)/.test(p);
  if (kind === 'agent') {
    return discoverAgents().map((a) => ({ name: a.name, description: a.description, group: a.group, path: rel(a.filePath), custom: isCustom(rel(a.filePath)) }));
  }
  if (kind === 'skill') {
    return discoverSkills().map((s) => ({ name: s.name, description: s.description, group: s.group, path: rel(s.filePath), custom: isCustom(rel(s.filePath)) }));
  }
  if (kind === 'command') {
    // A command is a file INSIDE a plugin (`<plugin>/commands/<name>.md`) — so list the
    // commands, labelled the way the operator invokes them (`/plugin:name`), not the
    // plugin folders. Only custom ones are editable.
    const out: DesignerEntry[] = [];
    const scanPlugin = (pluginRel: string, handle: string, custom: boolean): void => {
      let files: string[] = [];
      try { files = fs.readdirSync(path.join(root, pluginRel, 'commands')); } catch { return; }
      for (const f of files) {
        if (!f.endsWith('.md') || f.startsWith('_')) continue;
        const slug = f.replace(/\.md$/, '');
        const p = path.join(pluginRel, 'commands', f);
        let description = '';
        try { description = String(parseFrontmatter(fs.readFileSync(path.join(root, p), 'utf8')).description || ''); } catch { /* fine */ }
        out.push({ name: `${handle}:${slug}`, description, group: custom ? 'custom' : handle, path: p, custom });
      }
    };
    for (const [dir, custom] of [['plugins', false], [path.join('plugins', 'custom'), true]] as const) {
      let names: string[] = [];
      try { names = fs.readdirSync(path.join(root, dir)); } catch { continue; }
      for (const n of names) {
        if (n.startsWith('.') || n === 'custom') continue;
        const p = path.join(dir, n);
        try { if (!fs.statSync(path.join(root, p)).isDirectory()) continue; } catch { continue; }
        scanPlugin(p, n, custom);
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }
  return [];
}

/** The operator's own plugin handles — a new command joins one rather than minting another. */
export function customPluginHandles(): string[] {
  const root = frameworkRoot();
  if (!root) return [];
  try {
    return fs.readdirSync(path.join(root, 'plugins', 'custom'))
      .filter((n) => !n.startsWith('.') && !n.startsWith('_'))
      .filter((n) => { try { return fs.statSync(path.join(root, 'plugins', 'custom', n)).isDirectory(); } catch { return false; } });
  } catch { return []; }
}

// ── file index for quick-open (allowed roots, capped) ───────────────────────

export interface IndexedFile { name: string; path: string; root: string; }

// ── git status for the explorer (live M/U/A/D markers) ──────────────────────

const GIT_ALWAYS_HIDE = new Set(['node_modules', 'out', 'dist', '.git', '.DS_Store', '.venv', '__pycache__']);

/** Nearest ancestor (incl. self) holding a `.git` — the repo root, or undefined. */
function repoRootOf(dir: string): string | undefined {
  let d = dir;
  for (let i = 0; i < 40; i++) {
    try { if (fs.existsSync(path.join(d, '.git'))) return d; } catch { /* keep walking */ }
    const parent = path.dirname(d);
    if (parent === d) break;
    d = parent;
  }
  return undefined;
}

const repoListCache = new Map<string, { at: number; repos: string[] }>();
/** Repos under a root: the root itself if it's (in) a repo, else a bounded scan
 *  for nested `.git`s (a non-repo container like `~/code`). Cached ~20s. */
function reposUnder(rootPath: string): string[] {
  const own = repoRootOf(rootPath);
  if (own) return [own];
  const c = repoListCache.get(rootPath);
  const now = Date.now();
  if (c && now - c.at < 20000) return c.repos;
  const repos: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 6) return;
    let names: string[] = [];
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const name of names) {
      if (GIT_ALWAYS_HIDE.has(name) || name.startsWith('.')) continue;
      const full = path.join(dir, name);
      try { if (!fs.statSync(full).isDirectory()) continue; } catch { continue; }
      if (fs.existsSync(path.join(full, '.git'))) repos.push(full);
      else walk(full, depth + 1);
    }
  };
  walk(rootPath, 0);
  repoListCache.set(rootPath, { at: now, repos });
  return repos;
}

const gitCache = new Map<string, { at: number; files: Map<string, string> }>();
/** `git status --porcelain` for a repo → abs-path → code map. Cached ~2s. */
function gitStatusOne(repoRoot: string): Map<string, string> {
  const cached = gitCache.get(repoRoot);
  const now = Date.now();
  if (cached && now - cached.at < 2000) return cached.files;
  const files = new Map<string, string>();
  let out = '';
  try { out = execFileSync('git', ['-C', repoRoot, 'status', '--porcelain'], { encoding: 'utf8', timeout: 4000, maxBuffer: 1 << 22 }); }
  catch { gitCache.set(repoRoot, { at: now, files }); return files; }
  for (const line of out.split('\n')) {
    if (line.length < 4) continue;
    const xy = line.slice(0, 2);
    let p = line.slice(3);
    if (p.includes(' -> ')) p = p.split(' -> ')[1];
    p = p.replace(/^"(.*)"$/, '$1').replace(/\/$/, '');
    const abs = path.join(repoRoot, p);
    const code = xy.includes('?') ? 'U' : xy.includes('A') ? 'A' : xy.includes('D') ? 'D' : xy.includes('R') ? 'R' : 'M';
    files.set(abs, code);
  }
  gitCache.set(repoRoot, { at: now, files });
  return files;
}

export interface GitSnapshot { files: Record<string, string>; dirty: string[]; repos: string[]; }
/** A snapshot the renderer reconciles onto rendered rows: changed files (abs→code)
 *  + every ancestor folder up to each root (dirty), + the roots covered. */
// #40 The whole snapshot is TTL-cached. gitStatusOne shells `git status` SYNCHRONOUSLY
// per repo, and the repo walk descends 6 levels — so on a root like ~/code (dozens of
// repos) an uncached call blocks the main process long enough to freeze the window,
// which is the "hard loading time" when adding a workspace folder. Explorer paints and
// fs watcher events both ask for status repeatedly; one short-lived snapshot serves
// them all. (The repo LIST was already cached; the expensive status pass wasn't.)
let gitSnapCache: { key: string; at: number; snap: GitSnapshot } | null = null;
/* Changed LINE RANGES for one file, for the editor's gutter — `git diff -U0` gives hunk
   headers with no context, so `@@ -a,b +c,d @@` maps straight onto working-file lines.
   Both diffs are read: unstaged AND --cached, because a file can be partly staged and the
   operator wants to see everything not yet committed, not everything not yet staged.
   An untracked file reports its whole length as added — the honest answer, and cheap.
   Cached for 2s like gitStatusOne, since the gutter repaints on every keystroke. */
const diffCache = new Map<string, { at: number; ranges: Array<[number, number]> }>();
export function gitDirtyLines(absFile: string): Array<[number, number]> {
  const now = Date.now();
  const hit = diffCache.get(absFile);
  if (hit && now - hit.at < 2000) return hit.ranges;
  const ranges: Array<[number, number]> = [];
  const root = repoRootOf(path.dirname(absFile));
  if (!root) { diffCache.set(absFile, { at: now, ranges }); return ranges; }
  const rel = path.relative(root, absFile);
  const run = (args: string[]): string => {
    try { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 4000, maxBuffer: 1 << 22 }); }
    catch { return ''; }
  };
  // untracked → every line is new
  const tracked = run(['ls-files', '--error-unmatch', '--', rel]).trim().length > 0;
  if (!tracked) {
    try {
      const n = fs.readFileSync(absFile, 'utf8').split('\n').length;
      ranges.push([1, Math.max(1, n)]);
    } catch { /* unreadable — no marks */ }
    diffCache.set(absFile, { at: now, ranges });
    return ranges;
  }
  for (const args of [['diff', '-U0', '--', rel], ['diff', '-U0', '--cached', '--', rel]]) {
    for (const line of run(args).split('\n')) {
      // @@ -12,3 +12,4 @@  → the +side is the working file. A count of 0 means a pure
      // DELETION at that point: mark the surviving line so the change is still visible.
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m) continue;
      const start = Number(m[1]);
      const count = m[2] === undefined ? 1 : Number(m[2]);
      ranges.push(count === 0 ? [Math.max(1, start), Math.max(1, start)] : [start, start + count - 1]);
    }
  }
  diffCache.set(absFile, { at: now, ranges });
  return ranges;
}

export function gitStatusForRoots(roots: string[]): GitSnapshot {
  const key = roots.join(' ');
  const now = Date.now();
  if (gitSnapCache && gitSnapCache.key === key && now - gitSnapCache.at < 4000) return gitSnapCache.snap;
  const snap = computeGitStatusForRoots(roots);
  gitSnapCache = { key, at: now, snap };
  return snap;
}
function computeGitStatusForRoots(roots: string[]): GitSnapshot {
  const files: Record<string, string> = {};
  const dirty = new Set<string>();
  const covered: string[] = [];
  const ignored = ignoreMatchers(shellSettings().ignorePaths);
  // A file under an ignored path segment (e.g. `_archive/…`) contributes no
  // status and no dirty propagation — so ignored folders never raise a
  // pending-commit bubble on themselves or their ancestors.
  // Separator-agnostic: Windows paths arrive with backslashes, so splitting on '/' alone left
  // the whole relative path as ONE segment and no ignore rule could ever match it.
  const underIgnored = (abs: string, root: string): boolean =>
    abs.slice(root.length).replace(/^[\\/]+/, '').split(/[\\/]/).some((seg) => ignored.some((re) => re.test(seg)));
  for (const root of roots) {
    covered.push(root);
    for (const r of reposUnder(root)) {
      for (const [abs, code] of gitStatusOne(r)) {
        if (underIgnored(abs, root)) continue;
        files[abs] = code;
        for (let d = path.dirname(abs); d.startsWith(root) && d.length >= root.length; d = path.dirname(d)) {
          dirty.add(d);
          if (d === root) break;
        }
      }
    }
  }
  return { files, dirty: [...dirty], repos: covered };
}

// ── plugins / marketplace (the AIOS Partner Network) ────────────────────────
//
// The shell is glass: it never reimplements `claude plugin`. It READS Claude
// Code's own plugin state (installed_plugins.json / known_marketplaces.json)
// and surfaces a curated catalog (the-aios.org/plugins — plugins + credentials,
// vendors + coaches). Install/update runs the real CLI in a visible terminal.

export interface InstalledPlugin { id: string; name: string; marketplace: string; version: string; updatedAt: string; }

export function installedPlugins(): InstalledPlugin[] {
  const p = path.join(claudeDir(), 'plugins', 'installed_plugins.json');
  let raw: { plugins?: Record<string, Array<{ version?: string; lastUpdated?: string }>> };
  try { raw = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return []; }
  const out: InstalledPlugin[] = [];
  for (const [id, entries] of Object.entries(raw.plugins ?? {})) {
    const [name, marketplace = 'local'] = id.split('@');
    const e = Array.isArray(entries) ? entries[0] : undefined;
    out.push({ id, name, marketplace, version: String(e?.version ?? 'unknown'), updatedAt: String(e?.lastUpdated ?? '') });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export interface KnownMarketplace { name: string; source: string; repo: string; }

export function knownMarketplaces(): KnownMarketplace[] {
  const p = path.join(claudeDir(), 'plugins', 'known_marketplaces.json');
  let raw: Record<string, { source?: { source?: string; repo?: string; path?: string } }>;
  try { raw = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return []; }
  return Object.entries(raw).map(([name, v]) => ({
    name,
    source: v.source?.source ?? '',
    repo: v.source?.repo ?? v.source?.path ?? '',
  })).sort((a, b) => a.name.localeCompare(b.name));
}

export interface CatalogPlugin {
  id: string; name: string; displayName: string; description: string;
  marketplace: string; marketplaceRepo: string; badge: string; status: 'available' | 'soon';
}

/**
 * The curated front shelf. The AIOS plugin itself is the genuine, installable
 * anchor; the Partner Network entries are scaffolds for the marketplace that's
 * "opening soon" at the-aios.org/plugins — they teach the install gesture and
 * point partners to where they'll set up shop. Marked status:'soon' so the UI
 * never promises an install that can't run yet.
 */
export function pluginCatalog(): CatalogPlugin[] {
  return [
    {
      id: 'aios@the-aios', name: 'aios', displayName: 'AIOS — Daily Ritual & Strategic OS',
      description: 'The framework itself: daily ritual, strategic reviews, insight mining, accountability, multi-company mounting.',
      marketplace: 'the-aios', marketplaceRepo: 'The-AIOS/aios', badge: 'Official', status: 'available',
    },
    {
      id: 'frontend-design@claude-plugins-official', name: 'frontend-design', displayName: 'Frontend Design (Anthropic)',
      description: 'Distinctive, production-grade frontend interfaces. From Anthropic’s official plugin marketplace.',
      marketplace: 'claude-plugins-official', marketplaceRepo: 'anthropics/claude-plugins-official', badge: 'Anthropic', status: 'available',
    },
    {
      id: 'document-skills@anthropic-agent-skills', name: 'document-skills', displayName: 'Document Skills (Anthropic)',
      description: 'Create and edit Word, Excel, PowerPoint, and PDF documents from inside Claude Code.',
      marketplace: 'anthropic-agent-skills', marketplaceRepo: 'anthropics/skills', badge: 'Anthropic', status: 'available',
    },
    {
      id: 'coach@the-aios', name: 'coach', displayName: 'AIOS Coach Plugin',
      description: 'A coach’s methodology, rituals, and frameworks delivered as an AIOS plugin. Part of the AIOS Partner Network.',
      marketplace: 'the-aios', marketplaceRepo: 'The-AIOS/aios', badge: 'Coach', status: 'soon',
    },
    {
      id: 'partner@the-aios', name: 'partner', displayName: 'Plugin Partner Kit',
      description: 'Ship your own commands, agents, and credentials to AIOS operators. Become a Plugin Partner at the-aios.org/plugins.',
      marketplace: 'the-aios', marketplaceRepo: 'The-AIOS/aios', badge: 'Plugin Partner', status: 'soon',
    },
  ];
}

function fileIndexUncached(): IndexedFile[] {
  const roots: { base: string; label: string }[] = [];
  const r = frameworkRoot();
  if (r) roots.push({ base: r, label: 'aios' });
  for (const w of workspaceFolders()) roots.push({ base: w, label: path.basename(w) });
  const out: IndexedFile[] = [];
  const SKIP = new Set(['node_modules', 'out', 'dist', '.git', '.venv', '__pycache__']);
  for (const { base, label } of roots) {
    const stack: [string, number][] = [[base, 0]];
    while (stack.length && out.length < 5000) {
      const [dir, depth] = stack.pop() as [string, number];
      if (depth > 6) continue;
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (e.name.startsWith('.') || SKIP.has(e.name)) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { stack.push([p, depth + 1]); continue; }
        if (/\.(md|html?|pdf|png|jpe?g|svg|json|css|ts|js|txt)$/i.test(e.name)) out.push({ name: e.name, path: p, root: label });
      }
    }
  }
  return out;
}
export const fileIndex = ttlMemo(fileIndexUncached, 10000);
