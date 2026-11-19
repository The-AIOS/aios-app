# RFC: Live Preview — edit a note while it looks rendered

- **Status:** Design, for review
- **Scope:** AIOS App (this repo). No framework change. Glass is out of scope (notes open in VS Code's own editor there).
- **Code references:** `renderer/app.js` → `openViewer` (mode switch, `paint`, markdown render, checkbox toggle),
  `buildCodeEditor` (Edit mode), the find-in-file block (`findHost`); `src/main/main.ts` → `fs:write`;
  `src/main/menu.ts` (accelerators); Settings → *Open files in* (`openNotesIn`).

## 1. Summary

A markdown file in the App opens in one of two modes today: **Rendered** (read-only HTML; task checkboxes are the only
thing you can change) and **Edit** (raw markdown in a syntax-highlighted text box). An operator reading a daily note who
wants to change a word has to notice the ✏️ button, switch into raw markdown, find their place again, and switch back.
Obsidian solved this with a third mode, **Live Preview**: the note looks rendered, and you can type anywhere.

This RFC adds that mode, as a **third option beside the two that exist**, and makes it the default for new installs.

It also fixes a data-loss bug that exists today and that Live Preview would make far more likely (§ 4): the editor
saves without checking whether the file changed on disk since it was opened, so an agent's write to an open note is
silently overwritten by the next autosave.

**This opens a deliberate gate.** `CLAUDE.md` says *"Viewers render; Obsidian edits (editing is a later, deliberate
gate)."* Edit mode already crossed it partway; this RFC crosses it on purpose, and the PR updates that line.

## 2. Why

- Operators of this App "never open an editor" (CLAUDE.md). Rendered-by-default means the note they live in, today's
  daily note, can't be typed into without a mode change most of them won't find.
- Edits come in both sizes and the same mode must serve both: a tick or a word fixed in passing, *and* writing a long
  section or draft.
- The daily note is written concurrently: the operator in the App, plus agents (`/close-session`, the live daily-note
  ledger, spawned workers). The more time a note spends open-and-editable, the more that concurrency matters.

## 3. What the operator gets

### 3.1 Three modes

