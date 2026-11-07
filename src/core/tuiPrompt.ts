/**
 * Chat skin — recognise when the `claude` TUI is waiting on a dialog that only the terminal can
 * answer (a permission request, the folder-trust prompt, a /model picker, an AskUserQuestion, a
 * numbered menu, a bare Yes/No offer). PURE: it takes plain text and returns a verdict, so it is
 * testable without a pty.
 *
 * WHY THIS EXISTS. The chat view reads the transcript, and the transcript only learns about a tool
 * AFTER the operator allows it. While the TUI sits on "Do you want to proceed?", the transcript
 * shows a tool_use with no result and says nothing else; the only place the question exists is the
 * screen. So the chat view watches the tail of the pty output too, to know "the terminal is asking
 * something". When the options can be read with confidence the verdict also carries them (with the
 * key that picks each one) so the chat can draw buttons; when they cannot, the verdict omits
 * `options` and the chat falls back to showing the real terminal strip. Nothing here ever writes
 * to the pty: choosing is the caller's act, on the operator's click.
 *
 * HOW IT STAYS HONEST. A wrong "yes, there's a dialog" sends the operator to a terminal for nothing;
 * a wrong "no" leaves a blocked session looking idle. The first is cheaper, but ordinary answers
 * are full of numbered lists and sentences like "Do you want to proceed?", so every verdict needs
 * STRUCTURE, not wording: a list of option rows with the TUI's selection cursor (❯), sitting at
 * the very end of the screen (a dialog is the last thing painted; anything printed after it means
 * it was dismissed), plus a recogniser or a footer hint that only the TUI prints. Strings were
 * checked against the shipped CLI binary: "Do you want to proceed?", "tell Claude what to do
 * differently", "Yes, and don't ask again for", "Yes, I trust this folder", "Quick safety check",
 * "Select model", "Type something", "Chat about this", "Ready to submit your answers?", "You have not
 * answered all questions", "Enter to select", "Esc to cancel", and the
 * footer-less offers ("Make auto mode your default permission mode?", "Trust this directory?",
 * "Enter plan mode?", "Ready to code?", "Run this command?", …) which are drawn by the same Select
 * component with `hideIndexes` (no numbers) and, for some, with no footer at all.
 *
 * THE KEYS (why each one). The CLI's Select component, read in the shipped binary, handles three
 * inputs that matter here:
 *  - a digit key 0-9 picks option number `digit` directly (it calls onChange for that option) — but
 *    ONLY when the menu shows its numbers: `hideIndexes` turns digit selection off. So a numbered
 *    option's key is its digit; it is one keystroke, immune to where the cursor currently is.
 *  - ↓ / ↑ move the focus by one option; Enter accepts the focused one. An unnumbered menu has no
 *    other way in, so its key is "the arrows from the cursor to this option, then Enter". The cursor
 *    position is read from the screen, so the key is only valid for THIS snapshot: the monitor
 *    reports a moved cursor through `onRefresh`, and the caller must use the latest keys.
 *  - an "input" option (AskUserQuestion's "Type something.") does not accept on Enter; a digit
 *    focuses it so the operator can type. Those options are flagged `freeText`; their unnumbered
 *    key stops at the arrows (no Enter) for the same reason.
 * Several keystrokes in one pty write can be swallowed as one chunk by the TUI's input parser (the
 * same reason a message and its Enter are written separately), so `keyChunks(key)` splits a key into
 * pieces to write one at a time.
 *
 * KNOWN LIMITS: wording is the CLI's and changes between versions (English only, as the TUI is);
 * a dialog taller than the window the caller keeps loses its question line (the kind then falls
 * back to 'select'); 'other' is intentionally narrow. OPTIONS are omitted, not guessed, when: the
 * numbering does not start at 1 (a scrolled list); a multi-select ("Select all that apply") where
 * a digit toggles instead of submitting; an unnumbered menu with fewer than two aligned rows or a
 * row that starts lowercase (a wrapped label we cannot tell from an option); or two options share
 * the cursor. An unnumbered menu whose options are separated by blank lines (the "expanded"
 * layout) is read as one row and therefore omitted. A footer-less offer is only recognised as
 * Yes/No-shaped: one row starting `Yes` and one starting `No`/`Not now`/`Cancel`/`Back`, under a
 * question line; a dialog of other shapes without numbers or a footer is not seen (the stalled-turn
 * notice is the net). An option's `desc` is every row between it and the next option, so a label the
 * terminal wrapped shows its tail as a description (it used to be dropped); the last option never
 * gets one, because the rows after a list are the footer and the input box's border.
 */

