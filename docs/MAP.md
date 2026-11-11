# How the AIOS App is built: a map for your first hour

You don't need to read the whole codebase to fix one thing. This page tells you where each part of the App lives, so you can go straight to the twenty lines that matter. For setup and the rules PRs follow, see [CONTRIBUTING.md](../CONTRIBUTING.md).

## The App in one paragraph

The AIOS App is an [Electron](https://www.electronjs.org/) desktop app. It runs **Claude Code sessions** in terminal panes, and shows each one either as a terminal or as a **chat view**. Beside them are a **file viewer and editor** for the operator's notes (a folder of markdown called the **vault**), a **sidebar** of cards (Home, Health, calendar, boards), and a **bus** that lets one session start, message or close another. Everything works against a second repo, the **framework** ([The-AIOS/aios](https://github.com/The-AIOS/aios)), which holds the operator's vault, agents, skills and commands.

## Two halves: main and renderer

Electron apps have two kinds of code. Knowing which half a bug lives in saves most of the searching.

| | **main** (`src/main/`, `src/core/`) | **renderer** (`renderer/`) |
|---|---|---|
| Runs as | Node.js, one process | a web page in the window |
| Does | spawns terminals (`node-pty`), reads and writes files, talks to the OS, updates the App | draws everything you see, handles clicks and keys |
| Language | TypeScript, compiled to `out/` | plain JavaScript, no build step |
| Talks to the other | `ipcMain.handle(...)` in `src/main/main.ts` | `window.glassShell.<name>(...)`, defined in `src/preload/preload.ts` |

`src/core/` holds the **pure** logic: functions with no Electron and no disk, which is why most tests target them. `src/main/` wires that logic to the OS.

## Where things live

| You see… | Look in |
|---|---|
| A terminal pane, tabs, splits, tab groups | `renderer/app.js`: sections *unified/split zones*, *TAB ORDER*, *TAB GROUPS*; terminals spawn in `src/main/main.ts` (`pty:`) |
| The **chat view** (bubbles, composer, cards) | `renderer/app.js` from the *CHAT SKIN* marker on. Messages come from the session's transcript via `src/core/transcriptChat.ts` and `src/main/transcriptTail.ts`. Live state (suggestion, status line, dialogs) is read from the terminal screen: `chatSkinPromptSuggestion`, `chatSkinMirrorStatus`, `src/core/tuiPrompt.ts` |
| The **file viewer / editor** | `renderer/app.js`: `openViewer`, sections *viewers* and *syntax-highlighted editor*; notes are sanitized by `vaultSanitize` before showing |
| The **explorer** (file tree) | `renderer/app.js`, section *explorer* |
| The **sidebar** cards | `renderer/app.js`: *the pulse renderer*, *Health*, *BOARDS* (`src/core/boards.ts`, `src/main/boards.ts`), *CONNECTORS* |
| The **bus** (spawn / send / kill / resume between sessions) | `src/main/commandBus.ts`, `src/core/commandBus.ts`, `src/core/busVerbs.ts`, `src/core/sendQueue.ts` |
| **Settings**, What's New, the shortcut map | `renderer/app.js`: search `settings.`, *WHAT'S NEW*, *THE SHORTCUT MAP* |
| The App **menu**, menu-bar icon, Ask AIOS from any app | `src/main/menu.ts`, `src/main/menuBar.ts`, `src/main/quickBar.ts` with `renderer/quickbar.*` |
| **Updates** | `src/main/updater.ts`, and *APP UPDATE PILL* in `renderer/app.js` |
| **Words** on screen, in four languages | `src/i18n/locales/{en,es,pt-br,el}.json`. `renderer/i18n.js` is generated from them (`npm run gen-i18n`): never edit it by hand |
| Colours, spacing, the look | `renderer/theme.css` (tokens at the top, dark and light) |

`renderer/app.js` is large. Don't scroll it: search. Its sections start with `/* ═══` or `/* ──` banners, and its functions are named after what they do (`chatSkin…`, `vault…`, `board…`). Note that plain `grep` may treat the file as binary because of its emoji and box-drawing characters; use `grep -a`.

## Running it

See *Getting it running* in [CONTRIBUTING.md](../CONTRIBUTING.md). Two commands you'll use most:

- `npm run start:isolated`: the App with its own settings folder, so your test runs don't touch an installed copy.
- `npm test`: every test, after compiling.

## How the tests work

Tests live in `src/test/*.test.ts` and run with Node's built-in test runner.

- **Pure logic** (`src/core/`) is imported and called directly.
- **Renderer code** can't be imported (it's a page script), so many tests **read `renderer/app.js` as text**, pull out one function, and run it with fakes. Others check that a line of code is still there.
- Almost every such test comes with a **negative control**: the same check run against a deliberately broken copy of the source must fail. Look for `guarded(...)`: it takes the check and a function that breaks the code. If your new test passes on broken code too, it isn't testing anything.
- `npm run smoke` starts the real App hidden and drives a real Claude session. CI runs it on macOS.

When you fix something, add a test that **fails before your fix and passes after**. That's the one rule reviewers check every time.

## Words you'll meet

- **Session**: one running Claude Code conversation, usually with a name like `buddai` or `calm-heron`.
- **Transcript**: the `.jsonl` file where Claude Code records a session's conversation. The chat view draws from it.
- **Pane**: one terminal (or viewer) area in the window.
- **Vault**: the operator's notes, inside the framework folder.
- **Framework** or **canonical**: the [aios](https://github.com/The-AIOS/aios) repo. Glass (the VS Code extension) and the App are two **surfaces** over it.
- **Bus** or **spawn inbox**: `~/.aios/spawn-inbox/`, where a session drops a request for the App to start, message or close another session.
- **Board**: a sidebar card drawn from `~/.aios/boards/<name>/index.html`.
