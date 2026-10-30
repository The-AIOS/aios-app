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
 * "Select model", "Type something", "Chat about this", "Enter to select", "Esc to cancel", and the
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
 * notice is the net).
 */

export type TuiPromptKind = 'permission' | 'trust' | 'select' | 'question' | 'model' | 'other';
/**
 * One selectable row of a dialog. `n` is the number the TUI prints (null for an unnumbered menu).
 * `key` is what to write to the pty to pick it (see THE KEYS above; split with `keyChunks`).
 */
export interface TuiOption { n: number | null; label: string; selected: boolean; key: string; freeText?: boolean }
export interface TuiPrompt {
  kind: TuiPromptKind;
  hint: string;
  /** The question line ("Do you want to proceed?"), when the screen shows one. */
  question?: string;
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
// AskUserQuestion always adds free-text / discuss options; its header chips are ☐ ☒ ✔ checkboxes
const QUESTION = /(Type something|Chat about this|^\s*[←→]?\s*[☐☒]\s)/m;
const PERMISSION = /(Do you want to |Would you like to proceed|tell Claude what to do differently|Yes, and don't ask again|Yes, allow all edits|Yes, during this session)/i;
// 'other': a prompt that is not a menu but still waits on a keypress
const OTHER = /(Press Enter to continue|\(y\/n\)\s*$|\[y\/N\]\s*$|\[Y\/n\]\s*$)/i;

/** Only the lines at the very end of the screen can be a live dialog. */
const TAIL_LINES = 40;
/** The last option must be within this many non-empty lines of the end. A dialog prints at most a
 *  description and a footer after its last option; more than that means output moved on past it. */
const OPTION_REACH = 5;

const HINT_MAX = 160;
const clip = (s: string): string => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > HINT_MAX ? t.slice(0, HINT_MAX - 1) + '…' : t;
};

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

/** The nearest question line above `from` (exclusive), or undefined. */
function findQuestion(rows: string[], from: number): string | undefined {
  for (let i = from - 1; i >= Math.max(0, from - QUESTION_SPAN); i--) {
    if (QUESTION_LINE.test(rows[i])) return clip(rows[i]);
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
  const parsed: Array<{ n: number; label: string; cursor: boolean }> = [];
  for (const l of block) {
    const m = OPTION.exec(l);
    if (m) parsed.push({ n: Number(m[2]), label: tidyLabel(m[3]), cursor: !!m[1] });
  }
  const cursors = parsed.filter((o) => o.cursor).length;
  if (parsed.length < 2 || cursors !== 1 || parsed.some((o) => /^\[[ x✔✓]\]\s/.test(o.label))) return undefined;
  const cur = parsed.findIndex((o) => o.cursor);
  return parsed.map((o, i) => {
    const freeText = FREE_TEXT.test(o.label);
    return {
      n: o.n, label: o.label, selected: o.cursor,
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
      const question = findQuestion(lines, first);
      const options = numberedOptions(block, nums[0], ctx);
      const hintOf = (fallback: string): string => question ?? clip(lines[first - 1] ?? fallback);
      const verdict = (kind: TuiPromptKind, fallback: string): TuiPrompt =>
        ({ kind, hint: hintOf(fallback), ...(question ? { question } : {}), ...(options ? { options } : {}) });
      if (TRUST.test(ctx)) return verdict('trust', 'Trust this folder?');
      if (MODEL.test(ctx)) return verdict('model', 'Select model');
      if (QUESTION.test(ctx)) return verdict('question', 'Claude has a question');
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
      const question = menu ? findQuestion(tailRows, menu.first) : findQuestion(lines, cur);
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
      return { kind, hint: question, question, ...(options ? { options } : {}) };
    }
  }

  // 2. not a menu, but still waiting on a keypress — only trusted on the very last lines
  const endText = lines.slice(-2).join('\n');
  const o = OTHER.exec(endText);
  if (o) return { kind: 'other', hint: clip(lines[n - 1]) };
  return null;
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
    emit(detectTuiPrompt(buf));
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