export type TuiPromptKind = 'permission' | 'trust' | 'select' | 'question' | 'model' | 'other';
/**
 * One selectable row of a dialog. `n` is the number the TUI prints (null for an unnumbered menu).
 * `key` is what to write to the pty to pick it (see THE KEYS above; split with `keyChunks`).
 */
export interface TuiOption {
  n: number | null; label: string; selected: boolean; key: string; freeText?: boolean;
  /** The indented line(s) the TUI prints under an option's label ("Touch one file"), when there are any. */
  desc?: string;
}
export interface TuiPrompt {
  kind: TuiPromptKind;
  hint: string;
  /**
   * The question, when the screen shows one: the line ending in `?` ("Do you want to proceed?") or,
   * when that line is part of a paragraph (a long question wrapped by the terminal), the whole
   * paragraph. An AskUserQuestion is the model's own prose, which may put its `?` mid-row or not end
   * in one at all, so for that kind the paragraph right above the options IS the question.
   */
  question?: string;
  /** AskUserQuestion's header chip ("☐ Scope"), when the screen shows exactly one. */
  header?: string;
  /** Present only when the rows could be read with confidence; absent means "show the terminal". */
  options?: TuiOption[];
}

export const KEY_UP = '\x1b[A';
export const KEY_DOWN = '\x1b[B';
export const KEY_ENTER = '\r';
/** Split a `TuiOption.key` into the pieces to write one by one (arrows, a digit, the Enter). */
export function keyChunks(key: string): string[] {
  return key.match(/\x1b\[[0-9;]*[A-Za-z]|\r|[^\x1b\r]/g) ?? [];
}

/**
 * Strip terminal control sequences, keeping the text. CSI cursor-forward (`ESC[nC`) becomes spaces
 * because Ink positions words that way and joining them would glue "Yes," to "and". Everything
 * else (colours, cursor moves, OSC titles/hyperlinks, charset selects, bare C0 controls except
 * \n \r \t) is dropped.
 */
export function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\[(\d*)C/g, (_m, n: string) => ' '.repeat(Math.min(Number(n) || 1, 40)))
    // Ink also places words with an ABSOLUTE column (`ESC[<n>G`); dropping it glues the words
    // ("Quicksafetycheck") and no wording-based recogniser can match. A space is enough: the
    // lines are trimmed and the column itself carries no meaning here.
    .replace(/\x1b\[\d*G/g, ' ')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')                // OSC … BEL | ST
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')                         // CSI
    .replace(/\x1b[PX^_][\s\S]*?\x1b\\/g, '')                        // DCS / SOS / PM / APC
    .replace(/\x1b[()*+][0-9A-Za-z]/g, '')                           // charset selection
    .replace(/\x1b[@-Z\\-_=>78]/g, '')                               // two-char escapes
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

// box-drawing and block characters Ink draws dialogs with
export const BORDER = /[│┃║╭╮╰╯┌┐└┘─━═╌╍┄┅]/g;

/** `❯ 1. Yes`, `  2. No`, `› 3. …` — group 1 is the cursor (if any), 2 the number, 3 the label. */
const OPTION = /^\s*([❯›>])?\s*(\d{1,2})[.)]\s+(\S.*)$/;
/** `❯ label` with no number: the cursor of an unnumbered menu. */
const CURSOR_LINE = /^\s*[❯›]\s+\S/;
const FOOTER =/(Enter to (?:select|confirm|submit|continue)|Esc to (?:cancel|exit|close|go back)|to navigate|Tab\/Arrow keys|Press Enter to continue)/i;

const TRUST = /(Quick safety check|trust (?:this|the files in this) folder|Do you trust the files|Yes, I trust)/i;
const MODEL = /(Select model|Switch between Claude models)/i;
// AskUserQuestion always adds free-text / discuss options; its header chips are ☐ ☒ ✔ checkboxes.
// Its LAST screen (several questions, all answered) has neither: "Review your answers", one row per
// question and answer, then "Ready to submit your answers?" over `1. Submit answers` / `2. Cancel`,
// with NO footer. The chips sit above the whole review, out of the context window once the answers
// run past a few lines (measured: four questions put them 16 lines above the menu), so without its
// own wording that screen was not a dialog at all and the chat view drew nothing to submit with.
const QUESTION = /(Type something|Chat about this|^\s*[←→]?\s*[☐☒]\s|Ready to submit your answers\?|You have not answered all questions)/m;
const PERMISSION = /(Do you want to |Would you like to proceed|tell Claude what to do differently|Yes, and don't ask again|Yes, allow all edits|Yes, during this session)/i;
// 'other': a prompt that is not a menu but still waits on a keypress
const OTHER = /(Press Enter to continue|\(y\/n\)\s*$|\[y\/N\]\s*$|\[Y\/n\]\s*$)/i;
// a panel Claude Code opens over its prompt (↓ then Enter on "1 shell": "Shell details" … "← to go back · Esc/Enter/Space to
// close · x to stop"). Not a menu, so it is an 'other' prompt: the chat view shows the live terminal strip for it.
const PANEL = /(Esc\/Enter\/Space to close|←\s*to go back|\bx to stop\b)/i;
const PANEL_TITLE = /^\s*((?:Shell|Agent|Task|Background)[\w ]{0,30}|[\w ]{0,30}(?:details|tasks))\s*$/i;

/** Only the lines at the very end of the screen can be a live dialog. */
const TAIL_LINES = 40;
/** The last option must be within this many non-empty lines of the end. A dialog prints at most a
 *  description and a footer after its last option; more than that means output moved on past it. */
const OPTION_REACH = 5;

const HINT_MAX = 160;
/** A question is the text the operator decides on, so it gets more room than a hint (which feeds toasts). */
export const QUESTION_MAX = 800;
export const DESC_MAX = 300;
const clipTo = (s: string, max: number): string => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
};
const clip = (s: string): string => clipTo(s, HINT_MAX);

/** Every row of the screen, borders turned into spaces, trailing blank rows dropped. Blank rows in
 *  the MIDDLE are kept: they are what separates an option list from the text above it. */
function cleanRows(screen: string): string[] {
  const rows = stripAnsi(screen)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(BORDER, ' ').replace(/\s+$/, ''));
  while (rows.length && rows[rows.length - 1].trim() === '') rows.pop();
  return rows;
}

