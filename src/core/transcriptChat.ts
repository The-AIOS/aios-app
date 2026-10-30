/**
 * Chat skin — turn the lines of a Claude Code transcript (~/.claude/projects/<slug>/<sessionId>.jsonl)
 * into the items a chat view shows. PURE: no electron, no fs; the caller reads the file and hands us
 * lines, so every rule below is testable without a window or a session.
 *
 * The transcript is the single source of truth for the conversation: the pty and its `claude`
 * process are the real session, and this file is what that session writes down as it goes. The
 * chat view never talks to Claude itself, it only reads along.
 *
 * Format, as verified against live transcripts (one JSON object per line):
 *  - `user` / `assistant` / `system` carry the conversation. Everything else (attachment,
 *    api-request, api-request-blob, last-prompt, custom-title, agent-name, mode, permission-mode,
 *    file-history-snapshot, queue-operation, …) is bookkeeping and is dropped before parsing.
 *    Those bookkeeping lines start with `{"type":…`; the three we want do NOT (their first key is
 *    `parentUuid`), which is what lets us skip the large api-request blobs without parsing them.
 *  - an `assistant` message arrives SPLIT, one line per content block (thinking / text / tool_use),
 *    all sharing one `message.id` and the same `message.stop_reason` (tool_use or end_turn) — so
 *    stop_reason on a thinking line says nothing about whether the text has been written yet.
 *  - a `user` line has `message.content` as a string (what the operator typed, or an injected
 *    prompt) or as blocks: `tool_result` (the answer to a tool_use, `is_error` flags a failure) or
 *    `text` (a typed prompt with attachments, or the `[Request interrupted by user]` marker).
 *  - `isMeta`, `isSidechain` and the `<system-reminder>` / `<local-command-*>` wrappers mark text
 *    the operator did not write and should not see as a bubble.
 *  - the end of a turn is written as `system` with subtype `turn_duration` (and usually a
 *    `stop_hook_summary` beside it); a final answer also has `stop_reason: "end_turn"`.
 *
 * THE RULE FOR EVERY NUMBER HERE (same as chatEvents): an absent field stays undefined. Context
 * tokens are only reported when the message really carried an input-side count.
 */

import { summarizeTool } from './chatEvents';

// ── the contract with the renderer ──────────────────────────────────────────

export interface ChatItem {
  uuid: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  /** Raw markdown for assistant text; the renderer sanitises and renders it. */
  text?: string;
  tool?: {
    id: string; name: string; summary: string; status: 'running' | 'ok' | 'error';
    /**
     * A bounded, ANSI-free preview of the tool's result, present only once its tool_result arrived
     * (and only when there was something to show). UNTRUSTED DATA: it is whatever the tool printed,
     * so the renderer must paint it with textContent, never innerHTML — it is deliberately not
     * escaped here, because escaping at the source would double-encode for a textContent consumer.
     */
    output?: string;
    /** True when `output` was cut at TOOL_OUTPUT_MAX_CHARS / TOOL_OUTPUT_MAX_LINES. Absent otherwise. */
    outputTruncated?: boolean;
  };
  ts?: string;
}

/**
 * Caps on a tool result's preview. The preview rides inside the item, and an item travels over IPC
 * on every event that touches it (a backfill re-sends the whole history) and is then painted by the
 * renderer; a Read of a large file or a noisy build log must not be able to inflate either. Small on
 * purpose: this is a glance at what the tool said, the full text lives in the transcript and the
 * terminal. Both caps apply and the stricter one wins.
 */
export const TOOL_OUTPUT_MAX_CHARS = 4000;
export const TOOL_OUTPUT_MAX_LINES = 60;
/**
 * How much of a raw result is even looked at before cleaning. Stripping escapes from a multi-megabyte
 * result just to keep its first 4000 characters would stall the main process for nothing; the
 * margin over the char cap leaves room for the escapes and control characters the cleaning removes.
 */
const TOOL_OUTPUT_SCAN_CHARS = TOOL_OUTPUT_MAX_CHARS * 16;

export interface TranscriptUsage {
  /** input + cache creation + cache read of the LAST assistant message: what the context holds now. */
  contextTokens?: number;
  model?: string;
}

/** What one fed line (or batch) changed. A field is absent when nothing changed for it. */
export interface TranscriptUpdate {
  /** New or updated items, in order. The same uuid may appear again later with new content. */
  items: ChatItem[];
  /** The turn state, only when it flipped. */
  turnOpen?: boolean;
  usage?: TranscriptUsage;
}

