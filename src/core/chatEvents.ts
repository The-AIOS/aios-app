/**
 * Chat skin — the small pure helpers the usage bar and the tool lines share (no electron, no fs):
 *  (a) parseStatuslinePayload — read the payload Claude Code's statusline dumps to disk;
 *  (b) mergeStatus — build the usage bar's ChatStatus from one or more sources;
 *  (c) summarizeTool — one line saying what a tool call is about.
 * The conversation itself comes from the transcript (core/transcriptChat.ts), not from here.
 *
 * THE RULE FOR EVERY NUMBER HERE: an absent field stays `undefined`. A bar that shows "0%" because
 * a field was missing is a fabricated reading, and the operator would trust it. Nothing in this
 * file defaults a percentage to 0.
 */

// ── the contract (shared by main, preload and renderer) ─────────────────────

export interface ChatStatus {
  fiveHourPct?: number;
  sevenDayPct?: number;
  contextPct?: number;
  /** When the 5-hour / weekly window resets, as Unix SECONDS — only when the payload carries it. Never guessed
   *  from the window length: a reset time we were not given is simply absent. */
  fiveHourResetsAt?: number;
  sevenDayResetsAt?: number;
  /** The context window size in tokens, from the payload (the pane's own used tokens come from its transcript). */
  contextWindow?: number;
  model?: string;
  effort?: string;
  /** Set by `scopeStatusToSession` and carried by `mergeStatus`: true when the statusline payload described the
   *  asking tab's own session, false when it described another one (or when either id is missing). Absent when
   *  nothing was scoped. When false, model/effort/contextPct/contextWindow are NOT in this object at all. */
  sessionMatch?: boolean;
  /** Where the fields came from: the live session, the statusline file, or a blend of both. */
  source: 'sdk' | 'file' | 'mixed';
}

/** A ChatStatus without its provenance — what one source can contribute on its own. */
export type StatusFields = Omit<ChatStatus, 'source'> & {
  /** The session the payload was written for. Parser output only: it is used by `scopeStatusToSession` to decide
   *  what to hide and is never part of a ChatStatus, so it never travels to the renderer. */
  sessionId?: string;
};

// ── small, defensive readers ────────────────────────────────────────────────

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A finite number, or undefined. Numeric strings are NOT accepted: a payload that stringifies a
 *  percentage is a payload we do not understand, and guessing is how a bar lies. */
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

const clampPct = (n: number): number => Math.min(100, Math.max(0, n));

/** A reset instant as Unix seconds. The payload writes seconds; a value that is plainly milliseconds
 *  (after year 5138 as seconds) is scaled down rather than shown as a date in the far future. Zero,
 *  negatives and non-numbers are "not given". */
function epochSeconds(v: unknown): number | undefined {
  const n = num(v);
  if (n === undefined || n <= 0) return undefined;
  return n > 1e11 ? Math.round(n / 1000) : Math.round(n);
}

/** First defined value among dotted paths — the same idea as the statusline hook's
 *  `first_present`, because the payload's field names have moved between Claude Code versions. */
function firstPresent(o: unknown, paths: string[]): unknown {
  for (const p of paths) {
    let cur: unknown = o;
    for (const k of p.split('.')) {
      if (!isObj(cur)) { cur = undefined; break; }
      cur = cur[k];
    }
    if (cur !== undefined && cur !== null) return cur;
  }
  return undefined;
}

// ── (a) the statusline payload ──────────────────────────────────────────────

/**
 * Read `~/.claude/statusline-payload.json` (already read to a string, or parsed). Field paths and
 * fallbacks mirror hooks/statusline.py, which is the only place the payload's shape is verified
 * against a live Claude Code. Garbage in → `{}` out, never a throw, never an invented zero.
 */
export function parseStatuslinePayload(input: unknown): StatusFields {
  let d: unknown = input;
  if (typeof input === 'string') {
    try { d = JSON.parse(input); } catch { return {}; }
  }
  if (!isObj(d)) return {};

  // context: the reported percentage first; else derive it from tokens and the window size
  let context = num(firstPresent(d, [
    'context_window.used_percentage', 'context_window.percentage_used',
    'context.percentage_used', 'context.usage_pct',
  ]));
  if (context === undefined) {
    const used = num(firstPresent(d, ['context_window.total_input_tokens', 'context.tokens_used']));
    const size = num(firstPresent(d, ['context_window.context_window_size', 'context.window_size']));
    if (used !== undefined && size !== undefined && size > 0) context = (used / size) * 100;
  }

  const five = num(firstPresent(d, [
    'rate_limits.five_hour.used_percentage', 'rate_limits.five_hour.percent_used',
    'session_5h.used_percentage', 'session_5h.usage_pct',
  ]));
  const seven = num(firstPresent(d, [
    'rate_limits.seven_day.used_percentage', 'rate_limits.seven_day.percent_used',
    'rate_limits.weekly.used_percentage', 'weekly.usage_pct',
  ]));

  const fiveReset = epochSeconds(firstPresent(d, ['rate_limits.five_hour.resets_at', 'session_5h.resets_at']));
  const sevenReset = epochSeconds(firstPresent(d, ['rate_limits.seven_day.resets_at', 'rate_limits.weekly.resets_at']));
  const windowSize = num(firstPresent(d, ['context_window.context_window_size', 'context.window_size']));

  // `model` is an object ({id, display_name}) in current payloads and a bare string in older ones
  const m = d.model;
  const model = str(firstPresent(d, ['model.display_name', 'model.id'])) ?? str(m);
  const effort = str(firstPresent(d, ['effort.level', 'effort_level', 'effortLevel', 'model.effort_level']));

  const sessionId = str(firstPresent(d, ['session_id', 'sessionId', 'session.id']));

  const out: StatusFields = {};
  if (sessionId !== undefined) out.sessionId = sessionId;
  if (five !== undefined) out.fiveHourPct = clampPct(five);
  if (seven !== undefined) out.sevenDayPct = clampPct(seven);
  if (context !== undefined) out.contextPct = clampPct(context);
  if (fiveReset !== undefined) out.fiveHourResetsAt = fiveReset;
  if (sevenReset !== undefined) out.sevenDayResetsAt = sevenReset;
  if (windowSize !== undefined && windowSize > 0) out.contextWindow = Math.round(windowSize);
  if (model !== undefined) out.model = model;
  if (effort !== undefined) out.effort = effort;
  return out;
}