/** A question line: ends in `?`, optionally followed by a short parenthetical the TUI appends. */
const QUESTION_LINE = /\?\s*(?:\([^()]*\))?\s*$/;
/** How many rows above a menu a question may sit (a description paragraph can be in between). */
const QUESTION_SPAN = 12;
const MULTI_SELECT = /Select all that apply/i;
const FREE_TEXT = /^Type something/i;
const YES_ROW = /^Yes\b/;
const NO_ROW = /^(?:No|Not now|Cancel|Back)\b/;

/** The index of the nearest question line above `from` (exclusive), or -1. */
function questionRow(rows: string[], from: number): number {
  for (let i = from - 1; i >= Math.max(0, from - QUESTION_SPAN); i--) {
    if (QUESTION_LINE.test(rows[i])) return i;
  }
  return -1;
}
/**
 * The paragraph right above `from` (exclusive): past at most two blank rows (the TUI leaves one
 * between a question and its options), the non-blank rows up to the next blank one.
 */
function paragraphAbove(rows: string[], from: number): { first: number; text: string } | null {
  let end = from;
  while (end > 0 && from - end < 2 && rows[end - 1].trim() === '') end--;
  let i = end - 1;
  while (i >= 0 && end - i <= QUESTION_SPAN && rows[i].trim() !== '') i--;
  // nothing there, or no blank row bounding it from above (the top of the tail may cut a paragraph)
  if (i === end - 1 || i < 0 || rows[i].trim() !== '') return null;
  return { first: i + 1, text: rows.slice(i + 1, end).map((l) => l.trim()).join(' ') };
}
/**
 * The question above a menu starting at `rows[from]`. `rows` must keep its blank rows: they are
 * what bounds a paragraph. The `?` line, when there is one, is widened to its whole paragraph if
 * that paragraph sits right above the menu (a long question that the terminal wrapped: before, only
 * its last row was kept). `prose` (AskUserQuestion) also takes that paragraph when no row ends in `?`
 * — the model wrote the question, and nothing obliges it to end a row, or the text, with one.
 */
function findQuestion(rows: string[], from: number, prose = false): string | undefined {
  const q = questionRow(rows, from);
  const para = paragraphAbove(rows, from);
  if (para && (q >= para.first || (q < 0 && prose))) return clipTo(para.text, QUESTION_MAX);
  return q >= 0 ? clipTo(rows[q], QUESTION_MAX) : undefined;
}
/** AskUserQuestion's chips (`☐ Scope`, `← ☐ A  ☐ B  ✔ Submit →`): the header only when there is exactly one. */
const CHIP = /[☐☒]\s+([^☐☒✔←→]+)/g;
function findHeader(rows: string[], from: number): string | undefined {
  for (let i = from - 1; i >= Math.max(0, from - QUESTION_SPAN); i--) {
    const chips = [...rows[i].matchAll(CHIP)].map((m) => m[1].trim()).filter(Boolean);
    if (chips.length) return chips.length === 1 && !/[✔←→]/.test(rows[i]) ? clip(chips[0]) : undefined;
  }
  return undefined;
}

