# RFC: Menu bar — session status at a glance, and a quick bar from anywhere

- **Status:** Proposed
- **Scope:** AIOS App (this repo), macOS first. No framework change: the quick bar speaks the existing spawn-inbox protocol.
- **Delivery:** two independent PRs off `main` — (1) the menu-bar icon, (2) the quick bar. They share only two settings keys.

## 1. Summary

Desktop AI apps live in the macOS menu bar: an icon that is always there, and a global shortcut that opens a small
floating input over whatever the operator is doing. The AIOS App has neither. To see whether a session needs you, you
bring the App to the front; to start one, you switch to it and open a picker.

This RFC adds both, as glass over what already exists:

- **A menu-bar icon** that lists the operator's live sessions with their state, and shows a count when any of them is
  waiting for the operator. It reads the same 2-second pulse that already drives the panel and the Dock badge.
- **A quick bar** on a global shortcut the operator chooses: one line of text, one destination picker (a new session,
  an agent, or a live session), Enter to send. Inside the App the same destinations live in the Ask panel (*Send to*),
  so the floating bar exists only to reach Ask from another app. (Revised in the 0.15.0 test round: an in-app bar beside
  the Ask panel offered nothing the panel could not.)

Neither reimplements anything. The icon renders the registry the pulse already reads; the quick bar writes an ordinary
spawn-inbox request addressed to this surface, so a message from the quick bar is held, queued, verified and
dead-lettered exactly like one from an agent.

## 2. What it does for the operator

### 2.1 The menu-bar icon

- A monochrome template icon in the macOS menu bar, present while the App runs (the main window may be hidden).
- When one or more sessions are waiting for the operator, the count appears beside the icon (`tray.setTitle`). It sits
  alongside the Dock badge rather than replacing it.
- Clicking opens a menu:
  - **One row per live operator session**, with its state — working, needs you, error, ready — in the same four
    states the panel and the tabs show. Choosing a row brings the App forward on that session.
  - **Quick bar… ⇧⌘A** (once both parts are in, § 5), **Open AIOS**, **Settings…**, **Quit AIOS**.
- With no live sessions the list collapses to one disabled line ("No sessions running").

### 2.2 The quick bar

- **The chosen shortcut, from any app,** opens a small frameless panel near the top of the screen under the pointer, on the current
  Space, above other windows. The shortcut again, Esc, or a click elsewhere closes it.
- One text field and a destination chip. The chip (or **Tab**) opens a filterable list with three groups:
  1. **New session** — default. The name is suggested and editable.
  2. **Agents** — the same list *Launch agent* shows today. Choosing one launches that agent with the text as its task.
  3. **Live sessions** — the text is sent to that session.
- **Enter** sends and closes; the App stays where it was (a new session opens in the background). **⌘Enter** sends and
  brings the App forward on the target session.
- No answer is shown in the bar. The answer lives in the session; the icon's count and the existing *needs you*
  notification say when the session wants the operator.
- Text only. Attachments are out of scope (§ 6).

## 3. Design

### 3.1 Session state in the main process

`PanelHost.postRunning()` already computes, every 2 s, the registry overlaid with the program status and hands it to
`Attention.tick`. The icon subscribes to the same tick and uses `listOperatorSessions()` scope (interactive,
non-SDK, in scope), never the bus-wide `listRunningAgents()`.

The four-state mapping lives only in the renderer today (`statusInfo` in `renderer/app.js`). It moves into
`src/core/` as a pure function returning a state key (`busy | input | error | idle`); main uses the core copy and the
renderer keeps its own (it is a classic script), and a test pins the two to each other, as `attention.test.ts`
already pins the blocked-status regex. The icon and the panel must never disagree about what a session is doing.

The menu model is a pure function too — `(sessions, locale strings) → rows + count` — so it is unit-tested without
Electron. The menu is rebuilt only when that model changes, not on every tick, so an open menu is not torn down
under the pointer.

Choosing a session row reuses the `reveal({name, sessionId})` hook the *needs you* notification already uses.

### 3.2 The quick bar writes to the inbox