/** The fields that describe ONE conversation. Everything else in the payload (5-hour and weekly usage and their
 *  resets) belongs to the account and is true whichever session wrote the file. */
const PER_SESSION_FIELDS = ['model', 'effort', 'contextPct', 'contextWindow'] as const;

/**
 * Scope a parsed payload to the tab that is asking. The payload file is global: it is whatever the LAST Claude Code
 * session on the machine wrote, so its model, effort and context describe that session, which may be a different
 * conversation from the tab's. Showing them would put another session's numbers on this tab and look right.
 * So the per-session fields survive only on a positive match: both ids present, non-empty and equal. A missing id on
 * either side counts as "no match" (hide rather than risk showing the wrong session's data). The account-wide
 * fields are always kept. The payload's own sessionId is dropped from the result: the renderer only needs the verdict.
 */
export function scopeStatusToSession(file: StatusFields, tabSessionId: string | null | undefined): StatusFields & { sessionMatch: boolean } {
  const { sessionId, ...rest } = file;
  const sessionMatch = typeof sessionId === 'string' && sessionId !== ''
    && typeof tabSessionId === 'string' && tabSessionId !== ''
    && sessionId === tabSessionId;
  const out: StatusFields = { ...rest };
  if (!sessionMatch) for (const f of PER_SESSION_FIELDS) delete out[f];
  return { ...out, sessionMatch };
}

// ── (b) merging sources ─────────────────────────────────────────────

const FIELDS = ['fiveHourPct', 'sevenDayPct', 'contextPct', 'fiveHourResetsAt', 'sevenDayResetsAt', 'contextWindow', 'model', 'effort'] as const;

/**
 * The live session wins field by field; the file fills what the session cannot know (rate limits
 * and effort are account/CLI facts the SDK stream does not carry). The file is the LAST payload
 * written by ANY Claude Code session on the machine, so for model and context it can describe a
 * different conversation entirely — which is why it is only ever the fallback.
 * `source` says what actually contributed, so the bar can be honest about a stale reading.
 */
export function mergeStatus(sdk: StatusFields | undefined, file: StatusFields | undefined): ChatStatus {
  const out: ChatStatus = { source: sdk ? 'sdk' : 'file' };
  let fromSdk = false;
  let fromFile = false;
  for (const f of FIELDS) {
    const a = sdk?.[f];
    const b = file?.[f];
    if (a !== undefined) { (out as unknown as Obj)[f] = a; fromSdk = true; }
    else if (b !== undefined) { (out as unknown as Obj)[f] = b; fromFile = true; }
  }
  // the scoping verdict is not a data field (it would count as a source): the first source that made one wins
  const verdict = sdk?.sessionMatch ?? file?.sessionMatch;
  if (verdict !== undefined) out.sessionMatch = verdict;
  if (fromSdk && fromFile) out.source = 'mixed';
  else if (fromSdk) out.source = 'sdk';
  else if (fromFile) out.source = 'file';
  return out;
}

// ── (c) one line per tool call ──────────────────────────────────────────────

/** One line saying what a tool call is about — enough to recognise it, not to audit it. */
export function summarizeTool(name: string, input: unknown): string {
  const i = isObj(input) ? input : {};
  const pick = (...keys: string[]): string | undefined => {
    for (const k of keys) { const v = str(i[k]); if (v) return v; }
    return undefined;
  };
  let s: string | undefined;
  switch (name) {
    case 'Bash': case 'PowerShell': s = pick('command'); break;
    case 'Read': case 'Write': case 'Edit': case 'NotebookEdit': s = pick('file_path', 'notebook_path', 'path'); break;
    case 'Glob': case 'Grep': s = pick('pattern'); break;
    case 'WebFetch': s = pick('url'); break;
    case 'WebSearch': s = pick('query'); break;
    case 'Skill': s = pick('skill'); break;
    case 'Agent': case 'Task': s = pick('description', 'prompt'); break;
    default: break;
  }
  if (s === undefined) {
    // an unknown tool: its first string argument is the most informative thing we can show
    for (const v of Object.values(i)) { const t = str(v); if (t) { s = t; break; } }
  }
  if (s === undefined) { try { s = JSON.stringify(input) ?? ''; } catch { s = ''; } }
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > 160 ? s.slice(0, 159) + '…' : s;
}