const tidyLabel = (s: string): string => s.replace(/\s+/g, ' ').replace(/\s*[✔✓]\s*$/, '').trim();

/** The keys that move the focus from option `from` to option `to`, then accept. */
function arrowKey(from: number, to: number, accept: boolean): string {
  const d = to - from;
  return (d >= 0 ? KEY_DOWN : KEY_UP).repeat(Math.abs(d)) + (accept ? KEY_ENTER : '');
}

/** Options of a NUMBERED block; undefined when they cannot be trusted (see KNOWN LIMITS). */
function numberedOptions(block: string[], firstNum: number, ctx: string): TuiOption[] | undefined {
  if (firstNum !== 1 || MULTI_SELECT.test(ctx)) return undefined;
  const parsed: Array<{ n: number; label: string; cursor: boolean; desc: string[] }> = [];
  for (const l of block) {
    const m = OPTION.exec(l);
    if (m) parsed.push({ n: Number(m[2]), label: tidyLabel(m[3]), cursor: !!m[1], desc: [] });
    // a line between two options belongs to the one above it (the block ends at the last option, so
    // nothing printed after the list, a footer or a border label, can be taken for a description)
    else if (parsed.length) parsed[parsed.length - 1].desc.push(l.trim());
  }
  const cursors = parsed.filter((o) => o.cursor).length;
  if (parsed.length < 2 || cursors !== 1 || parsed.some((o) => /^\[[ x✔✓]\]\s/.test(o.label))) return undefined;
  const cur = parsed.findIndex((o) => o.cursor);
  return parsed.map((o, i) => {
    const freeText = FREE_TEXT.test(o.label);
    const desc = clipTo(o.desc.join(' '), DESC_MAX);
    return {
      n: o.n, label: o.label, selected: o.cursor,
      ...(desc ? { desc } : {}),
      // a digit picks it outright (one keystroke, whatever the cursor is on); only two-digit numbers
      // have no single key and fall back to the arrows
      key: o.n <= 9 ? String(o.n) : arrowKey(cur, i, !freeText),
      ...(freeText ? { freeText: true } : {}),
    };
  });
}

interface Menu { first: number; last: number; end: number; rows: Array<{ text: string; cursor: boolean }>; confident: boolean }

/**
 * Read an UNNUMBERED menu ending near the bottom of `rows`: a `❯ label` cursor row and its aligned
 * peers. Ink prints the pointer in a fixed-width gutter, so every option's label starts in the same
 * column; a line indented DEEPER is a description, one indented less (or a blank row) ends the list.
 * `confident` is false when a "row" starts lowercase — it is more likely the wrapped tail of a long
 * label than an option, and getting the count wrong would make the arrows land on the wrong choice.
 */
function readMenu(rows: string[]): Menu | null {
  let c = -1;
  let after = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].trim() === '') continue;
    if (CURSOR_LINE.test(rows[i])) { c = i; break; }
    if (++after > 8) return null;
  }
  if (c < 0) return null;
  const m = /^(\s*)[❯›](\s+)\S/.exec(rows[c]);
  if (!m) return null;
  const col = m[1].length + 1 + m[2].length;
  const indent = (l: string): number => l.length - l.trimStart().length;
  const peers: Array<{ i: number; text: string; cursor: boolean }> = [{ i: c, text: rows[c].slice(col), cursor: true }];
  let end = c;
  for (let i = c - 1; i >= 0; i--) {
    const l = rows[i];
    if (l.trim() === '') break;
    const d = indent(l);
    if (d < col) break;
    if (d === col) { if (CURSOR_LINE.test(l)) break; peers.unshift({ i, text: l.trim(), cursor: false }); }
  }
  for (let i = c + 1; i < rows.length; i++) {
    const l = rows[i];
    if (l.trim() === '') break;
    if (FOOTER.test(l)) break;
    const d = indent(l);
    if (d < col) break;
    if (d === col) { if (CURSOR_LINE.test(l)) break; peers.push({ i, text: l.trim(), cursor: false }); }
    end = i;
  }
  const texts = peers.map((p) => tidyLabel(p.text));
  return {
    first: peers[0].i, last: peers[peers.length - 1].i, end,
    rows: peers.map((p, k) => ({ text: texts[k], cursor: p.cursor })),
    confident: peers.length >= 2 && texts.every((t) => t !== '' && !/^[a-z]/.test(t)),
  };
}