| Mode | Looks like | Typing | Notes |
|---|---|---|---|
| **Reading** (today's *Rendered*) | Fully rendered | No | Unchanged, except its checkbox toggle gains the § 4.1 safety (it writes the file). Wikilinks still open notes. |
| **Live Preview** (new) | Rendered | Yes, everywhere | The line(s) the cursor/selection is on show their raw markdown; every other line shows formatted. |
| **Source** (today's *Edit*) | Raw markdown, syntax-coloured | Yes | Unchanged in behaviour (it gains the § 4 safety). |

- The viewer header's two-button segment becomes **three buttons**: Reading · Live Preview · Source. All three are
  visible: the App's operators don't discover hidden modes. *(Builder's call: icons vs words, and the i18n strings —
  the existing `viewer.rendered` / `viewer.edit` keys may be relabelled; add `viewer.live`. All four locales: en, es,
  pt-br, el.)*
- Settings → **Open files in** gains the third choice (`openNotesIn: 'live'`). Today the value is two-valued in three
  places, and all three must change or `'live'` silently reads back as Reading: the `ShellSettings` type,
  `shellSettings()` (`src/main/aios.ts`, coerces anything but `'source'` to `'rendered'`), and the renderer's
  `OPENNOTESIN !== 'source'` check in `openViewer`.
- **No ⌘E.** Obsidian's toggle is taken here (`CmdOrCtrl+E` = Toggle Explorer). A shortcut is optional; if one is
  added it must pass `menu.test.ts`'s no-duplicate-accelerator test and the renderer chord table.
- Non-markdown files are unaffected: HTML/PDF/images keep their viewers; code files keep Source only.

### 3.2 Default

- **New installs** default to Live Preview.
- **Existing installs that never chose** keep Reading — nobody's view changes under them on an update.
- **Mechanism (author's call):** `seedClaudeDefaults()` (`src/main/aios.ts`), which already treats an install as new
  when `<framework>/.glass/shell.json` is missing, writes `openNotesIn: 'live'`. The read-side fallback for a *missing*
  key stays `'rendered'`, so "missing" keeps meaning "an install from before this shipped".
- **"New" is per machine (author's call).** `.glass/` is gitignored, so an operator's second machine or a re-clone
  counts as new and gets Live Preview. Acceptable: it's a default, and the setting is one click.
- The operator who requested this sets their own setting to Live Preview; no special-casing.

### 3.3 What renders in Live Preview — day one

Must render cleanly on day one:

- headings (ATX `#`…`######`), bold, italic, strikethrough
- bullet / numbered lists, nested; **task checkboxes** — clickable, toggling `[ ]`↔`[x]` in the text
- links and **`[[wikilinks]]`** (incl. `[[target|alias]]`, `[[target#heading]]`) — clickable, opening the note exactly
  as Reading does today (`glassShell.resolveNote`); clicking must not also place the cursor in a way that edits
- inline code and fenced code blocks (code blocks highlighted with the highlight.js the App already ships)
- tables
- **frontmatter** — shown as property chips until the cursor enters it, then raw YAML. *Author's call:* Live Preview
  shows **every** top-level property as a chip (Reading caps at 8 and drops nested YAML); a nested value shows as raw
  text inside its chip. Hiding content you can edit is worse than a busier header. Reading's chips are unchanged.

Second wave (not day one): callouts (`> [!note]`), embedded images (`![[x.png]]`, `![](x.png)`), horizontal rules,
blockquote styling beyond plain, footnotes, HTML blocks, math.

**Rule for anything not yet handled: show it as plain markdown.** Never a half-rendered or flickering state. An
unsupported construct looks exactly like Source.

### 3.4 Everything Source mode has, Live Preview has

These are working features of today's Edit mode and must not regress in either editing mode:

- autosave 700 ms after typing stops, on blur, and on ⌘S
- the uncommitted-change bars (left), the overview ruler (right, clickable), the ‹ › change stepper and ⌥↑/⌥↓
- ⌘F find in the open file, which in an editing mode places a real selection at the match. In Live Preview this must
  go through **CodeMirror's own search** (`@codemirror/search` state, driven by the App's find bar): `findHost`/`runFind`
  walk DOM text nodes, and CodeMirror only renders the visible lines, so a DOM search would miss off-screen matches.
- undo/redo through the Edit menu. Today the menu is Electron's `{ role: 'editMenu' }` (`src/main/menu.ts`), whose Undo
  is the browser's native undo — which does **not** reach CodeMirror's own history. *Author's call:* replace only the
  Undo and Redo items with custom items that ask the renderer to undo/redo in the focused CodeMirror editor, and fall
  through to the native `webContents.undo()`/`redo()` when no CodeMirror editor has focus. Terminal, chat composer and
  ordinary inputs keep exactly today's behaviour; tested both ways.
- Tab inserts indentation (two spaces today); editor zoom

## 4. Safety — the anti-goals, in priority order

The operator ranked all four as deal-breakers, **losing text worst**.

### 4.1 Never lose text (top priority — also a fix for today's Edit mode)

**The bug today:** `openViewer` reads the file once; `save()` → `fs:write` writes the buffer unconditionally (atomic
temp-then-rename, which protects against a crash but not against a stale buffer). Nothing watches the open file.
If an agent writes to the note while it's open, the next autosave writes the old copy back over it. No warning.

**Required behaviour (both editing modes):**

1. **Know the base.** The editor remembers the exact disk content it last loaded or saved (the *base*).
2. **Conditional write.** A save sends the base's hash with the content; the main process writes only if disk still
   matches the base, otherwise returns *conflict* with the current disk content. (A new IPC, or an optional argument
   to `fs:write` — builder's call. Keep it atomic.)
3. **Watch the open file.** When it changes on disk:
   - **no unsaved edits** → reload in place, keeping cursor, selection and scroll as close as possible;
   - **unsaved edits** → three-way merge (base, mine, theirs). Changes to different lines merge silently — this is the
     common case (an agent ticks a ledger line while the operator types elsewhere). Overlapping changes → **do not
     write**; show a conflict bar offering *keep mine* / *take theirs* / *see both*. Until resolved, autosave is paused
     for that file and the tab shows it.
4. **Never silent.** Every path that discards either side is an explicit operator choice.
5. Also covers: the file deleted or renamed while open (stop autosaving, say so; don't recreate it silently).
   Two panes on one file can't happen today (`openViewer` focuses the existing pane for a path; one window) — keep
   that invariant rather than design for it.
6. **Reading's checkbox toggle is in scope.** It regex-edits `file.content` read at open and calls the same
   unconditional `save()`, so it has the same bug. It gets the same base / conditional write / reload-on-change.
   Build one "open file" model (path, base, buffer, watch, conditional save) that all three modes share.

Watching is per **file** (`fs.watch` on the file or its directory, filtered) — the explorer's `setupExplorerWatch`
reports directories, not files, and doesn't run under SMOKE, so reusing it would leave the smoke e2e unable to
exercise the watch. It must survive atomic-rename writes (most agents and `fs:write` itself replace the inode).
The App's own save must not bounce back as an "external change".

### 4.2 Opening never changes the file

The editor holds the markdown text; Live Preview is decoration only. **No serialisation step** (no
markdown → AST → markdown round-trip). Open + close with no keystrokes = zero bytes written. Open + type one character
+ delete it = file byte-identical (or not written). Line endings (CRLF), trailing whitespace, frontmatter formatting,
list markers and table spacing are preserved exactly.

**Files that can't be held byte-for-byte are not edited.** *Author's call*, following from "losing text worst" and
"the file changing on its own": CodeMirror normalises line endings (a pure-CRLF file is fine with `lineSeparator`
set; a file **mixing** CRLF and LF is not), and `fs:read` decodes as UTF-8, so invalid bytes would become U+FFFD on
the first save. On open, detect mixed line endings or a decode that doesn't round-trip; such a file opens in **Reading,
read-only in every mode** (checkbox toggle included), with a one-line notice saying why and offering *Reveal in
Finder*. Note today's Source textarea also normalises CRLF — the same detection protects Source.

### 4.3 No lag, no cursor jumps

- Benchmark: a large real daily note (today's is ~25 KB, ~200 lines with long lines and tables) and a synthetic
  10× version. Typing must stay instant; no frame where the cursor visibly jumps when syntax shows/hides on the line
  you enter or leave.
- Revealing raw markdown on the active line will shift that line's width/wrap — expected, and Obsidian does the same;
  it must not move the cursor's logical position or scroll the view.

### 4.4 No half-rendering

See § 3.3's rule. Rendering is per-construct and all-or-nothing.

## 5. How it's built (decided)

- **CodeMirror 6** (`@codemirror/state`, `view`, `commands`, `language`, `lang-markdown` + `@lezer/markdown` GFM
  extensions for tables/tasks/strikethrough). Live Preview = the standard technique: decorations that hide markup
  outside the active line(s), replace-widgets for checkboxes/links/frontmatter chips, line/mark styling for headings,
  code, tables. Source mode can stay on the existing `buildCodeEditor` (lowest risk) or move to the same CodeMirror
  instance with decorations off — **builder's call**, but § 3.4 and § 4 must hold in both.
- **One bundling step.** The renderer is plain `<script>` tags loading UMD builds from `node_modules`; CodeMirror 6
  ships ES modules only. Add an esbuild step that emits one IIFE file (e.g. `renderer/vendor/cm-live.js`) exposing
  what `app.js` needs on a global, wired into `compile` so `start`, `test`, `smoke` and `dist` all build it.
  `verify:package` must confirm the file is in the packaged app. No framework, no TypeScript migration of `app.js`.
- **Rendering parity with Reading.** Live Preview should look like Reading (same CSS for headings, lists, code,
  tables), so switching modes doesn't feel like a different app. The wikilink resolver and checkbox semantics are
  shared, not reimplemented.
- **Checkbox toggling** in Live Preview edits the document through the editor (an ordinary transaction), so it is
  undoable and goes through the same save path — unlike Reading's regex-over-the-file toggle.
- **Theme:** both the dark and light themes (light was recently fixed for contrast; don't regress it).

## 6. Tests

- **Round-trip (§ 4.2):** a fixture set of real-shaped vault notes (frontmatter, tables, nested tasks, CRLF, trailing
  spaces, wikilinks, code fences). Open in Live Preview, close, assert zero writes; type-and-revert, assert
  byte-identical. Include the `make-vault-fixture` vault.
- **Concurrency (§ 4.1):** unit tests over the merge logic (pure, in `src/core/`); an e2e in `smoke` that opens a note,
  writes it externally (rename-replace, like an agent), and asserts (a) clean reload with no edits, (b) silent merge on
  non-overlapping edits, (c) conflict bar and *no write* on overlap. The same e2e runs against Source mode and against
  Reading's checkbox toggle.
- **Unsafe files (§ 4.2):** mixed-EOL and invalid-UTF-8 fixtures open read-only and are never written.
- **Default (§ 3.2):** a **unit** test (first-run seeding is skipped under smoke): fresh settings → `live`; settings
  without the key → `rendered`; explicit values respected; `'live'` survives `shellSettings()`.
- **Undo (§ 3.4):** menu Undo/Redo reach CodeMirror's history when it has focus, and still work natively in a terminal
  and a plain input.
- **Parity (§ 3.4):** autosave timing, ⌘S, gutter after save, find in Live Preview, menu-undo noticed.
- **Accelerators:** `menu.test.ts` passes (relevant only if a shortcut is added).
- **Performance (§ 4.3):** a scripted typing run over the large fixture, reporting frame times; a budget the builder
  proposes and records in the PR.

## 7. Out of scope

- Glass (VS Code renders notes there).
- The second-wave constructs in § 3.3.
- Collaborative/real-time multi-user editing, Obsidian plugin compatibility, a WYSIWYG toolbar.
- Changing Reading mode (beyond relabelling).

## 8. Left to the builder

Icons vs words on the three buttons and their i18n; whether Source moves to CodeMirror; the watch mechanism; the
conditional-write API shape; the conflict bar's exact UI (it must be unmissable and its three choices explicit); the
performance budget; whether a keyboard shortcut is added and which.

## 9. Ships with

- `CLAUDE.md`: replace "Viewers render; Obsidian edits (editing is a later, deliberate gate)" with the new state.
- What's new / CHANGELOG entry (the `check:whatsnew` gate), all four locales. (That script's error message says
  "three"; fix it in passing.)
- The § 4.1 fix is worth calling out on its own in the release notes: it changes behaviour for Source mode too.