export interface TranscriptTracker {
  /** Feed one raw JSONL line. Blank, corrupt or irrelevant lines yield an empty update; never throws. */
  feed(line: string): TranscriptUpdate;
  /** Feed many lines and return ONE merged update (items deduped by uuid, last write wins). */
  feedAll(lines: readonly string[]): TranscriptUpdate;
  /** Forget everything — the file changed under us and will be re-read from the top. */
  reset(): void;
  /**
   * Where the tracker stands now, for announcing it once after a backfill. `orphanResults` counts the tool results (since
   * the last reset) whose call this tracker never saw: the sign that a read which started in the middle of the file cut a
   * tool call in two, so the tail reads a little further back before it trusts the window.
   */
  snapshot(): { turnOpen: boolean; usage: TranscriptUsage; orphanResults: number };
}

// ── small, defensive readers ────────────────────────────────────────────────

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);
function num(v: unknown): number | undefined { return typeof v === 'number' && Number.isFinite(v) ? v : undefined; }

/** Only these three types carry the conversation. */
const KEEP = new Set(['user', 'assistant', 'system']);
/** `{"type":"api-request-blob",…` — bookkeeping lines lead with their type; ours lead with parentUuid. */
const LEADING_TYPE = /^\s*\{\s*"type"\s*:\s*"([^"]*)"/;

/**
 * Whether a raw line COULD make a row: the cheap test the tail uses to size the window it reads from the end of a
 * file, without parsing anything. Bookkeeping lines lead with their type (`{"type":"api-request-blob",…`) and are the
 * bulk of a real transcript by bytes; the rest — user, assistant, system — are the conversation (a thinking block or a
 * sidechain line passes too, so this over-counts a little, which is the safe side for "read at least this much").
 */
export function isConversationLine(line: string): boolean {
  if (!line.trim()) return false;
  const lead = LEADING_TYPE.exec(line);
  return !lead || KEEP.has(lead[1]);
}

const INTERRUPT = /^\[Request interrupted by user[^\]]*\]$/;
const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

/** Text inside `<tag>…</tag>`, or undefined. Transcript wrappers are flat, so no nesting to handle. */
function tagText(s: string, tag: string): string | undefined {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(s);
  return m ? m[1] : undefined;
}

/**
 * What a user line's string content means for the chat:
 *  - a slash command (`<command-name>`) → what the operator typed, `/name args`;
 *  - local command output → a system note;
 *  - injected scaffolding (task notifications, caveats, reminders) → nothing;
 *  - anything else → the operator's message.
 */
function userText(raw: string): { role: 'user' | 'system'; text: string } | undefined {
  const s = raw.replace(REMINDER, '').trim();
  if (!s) return undefined;
  if (INTERRUPT.test(s)) return { role: 'system', text: s };
  const name = tagText(s, 'command-name');
  if (name !== undefined) {
    const args = tagText(s, 'command-args')?.trim();
    return { role: 'user', text: args ? `${name.trim()} ${args}` : name.trim() };
  }
  if (/^<local-command-(stdout|stderr)>/.test(s)) {
    const out = (tagText(s, 'local-command-stdout') ?? tagText(s, 'local-command-stderr') ?? '').trim();
    return out ? { role: 'system', text: out } : undefined;
  }
  // caveats, task notifications and other injected wrappers: not the operator's words
  if (/^<(local-command-caveat|task-notification|command-message|bash-input|bash-stdout|bash-stderr)\b/.test(s)) return undefined;
  return { role: 'user', text: s };
}

// ── tool result preview ─────────────────────────────────────────────────────

/** CSI (`ESC [ … final`), OSC (`ESC ] … BEL|ST`, terminated only — an open one must not eat the rest) charset/mode escapes with intermediate bytes (`ESC ( B`) and the remaining two-character escapes. */
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[ -/]+[0-~]|\x1b[@-Z\\-_]/g;
/** Every control character except \n and \t (C0, DEL and C1), including a stray ESC left by a cut. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

/**
 * The text of a `tool_result.content`, which is a string or an array of blocks. Only `text` blocks
 * contribute their text; an image (or any other block type) becomes a short neutral marker so the
 * reader sees that something was there without any binary or base64 reaching the view.
 */
function resultText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const b of content) {
    if (!isObj(b)) continue;
    if (b.type === 'text') { if (typeof b.text === 'string') parts.push(b.text); }
    else parts.push(b.type === 'image' ? '[image]' : '[other]');
  }
  return parts.join('\n');
}

