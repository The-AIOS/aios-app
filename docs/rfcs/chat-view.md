# RFC: Chat view — a skin over the terminal session

- **Status:** Prototype, for discussion
- **Scope:** AIOS App (this repo). No framework change.
- **Code references:** `feat/chat-skin`, branched from 0.12.0 and merged with `upstream/main` at 0.13.0 (it replaces the
  earlier `feat/chat-view` prototype). What changed since the first review is in § 12; what was measured on the
  packaged build is in § 11.
  The view mode moved from a tab icon to a Settings choice in `fdb4eca`, `0aae124`, `2ce84f0`, `d000cfe` and
  `c20ca7a` (§ 2.4)

## 1. Summary

The app's way to talk to Claude is a terminal, and that stays the right default (*Glass, not engine*:
the real `claude` CLI in a real pty, never reimplemented). But a terminal is a poor reading surface for
an operator who never opens an editor: no readable prose, no font choice, tool output that scrolls
away, no quiet "how much have I used".

This RFC describes a **chat view that is a visual layer over the same Claude Code session an existing
terminal pane already runs**. It is not a new pane, not a new session and not a second route to Claude.
Whatever starts a Claude pane today (Start / Launch, an agent, a ritual, `--resume`, a restored tab) keeps
doing exactly that; the app gains one choice, **Chat | Terminal** (Settings, § 2.4), that changes how the Claude
sessions are *looked at*. The pty and the `claude` process inside it remain the only source of truth. The chat reads
along (the session's transcript file, plus the tail of the pty output to notice dialogs) and writes back
through the same door the terminal uses. It never answers a dialog by itself: a dialog it could read is drawn as a
card of buttons, and a key goes to the pty only when the operator presses one of them (§ 5).

An earlier prototype (the `feat/chat-view` RFC this document replaces) built a separate "Chat" pane that
drove Claude through the Agent SDK. That pane was **removed** (§ 8). The pieces worth keeping — bubbles,
sanitised markdown, the font picker, the usage bar — were moved onto the skin.

It is a prototype: the loop is proved on a real session end to end by a gate in `npm run smoke` (§ 9), and
§ 10 lists what it does not do.

## 2. What it does for the operator

The view mode applies to every pane that runs Claude; panes that run anything else (a shell, a viewer, a
session that has ended) are never touched by it.

- **One mode, set in Settings.** *Settings → Claude sessions view: Chat | Terminal* (`claudeView`, § 2.4). There
  is no switch on the tab and none inside the pane (§ 2.2). The choice applies **live** to every open Claude
  pane and to each one that appears later, new, restored or resumed. `CmdOrCtrl+Shift+L` and *File → Switch
  Claude Sessions Between Chat and Terminal* flip the same global setting. Changing the mode creates no pane and
  no pty.
- **Looking is not choosing.** *View in the terminal* on a dialog card shows the live strip for that dialog and
  nothing else changes. The *Show terminal* buttons of the notice strip and of the error card step **that one
  tab** out of the mode. Neither ever writes the setting (§ 2.4).
- **One reading column.** The conversation is a single centred column, at most ~748 px wide with 16 px
  gutters, so a wide dock reads like a page and a narrow one simply fills. The log itself spans the pane (its
  scrollbar stays at the pane's edge); the column is made with side padding, which resolves against the pane.
  The look is inspired by the layout of chat apps in general (a column, boxes, compact tool rows, a floating
  composer); it uses the app's own tokens, Inter or the system font, and none of anyone's marks.
- **Boxes.** The operator's message is a soft rounded box on the right (plain text, line breaks kept). Claude's
  reply has **no bubble**: it is text across the whole column, markdown rendered once the message is complete,
  with a reading hierarchy (1.7 line height, headings, lists, quotes, links, rules), inline code on a soft
  fill, a **header on every code block** (language on the left, a **copy** button on the right: clipboard
  through the shell, "Copied" feedback) and **framed tables** (tinted header, faint zebra, their own horizontal
  scroll). The "You" / "Claude" labels are gone from the screen and remain, hidden, for screen readers. The
  code header, the copy button and the table wrapper are built as DOM *after* the sanitiser (§ 8), so the
  allowlist did not change and no `<button>` can come from the model. Notes for system events (an
  interruption, an API error, the output of a local command) are small centred pills.
- **The reply as it is written.** The transcript only records a message once it is complete, so a long answer
  used to appear all at once at the end. Now, while a turn is open, the reply being written on the terminal screen
  is drawn as **one provisional bubble that grows** (§ 3.2 `stream`, § 10 for what was measured): the same bubble as
  the real message, a step quieter, with a small caret in the busy hue at the end of the last line (no coral;
  `prefers-reduced-motion` stops the blinking). It is rendered through the same sanitised markdown as the final
  message. When the finished message lands in the transcript it **takes over that very node**: same place in the
  column, no second bubble, no scroll jump, no flicker (the real markdown is painted into the node already on
  screen). A tool that lands meanwhile goes above the preview; the preview is dropped when the turn ends or the
  view resets if nothing adopted it; a screen reader hears the finished message once (the preview is
  `aria-hidden`). With no transcript to take its place (a session with no id yet) nothing is previewed.
- **Tools as rows, with their output.** Each tool call is one compact row: a glyph by kind (read, edit, bash,
  search, web, agent; a wrench for the rest, MCP tools included), the name, its main argument truncated with an
  ellipsis, and a state mark: a quiet spinner in `--st-busy`, a check in `--st-ok`, a cross in `--st-error`
  (never coral). A run of two or more consecutive calls folds into **one summary row** (§ 2.2); a lone call
  stays a plain row. A row is a button (`aria-expanded`): opened, it shows
  what the tool returned (`ChatItem.tool.output`, § 3.2) in monospace, height-capped with its own scroll, with
  a notice when only the start was kept, or a neutral line when there is nothing (or the tool still runs). The
  status moves **in place** on the same node, so a row the operator opened stays open. The output is
  untrusted text and only ever goes in through `textContent`.
- **Activity indicator.** Three dots in `--st-busy` and "Claude is working…" **inside the column, under the
  last message**, while a turn is open and the pty has produced output recently, or a message was just sent.
- **The composer.** One large rounded card floating over the end of the conversation (a soft shadow, the
  text fading out under it): a textarea that grows to a ceiling and then scrolls and a **round send button**
  that becomes a round **stop button** while Claude works (`chatSkinControls` is unchanged: stop when working,
  send disabled without text). The card holds the text and those buttons and nothing else; the chips and the
  meters that used to share it are in the status bar under it (next bullet). Enter sends; Shift+Enter inserts
  a newline; IME composition never sends. Esc cuts the running turn (only while something is running — see
  § 3). Slash commands are sent like any other message, with no filter and no special path. The box is
  neutral: its border does not change colour on focus (a slightly stronger neutral edge and a faint halo),
  keyboard focus on the small controls is a neutral outline, and **the accent colour is used for the send
  button and nothing else** in the chat — markdown links take a cool `--chat-link` token (the house has no
  link token, and the markdown viewer's coral links are spoken for here).
- **The status bar under the card.** One bar, the last thing in the pane, with everything the operator wants
  to know about *what answers* and *what it costs*: model · effort · 5 h · week · context, and at the right
  end the keys hint (which shows only while the caret is in the box; the full sentence is the textarea's
  tooltip and its accessible description). The model and the effort are both buttons (§ 2.2). The earlier design split these in two (model and effort chips
  inside the card, the meters in a row of their own), which made the card busy and the row a toolbar; one bar
  under a quiet card reads as one answer to "what am I talking to, and how much is left". Its look is a
  **strip**: a rounded strip glued under the card, segments separated by short hairlines, a slim bar per meter;
  the card's bottom edge and the strip share one outline and one shadow, so the two read as one object.
  **Decision: the strip, chosen by the operator after comparing three looks side by side** (a thin line with a
  small ring per meter, a capsule per metric, and the strip). The other two were built, compared in the hidden
  shots and deleted, along with the class that switched between them, the `localStorage` preference and the
  usage ring; there is no setting for the look. The model is a
  button: it types `/model` through the same door as any other message (`chatSkinSubmit`, the only caller of
  `submitToPty`), and is disabled while a turn runs or a dialog is open.
  **Thresholds.** A meter is neutral below 60 %, `--st-warn` (amber) from 60 % and `--st-error` (a real red,
  never coral) from 85 %: the amber has to leave room to act before the red says "now". The thresholds are on
  the *percentage*, whatever number is shown (the context meter shows tokens). A reading we do not have is `—`
  with an empty bar, never `0`; an unknown effort is the dim word *effort*, never a dash and never another
  session's level, because a dash would read as a failure (§ 6).
  **The detail card.** Every meter answers hover and keyboard focus (not a `title`) with a card: the window,
  the percentage used, **when it resets** (a clock time today, weekday and time otherwise, plus the two
  largest units left) and, for context, **tokens over the window**. The reset lines appear only when the
  payload carried them; a reset already behind us says the reading predates it and dims the meter. The card
  does not open upward (that is where the text being typed is) or downward (the bar is the last thing in the
  pane): it **covers the bar's own line**, at its fixed two-line height, so nothing moves when it opens.
  The screenshot fixture throws if the card ever reaches into the composer or past the bar.
  **Responsive.** The bar is its own size container and gives up words before meaning: under 520 px the
  labels go, under 480 the "of 200k", the narrower pill and smaller bars, under 410 the effort, under 372
  the number inside a pill or strip segment (the bar and the colour remain), under 330 every number.
  Checked at panes of 400, 340 and 300 px.
- **Slash commands.** Typing `/` at the very start of the box opens a popup above the card listing what the
  operator can run: Claude Code's built-in commands, the AIOS plugin's `/aios:*`, the operator's own
  (`<config dir>/commands`), the project's (`.claude/commands` of the pane's folder) and the installed
  plugins'. Each row shows the name, its usage hint (`argument-hint`) and what it does (`description`), plus a
  quiet origin word when it is the operator's or the project's own (§ 2.1). It filters as they type (name, then alias, then
  the part after a `plugin:` prefix, then any word). ↑/↓ move (and wrap), **Enter or Tab complete** the
  highlighted command into the box as `/name ` and **never send** — the operator still reads the line and sends
  it with a second Enter; a click completes too; **Esc closes the popup and does not cut the turn** (its
  listener runs before the interrupt one, as the effort menu's does). It closes on blur, on sending, when the
  text stops being a lone slash word and when the command is already complete. Accessibility: the textarea is
  a `combobox` over a `listbox` of `option`s with `aria-activedescendant`. It only ever completes text; it
  writes nothing to the pty.
- **Files in the box.** Dropping files (from Finder or from the explorer) or an image on the card, or pasting
  an image, inserts its **absolute path in double quotes** at the caret, as Claude Code's own terminal does;
  it never sends. The drop stops at the card (the pane under it has its own drop zone that would write the
  path to the pty a second time). A picture with no file behind it goes through main, which saves it under
  the system temp folder (`aios-chat-paste/`, a name main chooses, png/jpeg/gif/webp, ≤ 25 MB, own files older
  than a day swept) and returns the path.
- **Reading settings live in Settings and nowhere else.** The font and the text size are two rows of the
  Settings tab, right after the `claudeView` selector, with a live sample line (both rows and the sample step aside while the mode is Terminal); a change repaints every open chat
  view at once and is stored through the same `chatFontFamily` / `chatFontSize` settings. A stack or size
  saved by hand stays selectable (§ 2.2).
- **Cards for the states.** *Connecting*, *waiting*, *empty* and *error* are one centred card (icon, a short
  title, a sentence; the error one adds a button back to the terminal; the empty one adds its three keys, § 2.1). *Quiet for a while* (a stalled turn) is a
  status card in the column in `--st-warn`, with the button back to the terminal.
- **Dialogs as cards with buttons.** When the TUI asks something (a permission, the folder-trust question, `/model`'s
  picker, an `AskUserQuestion`, a yes/no offer) and its rows could be read, the column gets a card in `--st-input`:
  who is asking, the question as the CLI worded it, **one button per option** (its number, its text; the option the
  TUI's cursor is on is the default and carries a return mark) and a **View in the terminal** link that shows the
  live strip instead. Click, or ↑/↓ and Enter, or the option's number: only that option's key reaches the pty, once;
  the card then disables itself until the next dialog (§ 5). When the options could not be read the live terminal
  strip is used exactly as before.
- **Motion, only as an answer to events.** A row that arrives rises a few px while it fades in (not for history
  loaded within 1.5 s of a reset); the log glides to the tail while the view is following it (`cs.stick`; a
  wheel-up takes the control back at once) and a round *latest* button appears when the operator has scrolled
  away. Every animation has a `prefers-reduced-motion` fallback.
- **Always a way out.** The Settings selector, the shortcut, the menu entry, the notice's *Show terminal* and the card's *View in the terminal* all lead to the terminal. The first three change the mode for every session; the last two only look (§ 2.4).

### 2.1 The polish pass: the popup, the bubble, the scale, the empty card

A pass over what looked rough in the screenshots, with no change to streaming or to dialogs. Every colour is a
`--chat-*` token (none minted outside `theme.css`), both themes, and every new sentence goes through `t()`.

- **The `/` popup is a list you can scan.** It showed every match (about ten rows, a quarter of the pane) in a card as
  wide as the composer. Now: **at most seven rows**, then a scroll (`.csl-list` has `max-height: 7 × --csl-row`; the
  list is content-box, so its padding comes on top). Where there are more rows beyond an edge a soft fade says so
  (`mask-image`, driven by `.more-t` / `.more-b`, because an overlay scrollbar is invisible until it moves), and
  the list's `scroll-padding` equals the fade's height so an arrow key never parks the chosen row under it. The
  columns are one grid shared by every row (a subgrid): **name | usage | what it does | origin**. A usage hint
  wider than its column is shortened **at a word** with its brackets closed (`<optional custom summarization
  instructions>` → `<optional custom…>`, never a dangling "or"), the whole text stays in its `title`, and the CSS
  ellipsis is only the net for one very long word. The card is at most 640 px wide. The origin ("project",
  "yours") lost its capsule: 10 px of `--faint` text at the edge. The highlighted row is one step *above* the
  popup's own tone (`--chat-pick-bg`, set as the popup's `--chat-row-hover`), where it used to be a step below
  and read as a hole. A narrow pane (≤ 480 px) stacks name and usage over the description and shows five rows.
- **The operator's bubble is lighter.** Padding 10 × 15 → 7 × 13, radius 16 → 14 (the tail corner 5 → 4), type
  one notch under the answer's (.96 em), fill 9 % → 6.5 % ink (5 % in the light theme), a hairline border
  instead of the strong one and no edge-light: a prompt is a line you said, not a card, and it should not
  compete with the answer, and it now sits just under the code surface (7 %) instead of above it.
- **One vertical scale.** Four unrelated sets of margins (22/8 px for rows, 6 px for tools, 10 px for notes, .9 em
  against 1 em inside markdown) became five variables on `.chatskin`: `--cs-m` 7 px, `--cs-turn` 19 px,
  `--cs-blk` .85 em, `--cs-sec` 1.4 em, `--cs-li` .25 em. Rows are flex children, so neighbouring margins **add**:
  `--cs-m` on both sides is the 14 px between any two blocks (messages, tool cards, notes, the working line);
  an operator message adds `--cs-turn`, so a **new turn opens at ~26 px**; inside a message paragraphs, lists,
  quotes, code blocks and tables are all `--cs-blk` apart (they used to be .9 and 1 em), a heading takes
  `--cs-sec` above and a tight .45 em below. The em units follow the reading size the operator picked.
- **The empty card is intentional.** It was an icon over "No messages yet", with the title **invisible in the
  dark theme** (a card has no message around it to inherit `--ink` from, so it fell back to the browser's
  black; the title now sets its own ink). Now: the tile, **"Start a conversation with {name}"** (the session's
  name, through `chatSkinWho`), a sentence, and three quiet keys — `/` commands, `↵` send, `⇧↵` new line — as
  hairline chips with mono glyphs, shown only for the empty state and optically centred. It teaches the three
  things that matter before the first message and says nothing the bar below does not already say.
- **The Terminal | Chat switch** was a segmented control in the pane header, polished here (no double
  outline). It no longer exists: § 2.2 removed the header and a tab icon took over, and § 2.4 then removed the
  icon too, leaving the mode in Settings.

### 2.2 The headerless pass: the font in Settings, the effort menu, the folded run (and, then, a switch on the tab)

Four decisions, taken together because each one frees or fills the same few pixels. Every one was judged on
`npm run chat:shot` pictures in dark and light, wide and narrow (§ 9), not on the code.

**1. No header; the switch lives on the tab.** *(The tab icon was replaced by a Settings choice afterwards, § 2.4; the header stays gone.)* The strip that held the `Terminal | Chat` switch and the font
button is gone: the log is the first thing in the pane, and the state card, the dialogs and the
composer sit where they sat. *Why:* the header said nothing the tab did not already say. The tab is where the
operator already looks to know which session this is, its chat/terminal state is one fact about that session,
and a second switch inside the pane meant two controls for one state and a strip of height spent on both. At the time of this pass the switch was a bubble icon on the tab (`.tview`, a 22×22 px
target with a hover fill, a focus ring and a tinted chip while the chat was on), plus `CmdOrCtrl+Shift+L`, the
*File* menu entry and a row in the tab's context menu; all of them acted on one pane and none created a pty. The
icon, its CSS and its helpers are gone (§ 2.4); what this pass decided, that the pane has no header and the log
is its first child, still holds. One visible consequence had to be fixed on purpose: the state card is the log's first child even while
hidden, so the first message used to sit ~45 px under the tab strip (the log's padding plus its turn margin,
which the header had been hiding); the first visible row now starts at the padding alone (~26 px).

**2. The reading font and size are in Settings, nothing else.** `Aa` was a popover in the header; it is now
two rows of the Settings tab, `settings.chatFont` and `settings.chatSize`, beside the view selector (then `chatViewDefault`, now `claudeView`), with a
sample line drawn in the chosen font and size. Changing one repaints every open chat view at once
(`chatApplyPrefs`) and persists through the same two settings as before, so nothing stored moves. A stack or
size written by hand in the config stays selectable as an extra entry. *Why:* a typeface is chosen once and
then lived with; a control that is on screen every minute for a decision made once is the wrong place for it.
Settings is where the operator already looks for "how do I want this app to read", and it can show a sample
of the font, which a one-line header button never could. The popover, its Esc listener and its state went
with it.

**3. The effort is changed from the status bar.** The effort segment is a button, like the model's. It opens
a small menu above the card listing *Low · Medium · High · Extra high · Max* and *Auto*, each with one line
on what it is for and a tick on the current one. *The command and the levels were verified, not assumed:*
`claude --help` of the installed CLI (2.1.311) lists `--effort <level>` with `low, medium, high, xhigh, max`,
and the binary's `/effort` handler answers `Usage: /effort [<levels>|auto]` and `Effort level set to auto`.
So a choice sends exactly `/effort <level>` through `chatSkinSubmit` (the same single door as `/model`; no
other write path) and only those six words can ever be sent. The CLI filters the levels by model (`xhigh` and
`max` do not exist everywhere), which is why the menu has a footer saying so and why a level the model lacks
is refused **by Claude Code, in the log, in its own words** instead of the app second-guessing it.
- *Disabled when the model button is.* One function, `chatSkinBarBlocked(p)` (a turn is running, a dialog is
  open, or the session has ended), decides it for the model button, the effort button and both menus; a menu
  open when the state turns blocked closes. A level picked while Claude is mid-turn or waiting on a dialog is not
  what a click on a quiet bar means, and the model button already refuses the same moments.
- *Optimistic value.* On a pick the segment shows the new level at once (`cs.status.effort`), and 2.5 s later
  (after the CLI has redrawn its status line) the status is refreshed; the next payload that is **this tab's**
  confirms or corrects it. The effort stays a per-session field (§ 6): no payload of another session can
  write it. With no known effort the segment is still a button, showing the dim word *effort*.
- *Anchoring.* The menu hangs from the card's wrapper, not from the bar (the bar clips its overflow), above
  the card, with its left edge on the segment's and clamped inside the pane; it never covers the strip it
  belongs to. Esc closes it and **does not cut the turn** (its listener is registered before the interrupt
  one and stops the event), as does a press outside, Tab, or choosing; arrows, Home and End move; the current
  level is `role=menuitemradio` with `aria-checked`. It has no entrance animation (motion is for state, and a
  hidden window leaves it paused, so the picture came out empty). Under 410 px of bar the segment still hides,
  as § 2 says.

**4. A run of tool calls is one row.** Two or more consecutive tool calls fold into a single summary row;
opening it shows the ordinary rows, each still a button with its own output. *Why:* a long task writes dozens
of calls, and as rows they pushed the answer off the screen; the operator wants to see *that* things ran and
whether any failed, and to look inside only when they care.
- *What is a run.* Consecutive tool items in the column. A hidden item (one that never draws) does not cut a
  run; **any other visible item does** (a message, a card). The rule is a pure function, `chatToolRuns`.
- *Aggregate state* (`chatToolSummary`): **running** if any call runs, otherwise **error** if any failed,
  otherwise ok; the number of failures is exact (`1 failed`, `2 failed`, plural per locale). A failure
  never hides behind a green group: the row's glyph and mark take `--st-error`, and the count is text, not
  only colour.
- *The line.* `N actions` and the names in order of first appearance with a count (`Glob, Read ×3, Grep,
  Edit, Bash`): first appearance, not frequency, so the line reads steadily while it grows instead of
  reshuffling on every call. While the run is **live** the names give way to the action in progress (the
  last running call: its name and its argument, truncated), and the glyph wears `--st-busy`; the counts stay
  in the tooltip. Long names and arguments end in an ellipsis before the state mark and the chevron ever move.
- *A run of one is not a group.* One call stays the plain row it always was; when the next call arrives it
  becomes a group, **on the same nodes** (rows are moved, never rebuilt, so one the operator opened stays
  open and its scroll position is kept).
- *The unfolded state persists.* A group starts folded, except when the operator had already opened one of
  its rows (that row must not vanish). The state lives on the node and in `cs.groupOpen`, keyed by the uuid of
  the run's first call, so it survives new calls joining, status changes, repaints, a run that splits and
  joins again, and older calls joining it from above when the tail window had cut it (the new first call
  inherits the choice of the run it absorbs and the absorbed keys are dropped, so a later fold is not undone by a stale one); a manual fold stays folded; a `reset` forgets everything. Unfolding follows the log to the
  tail, folding does not.

### 2.3 Paths in the conversation are links

A reply names files and folders all the time (`it is in ~/Projects/site/dist`, `I changed src/app.ts`), and in
the terminal the same words are already links. The chat does the same, with the same gesture, so an operator
does not have to learn a second one.

**What is linked.** Any path-shaped string in the assistant's reply, in the operator's own bubble, and in the
argument of a tool row (a `Read` or `Edit` row whose argument *is* a path is linked whole). The candidates come
from the terminal's own `pathCandidates` (one definition of what a path looks like), plus two shapes the terminal
never needed: a folder named on its own (`/tmp`, `renderer/`) and a quoted rooted path that holds spaces.
**Nothing is a link until it exists.** Every candidate is asked about, and only what exists, under an allowed
root, becomes a link; that is also what makes the loose candidate pattern safe, since a false positive would have
to be a real path. A path that does not exist stays plain text, exactly as it was written.

**The gesture is the terminal's.** A click on a file opens it in the viewer; a click on a folder reveals it in the
explorer; Cmd/Ctrl+Shift+click hands either to the operating system (Finder, Explorer). Enter does the same from
the keyboard on a focused link (a link inside a tool row's header is mouse-only, because a focusable element
nested in a button is not valid). Dragging to copy a path is not a click: with text selected nothing opens. The
hover tooltip is the terminal's `div.pathtip` with the absolute path, what a click does and the Cmd/Ctrl+Shift
hint. The link is the house link colour (`--chat-link`), plain at rest and underlined on hover, with the same
focus ring as every other control; a path longer than 48 characters is clipped with an ellipsis (stopping a
little short of the line, so the comma that follows it does not wrap alone) instead of widening the column.

**Why the decoration comes after the sanitiser, and why there is no `file://` href.** The reply is model text, and
`chatSanitize` lets through only `http(s)` and `mailto:` links. A path link is therefore never part of the
markdown: it is a `span` built by the renderer **after** sanitising, with its target (`{ abs, dir }`) kept in a
JS property. There is no `href` at all, so model text can neither carry a link of its own nor point one at a
file, and the allowlist is exactly as strict as it was. Opening goes through `openViewer`, `revealPath` and
`revealInOS`, which validate the path again.

**Resolution is batched, cached and asynchronous.** The text is on screen first; the links appear when the
answer comes. One message is one call to `fs:resolvePaths` (chunks of 200), because a long answer can name dozens
of files and a round trip per handful is what made hover slow in the terminal. Answers are cached per base folder:
a hit is kept, and a miss for ten seconds only, so a file the answer has just written does not stay unlinked. A
failed call is never remembered as "does not exist". The pass re-checks its nodes before changing anything (a
newer pass over the same node supersedes it, and a node painted over or removed in the meantime is skipped), and
a message asks about at most 240 distinct strings, so a pasted log cannot become hundreds of `stat` calls.

**The streaming preview never links.** `chatLinkPaths` is called only on a block painted **final**. The preview
is what the terminal paints, its text changes under every snapshot, and a link that vanishes with the next one
is worse than none; at hand-over the finished message is linked once.

**The new IPC.** `fs:resolvePaths(cands, base?)` returns `{ [candidate]: { abs, dir } }` for what exists, so the
chat can tell a folder from a file. The rules live in one place, `src/main/pathResolve.ts` (trim the prose
punctuation, drop `:line[:col]`, expand `~`, try the shell's current folder, then the framework root, then the
home folder, refuse anything outside the allowed roots), and `fs:resolveFile` and `fs:resolveFiles` now call the
same function with folders switched off. The terminal's replies keep their shape and its ceiling of 24; a
separate channel rather than a flag keeps it that way. Both call sites are checked by a test (§ 9).

### 2.4 The mode lives in Settings, not on the tab

The tab icon of § 2.2 answered "chat or terminal?" once **per tab**. An operator who prefers chat had to flip
every new session by hand, and one who prefers the terminal had a bubble on every Claude tab they never used. It
is one preference, so it is now one setting and the icon is gone.

- **The setting.** `claudeView`, `'chat' | 'terminal'`, shown in Settings as *Claude sessions view: Chat |
  Terminal* (a `<select class="tinput" data-setting="claudeView">`) in the same section as the chat font and
  size rows. In Terminal those two rows and their sample step aside, since they only mean something in Chat.
  The page shows `chatMode` (below), not the file, so it never disagrees with the tabs that are open.
- **Migration from `chatViewDefault`.** The setting this replaces was a checkbox, "open Claude sessions as
  chat". `normalizeClaudeView` (`src/main/aios.ts`, used by `shellSettings()`) reads it in this order: a stored
  `'chat'` or `'terminal'` wins; otherwise `chatViewDefault === true` gives chat; everything else (false, absent,
  `'true'`, `1`) gives terminal, which is what the unticked checkbox was. An operator who had ticked the box
  lands in chat with nothing to do. The old key is never rewritten or deleted, so an older app that is still
  pointed at the same `shell.json` finds the value it knows; the first save of `claudeView` supersedes it.
  `shell:setSetting` accepts `claudeView` only with one of the two values (anything else is refused without
  writing, because a bad value would be ignored on read and let a stale `chatViewDefault` come back) and no
  longer accepts `chatViewDefault`.
- **Applied live, to all of them.** `chatSkinSetMode(mode, { persist })` is the **only** door and the only
  writer of `claudeView`: it updates `chatMode` (a cache read once at start by `chatReadMode`), calls
  `chatSkinApplyMode`, tells the open Settings pages so their selector follows, and then saves. The apply walks
  the panes and calls `chatSkinSetView` on those that pass `chatSkinEligible` (a Claude session that has not
  ended); a shell, a viewer or an ended session is skipped, and applying creates no pane and no pty.
- **New, restored and resumed sessions.** `chatSkinMaybeDefault` reads `claudeView` fresh on every `createPane`
  with a `claude` command, which is the one path all three take. It only ever moves a pane **toward** chat:
  Terminal is what a pane already is.
- **Claude started inside a shell.** A tab that was a plain shell becomes eligible when `claude` starts in it
  (and again after an ending). `chatSkinTick` puts it in chat once, **on that flip**, when the mode is chat. This
  is new: the old default never did it, and without a tab icon there would be no other way to reach chat from
  there. Nothing else in the tick forces chat, so a tab the operator stepped out of is not pulled back.
- **The shortcut.** `CmdOrCtrl+Shift+L` and *File → Switch Claude Sessions Between Chat and Terminal* (intent
  `toggleChatView`) flip the **global** mode, not the focused tab: `chatSkinToggleMode` reads the config fresh (a
  value synced from another machine is what gets flipped), inverts it, goes through `chatSkinSetMode`, and shows
  a toast ("Claude sessions now show as chat" or "...as terminal") because no icon changes to tell the operator.
- **A session that ends goes back to the terminal**, as before (`chatSkinOnExit`, `chatSkinSessionChanged`), so
  "[session ended]" is shown rather than a dead composer. This changes that pane's view and never the setting.
- **A look is not a choice.** *View in the terminal* (dialog card, and the strip for a dialog the parser could
  not read) only changes `cs.promptTerm`, which of the card and the live strip is in front, and the mode is
  untouched. The *Show terminal* buttons of the notice strip and the error card do step that tab out of the
  mode, on purpose. Since there is no icon to come back with, the tab's context menu has one row for it,
  *Return this tab to the chat view* (or *terminal view*), shown only for a tab that is out of the mode
  (`chatSkinOutOfMode`). It makes the tab follow the mode (`chatSkinFollowMode`) and never writes the setting.
  Neither action can reach `claudeView`, which a test pins (§ 9).
- **Removed.** `chatSkinMountToggle`, `chatSkinPaintToggle`, `chatSkinToggle`, `chatSkinToggleFocused`,
  `p.viewBtn`, the call in `createPane` and the `.tview` CSS, plus the strings `settings.chatViewDefault` and its
  hint. Added: `settings.claudeView` (+ hint, `.chat`, `.terminal`) and `chat.skin.modeNowChat` /
  `chat.skin.modeNowTerminal`, in en, es and pt-br. `chat.skin.toChat` / `chat.skin.toTerminal` stay for the
  context-menu row only, with new wording.

Commits on `feat/chat-skin` (each trailer-signed; the intermediate ones are not green on their own, because the
renderer and its tests land separately, and only the end state is):

| Commit | What |
|---|---|
| `fdb4eca` | `feat(settings)`: `claudeView` and the migration from `chatViewDefault` |
| `0aae124` | `refactor(chat)`: one global view mode replaces the per-tab toggle |
| `2ce84f0` | `test(smoke)`: enter chat through the view mode, not a tab button |
| `d000cfe` | `test(chat-shot)`: shoot the Claude tab without a switch and the view selector |
| `c20ca7a` | `test(chat)`: pin the global view mode, the missing tab switch and the doors |

## 3. Architecture

```
                    ┌────────────────────────── main ───────────────────────────┐
 claude (real TUI)  │                                                            │
   ▲   │            │  pty:data ─┬─► renderer (xterm, hidden but alive)          │
   │   │ writes     │            └─► PromptMonitor ── 'prompt' ──┐               │
   │   ▼            │                 (core/tuiPrompt.ts, pure)   │               │
  pty ◄── pty:write ┤                                             ▼               │
   │                │  <slug>/<sessionId>.jsonl                chatSkin:event ────┼─► renderer
   └─ appends ───►  │     │  fs.watch + poll                    (paneId + …)       │    (chat overlay)
   (transcript)     │     ▼                                         ▲              │
                    │  transcriptTail.ts ─► tracker (pure) ─────────┘              │
                    │  offset, split lines,   core/transcriptChat.ts               │
                    │  late file, id change                                        │
                    └────────────────────────────────────────────────────────────┘

 renderer ─ submitToPty(id, text) ─► pty:write (text, then CR as a second write) ─► claude
 renderer ─ chatSkin:screen (what xterm shows, snapshots) ─┬─► PromptMonitor ── 'prompt' (+ question, options)
                                                           └─► StreamTracker ── 'stream' (reply so far; adopt)
 renderer ─ a card button ─► chatSkinSendKey ─► pty:write (the option's key, chunk by chunk) ─► claude
```

**Two inputs, one output, one way back.**

- *Transcript tail* (`src/main/transcriptTail.ts`, no electron import). Given a `paneId` and a
  `sessionId`, it locates `~/.claude/projects/<any project folder>/<sessionId>.jsonl` (the cwd slug is
  not known to the caller, since a session may have been resumed from elsewhere, so every subdirectory is
  tried), reads it in 1 MiB async chunks and feeds each complete line to the tracker. It must survive
  what real transcripts do:
  - *the file does not exist yet* (a new session writes its first line seconds after launch): it emits
    `missing` once and keeps searching, at a slower pace after about 30 polls;
  - *a line written in two halves*: the unfinished tail is held until its newline; a multi-byte character
    split across reads is decoded whole (`StringDecoder`);
  - *large files*: backfill is chunked and async, never blocking main;
  - *truncation or replacement* (different inode, or size below the offset): `reset`, then re-read from
    the top;
  - *`fs.watch` is unreliable* (coalesced events, missed after a replace, `EMFILE`): a 1 s poll runs
    alongside and is the guarantee; the watcher only makes it quicker;
  - *the sessionId changes* (`/clear`, a resume that forks): the renderer unwatches and re-watches; one
    watch per pane, a new one replaces the old.
- *Tracker* (`src/core/transcriptChat.ts`, pure). Turns lines into `ChatItem`s and tracks the turn state
  and the context size. It never throws on a corrupt line.
- *Dialog detector* (`src/core/tuiPrompt.ts`, pure). Reads the pty's output and, once the renderer sends
  them, snapshots of what its terminal shows. To notice that the TUI is waiting on a dialog and to read its question
  and options with the key that picks each one (§ 5).
- *Streaming extractor* (`src/core/screenStream.ts`, pure). Reads the reply being written off the same snapshots
  (`extractStreaming`), keeps a `StreamTracker` per watched pane (what to send, how to join the windows of a
  reply taller than the terminal, which transcript line IS the previewed text). It runs **in main**, not in the
  renderer, for three reasons: it is a pure TypeScript core with unit tests (the renderer is plain JS with no
  imports, so it would need a second copy); the decision "this transcript line is the preview" needs both streams,
  and main is the only place that sees the snapshots and the transcript items; and the renderer then receives only
  the text that changed instead of a screenful every 150 ms.
- *Writing back*: **only** `submitToPty(id, text)`, the chokepoint that writes the text and then the CR
  as two separate writes. Claude Code turns on bracketed paste, so a single `text + CR` write arrives as
  one paste, inside which the CR is a literal newline: the message lands in the box and never sends.
  `npm run check:tokens` fails when a renderer line matches the one-chunk pattern (`ptyWrite(… + '\r')`).
  The only other things the skin ever writes are a lone ESC (`\x1b`) to cut a running turn, and only while
  something is running, because an idle Esc is not harmless in Claude Code (a second one opens the rewind menu);
  and **a dialog's answer**, through its own chokepoint, `chatSkinSendKey`: a digit, an arrow up/down or Enter and
  nothing else (validated against `/^(?:\x1b\[[AB]|\r|[0-9])+$/` before anything is written), split into pieces
  written one by one 60 ms apart because several keys in one write can be swallowed by the TUI's input parser as a
  single chunk, which is the same reason a message and its CR are separate writes. It is not `submitToPty`
  because that appends a CR, and a digit must never get one: the digit already selects, and an Enter after it
  would confirm whatever comes next. Only `chatSkinPick` calls it, and `chatSkinPick` runs only from a click or a
  key on a card button.

**`paneId` is the pty id.** `pty:spawn` returns `nextId++` and stores it in `ptys`; the renderer keys its
`panes` Map and `ptyWrite` by it; the skin map in main uses the same number. There is no translation
layer to drift.

**Lifetime of a watch.** Created by `chatSkin:watch`, which may be called **without a session id** (`null`:
"dialogs only", no transcript yet — § 5); a later `chatSkin:watch` with the real id replaces the transcript
and keeps the same dialog monitor, so a dialog still open is neither forgotten nor announced twice. Ended by `chatSkin:unwatch`, the pty's exit (after
one last read pass, `finish`, because a session's closing lines land just before it exits), `pty:kill`,
destruction of the sender, or closing the window / quitting. A `watch` for a pane whose pty has already
exited is accepted (it shows the history) and lasts until `unwatch` or the window goes.

### 3.1 Hiding the terminal without breaking it (fit / resize)

The xterm is **hidden, never detached and never `display:none`'d**. An absolute overlay covers the pane
and `.twrap` becomes `visibility:hidden`, which keeps its box. The reason is the fit addon: it measures
the container, and a zero-size container yields 0 columns; the resulting `pty:resize` would reflow and
tear the TUI, a failure that shows only when the operator comes back to the terminal. Consequences the
code and its tests hold to:

- the skin never calls `fit()` while it is up; the **only** `fit()` in the block is the one in
  `chatSkinHandBack`, run once when the terminal is handed back (followed by the usual geometry push);
- no skin CSS rule uses `visibility:visible`, which would punch through `.panehidden` by inheritance; the
  dialog strip uses `inherit`.

### 3.2 Event contract (`chatSkin:event`)

Every event carries `paneId` plus exactly one of:

| Event | Meaning |
|---|---|
| `{type:'reset'}` | Empty the view. Sent before a backfill and whenever the file is replaced or changes. |
| `{type:'items', items}` | **Upsert by `uuid`**, in order. The same `uuid` may arrive again with new content. |
| `{type:'turn', open}` | A turn started or ended. |
| `{type:'usage', contextTokens?, model?}` | This session's own numbers. Not sent when neither is known. |
| `{type:'prompt', kind\|null, hint?, question?, options?, refresh?}` | The TUI is (or stopped) waiting on a dialog (§ 5). `question` is the line the CLI asks; `options` (at most 12) are `{n\|null, label, selected, key, freeText?}`, present only when the rows were read with confidence: `n` is the number the TUI prints, `selected` marks the cursor's row, `key` is what picks it. `refresh: true` marks the SAME dialog with its cursor moved (new `selected` and, for an unnumbered menu, new `key`s), not a new dialog. |
| `{type:'stream', text, anchor, headCut}` | The reply being written, as the screen shows it so far (`text` replaces the previous preview's). `anchor` is its first words (stable once there are six), `headCut` says the reply is taller than the terminal and only a window of it was seen. |
| `{type:'stream', text:null}` | Nothing is being written right now (the spinner went away, a tool took the bottom, a dialog opened). The renderer keeps the preview where it is, frozen: the real message is about to arrive. |
| `{type:'stream', text:null, adopt: uuid}` | The transcript line `uuid` IS the previewed message. It is sent **just before** the `items` event that carries it, and the renderer hands the preview's node to that item. |
| `{type:'missing'}` | The transcript file does not exist yet. Not an error; main keeps looking. |
| `{type:'error', code}` | The read failed (`read-failed`). |

`ChatItem = {uuid, role: 'user'|'assistant'|'tool'|'system', text?, tool?: {id, name, summary, status: 'running'|'ok'|'error', output?, outputTruncated?}, ts?}`.
`tool.output` is a bounded preview of the tool's result (ANSI and control characters removed, at most 4,000
characters and 60 lines, cut at the head; `outputTruncated: true` when it was cut) that exists only once the
result has arrived. It is **untrusted data**: the renderer shows it through `textContent` only. It is not
redacted, because it goes to this app's own window and nowhere else (`core/transcriptChat.ts` says why).
Details the renderer relies on:

- During a backfill only `items` are streamed; `turn` and `usage` are announced **once** when it ends,
  so a long history does not flicker the indicator.
- A tool item uses the `tool_use` id as its `uuid`; when the result arrives the same `uuid` comes again
  with `ok` or `error`. A tool still running when the transcript records an interruption is marked `error`.
- `prompt` is sent when the dialog's *identity* changes (kind, question, and each option's number and label);
  moving the cursor inside the terminal is a `refresh`, never a new dialog. `null` means the dialog is gone.
- `stream` is sent only for a transcript-backed watch, only when the text changed, and stops being sent the
  moment the screen stops showing a reply being written. A preview is dropped on `turn: {open:false}` and on
  `reset` if no `adopt` took it; the extractor remembers the last adopted text until the next turn begins so a
  stale screen (the CLI keeps saying `esc to interrupt` for a moment after the transcript has the message)
  cannot revive it as a second preview.
- Absent numbers stay absent, never `0`.

IPC surface: `chatSkin:watch(paneId, sessionId | null) → {ok:true, file} | {ok:false, error:'not-found'|'bad-id'}`
(`not-found` does not stop the search; with `null` the answer is `{ok:true, file:''}` and only the dialog
monitor starts), `chatSkin:unwatch(paneId)`, `chatSkin:screen(paneId, text)` (one-way: the terminal's
screen snapshots, accepted only from the sender that owns the watch), the `chatSkin:event` stream, and
`chat:status` for the usage bar. The `sessionId` becomes part of a path, so anything not shaped like an id
(`/^[A-Za-z0-9-]{8,}$/`) is refused before it is joined. The renderer treats `not-found` as "waiting", not
as an error: a new session has no transcript file until its first message.

## 4. The transcript format, as verified

Verified by reading real transcripts under `~/.claude/projects` read-only (nothing copied; no content
appears here or in any fixture). The format is Claude Code's own and **not a documented contract** (§ 10).

- One JSON object per line. Lines that carry the conversation lead with `parentUuid`; bookkeeping lines
  lead with `"type"`: `last-prompt`, `custom-title`, `ai-title`, `agent-name`, `mode`, `permission-mode`,
  `bridge-session`, `queue-operation`, `file-history-snapshot`, `api-request*` and similar. The tracker
  checks the leading `"type"` with a regex and **skips those without parsing them**, which matters
  because some (request blobs) are enormous. `attachment` lines do *not* lead with `type`; they are
  parsed and then ignored by the type switch.
- **Used:** `user`, `assistant`, `system`. **Ignored:** everything else.
- **`assistant` is split by block.** One line per content block (`thinking`, `text`, `tool_use`), all of a
  message sharing `message.id` and the same `message.stop_reason`. So `stop_reason: "end_turn"` on a
  `thinking` line says nothing about whether the text has been written. The turn is closed only by a
  `text` block with `end_turn`, or by `system` / `turn_duration`, or `system` / `stop_hook_summary`.
  `thinking` blocks are not shown. Any other assistant activity marks a turn open.
- **Usage** comes from `message.usage` of the latest real assistant message: context tokens =
  `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`, reported only when the input
  side is really present; the model from `message.model`.
- **Synthetic messages:** model `<synthetic>` (stop reason `stop_sequence`, API-error text). Shown as a
  `system` note; the turn ends.
- **`user`:** `message.content` is a string (what the operator typed, or an injected prompt) or a list of
  blocks. Blocks are `tool_result {tool_use_id, content, is_error?}` or `text` (a typed prompt with
  attachments, or the interruption marker `[Request interrupted by user…]`). A result flips the matching
  tool item and marks the turn open.
- **What is dropped as "not typed by the operator":** `isMeta` lines (skill bodies, auto-continuations,
  caveats), `isSidechain` lines (a subagent's chatter), and the wrappers `<system-reminder>`,
  `<local-command-caveat>`, `<task-notification>`, `<command-message>`, shell-capture tags. A slash command
  is stored with `<command-name>` / `<command-args>` and is shown as the `/name args` the operator typed;
  `<local-command-stdout>` / `-stderr` becomes a `system` note.
- **`system` subtypes** seen: `turn_duration`, `stop_hook_summary`, `api_error`, `local_command`,
  `informational`, `away_summary`, `compact_boundary`, `bridge_status`. Only the first two are used.

*Not verified in this pass:* every subtype above on a single recent file (the sample I re-read showed
`turn_duration`, `informational`, `away_summary`, `bridge_status`); behaviour across Claude Code versions.

## 5. Dialogs: a card when the options can be read, the live terminal when not

The transcript learns about a tool *after* the operator allows it. While the TUI sits on "Do you want to
proceed?", the transcript shows a `tool_use` with no result and says nothing else; the question exists only
on the screen. The same goes for the folder-trust prompt, `/model`'s picker, an `AskUserQuestion`, and any
numbered menu. The chat reads them off the screen, draws them as a **card of buttons** when it understood the rows,
and shows the **real terminal strip** when it did not. Either way **it never answers one by itself**: a key
leaves for the pty only when the operator clicks a button or presses a key on it.

**Detection** (`detectTuiPrompt`, pure; `createPromptMonitor` wraps it). It is judged 120 ms after its input
settles, because a TUI repaints a dialog in many small writes, and it works from **what the terminal shows,
not from the byte stream** (`39d60fd`):

- Ink repaints a dialog differentially (moving the selection rewrites two lines, not the footer), so the tail
  of the raw stream stops looking like a dialog while the dialog is still open. The renderer's xterm is the
  only thing that knows the screen *now*. While a pane is in chat view, after xterm has parsed each chunk
  (the callback of `term.write`, `chatSkinScreenSoon`), the renderer sends at most one snapshot per 150 ms
  window: the last 60 rows of xterm's buffer as plain text (`chatSkinScreenText`) over `chatSkin:screen`.
  Main keeps the last 8 KiB, and the monitor's `screen()` **replaces** its buffer instead of extending it.
- Until the first snapshot of a pane arrives, the monitor is fed the raw pty output (`push`, bounded tail of
  16 KiB). Once one has arrived (`screenFed`), the raw stream is no longer fed: mixing the two would let a
  repaint talk the monitor out of a dialog that is still open.
- A dialog that was already on screen needs no new bytes to be seen. Main keeps a per-pty tail of the last
  16 KiB of output from the moment the pty spawns (`ptyTails`) and pushes it into a monitor when one is
  created; and `chatSkinSync` asks for a snapshot as soon as a watch starts.

A verdict needs *structure*, not wording, because ordinary answers are full of numbered lists and sentences
like "Do you want to proceed?":

1. a numbered option list (consecutive, at least two) with the TUI's selection cursor `❯`, whose last option
   is within five non-empty lines of the end of a 40-line tail (a dialog is the last thing painted);
   *or an unnumbered menu* (`ec1c440`): a `❯ label` cursor line between the second-to-last and the
   ninth-to-last non-empty line **and** the TUI's own footer (`Enter to confirm`, `Esc to cancel`, …) in the
   last two. Same structure, minus the numbers;
2. a recogniser around it that only the TUI prints — trust, model picker, question chips / "Type something",
   permission wording — or, for an unrecognised but real menu, the TUI's own footer (`Enter to select`,
   `Esc to cancel`);
3. kinds: `permission · trust · select · question · model · other`; `other` is deliberately narrow (a
   keypress prompt such as `(y/n)` on the very last lines). The `hint` is the question line, trimmed.

**The folder-trust dialog, as Claude Code 2.1 really draws it** (`ec1c440`). The detector was first written
against numbered menus. The real dialog is `Accessing workspace:` and the folder, then `Quick safety check:
Is this a project you created or one you trust?`, `Security guide`, and two **unnumbered** rows, `❯ No, exit`
over `Yes, I trust this folder`, with `Enter to confirm · Esc to cancel` as the last line. Two things made
it invisible: the TUI places words with an absolute column (`ESC[<n>G`), and dropping that sequence glued
them (`Quicksafetycheck`) so no wording could match; and the missing numbers failed the menu rule. Now
`stripAnsi` turns the absolute-column sequence into a space, and the unnumbered menu above is accepted. The
trust recogniser matches `Quick safety check`, `trust this folder` / `trust the files in this folder`,
`Do you trust the files` and `Yes, I trust`; the `hint` is the first context line that matches, normally
the `Quick safety check` line. The numbered variant is still recognised. `src/test/chatSkin.test.ts`
holds the real sequences (a raw stream with the column sequences, a repaint that moves the cursor, a screen)
with controls: stripping the column sequences instead of spacing them yields no verdict, and a raw stream
followed by the repaint reads as "gone" while the screen still shows the dialog.

**What the parser also reads: the question and the options, with the key behind each one** (`src/core/tuiPrompt.ts`).
The verdict carries `question` and `options: [{n, label, selected, key, freeText?}]` only when the rows could be
read with confidence (a numbered list that starts at 1, an unnumbered menu with at least two aligned rows, a
Yes/No offer under a question line). The key is what the CLI's own `Select` component accepts, read in the
shipped binary: a digit picks that numbered option at once, but only when the menu shows its numbers; an
unnumbered menu is reached with ↑/↓ from the cursor and confirmed with Enter; a free-text option ("Type
something.") is focused by a digit or the arrows and is **not** confirmed by Enter (so its key stops short of it).
Because the arrows are relative to the cursor, moving the cursor in the terminal re-issues the keys: the monitor
reports it as `onRefresh`, main forwards it as `refresh: true`, and the card adopts the new keys and default mark
without becoming a new, re-enabled card. What it does **not** read it omits rather than guesses (a scrolled
list, a multi-select, rows separated by blank lines): no `options`, and the strip is used.

**What the operator sees — the card.** A dialog with `options` becomes a card at the end of the column (the
composer says *waiting for your answer above*, and is disabled):

- a header with who is asking (`chatSkinWho(p)`, never a hardcoded product name), the question as the CLI worded it
  (text only), and **one button per option**: its number (an unnumbered menu counts 1, 2, 3 from the top, where a
  finger goes) and its text; the option the TUI's cursor is on is the default, marked with a return glyph and a
  stronger neutral edge, so Enter does what it shows. The card is blue (`--st-input`, "waiting on the operator"),
  never coral;
- **View in the terminal** swaps the card for the live strip of the same dialog (and a *Show the buttons* button
  in its notice brings the card back); looking never answers anything;
- keyboard: ↑/↓/Home/End move between buttons, Enter or Space presses the focused one, a digit presses the option
  with that number, a chord (Ctrl, Cmd, Alt) is left alone. The default button takes the focus when the card
  appears and the pane is in front;
- accessibility: the card is `role="group"` with an `aria-label` naming the session, described by the question; the
  default option reads *preselected*; the answer-sent line is a `status`;
- a click calls `chatSkinPick`, which marks the card used **before** it writes, so a double click answers once; it
  sends the option's `key` through `chatSkinSendKey` (§ 3) and nothing else. The card stays disabled until the next
  `prompt` event that is not a `refresh`, or the dialog going away; if the same dialog is still up
  6 s later the key evidently never landed and the card is re-armed, so the operator is never stuck behind
  disabled buttons;
- an option the parser flagged `freeText` gets its key only (the arrows, no Enter) and the live terminal comes
  forward so the operator can type: typing is theirs;
- an option list in which any key is not a digit, an arrow or Enter, or any label is not text, is refused **as a
  whole** by the renderer and the dialog falls back to the strip.

**What the operator sees — the strip.** With no `options` (or after "View in the terminal"), a non-null `prompt`
puts `cs-strip` on the pane: the overlay shrinks to the upper part and the **real xterm** is un-hidden in the
lower strip (so the TUI's bottom rows, where the dialog is drawn, are visible) and takes the focus. A notice
(`role="alert"`) says what is being asked. The box is disabled for the duration. If the pane is not in front or
the window is hidden, the tab is marked and a toast says which session needs the operator (for a card the toast
says the session *needs your answer*; for the strip, *in its terminal*). When the dialog goes (`kind: null`) the
card or the strip closes and the caret returns to the box.

**When the dialog is considered answered.** The screen moving past it (a snapshot that no longer shows one;
before the first snapshot, the pty output), or *proof from the transcript*:
a finished tool result or a new operator message (main calls `monitor.clear()`). A fresh assistant text does
**not** clear it, on purpose: model text can appear while a dialog is still open.

**Safety net — "never blocked without the operator seeing it".** Detection is a heuristic, so there is a
second line of defence that does not depend on recognising anything: an *open turn* with a *live pty* and a
transcript silent for more than 20 s raises a notice with a **Show terminal** button. In that state the
renderer also re-asks the process tree for the live sessionId (at most three times per watch), since a
silent transcript can mean the session was replaced under the same pty.

**Honest limits.**

- The wording is the CLI's and changes between versions; recognition is English-only. Strings were checked
  against the shipped CLI at the time of writing.
- A dialog taller than the retained window loses its question line (the kind then falls back to `select`).
- A false positive sends the operator to the terminal for nothing; a false negative leaves the session
  looking idle until the 20 s net fires. The design leans to the first.
- **A dialog with nothing to anchor on is recognised only in the Yes/No shape.** The first-run offer to make auto
  mode the default has no footer; it is read as a `select` with two unnumbered rows when one row starts `Yes`,
  one starts `No`/`Not now`/`Cancel`/`Back`, and a question stands above them. Any other footer-less shape, and any
  new first-run nag a CLI version adds, is not seen (the stalled-turn net is what catches it).
- **A card is only as right as the key behind it.** The keys were read in the CLI's `Select` component and
  checked against a real permission dialog (§ 9: the "No" button closes it), but a version that changes how a menu
  takes its input would make a button do something else. The mitigation is the shape of the failure: a card can
  only send a digit, an arrow or Enter; a dialog it cannot read has no card; "View in the terminal" is always one
  click away; and a used card re-arms after 6 s if the dialog is still up.
- **The options the real CLI offered were not the ones the first parser tests assumed.** The permission dialog of
  the version this was measured on (2.1.310, default permission mode) has *four* rows: *Yes*, *Yes, and always
  allow access to…*, *Yes, and switch to auto mode…*, *No*, with the number of *No* being 4, not 3 — which is why
  the card sends the parser's key for the row labelled *No* and never a number it assumed.

**Before the session has an id** (`39d60fd`). A new session in a folder Claude Code has not seen blocks on
the folder-trust dialog *before* it registers a session id. The chat view used to start watching only once
it had one, so the overlay hid the only thing the session was waiting on. Now `chatSkinSync` watches as soon
as the pane is in chat view and its pty is alive: with no id the watch is `''` in the renderer and `null`
on the wire, main starts only the dialog monitor, and the view reads "connecting". The strip and the notice
work exactly as for any dialog. When the id is adopted the watch is replaced by one that also follows the
transcript, keeping the monitor.

## 6. The status bar's data: what is the pane's and what is the account's

`~/.claude/statusline-payload.json` is the last payload written by **any** Claude Code session on the
machine. It is global, not per tab. A bar that drew it as it came would show tab A's model and context
under tab B's box, and, worse, nothing would look wrong. So the payload is **scoped to the tab by session
id before anything per-session is believed** (the filter lives in main, with a second lock in the renderer):

- **What belongs to the session, and what to the account.** The payload carries `session_id`. These fields
  describe *one session* and are kept only when it is this tab's: **model, effort, context percentage and
  context window**. These describe the *account* and are the same whichever session wrote them: the
  **5-hour and weekly percentages and their resets**. The 5 h and week meters are therefore always drawn, and
  the other four only from a payload that is this tab's own.
- **`scopeStatusToSession(file, tabSessionId)`** (`src/core/chatEvents.ts`) returns the parsed payload plus
  `sessionMatch`, which is `true` only when both ids are non-empty strings and equal. Without a match it
  **deletes** the four per-session fields and keeps the account's; the payload's own `sessionId` never leaves
  the parser. A missing id on either side (a payload from an older CLI, a tab that has not adopted its session
  yet, an empty string) is "no match", never "assume it is mine". The `chat:status(sessionId)` IPC validates
  the id with the same `isSessionId` the transcript watch uses (anything else becomes `null`) and answers
  `mergeStatus(undefined, scopeStatusToSession(parseStatuslinePayload(…), tabId))`; on a read error it answers
  `sessionMatch: false`. The renderer's `chatApplyStatus` repeats the rule: it writes those four fields only
  when `s.sessionMatch === true`, so an older `main` that does not send the flag also writes none of them.
- **Why the effort never shows another session's.** With no match there are two honest answers for each
  per-session field: this tab's own value, or nothing. The model and the context have a source of their own
  (below); the **effort has none**, since the transcript does not record it, so the segment shows the dim word
  *effort* (it is a button now, § 2.2, and has to stay one) until a matching payload says the level. The
  operator's own pick is the one other source, and it is this tab's by construction. A wrong effort is worse than a missing one: it is
  a confident statement about *this* message ("high") that is true of somebody else's, and the operator would
  act on it. A dash was rejected for the same reason as a `0 %`: it reads as a failure rather than as "not
  known yet".
- **Context and model of the pane come from this session's own transcript** (the `usage` event) whenever
  it has them: the context shows as tokens (for example `84k`), the model overrides the payload's. The
  payload only fills what the transcript cannot say, field by field, and only from a matching payload.
- **Resets and the context window.** `parseStatuslinePayload` returns `fiveHourResetsAt`, `sevenDayResetsAt`
  and `contextWindow` only when they are usable numbers (a reset written in milliseconds is scaled; anything
  else is dropped); `mergeStatus` carries them with the same field-by-field rule and propagates
  `sessionMatch` (the SDK side's first, then the file's) without counting it as a source of data. Nothing is
  inferred: with no reset in the payload the detail card simply has no reset line. The context meter's
  percentage is this pane's own tokens over the window size **only when they agree** (tokens above the window
  mean the payload describes another session's model), and the card then reads `used / total`.
- An absent field is shown as `—`, never `0%`: a bar that shows `0%` for a missing number is a fabricated
  reading. `chat:status` is refreshed about every 20 s while a chat view is up.
- **The test that pins it, with a negative control** (`src/test/usageReader.test.ts`): the same payload is fed
  to two tabs. The tab whose id equals the payload's keeps model, effort and context and gets
  `sessionMatch: true`; **the other tab gets none of the four and keeps the account's numbers**. A missing id on
  either side is "no match" in every combination (no `session_id`, a `null` / `undefined` / empty tab id, both
  absent). The control is that the assertion was run against a build with the line that deletes the
  per-session fields broken on purpose: two tests failed, and passed again when the line was restored. A guard
  that has never been seen to fail is only a hope. The screenshot fixture adds `bar-nomatch-dark` (a payload
  that is another tab's), which **fails the run** if the effort segment shows any level or the model is not the
  transcript's.
- Open item: the exported type still carries the label `source: 'sdk' | 'file' | 'mixed'` from the SDK era;
  only `file` is produced now.

## 7. Invariants that hold because the pane is the same

The skin adds fields (`p.view`, `p.chatSkin`, …) and DOM nodes inside `p.el`, and nothing
else. So everything that finds or controls a pane keeps working untouched:

| Invariant | Why it holds |
|---|---|
| **name, `byName`, ambiguity** | The skin never assigns `name`, `confirmedName` or `cmd`, never calls `renamePane`, `panes.set/delete`. |
| **resume** | A resumed session is a normal `createPane` with `claude --resume`; the skin attaches by `sessionId` like any pane. |
| **bus `send` / `kill`** | They address the pane and its pty; `send` goes through the same `submitToPty` the box uses. |
| **`runInPrimary`, rituals** | They write into the primary pane's pty; the skin is just another way to look at it. |
| **closing the tab** | `closePane` tears the watch down before the pane and its id go away. |
| **restore, resume** | Restored and resumed panes come through `createPane`; `chatSkinMaybeDefault` reads `claudeView` there, so the mode applies to them like any new one. |
| **no second session** | Changing the mode spawns no pty (`createPane`, `ptySpawn`, `new Terminal` are absent from `chatSkinSetMode`, `chatSkinApplyMode` and `chatSkinSetView`). |
| **only Claude panes** | `chatSkinApplyMode` filters by `chatSkinEligible`: a shell, a viewer or an ended session is never moved by the mode. |
| **the mode has one writer** | Only `chatSkinSetMode` writes `claudeView`. A tab stepping out of the mode, a card's *View in the terminal* and the context-menu row never do. |

The one deliberate exception is stated and bounded: the skin may **correct** `p.sessionId` (a `/clear` or
a forking resume replaces the session under the same pty), by asking the process tree (`session:under`),
the same authority the other adoption sites use. There is exactly one `sessionId` assignment in the skin.

How the tests cover it: `src/test/chatSkin.test.ts` reads the source and checks each of the above, and each
check is paired with a **negative control** — the same check run on a deliberately broken copy must fail
(for example: a mode change that calls `createPane`; a box that writes `text + '\r'` itself; a hidden host given
`display:none`; a dialog notice without `role="alert"`). A check that cannot fail would report confidence
about something it never examined.

## 8. Decision: the Agent SDK "Chat" pane was removed

The previous prototype added a pane kind, **Chat**, that ran Claude through the Agent SDK
(`chatSession.ts`, `@anthropic-ai/claude-agent-sdk`). This branch **removes** it, with the dependency and
its `asarUnpack` entry. Reasons:

1. **Two paths to Claude with different semantics.** In the SDK pane, permissions were decided by a
   `canUseTool` callback the app implemented; in a terminal they are decided by the TUI against the
   operator's settings. The same operator could get different behaviour in two tabs of the same app, and
   the app owned one of the two permission engines — exactly the thing it should not own.
2. **A session foreign to everything the app knows about sessions.** An SDK chat was not reachable by
   `byName`, the command bus (`send` / `kill`), rituals, `runInPrimary`, or `--resume`: none of those can
   address a session that is not a pty pane. Each missing integration would have had to be rebuilt for a
   second kind of session, or left as a permanent hole.
3. **Duplicating the engine.** *Glass, not engine*: the real `claude` in a real pty is the product. An SDK
   session re-drives the same engine from inside the app (queueing input, interrupts, approvals), which is
   the reimplementation the principle rules out.
4. **Weight of the dependency.** A 0.x package tied to a native binary, one optional package per platform,
   a lockfile diff of roughly 1.3k lines (removed again here), an unpacked-from-asar binary whose packaged
   behaviour was never verified.
5. **Maintenance surface.** A second event model, a second set of IPC channels and a pane kind to keep in
   step with every change to panes.

**What was reused** (it lives in `renderer/app.js` between `CHAT SKIN` and `END CHAT SKIN`; the look of all of it was redesigned afterwards, § 2): the bubbles;
the sanitised markdown (a private `marked` instance that escapes raw HTML, then an allowlist pass over an
inert `<template>`, two independent guards because model output can quote a web page or an email and this
renderer holds the whole `glassShell` bridge) and the highlighting; the font and size picker with its
settings; the usage bar; and from `core/chatEvents.ts` the pure helpers `parseStatuslinePayload`,
`mergeStatus` and `summarizeTool`. The SDK-specific event types and the permission cards are gone.

What is given up: the SDK's structured partial deltas and its own permission engine. The skin shows complete
messages from the transcript, a preview of the one being written read off the screen (§ 3.2), and turns a
terminal dialog into buttons that press the terminal's own keys (§ 5): the decision is still taken by the TUI,
against the operator's settings. That is the price of there being one session, and it is smaller than it was.

## 9. How it is tested

- **Unit tests with neutral, hand-written fixtures, each with a negative control.**
  `src/test/transcriptChat.test.ts` (the rules in § 4: split assistant, tool upsert, filtered wrappers,
  interrupts, synthetic errors, usage), `src/test/tuiPrompt.test.ts` (each dialog kind; a normal markdown
  answer and a lone numbered line trigger nothing; a dialog that scrolled away is gone; the monitor
  reports transitions only; the question, the options and the key behind each one), `src/test/screenStream.test.ts`
  (the reply being written, and its negatives: idle, tools only, a dialog, the operator's own message just sent,
  the input box, footers, the spinner; the real CLI's quirks — no spinner while text is written, a no-break space in
  the empty box, a titled box border, the right-aligned effort line, a list number painted before its text, the
  tool progress lines; `stitch`, the tracker and the adoption, including a torn tail and a stale screen),
  `src/test/transcriptTail.test.ts` (runs the tail for real against a temp
  folder: late file, line in two halves, a multi-byte character split across reads, truncation, id change,
  `unwatch` leaves no watcher, ids that are not id-shaped never touch the filesystem).
  `src/test/chatSkin.test.ts` holds the wiring invariants of § 7. Fixtures are written by hand; no real
  transcript is copied into the repo. The controls are real: breaking the UTF-8 decoder on purpose made the
  multi-byte test fail.
- **Guards that read the code and run it.** `src/test/chatSkin.test.ts` also pins, each with a negative
  control (the check is run against a deliberately broken copy and must fail): coral only in the send button
  (every stylesheet rule that reaches for `--accent` inside the chat is listed and only the send button
  passes); the meters are in the status bar and the pane has no header, with a control that reinjects one; the popup's Esc listener is registered before the
  interrupt one and stops the event (the two listeners are replayed in registration order with a fake event);
  Enter with the popup open completes and is consumed, so it cannot send; the drop inserts the double-quoted
  path and stops the event before its early return. The status bar, the popup and the drop/paste code are
  **run for real** from the real source against a stand-in DOM (dash and empty bar for a missing reading,
  60/85 colours, resets present or absent, a stale reset, a stale popup answer ignored, caret and spacing of
  an inserted path). `src/test/slashCommands.test.ts` covers the pure module (merge precedence, ranking,
  what the box is asking for) and `src/test/usageReader.test.ts` covers the statusline parser, the new reset
  and window-size fields included (absent, unusable and millisecond values).
- **Guards for the view mode** (§ 2.4), in `src/test/chatSkin.test.ts` and `src/test/transcriptTail.test.ts`, each
  with a negative control. *No switch on the tab:* `createPane` must not mount one, and a CSS rule for `.tab .tview`
  is detected by the pattern the test uses (the control adds one). *Migration:* `normalizeClaudeView` is compiled
  from `src/main/aios.ts` with `ts.transpileModule` and run over a table of ten cases (explicit value wins; only a
  literal `true` of the old key means chat; `false`, absent, `'true'` and `1` mean terminal); controls ignore the
  old key, accept any truthy value, let the old key beat an explicit one, and make absent mean chat. A temporary
  `shell.json` read through `shellSettings()` (with `HOME` and `GLASS_FRAMEWORK_PATH` isolated) checks the real
  read path, and `setSetting` is shown to refuse a bad `claudeView` (control: remove the guard). *Live
  application:* the real block is run with `new Function` and a stand-in pane list; changing the mode moves the
  Claude panes and not the shell, the viewer or the ended session (control: drop the `chatSkinEligible` filter).
  *The shortcut:* it reads fresh, inverts, writes `('claudeView', next)`, applies and toasts; a bogus value
  changes nothing and `persist: false` writes nothing (controls: remove the write, remove the apply, change the
  intent). *One writer:* `chatSkinSetMode` is the only caller of `setSetting('claudeView', …)` (control: a notice
  button that calls it fails), the tick forces chat only on the eligibility flip (control: force it always), and
  `createPane`/`chatSkinMaybeDefault` read `claudeView`. The context-menu row exists only for a tab that is out of
  the mode. The font rows share a section with the selector and are hidden in Terminal. The chat-shot fixture
  adds `tab-dark`/`tab-light` (the Claude tab with no switch, asserted) and `settings-terminal-dark`/`-light`
  (the selector at Terminal with the font rows gone); `settings-dark`/`-light` now assert the selector shows the
  live mode.
- **Guards for the streaming bubble and the dialog cards**, also in `src/test/chatSkin.test.ts`, each with a
  negative control and each **run for real** from the real source against a stand-in DOM that has ordered
  children, classes and a class-selector query: text growing is one provisional bubble and the finished message
  takes that very node over (same node, same slot, one answer row, no leftover class or `aria-hidden`; breaking
  the hand-over or creating a bubble per event fails it); a tool landing meanwhile goes above the preview; a
  preview nobody adopted is dropped on turn end and on reset and a frozen one is not; a different block replaces
  the preview rather than being appended; the snapshot timer waits for an open frame and gives up on a menu that
  keeps the cursor hidden; a dialog with readable options is a card (group, aria-label with the session's name,
  one button per option, the default marked, the question as text) and one without (absent, empty, a key that is
  not a digit/arrow/Enter, a non-text label) keeps the strip; **a click sends exactly the option's key**, one write
  for a digit and one per piece for arrows and Enter, never text plus a CR (the broken copy routes it through
  `submitToPty` and fails); nothing outside digit/arrow/Enter can come out of the key path; a double click answers
  once, a moved cursor adopts the new keys without re-enabling the card, a new dialog is a fresh card, and a card
  whose dialog stays up is re-armed; **the card writes nothing on its own** (drawing, refreshing, focusing, a
  quiet period, the dialog going away: zero writes; the broken copy auto-picks the default and fails); the
  keyboard (digits by position, arrows wrap, a chord is ignored); a typing option gets only its key and brings the
  terminal; only `chatSkinPick` calls `chatSkinSendKey` and only the click handler and the digit key call
  `chatSkinPick`; every string is a key in en, es and pt-br with `{name}`; nothing coral in the preview or the
  cards. On main's side: the question and options are forwarded bounded and untouched, a moved cursor is a
  `refresh`, the adoption is sent before the item, and no transcript means no preview.
- **Shots.** `npm run chat:shot` (hidden window) renders hand-written cases in dark and light and in narrow
  and wide panes: the status bar (at rest, narrow, each detail card forced open, hot
  values, no readings, and a payload that is another tab's: `bar-strip-<theme>[-narrow|-tip|-hot|-hot-tip]`,
  `bar-none-dark`, `bar-nomatch-dark`), dense tool rows, the slash popup (sixteen commands from every source
  at the top and scrolled, filtered, narrow, and through the real IPC), the operator's bubbles over the spacing
  scale (`bubble-*`), the empty card (`empty-*`), the drop
  veil and inserted paths, the reply half-written and the same reply after the finished message has taken its
  place (`stream-half-*`, `stream-final-*`), a permission card, a `/model` menu card, a question card with a typing
  option, a used (disabled) card and a dialog shown on the live strip with the way back to the buttons
  (`dialog-*`). A fixture event of type `stream` or `prompt` with `options` goes through the same
  `chatSkinHandleEvent` the transcript tail feeds, so the harness did not change; no shot clicks an option (the
  pane behind it is a `cat`).
- **End-to-end gate in the smoke run** (`chatViewSmoke` in `src/main/main.ts`, `97cf42d`). The last step of
  `npm run smoke` (`electron . --smoke`), run in the hidden window the smoke already uses (`show: !SMOKE`),
  after the fast gates and outside their 25 s ceiling, because it waits on a model and has deadlines of its
  own. It is skipped when an earlier gate failed, so a broken build does not also spend a model call. A smoke
  run uses a private, throwaway userData folder, so it neither reads nor writes the operator's local storage
  while their app is open. It never opens a window on the operator's screen: it is run only through
  `npm run smoke`, not with `npm start`, `--eval` or `--shot`.
  - *Switches.* `AIOS_SMOKE_CHAT` unset: it runs when a usable `claude` is found (on the `PATH` and signed
    in) and is `SKIPPED` otherwise (a laptop without it, CI). `AIOS_SMOKE_CHAT=1`: a gate that cannot run
    is a **failure**, because "did not run" must never read as "passed". `AIOS_SMOKE_CHAT=0`: skipped on
    purpose. `AIOS_SMOKE_CHAT_DEBUG` prints periodic progress lines (rows, state, pty age, the last screen
    rows) while it waits for the answer.
  - *What it proves.* It drives the whole path through the same functions the operator's hands drive:
    1. `createPane`, the launch path every session uses, in a fresh temporary folder (`aios-smoke-chat-*`)
       with `claude --model haiku`, its own name, `--strict-mcp-config` and a `--settings` blob that turns
       hooks off, remote control off and the status line into a no-op, and with the environment inherited
       from a launching Claude session dropped (`env -u`), so a throwaway session reaches nothing of the
       operator's world;
    2. the chat mode set **at once** through `chatSkinSetMode('chat', { persist: false })`, the function the
       Settings selector calls, while the session is still blocked on the folder-trust dialog and has no id,
       which is exactly when the chat view must not hide the terminal; right after, it fails if the open pane did
       not follow the mode, if a header, a `.tview` or a `viewBtn` is present, or if the log is not the first thing
       in the view. `persist: false` is deliberate: the smoke run has its own throwaway userData, but `claudeView`
       lives in the framework's `.glass/shell.json` (the operator's `~/aios` unless `GLASS_FRAMEWORK_PATH` points
       elsewhere), so a persisted write would change the operator's real preference from a QA run. The cleanup
       puts the live mode back to what the run found;
    3. the wait (up to 75 s) for the pane to adopt its session id and for the chat view to follow it. It
       records whether the detector reported `trust`, and answers the dialogs itself by reading the screen
       and moving the cursor: "Yes, I trust" for the trust dialog and "No" for the auto-mode offer. No
       session id in time is a failure that says whether the detector ever reported the trust dialog;
    4. a message typed into the chat composer and sent with Enter (`submitToPty`), asking for exactly a
       random word (`PONG-` plus eight hex digits);
    5. an operator bubble **and** an assistant bubble carrying that word, painted from the transcript
       (up to 90 s). A dialog that interrupts the turn is a failure;
    6. **streaming, measured.** A second message asks for `write 25 numbered short lines about rivers`. A tap
       on everything main sends to the view (`skinTap`, read-only, null outside this gate) records the `stream`
       events that arrived **before** the transcript line, how long before it the first text appeared, whether
       each preview is a prefix of the final message (`sameMessage`), how many `adopt` events named it, the
       extractor's time per snapshot, the renderer's snapshot cost and the CPU of the main and renderer
       processes (`app.getAppMetrics`, every 500 ms). Then it looks at what was **painted**: exactly one answer
       bubble, that bubble is the node the preview used (the gate tags the provisional node while it grows and
       checks the tag on the finished bubble), and no provisional left hanging;
    7. **a real permission dialog.** The session runs with `--permission-mode default`, so a third message that
       asks for `touch <random file>` through the Bash tool stops on "Do you want to proceed?". The gate checks
       the event carried `options`, that the dialog is drawn as a card (and the terminal strip is not up), then
       **presses the card's "No" button** (the option whose label refuses) and checks that the card disables
       itself at once, that the dialog closes by itself and that the file was not created. It never presses a
       button that accepts; Esc is the only other key it would write (to leave the run clean), and needing it is
       a failure. The folder-trust dialog of step 3 is answered through the card's button too, which exercises the
       arrows-then-Enter keys of an unnumbered menu on the real CLI.
  - *How it cleans up.* On success and on failure it closes the pane, checks that the `claude` process
    tree is gone (killing by pid and reporting a problem if not), that the pty and the transcript watcher
    are unregistered and that the session left the registry, and removes the temporary folder and the
    transcript folder Claude Code made for that cwd, after checking the name and the location and that it
    is not a symlink. Any leftover turns an `ok` into a failure.
  - *Exit code.* Only a `FAILED` verdict (or an earlier gate failing) exits non-zero; `SKIPPED` does not.
  - `src/test/chatSkin.test.ts` pins the shape of the gate (hidden window, skip and strict modes, cleanup in
    `finally`, deletion only of what it can name) with negative controls.
- **Gates for a change like this:** `npm test`, `npm run smoke`, `npm run check:tokens` (no colour
  outside `theme.css`; every pty submit goes through `submitToPty`), `npm run check:whatsnew`.
- **What source-reading tests cannot see:** that the bubbles actually paint and that the detector sees a
  real dialog. The smoke step above now covers both against a real session. What it does not look at is
  the geometry of the strip (that the real xterm is un-hidden in the lower part and takes the focus); that
  is what the screenshot harness below shows.
- **Looks are verified by looking: `npm run chat:shot`** (`2d30d9b`). A CSS rule can pass every source test and
  still draw an unreadable column, so the visual design is checked on pictures. The harness boots the real
  renderer in a window that **is never shown** (`show:false`, a lock that cancels `show()`, `focus()` and
  `restore()`, and a `show` handler that hides it again; the unit suite pins it with negative controls),
  with a private `userData` under the temp folder, at device scale factor 2, and writes one PNG per *shot* of a
  hand-written fixture (`src/test/fixtures/chat-shot.json`, neutral: an invented sync client, no real
  transcript). `npm run chat:shot -- --out <dir> [--fixture <file>]`.
  - A shot is `{name, theme: dark|light, events, composer, terminal, js, size, layout, clip: window|pane,
    working}`. `events` names streams of the same events `chatSkinHandleEvent` receives (reset, items, turn,
    usage, prompt, missing, error, plus `status` for the usage meters); `js` runs in the renderer with
    `{cs, root, $, $$, sleep}`, which is how a shot opens a tool row, unfolds a group or opens the effort menu.
  - The fixture covers what the design must hold: operator boxes, an answer with headings, lists, inline code,
    a TypeScript and a bash block, a table, a quote and a link; a read, then a run of three tool calls in three
    states (done, failed, running) with one opened to show its output; the composer with text and the stop
    button; usage meters (and a high-usage variant that turns them gold and red); the Settings tab with the font rows; the
    attention card over a live dialog; the empty state; a narrow window; the stock workbench layout; all of them
    in dark and light where it matters.
  - Some shots are **assertions as well as pictures**: a helper in the fixture's `setup` makes the run fail
    when a bar's detail card reaches into the composer or past the bar, when the effort shows for a payload
    that is not the tab's, when the `/` popup shows more than seven whole rows, or when the active row is out
    of view; when the pane has a header again, the tab has a view switch again or a gap opens above the log; when the
    effort menu is cut off by the pane, sits over the bar or has no level ticked; when a run of tool calls was
    not folded, is not in the state the shot names, will not unfold with the failed row open, or its summary
    text spills out of the row. A look that regresses breaks the run, not only a picture nobody opens.
  - The run has a single 300 s ceiling in `main.ts` for the **whole** fixture (and 360 s in the runner). It was
    150 s until the fixture reached 79 shots and took about two minutes; `settleMs` is 450, which is enough for
    the 340 ms entry animation. The next big batch should make the timer per-shot rather than raise it again.
  - **The headerless pass has twenty shots** (`no-header`, `effort-menu`, `group-live`, `group-done-fail`,
    `group-open-row`, each × dark/light × wide/`-narrow`; the first is the full window, so the tab strip is in
    it, the rest are cropped to the pane): the chat with no header and no switch on the tab; the effort menu
    open over the end of the log; a run still going with the action in progress; the same run finished with
    one failure; and the run unfolded with the failed row open and its output showing. Their streams
    (`tools-live`, `tools-fail`) are invented, and a unit test counts what they hold (a live run with exactly one
    call running; a finished one with exactly one failure), with controls. None of them picks a level: the
    driver only looks, and a test forbids `ptyWrite`, `chatSkinSubmit` and `chatSkinEffortPick` in the helpers.
  - **Path links (§ 2.3) are tested in two halves.** `src/test/chatPathLinks.test.ts` runs the resolver for real
    against a folder it creates itself (a file, a folder, names with spaces, `~`, a `:line` suffix, a path that does
    not exist, one outside the allowed roots, `..` that would climb out of one) and the linker against a fake
    resolver and a fake DOM: what is linked and what is not (the control: a missing path stays text), the longest
    candidate winning over a shorter prefix, code blocks linked inside their highlight spans, nothing nested inside
    an existing link or a button, the click, Cmd/Ctrl+Shift and Enter gestures, a message re-rendered while the
    answer was on its way, and the cache with a newer pass superseding an older one. Its security cases feed model text containing `file://` URLs and `<a href="file:...">` and
    assert that no `href` and no `<a>` results, with a deliberately broken linker as the negative control, and that
    the sanitiser's pattern still admits only `http(s)` and `mailto:`. Source guards pin the order (linking after
    `chatSanitize`), the absence of linking in the streaming path, the use of `pathCandidates`, and that the
    terminal still goes through `resolveFiles` and gets no folders. `src/test/chatSkin.test.ts` gives the streaming
    harness a spy: the preview is not linked and the final message is.
  - **Path links are shot too** (`paths-dark`, `paths-light`, `paths-narrow-*`, `paths-hover-*`). The runner creates
    real files and a folder with invented names inside the throwaway HOME's framework root, and the reply also
    names one path that does not exist as the control. The shot **fails** if the file, the folder or the long path
    is not a link, if the missing one is, if any link carries an `href`, or, in the narrow pane, if the long path is
    not clipped or pushes the log sideways. The hover shots do not toggle a class (that would photograph a copy of
    the rule): a `hover` selector on a shot makes the process send a real `mouseMove` to the hidden window and
    fails the run unless the element then matches `:hover`.
  - How it is used: after every visual change, look at **every** PNG (dark and light) before calling it done —
    spacing, hierarchy, contrast in the light theme, truncation, shadows. It does not replace the gates; it is
    the one place a redesign is actually seen. It never answers a dialog and never writes to a pty.

## 10. What it does not do yet, and risks

**Not done**

- **Streaming of anything but the reply text.** Thinking, a tool's progress and a subagent's output are not
  previewed; only the last text block of the turn is (a block followed by a tool row is complete, and the
  transcript has it). The preview is what the terminal PAINTS: markdown rendered by the TUI (no `**`, no `#`, no
  fences, link targets gone, tables as box characters), re-wrapped to its width, so the finished message can
  look different from the preview once its real markdown is drawn (a heading grows, inline code gets its fill).
  That is the one visible change at hand-over; the position does not move.
- **Tool output beyond the preview.** Rows show the bounded preview (§ 2, § 3.2); the full result stays in the
  transcript and the terminal. A very long output, or a diff rendered as a diff, is not drawn.
- **Thinking and subagent activity** are not shown (subagent lines are dropped on purpose).
- **Dialogs whose rows the parser cannot read** (a scrolled list, a multi-select, rows separated by blank lines, a
  footer-less shape other than Yes/No) are still only pointed at: the strip, as before (§ 5).
- **`@` mentions** in the box (files and images arrive as quoted paths, § 2, not as attachment chips).
- **A permission-mode picker.** The chat follows what the session already runs under.
- **Accessibility pass** beyond the log region, the alert notice and the menu roles of the effort menu.
- **The `/` popup does not tag plugin commands.** A plugin's name is already the prefix (`weekly:plan`), so only
  the project's and the operator's own commands carry an origin word. An `aios` tag for the bundled plugin would
  be one more locale key and a `source` value; it was left out until someone misses it.
- **Path links are for what exists on this machine, in this pane's reach.** A path the model invents, a file that
  was deleted since, or one outside the allowed roots stays text, and so does one that only exists on another
  machine. A relative path is read against the shell's *current* folder (the same rule as the terminal), so a
  message written before the operator `cd`-ed may resolve somewhere else, or not at all. A file named with spaces
  and no quotes is found by trying the longer candidates (up to six words), not by any parsing, so an unusual
  name can lose to a shorter prefix that happens to exist. The links are asked about when the message is
  painted: a file created later is linked only if the message is painted again, and the cache forgets a miss after
  ten seconds. The tooltip is the terminal's, so a very long absolute path is cut by its width rather than wrapped.
  The streaming preview is not linked (§ 2.3). Where the candidate pattern cannot tell where a path ends (a path
  glued to other characters inside a long command line) the link may be shorter or longer than the operator
  expects; existence decides, so it is never a path that is not there.
- **Cloud mode.** The tail reads a local file; moving sessions behind a host is the cloud-mode RFC's
  concern, and the tail's injected projects folder and callback are the seam.

**Streaming: is it viable, and what was measured.** Yes, on the real screen, and it is on. The rule set at the
start was that a streaming that merely *looked* like it worked would not ship, so the first thing built was the
measurement (`chatViewSmoke` step 6, § 9) against a real `claude` (2.1.310, haiku, an ephemeral session in a
temporary folder, hidden window), asking for `write 25 numbered short lines about rivers`. Its first runs
**failed**, and what they showed is what the extractor now handles:

| What the real screen does | Effect on the first version | Fix (`src/core/screenStream.ts`, renderer) |
|---|---|---|
| While text is written the CLI draws **no spinner**; the only sign of a live turn is `… · esc to interrupt` on the footer line under the box | 2 stream events in a 5 s answer | the footer is read where it lives (under the box) |
| The empty box is painted `❯` + a **no-break space** | the box was not found, so its border read as text | no-break spaces are plain spaces |
| The box's top border **carries the session's name** (`──── my-session ─`) | it ended the reply block, so nothing was a reply | a titled border is a border |
| A right-aligned **`◐ medium · /effort`** row sits above the box | it leaked into the text (`2. ◐ medium · /effort`) | known noise |
| A list number is painted **before its text** (`3.`, then a moment later `3. The Nile…`) | glued to the line above | a bare number starts an item |
| The terminal is shorter than a 25-line reply, so the **head scrolls off** and each snapshot is a window | the preview jumped to the last 14 lines | `stitch` joins the windows back into the whole text |
| The CLI paints a frame **in pieces of ≤ ~1 KB, up to ~100 ms apart**, between `ESC[?25l` and `ESC[?25h` | a snapshot in between is **torn** (line 23 and line 24 mashed together), and a torn tail does not match the final message | a snapshot waits for the frame to close (≤ 250 ms more, never for ever), and the join tolerates a repaint in the last two lines |
| `⏺ Running 1 shell command…` is a tool progress line | read as a reply | known tool summaries |
| The finished message is in the transcript while the screen still says `esc to interrupt` | the same text could come back as a second preview | the last adopted text is remembered until the next turn |

With those in, four consecutive runs on the same machine gave:

| run | stream events before the transcript line | first text before it | previews that were a prefix of the final | last preview / final | snapshots in the answer | extractor (avg / max) | CPU main / renderer |
|---|---|---|---|---|---|---|---|
| 1 | 11 | 4.1 s | 11 / 11 | 35 % ¹ | 28 in 5.9 s | 0.35 / 1.94 ms | 0.2 % / 0.5 % |
| 2 | 24 | 3.3 s | 24 / 24 | 96 % | 41 in 5.3 s | 0.33 / 2.61 ms | 0.2 % / 0.8 % |
| 3 | 23 | 3.3 s | 23 / 23 | 96 % | 31 in 4.3 s | 0.29 / 1.13 ms | 0.2 % / 0.8 % |
| 4 | 22 | 2.9 s | 22 / 22 | 95 % | 28 in 3.8 s | 0.20 / 1.31 ms | 0.4 % / 0.9 % |

¹ The model paused for 2.6 s after ten lines and then finished; the terminal had nothing more to show, so there was
nothing more to preview. The preview can only be as fine as the CLI's own painting.

In every run exactly one answer bubble was on screen at the end, it was the node the preview had used, and no
preview was left hanging. The snapshot itself costs ~0.01–0.15 ms in the renderer (60 rows of the buffer) and the
timer change (a snapshot after 40 ms of quiet, never later than 150 ms after the first unsent byte, plus up to
250 ms while a frame is open) sends about the same number of snapshots as before; nothing needed throttling. The
numbers are for this machine, this CLI version and a fast model; a slower model streams in smaller steps, and the
window stitching matters more for replies taller than the pane.

**Risks**

- **The streaming preview depends on how the TUI paints**, which is the CLI's, not a contract: its footer, its
  spinner, its frame brackets and its tool progress wording changed what had to be handled between the first
  run and the fifth, and will again. The failure mode is bounded: if the extractor sees nothing it sends nothing
  and the chat is exactly what it was (complete messages from the transcript); if it sees something that is not
  the message, the adoption does not match, the preview is dropped at the end of the turn, and the finished
  message appears as before. A preview is never what stays.
- **The transcript format is Claude Code's, not a contract.** Field names, the split-by-block shape, the
  end-of-turn markers and the wrapper tags can change between versions. The tracker is defensive (unknown
  lines are ignored, nothing throws), which means a change degrades silently into a thinner chat, not a
  crash. There is no version check.
- **The TUI heuristic is fragile across versions** (wording, layout, glyphs). The 20 s stalled-turn notice
  is the guarantee, not the detector.
- **Sessions without an adopted `sessionId`** have no transcript watch and so no chat content, but their
  dialogs are watched from the screen (§ 5, `39d60fd`). Adoption depends on the registry / title
  announcement; a pane that never gets one stays on "connecting" in chat view, with an empty log.
- **Large transcripts.** Solved at open, not while following (§ 12.3). The view loads a window of the end of the file
  (about 300 conversation lines, at most 16 MB) and pages the rest in when the operator scrolls to the top, so its
  size no longer depends on the length of the file. A live session still adds rows below, with no pruning above while
  the operator follows the end (about 25 DOM nodes per row), and what the operator scrolls up to read stays. There
  is no virtualisation. Only the main-process and renderer numbers of § 12.3 were measured, on synthetic transcripts;
  painting and compositing of a window that is never shown were not.
- **`/clear` and resume** are followed from the process tree (§ 12.2) and verified against a real session. A
  *fork* of a session (`--fork-session`, the picker's "fork" choice) was not exercised.

**Open questions**

1. *(partly answered)* The footer-less Yes/No offers are now read (§ 5). Open: other footer-less shapes, which
   nothing points the operator at, since the stalled-turn notice needs an open turn.
2. Is 20 s the right threshold for the stalled-turn notice, and should it differ for long tool runs?
3. *(answered)* The tool's output now sits behind a disclosure in each row. Open: should the row open on its
   own for an error, or for the tool that is blocking a turn?
4. *(answered by § 2.4)* The mode is global on purpose: one setting, `claudeView`, for every Claude session. Open: would anyone want it per agent or per project? The per-tab *Show terminal* and its way back cover the one-off case today, and nothing asked for more, so a per-agent override is not built.
5. Is a version guard on the transcript format worth having (warn when no `user`/`assistant` line was
   recognised in a non-empty file)?

## 11. The packaged build

Everything above was proven against source, where Electron is `node_modules/electron`. A shipped app differs in
exactly the places this feature depends on: the renderer, its stylesheet and `marked` / `highlight.js` are read
from inside `app.asar`, the preload runs from there, and node-pty is unpacked beside it. So the packaged binary was
checked as its own artifact.

**What was built.** `npm run dist` (compile, `electron-builder --mac dmg`, then `verify:package`) on an Apple
silicon Mac without a Developer ID certificate. electron-builder logged `skipped macOS application code signing`
and produced `AIOS-arm64.dmg` and `dist/mac-arm64/AIOS.app`, **unsigned and not notarized**. The command exits 0
in that state, so a green `npm run dist` on a machine without the identity is not evidence of a signed build.

**What was run.** The packaged binary was started by its own path (never through LaunchServices, which would share
a bundle id with an installed copy), with `--smoke`, a throwaway user-data folder and no window ever shown. Before
that, the code was read for every way a smoke run could reach a visible window: the window is created with
`show: false`; the instance lock, the command bus, the keep-awake blocker, the config watchers and the updater are
off under `--smoke`; the only paths that call `show()` or `focus()` were the Dock `activate` handler and the
`second-instance` handler. The first was not guarded for smoke runs, so it is now (`!(SMOKE || CHAT_SHOT)`), and a
smoke run on macOS also sets the `accessory` activation policy, so it takes no Dock icon. The second needs the lock,
which a smoke run never takes.

| Check | Result on the packaged build |
|---|---|
| `verify:package` static: bundle name matches the four helpers | pass |
| `verify:package` contents: no compiled test suite in the asar | pass (`out/` carries `core`, `i18n`, `main`, `preload`) |
| `AIOS_SMOKE_CHAT=1 verify:package` (the harness runs the binary) | pass in 63 s end to end, `chat assets OK`, `chat view OK` |
| Binary run directly, `AIOS_SMOKE_CHAT=1 ... --smoke` | exit 0; `isPackaged=true`, app path inside `app.asar`, renderer URL inside `app.asar`; both chat gates ran, 0 occurrences of `SKIPPED` |
| `--chat-shot` on the packaged binary (hidden window, synthetic `HOME`, temporary user data) | exit 0, 89 PNGs; the bubbles show highlighted code, tables, quotes and links |

**What the smoke now proves inside the asar.** A new gate, `chatAssetsSmoke`, runs on every `--smoke`, needs no model
and cannot be skipped. It reports where the app was loaded from, then checks in the renderer: `marked` and
`highlight.js` are present, the preload bridge exposes the chat methods, the stylesheet carries the chat rules (32
`.cs-` rules), and the app's own `chatRender` turns a markdown bubble into bold, a table and highlighted code while
a hostile payload (`<img onerror>`, `<script>`, a `javascript:` link) comes out as inert text with nothing executed.
Control: with the `highlight.js` script tag removed from `index.html`, the smoke fails with `highlight.js did not
load; code was not highlighted`; with the `marked` tag removed an earlier gate (the file viewer) fails first.

**Two properties of the harness worth knowing.** `verify:package` printed the smoke's output only when it failed, so
a pass could not say whether the chat gate ran or skipped; it now prints the chat gate lines on a pass, requires
`chat assets OK`, and with `AIOS_SMOKE_CHAT=1` requires that the real-session gate ran. And its fixed 90 s kill sat
close to the real duration of a smoke that drives a live session (about 60 s), so the limit is 300 s in that mode
(`AIOS_VERIFY_TIMEOUT_MS` overrides it) and the child runs in its own process group, so a kill takes the `claude`
session and the shell with it instead of orphaning them.

**Not verified.** Code signing, notarization and Gatekeeper (no identity on the machine). Installing the dmg and the
auto-update path (out of scope: it would touch an installed copy). The Windows and Linux builds: `dist:win` and
`dist:linux` were not run, so the asset gate has not run there. The gate has no platform condition in the app and both
scripts end in `verify:package`, whose Linux and Windows checks now require `chat assets OK` as the macOS one does
(`chat view` is only reported); that the line appears in their output is for the `linux-dist` and `windows-dist` CI
jobs to show. Painting of the packaged window: the window is never shown, so the PNGs come
from `capturePage`, not from the screen.

## 12. What changed since the first review

### 12.1 Merge with upstream 0.13.0, and Windows

The branch now contains `upstream/main` (a merge commit, no rebase). Eight files conflicted, twelve hunks; in each
the upstream behaviour was kept and the chat's addition layered over it (the `openExports` setting replaced
`autoOpenExports`; `fs:resolveFiles` is upstream's async `{open, reveal}` and the chat keeps its own
`fs:resolvePaths`; on pty exit both the draft-hold release and the chat's cleanup run). Generated `i18n.js` was
regenerated, not merged by hand. The merge broke five tests that were not conflicts (three that pinned the old
`resolveFiles` handler, two because the Greek locale lacked the chat's keys); they were rewritten with their negative
controls, not loosened.

A Windows CI failure was also fixed. The test expected POSIX literals while `pluginCommandDirs` returns paths joined
with the host separator. The production code had a latent bug on the same line: `cwd.startsWith(projectPath +
path.sep)` fails on Windows when one side uses `/`, the drive letter or a folder differs in case, `projectPath` has a
trailing separator, or it is a drive root, and the symptom is silent (a project plugin's commands missing from the
`/` popup). `isSameOrInside(root, child, pathMod)` (`src/main/pathResolve.ts`) is a pure function that takes the
path module, so Windows rules are tested from any host with `path.win32`. Three tests with negative controls (each
mutation of the helper or the old condition fails at least one test). Whether Windows or Claude Code really write
those path shapes was not confirmed; they can arrive.

### 12.2 `/clear` and resume

**Finding.** The assumption in the first draft (old bubbles stay until the new transcript file appears) was wrong
for Claude Code 2.1.x. `/clear` and `/resume` start a new session inside the *same* `claude` process: the pty, the
pid and the tab stay, and that pid's registry entry now holds the new id. The status pulse looked the old id up in the
registry, did not find it, and read that as the end of the session: the tab said "(ended)", the session id was
dropped and the view fell back to the terminal. This also happened in terminal view. Real session, before the fix:

    before /clear — view=chat  id=b2663a1e watched=b2663a1e tail=b2663a1e→b2663a1e
    /clear +1.0s  — view=term  id=d910ff89 watched=null      tail=none
    FAILED — /clear: not finished after 45s

**Fix.** Before declaring the end of a session, the pulse asks the pty's process tree (the same authority
`adoptUnidentified` uses). A live session under that pty with another id is adopted (id, confirmed name, rename
unless the operator named it, persistence, chat view notified); with nothing live it ends as before. When the
watched id changes, the view is emptied (`chatSkinResetView`, shared with the tail's `reset` event) and the
in-flight state is dropped. Every tail event now carries the transcript id it belongs to (`sid`), and the renderer
discards events whose id is not the one it watches, so a late read from the old transcript cannot repaint over the
new one.

**Real run after the fix** (smoke step 8, a real session, hidden window): after `/clear` the id changes, the view
follows it, the tail points at the new file, no row of the old session remains, and the first rows are the new
transcript's own (`/clear`, the next question, its answer). After `/resume <original id>` the view returns to the
same five rows, compared text to text, with none duplicated. Cleanup removes the pane, the processes, the temporary
folder and the transcript folder.

**Controls (real mutations, restored afterwards).** Removing the reset on id change: 3 chat tests fail. Removing
the `sid` filter: 1 fails. Removing the process-tree lookup in the pulse (the original behaviour): the pulse test
fails. Removing `unwatch` at the start of the tail's `watch`: the new tail test and 4 others fail. Removing the
tail's `reset` when the file appears: 4 fail.

**Limits.** A new id whose transcript does not exist yet leaves the view empty (`missing`) rather than showing the
old rows; that case never happened in the real session, so it is covered by a unit test only. Forks were not tried.

### 12.3 Long transcripts

**Measurement.** `npm run chat:bench -- --lines 5000,50000` builds a seeded synthetic transcript, opens it in a
hidden window through the real tail and the real renderer, and measures load, per-line cost, DOM size and memory,
before and after the change. The mix is calibrated from the *counts per line type and sizes* of one real 35 MB, 1,624
line transcript (no content read): 21 % attachments, 16 % request blobs of about 37 KB, 8.6 % tool results averaging
161 KB, about 4 % conversation text. That is why 5,000 lines weigh 91 MB and 50,000 lines 905 MB. The full run takes
about 80 s and removes its temporary files.

| | 5,000 lines (91.2 MB), before → after | 50,000 lines (905.3 MB), before → after |
|---|---|---|
| main: load, reset to turn (ms) | 82 → 20 | 756 → 17 |
| main: IPC events / items / JSON (MB) | 91 / 664 / 1.68 → 5 / 124 / 0.34 | 852 / 6,975 / 17.62 → 5 / 141 / 0.36 |
| renderer: load to last row (ms) | 197 → 66 | 13,301 → 75 |
| renderer: handler per new line, median / p95 (ms) | 10.1 / 12.2 → 4.1 / 6.1 | 49.3 / 65.1 → 4.3 / 6.8 |
| renderer: rows held | 602 → 124 | 6,405 → 141 |
| renderer: DOM nodes in the log | 15,170 → 2,853 | 160,347 → 3,924 |
| renderer: process working set, loaded (MB) | 273 → 209 | 1,304 → 214 |
| after 60 live lines: rows / log nodes | 645 / 16,270 → 167 / 3,953 | 6,448 / 161,447 → 184 / 5,024 |
| scroll to the top: rows before → after | 645 → 645 (nothing more to load) → 167 → 274 | 6,448 → 6,448 → 184 → 303 |

A conversation-heavy mix ("chatty": small tool results) gives 6.4 MB and 64.2 MB files and 241 and 247 rows.

**Reading the numbers.** Before, everything grew with the file: ten times the lines gave 10.6 times the DOM nodes,
4.8 times the working set, a load of 13 s instead of 0.2 s, and every new line cost five times as much because the
regrouping pass walks all rows on each event. The JS heap barely moved (12.7 MB at 50,000 lines): Blink's DOM lives
outside V8's heap, so the useful indicators are nodes and the process working set. Working set and RSS include
about 190 MB of Chromium baseline; read the differences.

**Method limits.** The bench window is born hidden but with `backgroundThrottling: false`, so `document.hidden` was
false and `requestAnimationFrame` ran at about 60 fps. "Load" is JS plus IPC until the handler of the last row
returns; "forced layout" is a synchronous `getBoundingClientRect`, so it includes style and layout but not paint.
**No figure is a paint or compositing time**, because a window that is never shown is never painted to a screen.
Long tasks measured 0 almost always; the 13 s before was many small events, not one block. `privateBytes` is not
available on macOS and is not reported. Numbers come from one Apple silicon Mac and one seed.

**Change.** Main reads the end of the transcript backwards in 256 KB blocks until it holds about 300 conversation
lines or 16 MB (constants in `src/main/transcriptTail.ts`), parses them with the tracker, and sends `reset`, `span`
(whether anything lies above) and `items`; live lines continue from the end of that window as before. In a mix
dominated by large results the byte cap decides (124 and 141 rows), in a chatty one the line cap does (241 and 247).
A window is never cut inside a tool call (results whose call was not seen widen the read a little), and a single line
longer than the byte cap is stepped over, so that row is not shown but what is above it stays reachable. Scrolling near
the top sends `chatSkin:earlier`; main reads the window above with a tracker of its own, so history never touches
the live turn's state, and replies with an `earlier` event (`items`, `more`); the renderer puts the rows above and
moves `scrollTop` by the height it added, so the bubble in view does not move (0 px in the measurement). Truncation
or replacement of the file re-windows from the new end. `current(paneId)` reports what the tail is following, for the
smoke.

**What it does not do.** The cap applies at open. A session that keeps running adds rows without pruning above
(about 25 DOM nodes per row), and rows the operator scrolls up to read stay. An in-view search or jump-to-start over
rows not loaded does not exist; the terminal view and the transcript file still have the whole history.

### 12.4 Results of the final pass

Run on the final commit of this branch: `npm run compile`, `npm test`, `npm run check:tokens`,
`npm run check:whatsnew`, `AIOS_SMOKE_CHAT=1 npm run smoke` (with the real-session gate running, not skipped).
Counts and output are in the pull request thread, not here, because a number in a design document goes stale with
the next commit.

### 12.5 For the design review

- **Where the line is drawn.** The chat is a skin; the pty and `claude` are the source of truth. `/clear` and resume
  fit that: the pane does not change, the view follows the id the process reports.
- **A cost to decide on.** Paging above the window is the only place the view shows less than the file holds. If a
  search over the whole conversation is wanted, it belongs in main (reading the file), not in the DOM.
- **Platform scope.** Verified on macOS only (§ 11). Windows rules are exercised from tests with `path.win32`; the
  Windows and Linux packages were not built or run. Their `verify:package` now requires `chat assets OK`; the first
  CI run of `linux-dist` and `windows-dist` is the first time it is checked there.

### 12.6 When it ships: release notes

The chat view is not part of 0.13.0 and the maintainers want it in a release of its own, so this branch changes
neither the version nor the "What's new" copy. When it ships:

1. Bump the version as RELEASING.md describes (`npm version <level>` bumps `package.json` and creates the tag).
2. Write the What's New copy for that version: the keys are `whatsnew.for` (the version it describes), `whatsnew.sub`
   and `whatsnew.h1`..`whatsnew.b4`, in every locale that `scripts/check-whatsnew.mjs` lists (`en`, `es`, `pt-br`,
   `el`), then regenerate `renderer/i18n.js` with `npm run gen-i18n`. `npm run check:whatsnew` fails when the stamp
   is not the current version or the prose is identical to the previous release's. Rank the copy by what someone
   notices in their first ten minutes; the chat view is the headline, the transcript paging and the packaging gate
   are plumbing for the GitHub notes. RELEASING.md also asks for a look at What's New in the real App before the tag.
3. The chat's own UI strings already exist in all four locales; in `el` they are the English text until someone
   translates them.
4. The repository has no CHANGELOG file (`upstream/main` has none), so there is nothing to append; the release notes
   live with the GitHub release.