function menuOptions(menu: Menu | null, ctx: string): TuiOption[] | undefined {
  if (!menu || !menu.confident || MULTI_SELECT.test(ctx)) return undefined;
  const cur = menu.rows.findIndex((r) => r.cursor);
  return menu.rows.map((r, i) => {
    const freeText = FREE_TEXT.test(r.text);
    // no numbers to press: walk the focus there and accept (an input row cannot be accepted)
    return { n: null, label: r.text, selected: r.cursor, key: arrowKey(cur, i, !freeText), ...(freeText ? { freeText: true } : {}) };
  });
}

/**
 * `screenText`: the recent output of the pty (ANSI may still be present; it is stripped here).
 * Returns the kind of dialog the TUI is showing at the END of that text, or null.
 */
export function detectTuiPrompt(screenText: string): TuiPrompt | null {
  if (!screenText) return null;
  const rows = cleanRows(screenText);
  const all = rows.filter((l) => l.trim() !== '');
  if (all.length === 0) return null;
  const lines = all.slice(-TAIL_LINES);
  const n = lines.length;
  // the same tail WITH its blank rows, for the readers that need to see where a list ends
  let start = rows.length; let seen = 0;
  while (start > 0 && seen < n) { start--; if (rows[start].trim() !== '') seen++; }
  const tailRows = rows.slice(start);

  // 1. the option list: consecutive numbered lines, at least two, one carrying the cursor
  let last = -1;
  for (let i = n - 1; i >= 0; i--) if (OPTION.test(lines[i])) { last = i; break; }

  if (last >= 0 && n - 1 - last <= OPTION_REACH) {
    // walk up over the block: numbering must descend by one per option going up (so an older list
    // printed above the dialog is not swallowed), with a few indented description lines between them
    let first = last;
    const nums: number[] = [];
    let gap = 0;
    for (let i = last; i >= 0; i--) {
      const m = OPTION.exec(lines[i]);
      if (m) {
        const v = Number(m[2]);
        if (nums.length && v !== nums[0] - 1) break;
        first = i; nums.unshift(v); gap = 0;
        if (v === 1) break;
      } else if (++gap > 4) break;
    }
    const block = lines.slice(first, last + 1);
    const cursor = block.some((l) => { const m = OPTION.exec(l); return !!m && !!m[1]; });
    const sequential = nums.length >= 2 && nums.every((v, i) => i === 0 || v === nums[i - 1] + 1);
    const withBelow = lines.slice(first, n).join('\n');
    // context: what the TUI prints around a dialog (title + question above, footer below)
    const above = lines.slice(Math.max(0, first - 8), first).join('\n');
    const ctx = `${above}\n${withBelow}`;

    if (cursor && sequential) {
      // the same row in the tail WITH blank rows: `lines` has none, and a paragraph ends at a blank one
      const nonBlank: number[] = [];
      tailRows.forEach((l, i) => { if (l.trim() !== '') nonBlank.push(i); });
      const at = nonBlank[first] ?? 0;
      const asked = QUESTION.test(ctx);
      const question = findQuestion(tailRows, at, asked);
      const header = asked ? findHeader(tailRows, at) : undefined;
      const options = numberedOptions(block, nums[0], ctx);
      const hintOf = (fallback: string): string => (question ? clip(question) : clip(lines[first - 1] ?? fallback));
      const verdict = (kind: TuiPromptKind, fallback: string): TuiPrompt =>
        ({ kind, hint: hintOf(fallback), ...(question ? { question } : {}), ...(header ? { header } : {}), ...(options ? { options } : {}) });
      if (TRUST.test(ctx)) return verdict('trust', 'Trust this folder?');
      if (MODEL.test(ctx)) return verdict('model', 'Select model');
      if (asked) return verdict('question', 'Claude has a question');
      if (PERMISSION.test(ctx)) return verdict('permission', 'Claude needs permission');
      // an unrecognised but real menu: the cursor, the numbering AND the TUI's own footer
      if (FOOTER.test(withBelow)) return verdict('select', 'Choose an option');
    }
  }

  // 1b. a menu WITHOUT numbers. Claude Code 2.1 draws the folder-trust dialog as `❯ No, exit` over
  // `Yes, I trust this folder`, with no "1."/"2.". The structure that keeps this honest is the same
  // as above, minus the numbering: the selection cursor on a line near the end AND the TUI's own
  // footer (`Enter to confirm · Esc to cancel`) as the very last thing painted.
  const menu = readMenu(tailRows);
  if (FOOTER.test(lines.slice(-2).join('\n'))) {
    let cur = -1;
    for (let i = n - 2; i >= Math.max(0, n - 9); i--) if (CURSOR_LINE.test(lines[i])) { cur = i; break; }
    if (cur >= 0) {
      const ctx = lines.slice(Math.max(0, cur - 10)).join('\n');
      const pick = (re: RegExp, fallback: string): string => clip(lines.slice(Math.max(0, cur - 10), cur).find((l) => re.test(l)) ?? fallback);
      const question = menu ? findQuestion(tailRows, menu.first, QUESTION.test(ctx)) : findQuestion(lines, cur);
      const options = menuOptions(menu, ctx);
      const extra = { ...(question ? { question } : {}), ...(options ? { options } : {}) };
      if (TRUST.test(ctx)) return { kind: 'trust', hint: pick(TRUST, 'Trust this folder?'), ...extra };
      if (MODEL.test(ctx)) return { kind: 'model', hint: pick(MODEL, 'Select model'), ...extra };
      if (QUESTION.test(ctx)) return { kind: 'question', hint: pick(QUESTION, 'Claude has a question'), ...extra };
      if (PERMISSION.test(ctx)) return { kind: 'permission', hint: pick(PERMISSION, 'Claude needs permission'), ...extra };
      return { kind: 'select', hint: clip(lines[cur - 1] ?? 'Choose an option'), ...extra };
    }
  }

  // 1c. a Yes/No offer with neither numbers NOR a footer ("Make auto mode your default permission
  // mode?"). With nothing to anchor on, the structure has to be doubled up instead: aligned rows
  // behind the selection cursor, one starting Yes and one starting No, a question line above them,
  // and (as always) the list being the last thing on the screen. Prose that merely says "Do you
  // want to …?" has no cursor rows; a composer holding the word "Yes" has no No row beside it.
  if (menu && menu.confident && !FOOTER.test(tailRows.slice(menu.end + 1).join('\n'))) {
    const yes = menu.rows.some((r) => YES_ROW.test(r.text));
    const no = menu.rows.some((r) => NO_ROW.test(r.text));
    const question = findQuestion(tailRows, menu.first);
    const trailing = tailRows.slice(menu.end + 1).filter((l) => l.trim() !== '');
    if (yes && no && question && trailing.length <= 3 && !trailing.some((l) => CURSOR_LINE.test(l))) {
      const ctx = tailRows.slice(Math.max(0, menu.first - QUESTION_SPAN)).join('\n');
      const options = menuOptions(menu, ctx);
      const kind: TuiPromptKind = TRUST.test(ctx) ? 'trust' : MODEL.test(ctx) ? 'model' : PERMISSION.test(ctx) ? 'permission' : 'select';
      return { kind, hint: clip(question), question, ...(options ? { options } : {}) };
    }
  }

  // 2. not a menu, but still waiting on a keypress — only trusted on the very last lines
  const endText = lines.slice(-2).join('\n');
  if (PANEL.test(lines[n - 1]) || PANEL.test(lines.slice(-2).join(' '))) {   // a narrow pane wraps the footer ("… x to stop · Esc" / "to close")
    const title = lines.slice(Math.max(0, n - 30), n - 1).reverse().find((l) => PANEL_TITLE.test(l));
    return { kind: 'other', hint: clip(title ?? lines[n - 1]) };
  }
  const o = OTHER.exec(endText);
  if (o) return { kind: 'other', hint: clip(lines[n - 1]) };
  return null;
}