/**
 * Turn a tool_result's content into the preview the chat shows, or undefined when there is nothing
 * to show. Order matters: look at a bounded prefix, strip escapes, normalise carriage returns (a
 * progress bar redraws with a bare \r, which would otherwise glue its frames together), drop
 * the remaining control characters, THEN apply the caps — so they count what is really displayed.
 *
 * Deliberately NOT redacted (src/main/redact.ts is not applied here or in transcriptTail):
 *  - redaction exists to guard text that LEAVES the machine (the "Report this" file). This text goes
 *    only to our own renderer, and it is byte-for-byte what the terminal pane already shows and what
 *    the transcript already holds on disk — masking it here protects nothing the operator cannot
 *    already see in the same window;
 *  - its patterns are heuristics (`password = …`, `token …`), and in a tool result they fire on
 *    ordinary source code a Read returns, so the view would show "[redacted]" where the file has
 *    text, and the operator would not be able to tell a mask from the file's content;
 *  - this module is the pure core shared with the other front (no imports from src/main).
 * If this preview is ever sent anywhere outside the window, redact at THAT boundary.
 */
export function previewToolOutput(content: unknown): { text: string; truncated: boolean } | undefined {
  const raw = resultText(content);
  if (raw === undefined) return undefined;
  let truncated = raw.length > TOOL_OUTPUT_SCAN_CHARS;
  let s = (truncated ? raw.slice(0, TOOL_OUTPUT_SCAN_CHARS) : raw)
    .replace(ANSI, '')
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL, '')
    .trimEnd();              // before counting lines: a final newline is not a line
  const lines = s.split('\n');
  if (lines.length > TOOL_OUTPUT_MAX_LINES) { s = lines.slice(0, TOOL_OUTPUT_MAX_LINES).join('\n'); truncated = true; }
  if (s.length > TOOL_OUTPUT_MAX_CHARS) {
    s = s.slice(0, TOOL_OUTPUT_MAX_CHARS);
    // do not leave half of a surrogate pair at the cut
    if (/[\ud800-\udbff]$/.test(s)) s = s.slice(0, -1);
    truncated = true;
  }
  s = s.trimEnd();     // a cut can land right after a newline or a space
  return s ? { text: s, truncated } : undefined;
}