The bar does not talk to a pane directly. The hold-until-idle queue, the operator-is-typing hold, supersede, the
transcript verification and the dead letter all live in `runSend`/`runSpawn` on the bus side, before the renderer is
asked to type. A direct path would skip them and type into a busy session. So the bar's main-process handler writes a
request file into the inbox, addressed to this surface:

| Destination | Request |
|---|---|
| New session | `{"name": "<name>", "task": "<text>", "surface": "app"}` |
| Agent | `{"name": "<agent>", "task": "/aios:agent <agent> — <text>", "surface": "app"}` (the same first prompt *Launch agent* sends today) |
| Live session | `{"action": "send", "name": "<name>", "prompt": "<text>", "surface": "app"}` |

Names are sanitised with the bus's own `sanitizeName`, and a new session never takes a name that is running. The file
(`quick-bar-<name>-<ms>.json`, so two sends a moment apart are two files) is written whole and renamed into place, so
the watcher never sees a partial request.

There is deliberately **no `from`**. The bus uses it to let a newer message from the same writer supersede an older
one still queued; the operator is not a session, and two things they typed must both arrive.

### 3.3 Windows

The bar is a second `BrowserWindow` (`frame: false`, `alwaysOnTop`, `visibleOnAllWorkspaces`, `type: 'panel'` on
macOS, hidden rather than destroyed on close), with its own narrow preload: list destinations, submit, close. It has
no PTY, file or settings access.

Today some main-process code takes `BrowserWindow.getAllWindows()[0]` to mean the main window. Every such use moves to
the explicit main-window reference before the second window exists.

### 3.4 The shortcut

- The shortcut the operator picks is registered with `globalShortcut`, so it works whether or not the App is focused.
- In-app ⇧⌘A stays *Launch agent*, the modal agent picker, as before the quick bar. The quick bar has no in-app key:
  inside the App its destinations are in the Ask panel.
- A global shortcut takes the combination away from every other app (Finder's *Go to Applications*, Chrome's tab
  search). This is said in Settings next to the field.
- If `globalShortcut.register` returns `false` (another app owns it), Settings shows the conflict instead of failing
  silently, and the in-app accelerator keeps working.

### 3.5 Settings

Two keys in `.glass/shell.json`, added to the `shellSettings` interface and to the `shell:setSetting` whitelist:

- `menuBar: boolean` — default `true` on macOS. Toggling it creates or destroys the icon live.
- `quickBarShortcut: string` — default empty: no global shortcut until the operator picks one, because a global
  shortcut takes its keys from every other app (⇧⌘A is Slack's *All unreads* and Finder's *Applications*).
  Settings shows the field and, when the OS refused the combination, says so under it.

### 3.6 Lifecycle and test runs

- The icon and the shortcut are created after `whenReady`, rebuilt on locale change (alongside the application menu),
  and released on `will-quit` (`globalShortcut.unregisterAll`).
- Neither is created under the smoke, screenshot, eval or chat-shot runs, the same gate the bus already has.
- The template image ships under `renderer/` (`build/` is not packaged).

## 4. Tests

- Core: status classification (and its pin against the renderer copy), the menu model (rows, order, count, empty
  state), the request builder (each destination, name sanitising, never an `_`-prefixed field).
- Main: `getAllWindows()[0]` no longer used for the main window (source assertion); the menu still has no duplicate
  accelerators; every new intent has a renderer route (`menu.test.ts`).
- Locales: new keys present in all four locales.
- Smoke is unchanged: neither feature exists under `--smoke`.

## 5. Delivery

1. **Menu-bar icon** — core status function + pin test, menu model, `Tray` wiring on the `postRunning` tick, the
   `menuBar` setting, the template image, locale strings.
2. **Quick bar** — the panel window and its preload, the request builder, ⇧⌘A registration and the *Launch agent*
   hand-over, the `quickBarShortcut` setting, the `getAllWindows()[0]` clean-up, locale strings.

Either can merge first. The menu-bar row *Quick bar… ⇧⌘A* (§ 2.1) needs both, so it is added by a small follow-up
once the second one lands.

## 6. Not in this RFC

- Attachments (images, files, screen capture).
- Dictation.
- Showing the answer inside the bar.
- Windows and Linux: Electron's `Tray` works there, but the panel's look and the shortcut conventions differ; the
  code is guarded by platform and left for a follow-up.