// ── a question taller than the screen, read from the transcript ─────────────────────────────────

/** One question of an AskUserQuestion call, as the model wrote it (tool_use input), bounded. */
export interface AskQuestion {
  question: string; header?: string; multiSelect: boolean;
  options: Array<{ label: string; description?: string }>;
}
const ASK_MAX_QUESTIONS = 4;
const ASK_MAX_OPTIONS = 12;

/** The questions of an AskUserQuestion `tool_use.input`, or undefined when it is not that shape. */
export function askQuestionsOf(input: unknown): AskQuestion[] | undefined {
  const qs = input && typeof input === 'object' ? (input as { questions?: unknown }).questions : undefined;
  if (!Array.isArray(qs)) return undefined;
  const out: AskQuestion[] = [];
  for (const q of qs.slice(0, ASK_MAX_QUESTIONS)) {
    if (!q || typeof q !== 'object') return undefined;
    const r = q as { question?: unknown; header?: unknown; multiSelect?: unknown; options?: unknown };
    if (typeof r.question !== 'string' || !r.question.trim() || !Array.isArray(r.options)) return undefined;
    const options: AskQuestion['options'] = [];
    for (const o of r.options.slice(0, ASK_MAX_OPTIONS)) {
      const label = o && typeof o === 'object' ? (o as { label?: unknown }).label : undefined;
      if (typeof label !== 'string' || !label.trim()) return undefined;
      const d = (o as { description?: unknown }).description;
      options.push({ label: clipTo(label, 200), ...(typeof d === 'string' && d.trim() ? { description: clipTo(d, DESC_MAX) } : {}) });
    }
    if (!options.length) return undefined;
    out.push({
      question: clipTo(r.question, QUESTION_MAX), multiSelect: r.multiSelect === true, options,
      ...(typeof r.header === 'string' && r.header.trim() ? { header: clip(r.header) } : {}),
    });
  }
  return out.length ? out : undefined;
}