export function createTranscriptTracker(): TranscriptTracker {
  let turnOpen = false;
  /** Tools waiting for their result, by tool_use id. Deleted on result, so this stays small. */
  let running = new Map<string, ChatItem>();
  let lastUsage: { contextTokens?: number; model?: string } = {};
  let orphanResults = 0;

  function setTurn(open: boolean, u: TranscriptUpdate): void {
    if (turnOpen === open) return;
    turnOpen = open;
    u.turnOpen = open;
  }

  function onAssistant(d: Obj, u: TranscriptUpdate): void {
    const msg = isObj(d.message) ? d.message : {};
    const model = str(msg.model);
    const synthetic = model === '<synthetic>';
    const uuid = str(d.uuid) ?? '';
    const ts = str(d.timestamp);
    const content = Array.isArray(msg.content) ? msg.content : typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : [];

    // "API Error: …" and "No response requested." are written as a synthetic assistant message.
    // They are not an answer: show them as a system note and let the turn end.
    if (synthetic) {
      const text = content.map((b) => (isObj(b) && b.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('').trim();
      if (text && uuid) u.items.push({ uuid, role: 'system', text, ...(ts ? { ts } : {}) });
      setTurn(false, u);
      return;
    }

    let closes = false;
    content.forEach((b, i) => {
      if (!isObj(b)) return;
      // one line normally holds one block; if a writer ever packs several, give each its own uuid
      const id = i === 0 ? uuid : `${uuid}:${i}`;
      if (b.type === 'text' && typeof b.text === 'string') {
        if (!b.text.trim()) return;
        if (id) u.items.push({ uuid: id, role: 'assistant', text: b.text, ...(ts ? { ts } : {}) });
        if (msg.stop_reason === 'end_turn') closes = true;
      } else if (b.type === 'tool_use') {
        const toolId = str(b.id);
        const name = str(b.name) ?? 'tool';
        if (!toolId) return;
        const item: ChatItem = {
          uuid: toolId, role: 'tool',
          tool: { id: toolId, name, summary: summarizeTool(name, b.input), status: 'running' },
          ...(ts ? { ts } : {}),
        };
        running.set(toolId, item);
        u.items.push(item);
      }
      // `thinking` blocks are deliberately not shown
    });

    // usage: the last real message's input side is what the context currently holds
    const usage = isObj(msg.usage) ? msg.usage : undefined;
    const next: { contextTokens?: number; model?: string } = { ...lastUsage };
    if (model) next.model = model;
    if (usage && num(usage.input_tokens) !== undefined) {
      // only trust it when the input side is really reported; a lone output count is not "context"
      next.contextTokens = (num(usage.input_tokens) ?? 0) + (num(usage.cache_creation_input_tokens) ?? 0) + (num(usage.cache_read_input_tokens) ?? 0);
    }
    if (next.contextTokens !== lastUsage.contextTokens || next.model !== lastUsage.model) {
      lastUsage = next;
      u.usage = { ...next };
    }

    // any real assistant activity means a turn is in flight; a finished answer closes it
    setTurn(!closes, u);
  }

  function onUser(d: Obj, u: TranscriptUpdate): void {
    if (d.isMeta === true) return;      // skill bodies, auto-continuations, caveats: injected, not typed
    const msg = isObj(d.message) ? d.message : {};
    const uuid = str(d.uuid) ?? '';
    const ts = str(d.timestamp);
    const c = msg.content;

    if (typeof c === 'string') {
      const r = userText(c);
      if (!r) return;
      if (uuid) u.items.push({ uuid, role: r.role, text: r.text, ...(ts ? { ts } : {}) });
      setTurn(r.role === 'user', u);     // a typed message starts a turn; an output note does not
      return;
    }
    if (!Array.isArray(c)) return;

    const texts: string[] = [];
    let interrupted = false;
    for (const b of c) {
      if (!isObj(b)) continue;
      if (b.type === 'tool_result') {
        const id = str(b.tool_use_id);
        const item = id ? running.get(id) : undefined;
        if (id && item?.tool) {
          running.delete(id);
          const out = previewToolOutput(b.content);
          u.items.push({
            ...item,
            tool: {
              ...item.tool,
              status: b.is_error === true ? 'error' : 'ok',
              ...(out ? { output: out.text, ...(out.truncated ? { outputTruncated: true } : {}) } : {}),
            },
          });
        } else if (id) orphanResults++;   // its call is before where this read began (or was interrupted)
        // a result means the model is mid-turn (it will read this next)
        setTurn(true, u);
      } else if (b.type === 'text' && typeof b.text === 'string') {
        if (INTERRUPT.test(b.text.trim())) interrupted = true;
        else texts.push(b.text);
      }
    }
    if (interrupted) {
      if (uuid) u.items.push({ uuid, role: 'system', text: '[Request interrupted by user]', ...(ts ? { ts } : {}) });
      // whatever was running will never report back
      for (const [id, item] of running) {
        if (item.tool) u.items.push({ ...item, tool: { ...item.tool, status: 'error' } });
        running.delete(id);
      }
      setTurn(false, u);
      return;
    }
    const r = texts.length ? userText(texts.join('\n')) : undefined;
    if (r && uuid) {
      u.items.push({ uuid, role: r.role, text: r.text, ...(ts ? { ts } : {}) });
      setTurn(r.role === 'user', u);
    }
  }

  function onSystem(d: Obj, u: TranscriptUpdate): void {
    // turn_duration is written once per finished turn; stop_hook_summary closes the same moment
    if (d.subtype === 'turn_duration' || d.subtype === 'stop_hook_summary') setTurn(false, u);
  }

  function feed(line: string): TranscriptUpdate {
    const u: TranscriptUpdate = { items: [] };
    const s = line.trim();
    if (!s) return u;
    const lead = LEADING_TYPE.exec(s);
    if (lead && !KEEP.has(lead[1])) return u;      // bookkeeping: skip without paying for the parse
    let d: unknown;
    try { d = JSON.parse(s); } catch { return u; } // a half-written or corrupt line is not worth dying over
    try {
      if (!isObj(d) || d.isSidechain === true) return u;   // a subagent's chatter is not this conversation
      switch (d.type) {
        case 'assistant': onAssistant(d, u); break;
        case 'user': onUser(d, u); break;
        case 'system': onSystem(d, u); break;
        default: break;
      }
    } catch { /* a malformed message must not take the view down */ }
    return u;
  }

  function feedAll(lines: readonly string[]): TranscriptUpdate {
    const out: TranscriptUpdate = { items: [] };
    const at = new Map<string, number>();
    for (const l of lines) {
      const u = feed(l);
      for (const it of u.items) {
        const i = at.get(it.uuid);
        if (i === undefined) { at.set(it.uuid, out.items.length); out.items.push(it); }
        else out.items[i] = it;       // an update to something already in this batch: keep its place
      }
      if (u.turnOpen !== undefined) out.turnOpen = u.turnOpen;
      if (u.usage) out.usage = u.usage;
    }
    return out;
  }

  return {
    feed,
    feedAll,
    reset(): void { turnOpen = false; running = new Map(); lastUsage = {}; orphanResults = 0; },
    snapshot(): { turnOpen: boolean; usage: TranscriptUsage; orphanResults: number } { return { turnOpen, usage: { ...lastUsage }, orphanResults }; },
  };
}
