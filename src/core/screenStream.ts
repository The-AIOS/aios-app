/**
 * Chat skin — read the assistant reply that is being WRITTEN right now off the TUI screen.
 * PURE: it takes the plain text of the visible terminal (the same shape `detectTuiPrompt` gets) and
 * returns the text of the reply in progress, or null. No electron, no fs, no pty.
 *
 * WHY THIS EXISTS. The transcript only records a message when the model has finished it, so the chat
 * view shows nothing for the seconds a long answer takes to arrive, while the terminal shows it word
 * by word. The screen is the only place the partial reply exists. The chat view draws it as a
 * PROVISIONAL bubble and, when the finished message lands in the transcript, replaces the bubble by
 * the real one: the transcript stays the single source of truth, this is only a preview of it.
 * `sameMessage` is how the renderer decides that a transcript message IS the one that was previewed
 * (so the bubble is swapped, not duplicated).
 *
 * WHAT THE SCREEN LOOKS LIKE (hand-checked against the shipped CLI's strings, not copied from any
 * session): older turns scroll up as `> what the operator typed` and `⏺ …` blocks; the reply in
 * progress is the LAST `⏺` block, its text indented two columns under the bullet and re-wrapped to
 * the terminal width; below it a spinner (`✻ Thinking…`, `· Pondering… (12s · esc to interrupt)`),
 * then the input box (`╭─╮ │ > … │ ╰─╯`, or a `─────` rule above and below), then footer hints
 * (`? for shortcuts`, `auto-accept edits on`) and whatever status line the operator configured.
 *
 * WHAT COUNTS AS "STREAMING". All three must hold, because each alone is also true of a finished
 * screen: (1) the spinner (or an "esc to interrupt" hint) is on screen — an idle screen keeps the
 * last answer visible but has no spinner; (2) the LAST block is a text block — a `⏺ Tool(…)` row
 * after the text means the text is complete and the transcript has it, and a screen that ends in a
 * tool row has no reply in progress; (3) no dialog is up (`detectTuiPrompt`), because a dialog
 * replaces the spinner and the box and what is above it is not being written any more.
 *
 * KNOWN LIMITS, all of them things the screen cannot say:
 *  - the TUI paints MARKDOWN RENDERED: `**bold**` markers, `#` heading marks, code fences and the
 *    language tag are gone, links lose their URL, tables are drawn with box characters. The text
 *    returned is what the TUI shows, not the model's source; `sameMessage` compares on letters and
 *    digits only for exactly this reason. Partial markdown (an unclosed `**`, half a table) is
 *    returned as painted.
 *  - re-wrapped lines are rejoined by a heuristic: a line that starts a list item, a table row, a
 *    quote or is indented as code starts a new line, anything else is a continuation. A WRAPPED CODE
 *    LINE is therefore split in two, and a hard line break inside a paragraph is lost (markdown folds
 *    it into a space anyway).
 *  - only the visible rows exist: a reply taller than the window has lost its head (`headCut`), and
 *    nothing here can recover it. The head is also what `anchor` is built from, so a headCut reply
 *    has an empty anchor and must be matched with `sameMessage(…, { headCut: true })`.
 *  - the last word may be half-written and the last line is whatever was painted so far.
 *  - an operator-configured status line, if the caller keeps rows below the input box, is dropped
 *    only when the input box itself is found; without the box it can leak in as text.
 *  - text before a tool call in the same turn is deliberately NOT returned (see 2 above).
 *  - the wording of the spinner, the glyphs and the footers are the CLI's and change between versions.
 */
import { stripAnsi, BORDER, detectTuiPrompt } from './tuiPrompt';

export interface StreamingReply {
  /** The reply as painted so far, rewrapped, without bullet, spinner, input box or footers. */
  text: string;
  /**
   * A stable signature of the BEGINNING of the block: its first words, lowercased, letters and digits
   * only, joined by single spaces. It stops changing once the block has `anchorWords` words, so the
   * renderer can key the provisional bubble by it while the text grows. Empty when `headCut`.
   */
  anchor: string;
  /** True when the opening bullet is not on screen (the reply is taller than the window). */
  headCut: boolean;
}