/** Labels compared the way the screen can show them: spacing folded, and a row the terminal wrapped
 *  only has its head, so one being the start of the other is a match. */
const norm = (s: string): string => tidyLabel(s).toLowerCase();
const sameLabel = (screen: string, model: string): boolean => {
  const a = norm(screen); const b = norm(model);
  return !!a && (a === b || b.startsWith(a) || a.startsWith(b));
};
const CHAT_ABOUT = /^Chat about this/i;

/**
 * `detectTuiPrompt`, plus the case it cannot read: an AskUserQuestion whose question and described
 * options are taller than the screen. Its top (question, chips, option 1 and the cursor) has scrolled
 * away, so the visible rows are a tail of the list and the screen alone says nothing trustworthy.
 * The transcript holds the whole call: the pending `tool_use` (`ask`, the questions not yet answered)
 * carries every question and option. It is used only when (a) the screen did not already yield a
 * question card, (b) the TUI's own footer and its "Type something" / "Chat about this" rows are on
 * screen, and (c) exactly ONE question of the call matches every visible numbered row, so the card
 * can never show a question the dialog is not asking. Answering is unchanged: the digits (or, past
 * 9, arrows from a cursor that must then be visible) go to the pty as for any numbered dialog.
 */
export function detectWithAsk(screenText: string, ask: readonly AskQuestion[] | null | undefined): TuiPrompt | null {
  const r = detectTuiPrompt(screenText);
  if (!ask || !ask.length || !screenText) return r;
  if (r && r.kind === 'question' && r.options && r.question) return r;   // the screen read it whole: PR 130's path
  const lines = cleanRows(screenText).filter((l) => l.trim() !== '').slice(-TAIL_LINES);
  if (lines.length < 2 || !FOOTER.test(lines.slice(-2).join('\n'))) return r;
  if (!/(Type something|Chat about this)/m.test(lines.join('\n'))) return r;
  const visible: Array<{ n: number; label: string; cursor: boolean }> = [];
  for (const l of lines) { const m = OPTION.exec(l); if (m) visible.push({ n: Number(m[2]), label: tidyLabel(m[3]), cursor: !!m[1] }); }
  if (!visible.length) return r;
  const fits = (q: AskQuestion): boolean => {
    const k = q.options.length;
    return visible.every((v) => (v.n >= 1 && v.n <= k) ? sameLabel(v.label, q.options[v.n - 1].label)
      : v.n === k + 1 ? FREE_TEXT.test(v.label) : v.n === k + 2 ? CHAT_ABOUT.test(v.label) : false);
  };
  const matches = ask.filter(fits);
  if (matches.length !== 1) return r;
  const q = matches[0];
  const base = { kind: 'question' as const, hint: clip(q.question), question: q.question, ...(q.header ? { header: q.header } : {}) };
  // multi-select is answered with space and Enter over checkboxes: the card points at the terminal, as for the screen
  if (q.multiSelect) return base;
  const k = q.options.length;
  const total = k + 2;
  const cur = visible.find((v) => v.cursor)?.n;
  if (total > 9 && cur === undefined) return base;   // a two-digit row needs arrows, and arrows need the cursor
  const shown = (n: number): string | undefined => visible.find((v) => v.n === n)?.label;
  const keyOf = (n: number, accept: boolean): string => n <= 9 ? String(n) : arrowKey((cur as number) - 1, n - 1, accept);
  const options: TuiOption[] = q.options.map((o, i) => ({
    n: i + 1, label: o.label, selected: cur === i + 1, key: keyOf(i + 1, true), ...(o.description ? { desc: o.description } : {}),
  }));
  options.push({ n: k + 1, label: shown(k + 1) ?? 'Type something.', selected: cur === k + 1, key: keyOf(k + 1, false), freeText: true });
  options.push({ n: k + 2, label: shown(k + 2) ?? 'Chat about this', selected: cur === k + 2, key: keyOf(k + 2, true) });
  return { ...base, options };
}

// ── a debounced watcher over the pty output ─────────────────────────────────