export interface ExtractOptions {
  /** Words in the anchor. Default `STREAM_ANCHOR_WORDS`. */
  anchorWords?: number;
  /** Require the spinner to be visible (default true). False reads the last text block of ANY screen. */
  requireActive?: boolean;
}

export const STREAM_ANCHOR_WORDS = 6;

/** A row made only of box-drawing characters: a border or rule of the input box. */
const isRule = (l: string): boolean => l.trim() !== '' && (l.replace(BORDER, '').trim() === '' || TITLED_RULE.test(l));
/** The box's top border carries the session's name on the right: `────────── my-session ─`. Still a border. */
const TITLED_RULE = /^\s*[─━═]{3,}\s\S[^─━═]*\s[─━═]+\s*$/;
/** The input box's prompt row: `> text`, `❯ text`, optionally between side borders. */
const PROMPT_ROW = /^(?:[│┃] ?|\s?)[>❯](?: |$)/;
/** A row the operator typed, echoed into the scrollback: the prompt glyph flush left. */
const ECHO_ROW = /^\s{0,1}[>❯]\s+\S/;
const BULLET = /^\s{0,1}[⏺●]\s?(.*)$/;
const THINKING = /^\s{0,1}∴/;
/** `Bash(npm test)`, `Update(src/a.ts)`, `Web Search("x")`, `server - tool (MCP)(arg)`: a name glued to `(`. */
const TOOL_HEAD = /^(?:[A-Z][\w.:-]*(?: [A-Z][\w.:-]*){0,2}|[a-z][\w.-]*(?: - [\w.-]+)?)(?: \(MCP\))?\(/;
/** The collapsed summaries the TUI prints for read-only tools: `Searched for 2 patterns (ctrl+o to expand)`. */
const TOOL_SUMMARY = /\(ctrl\+o to expand\)|^(?:Read|Searched for|Listed|Wrote|Edited|Updated|Created|Fetched|Ran) \d+|^(?:Running|Reading|Searching|Listing|Fetching|Writing|Editing|Updating|Creating) \d+ /;
const RESULT_ROW = /^\s*⎿/;

/** Spinner: a glyph, a short phrase ending in an ellipsis, optionally `(12s · ↓ 1.2k tokens · esc to interrupt)`. */
const SPINNER = /^\s{0,1}[✻✽✶✳✢·∗✺]\s+\S+(?:\s\S+){0,3}\s?(?:…|\.\.\.)(?:\s*\([^)]*\))?\s*$/;
/** `*` is also a plain list bullet, so it only counts as a spinner with the parenthetical the spinner carries. */
const SPINNER_STAR = /^\s{0,1}\*\s+\S+(?:\s\S+){0,3}\s?(?:…|\.\.\.)\s*\([^)]*(?:esc|tokens|\d+s)[^)]*\)\s*$/;
const ESC_HINT = /^\s*\(?esc to interrupt\)?\s*$/i;
/** The footer's live-turn marker: `… (shift+tab to cycle) · esc to interrupt`, or the bare hint, on a row under the box. */
const FOOTER_LIVE = /(?:^|[·|(\s])esc to interrupt\)?\s*$/i;
/** The line the TUI leaves after a turn ends (`✻ Worked for 1m 3s`): noise, and proof the turn is over. */
const DONE_MARK = /^\s{0,1}[✻✽✶✳✢·]\s+\S+ for \d/;
/** Footer and mode hints under the input box. Anchored: a sentence in an answer must not match. */
const FOOTER_NOISE: RegExp[] = [
  // the right-aligned effort indicator the CLI draws on the row above the input box: `◐ medium · /effort`
  /^\s*\S+\s+\w+\s+·\s+\/effort\s*$/i,
  // the hint is followed by a wide gap and the status columns, or ends the line; a sentence that merely starts with it is text
  /^\s*\?\s+for shortcuts(?:\s{2,}.*)?$/i,
  /^\s*⏵⏵?\s/,
  /^\s*[⏸⏹]?\s*(?:auto-accept edits|accept edits|bypass permissions|plan mode)\b.*$/i,
  /\(shift\+tab to cycle\)\s*$/i,
  /^\s*(?:ctrl\+[a-z] to (?:expand|hide|show)[\w ]*|press ctrl-?c again to exit|\d+ (?:shells?|tasks?|agents?) running.*)\s*$/i,
];

const isSpinner = (l: string): boolean => SPINNER.test(l) || SPINNER_STAR.test(l);
const isNoise = (l: string): boolean => isSpinner(l) || ESC_HINT.test(l) || DONE_MARK.test(l) || FOOTER_NOISE.some((r) => r.test(l));

type ItemType = 'echo' | 'text' | 'tool' | 'thinking' | 'other';
interface Item { type: ItemType; lines: string[]; orphan?: boolean }

const indentOf = (l: string): number => l.length - l.trimStart().length;
/* `3.` alone on a row is the next item caught half-painted (the number first, its text a moment later): still an item, not a wrap. */
const LIST_ITEM = /^\s*(?:[•◦▪▸\-*]|\d{1,3}[.)])(?:\s+\S|\s*$)/;
const TABLE_ROW = /^\s*[│┃┌┐└┘├┤┬┴┼─]/;
const QUOTE_ROW = /^\s*(?:▎|▌|>)\s?/;

/**
 * Rejoin what the terminal wrapped. `rows` are the block's content rows with the two-column bullet
 * gutter already removed. Paragraphs (blank-row separated) stay apart; inside one, a row continues
 * the previous unless it starts a list item, a table row, a quote, or is indented like code.
 */
function reflow(rows: string[]): string {
  const paragraphs: string[][] = [[]];
  for (const r of rows) {
    if (r.trim() === '') { if (paragraphs[paragraphs.length - 1].length) paragraphs.push([]); continue; }
    paragraphs[paragraphs.length - 1].push(r);
  }
  const out: string[] = [];
  for (const para of paragraphs) {
    if (!para.length) continue;
    const lines: string[] = [];
    let cur = '';
    let inList = false;
    for (const r of para) {
      const t = r.trim();
      if (cur === '') { cur = indentOf(r) >= 2 ? r.trimEnd() : t; inList = LIST_ITEM.test(r); continue; }
      if (LIST_ITEM.test(r) || TABLE_ROW.test(r) || QUOTE_ROW.test(r) || (indentOf(r) >= 2 && !inList)) {
        lines.push(cur); cur = indentOf(r) >= 2 ? r.trimEnd() : t; inList = LIST_ITEM.test(r);
      } else cur += ' ' + t;
    }
    if (cur) lines.push(cur);
    out.push(lines.join('\n'));
  }
  return out.join('\n\n').replace(/[▍▌█▏]+\s*$/, '').trimEnd();
}