export interface PromptMonitor {
  /** Raw pty output, exactly as it arrives (ANSI included). */
  push(data: string): void;
  /**
   * What the terminal currently SHOWS (plain text, as the owner's emulator rendered it). The raw
   * stream cannot say this: Ink repaints a dialog differentially (moving the selection rewrites two
   * lines and not the footer), so the tail of the stream stops looking like a dialog while the
   * dialog is still open. A screen replaces the buffer instead of extending it.
   */
  screen(text: string): void;
  /** The transcript moved on (a tool finished, the operator typed): whatever was asked is answered. */
  clear(): void;
  /** Stop timers; nothing is emitted afterwards. */
  dispose(): void;
}

export interface PromptMonitorOptions {
  /**
   * Called ONLY when a different dialog appears — another kind, question or set of options (their
   * numbers and labels); `null` means the dialog is gone. `prompt` is the whole
   * verdict (with `question`/`options`); `kind` and `hint` stay as the first two arguments so
   * existing consumers keep working.
   */
  onChange(kind: TuiPromptKind | null, hint?: string, prompt?: TuiPrompt): void;
  /**
   * The SAME dialog, but its cursor moved (so `selected` and, for an unnumbered menu, every `key`
   * changed). Optional: a consumer that never draws buttons can ignore it.
   */
  onRefresh?(prompt: TuiPrompt): void;
  debounceMs?: number;
  /** Raw characters kept. ANSI-heavy redraws are ~3x their visible text, so this is a few KB of screen. */
  maxChars?: number;
  /** The detector to run; `detectTuiPrompt` when absent. The chat view passes `detectWithAsk` bound to the
   *  session's pending AskUserQuestion, so a question taller than the screen still becomes a card. */
  detect?: (screenText: string) => TuiPrompt | null;
  /** Injected so a test needs no real clock. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
}

/**
 * Keeps a bounded tail of pty output and runs the detector on it AFTER output settles (a TUI repaints
 * a dialog in many small writes; judging each one would flicker). It reports transitions only: the
 * same dialog twice is one event (a cursor that moved inside it goes to `onRefresh`), and a dialog
 * that goes away is `null`.
 *
 * Output alone cannot always say a dialog was dismissed (a repaint may leave its text in the tail),
 * so the owner also calls `clear()` when the transcript proves it was answered. `clear()` drops the
 * buffer too, otherwise the stale dialog text would be detected again on the very next repaint.
 */
export function createPromptMonitor(o: PromptMonitorOptions): PromptMonitor {
  const debounceMs = o.debounceMs ?? 120;
  const maxChars = o.maxChars ?? 16384;
  const setT = o.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearT = o.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let buf = '';
  let current: string | null = null;      // signature of what was last reported; null = nothing open
  let timer: unknown;
  let dead = false;

  // IDENTITY of a dialog = kind + question + the options' numbers and labels. Not the hint (for a
  // prompt with no question it is a screen line that can keep changing) and not the cursor: moving
  // the selection inside the terminal is the same dialog, so `onChange` stays quiet. But the keys of
  // an unnumbered menu are relative to the cursor, so the moved cursor is reported through
  // `onRefresh` instead, and a consumer that draws buttons must adopt the latest keys.
  const idOf = (r: TuiPrompt | null): string | null => r === null ? null
    : JSON.stringify([r.kind, r.question ?? '', r.options ? r.options.map((x) => [x.n, x.label]) : null]);
  const stateOf = (r: TuiPrompt): string => JSON.stringify(r.options ? r.options.map((x) => [x.selected, x.key]) : null);
  let curState = '';

  const emit = (r: TuiPrompt | null): void => {
    if (dead) return;
    const id = idOf(r);
    if (id === current) {
      if (r && stateOf(r) !== curState) { curState = stateOf(r); o.onRefresh?.(r); }
      return;
    }
    current = id;
    curState = r ? stateOf(r) : '';
    if (r) o.onChange(r.kind, r.hint, r); else o.onChange(null);
  };

  function evaluate(): void {
    timer = undefined;
    if (dead) return;
    emit((o.detect ?? detectTuiPrompt)(buf));
  }

  return {
    push(data: string): void {
      if (dead || !data) return;
      buf = (buf + data).slice(-maxChars);
      if (timer !== undefined) clearT(timer);
      timer = setT(evaluate, debounceMs);
    },
    screen(text: string): void {
      if (dead) return;
      buf = String(text ?? '').slice(-maxChars);
      if (timer !== undefined) clearT(timer);
      timer = setT(evaluate, debounceMs);
    },
    clear(): void {
      if (dead) return;
      buf = '';
      if (timer !== undefined) { clearT(timer); timer = undefined; }
      emit(null);
    },
    dispose(): void {
      dead = true;
      if (timer !== undefined) { clearT(timer); timer = undefined; }
      buf = '';
    },
  };
}