/** Letters and digits, lowercased: what survives both the TUI's markdown rendering and the model's source. */
export function normalizeForMatch(s: string): string {
  return stripMarkdownSyntax(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/** Drop the markdown the TUI does not paint as text: fence lines (and their language tag) and link targets. */
function stripMarkdownSyntax(s: string): string {
  return s
    .replace(/^\s*(?:```|~~~).*$/gm, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<https?:[^>]*>/g, ' ');
}

/** The first `n` words as a lowercase, letters-and-digits signature. */
export function anchorOf(text: string, n = STREAM_ANCHOR_WORDS): string {
  const words = stripMarkdownSyntax(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return words.slice(0, n).join(' ');
}

/**
 * Does the finished transcript message `finalText` correspond to the provisional bubble `provisional`?
 * The provisional text is a PREFIX of the final one (it was cut mid-stream), compared on letters and
 * digits so that markdown the TUI rendered away, rewrapping and bullets do not matter. With
 * `headCut` the provisional is the TAIL of what was written (its head scrolled off), so a substring
 * match is used instead, with a minimum length so a short fragment cannot match everything.
 */
export function sameMessage(provisional: string, finalText: string, opts: { headCut?: boolean } = {}): boolean {
  const a = normalizeForMatch(provisional);
  const b = normalizeForMatch(finalText);
  if (!a || !b) return false;
  if (opts.headCut) return a.length >= 12 && b.includes(a);
  return b.startsWith(a);
}

/**
 * Find the input box, if the screen shows one at the bottom, and return the row where it starts
 * (its top border when it has one), else -1. The box is the LAST prompt row, but a prompt row is
 * also how an earlier message of the operator's is echoed into the scrollback, so it only counts
 * as the box when what follows is what a box has under it: a bottom border and footers, never a
 * `⏺` block. That is also why a reply containing a table (more border rows) is not eaten.
 */
function composerStart(rows: string[]): number {
  let p = -1;
  for (let i = rows.length - 1; i >= Math.max(0, rows.length - 24); i--) if (PROMPT_ROW.test(rows[i])) { p = i; break; }
  if (p < 0) return -1;
  const rest = rows.slice(p + 1);
  if (rest.some((l) => BULLET.test(l) || ECHO_ROW.test(l))) return -1;
  const bottom = rest.findIndex(isRule);
  if (bottom >= 0) {
    // draft lines before the bottom border (a multi-line message), then footers and, possibly, the
    // operator's own status line — a few rows, never a screenful
    if (bottom > 8 || rest.slice(bottom + 1).filter((l) => l.trim() !== '' && !isRule(l) && !isNoise(l)).length > 3) return -1;
  } else if (!rest.every((l) => l.trim() === '' || isNoise(l))) return -1;
  let c = p;
  while (c - 1 >= 0 && isRule(rows[c - 1])) c--;
  return c;
}

/**
 * The assistant reply being written on this screen, or null when there is none (idle screen, a dialog
 * up, only tools running, nothing painted yet). See the header for what "being written" requires.
 */
export function extractStreaming(screen: string, opts: ExtractOptions = {}): StreamingReply | null {
  if (!screen) return null;
  if (detectTuiPrompt(screen)) return null;
  /* The CLI paints some gaps as NO-BREAK SPACES (`❯\u00a0` for an empty box, `⎿\u00a0Tip: …`), which no `\s ` in
     the patterns below would match — and which showed up only against the real screen. Plain spaces from here on. */
  const all = stripAnsi(screen).replace(/\u00a0/g, ' ').replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/\s+$/, ''));

  // 1. cut the input box and everything under it
  const c = composerStart(all);
  let rows = c >= 0 ? all.slice(0, c) : all.slice();
  /* While text is being written the CLI (2.1.x) draws NO spinner row: the only sign of a live turn is the footer
     under the box, `… (shift+tab to cycle) · esc to interrupt`. Read it where it lives (under the box, or the last
     rows without one) so a sentence in the answer that says the same words cannot make an idle screen look live. */
  const footerLive = (c >= 0 ? all.slice(c) : all.slice(-6)).some((l) => FOOTER_LIVE.test(l));

  // 2. the spinner marks a live turn and the end of the reply: whatever sits under it (a todo panel,
  // a tip, a queued message) is not text of the reply
  let s = -1;
  for (let i = rows.length - 1; i >= 0; i--) if (isSpinner(rows[i]) || ESC_HINT.test(rows[i])) { s = i; break; }
  if (s < 0 && !footerLive && (opts.requireActive ?? true)) return null;
  if (s >= 0) rows = rows.slice(0, s);

  // 3. group the rest into blocks
  const items: Item[] = [];
  let cur: Item | null = null;
  for (const row of rows) {
    if (isNoise(row)) continue;
    if (row.trim() === '') { cur?.lines.push(''); continue; }
    if (ECHO_ROW.test(row)) { cur = { type: 'echo', lines: [row] }; items.push(cur); continue; }
    if (THINKING.test(row)) { cur = { type: 'thinking', lines: [row] }; items.push(cur); continue; }
    const b = BULLET.exec(row);
    if (b) {
      const body = b[1];
      const type: ItemType = TOOL_HEAD.test(body) || TOOL_SUMMARY.test(body) ? 'tool' : 'text';
      cur = { type, lines: [body] }; items.push(cur); continue;
    }
    if (RESULT_ROW.test(row)) { if (cur?.type !== 'tool') { cur = { type: 'tool', lines: [] }; items.push(cur); } cur.lines.push(row); continue; }
    if (!cur) {
      // content with no opener above it: the head of a tall reply scrolled off. Only a row at the text
      // gutter qualifies; deeper rows are as likely to be a tool's output.
      if (indentOf(row) >= 2 && indentOf(row) <= 3) { cur = { type: 'text', lines: [row.trimStart()], orphan: true }; items.push(cur); }
      continue;
    }
    if (cur.type === 'text' && indentOf(row) < 2) { cur = { type: 'other', lines: [row] }; items.push(cur); continue; }   // flush-left output ends the block
    cur.lines.push(row);
  }

  // 4. the reply in progress is the last block, and only if it is text
  const last = items[items.length - 1];
  if (!last || last.type !== 'text') return null;
  const body = last.lines.map((l, i) => (i === 0 ? l.trim() : l.slice(Math.min(2, indentOf(l)))));
  const text = reflow(body);
  if (!text) return null;
  const n = opts.anchorWords ?? STREAM_ANCHOR_WORDS;
  return { text, anchor: last.orphan ? '' : anchorOf(text, n), headCut: !!last.orphan };
}

// ── the stateful half: what to tell the renderer, and when the preview becomes the real message ────

/**
 * What goes over `chatSkin:event` for the provisional bubble.
 *  - `{text, anchor, headCut}`: the reply as painted so far (replaces the previous preview's text).
 *  - `{text: null}`: no reply is being written right now (the spinner went away, a tool row took the
 *    bottom, a dialog opened). The renderer keeps the preview where it is, frozen, because the finished
 *    message is about to land in the transcript and must take the preview's place without a gap.
 *  - `{text: null, adopt: uuid}`: the transcript line `uuid` IS the message that was previewed, and it
 *    is the next `items` event: the renderer hands the preview's node to that item instead of drawing a
 *    second bubble.
 */
export type StreamEvent =
  | { type: 'stream'; text: string; anchor: string; headCut: boolean }
  | { type: 'stream'; text: null; adopt?: string };

export interface StreamTracker {
  /** A new screen snapshot. Returns the event to send, or null when nothing changed since the last one. */
  screen(text: string): StreamEvent | null;
  /** Transcript items about to be sent. Returns the adoption event when one of them is the previewed message. */
  items(items: ReadonlyArray<{ uuid: string; role: string; text?: string }>): StreamEvent | null;
  /** The turn ended: whatever preview is still hanging is forgotten (the renderer drops its own on `turn`). The last adopted message is remembered so a stale screen cannot revive it. */
  end(): void;
  /** A turn started: the memory of the last adopted message is dropped (a new turn may legitimately open with the same words). */
  begin(): void;
  /** The view was reset or a different transcript is followed: forget everything. */
  reset(): void;
  /** The preview main last sent (for tests and the smoke measurement). */
  current(): { text: string; headCut: boolean } | null;
}

/** Cap on the snapshot read: 60 rows of a very wide terminal; anything beyond is not a screen. */
export const STREAM_SCREEN_MAX = 64 * 1024;

/**
 * Join two views of one growing reply. Each snapshot is a WINDOW of the terminal, so a long reply loses its
 * head from the top as it grows (the CLI repaints only what fits); the head is known from earlier snapshots.
 * `win` is the new window (its first row may be the middle of a line), `acc` what was assembled so far (its last
 * line may still have been growing). The window must start somewhere inside `acc` and agree with it on every
 * line they share; the result is `acc` up to that point followed by the whole window. Null when they share
 * nothing (the reply moved on faster than the snapshots, or it is a different block): the caller then shows the
 * window alone rather than invent a join.
 */
export function stitch(acc: string, win: string): string | null {
  const A = acc.split('\n');
  const W = win.split('\n');
  for (let i = 0; i < A.length; i++) {
    const last = i === A.length - 1;
    /* Where does the window begin? In the middle of a line that was complete (its tail is the window's first row), or, for
       the last line of `acc` — which may still have been growing — in a line that overlaps it at its end or extends it. */
    let first: string | null = null;
    if (!last) { if (A[i] === W[0] || (W[0].length >= 12 && A[i].endsWith(W[0]))) first = A[i]; }
    else first = overlapJoin(A[i], W[0]);
    if (first === null) continue;
    if (W.length < A.length - i) continue;   // the window ends before `acc` does: it is older, not newer
    let ok = true;
    const shared = Math.min(A.length - i, W.length);
    /* Every shared line must agree, EXCEPT the last two: those are the ones being repainted right now, and a
       snapshot can catch the TUI between the erase and the rewrite (seen against the real screen: half a line, then
       the next one already there). Trusting the lines before them is what makes the join safe; the window's
       version of the tail wins, because it is the newer paint. */
    const strictUntil = shared >= 5 ? shared - 2 : shared;
    for (let j = 1; j < strictUntil; j++) {
      const a = A[i + j];
      const b = W[j];
      if (i + j === A.length - 1 ? !b.startsWith(a) : a !== b) { ok = false; break; }   // only the last line of `acc` can have grown
    }
    if (!ok) continue;
    return A.slice(0, i).concat(first, W.slice(1)).join('\n');
  }
  return null;
}

/** `a` is a line that may still have been growing; `w` is the same line as a newer window shows it (possibly cut at its start). */
function overlapJoin(a: string, w: string): string | null {
  if (w === a || (a.length >= 2 && w.startsWith(a))) return w;
  if (w.length >= 12 && a.endsWith(w)) return a;
  for (let k = Math.min(a.length, w.length); k >= 12; k--) if (a.endsWith(w.slice(0, k))) return a.slice(0, a.length - k) + w;
  return null;
}

/**
 * Is `finalText` (a transcript message) the reply this preview was showing? Strict first (`sameMessage`); then
 * the same test with the preview's last two lines left out, because the preview is a snapshot of a screen that was
 * being repainted and its tail can be torn. The part that is kept must still be long enough to mean something.
 */
export function previewIsMessage(preview: string, finalText: string, headCut: boolean): boolean {
  if (sameMessage(preview, finalText, { headCut })) return true;
  const lines = preview.split('\n');
  const kept = lines.length >= 3 ? lines.slice(0, -2).join('\n') : preview.slice(0, Math.floor(preview.length * 0.6));
  return normalizeForMatch(kept).length >= (headCut ? 24 : 12) && sameMessage(kept, finalText, { headCut });
}

/** How many unjoinable windows in a row are ignored before one is believed (the reply really did move on). */
const STITCH_PATIENCE = 3;

export function createStreamTracker(opts: ExtractOptions = {}): StreamTracker {
  let prev: { text: string; anchor: string; headCut: boolean } | null = null;   // the last preview, live or frozen
  let live = false;                                                                // is `prev` still being written?
  /* The text of the message that was just adopted. The screen keeps saying "esc to interrupt" for a moment after the
     transcript has the finished message, and a snapshot taken in that gap reads the SAME text as a reply in progress: without
     this it would be drawn again as a second preview under the real message, and never replaced. */
  let done: string | null = null;
  let misses = 0;   // consecutive windows that could not be joined to what we have
  return {
    screen(text: string): StreamEvent | null {
      const r = extractStreaming(String(text ?? '').slice(-STREAM_SCREEN_MAX), opts);
      if (r && done !== null && sameMessage(r.text, done, { headCut: r.headCut })) return null;   // the finished message, seen again on a stale screen
      if (r) {
        let next = r;
        if (r.headCut && prev) {
          // a window over a reply that has outgrown the terminal: rebuild the whole text from the windows seen so far
          const joined = stitch(prev.text, r.text);
          if (joined !== null) { next = { text: joined, anchor: prev.anchor, headCut: prev.headCut }; misses = 0; }
          else if (live && ++misses <= STITCH_PATIENCE) return null;   // not joinable (a torn paint, or a gap): keep what we have rather than shrink to a window — a few times
          else misses = 0;
        } else misses = 0;
        if (live && prev && prev.text === next.text) return null;
        prev = next; live = true;
        return { type: 'stream', text: next.text, anchor: next.anchor, headCut: next.headCut };
      }
      if (!live) return null;
      live = false;                      // freeze: keep `prev` for the adoption, tell the renderer once
      return { type: 'stream', text: null };
    },
    items(items): StreamEvent | null {
      if (!prev) return null;
      for (const it of items) {
        if (it.role !== 'assistant' || typeof it.text !== 'string' || !it.text.trim()) continue;
        if (previewIsMessage(prev.text, it.text, prev.headCut)) { prev = null; live = false; done = it.text; return { type: 'stream', text: null, adopt: it.uuid }; }
      }
      return null;
    },
    end(): void { prev = null; live = false; misses = 0; },
    begin(): void { done = null; },
    reset(): void { prev = null; live = false; done = null; misses = 0; },
    current(): { text: string; headCut: boolean } | null { return prev ? { text: prev.text, headCut: prev.headCut } : null; },
  };
}
