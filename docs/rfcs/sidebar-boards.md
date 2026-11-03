# Sidebar boards: a card the operator programs (#91)

Every layer of the framework has a `custom/` slot except the sidebar. A **board** is that slot: a
sidebar card whose content is one static HTML file the operator's own tooling writes. The App lists
the boards, shows them, and knows nothing about what they mean.

## Contract

- **Source:** `~/.aios/boards/<name>/index.html` (`$AIOS_BOARDS_DIR` overrides the root, as
  `$AIOS_HEALTH_DIR` does for Health). One folder per card. No folder, no card; a folder without
  `index.html` is not a board. Folders starting with `.` are ignored.
- **Static HTML only.** Scripts never run (see Isolation). Stylesheets, images and fonts may live
  next to `index.html` in the same folder.
- **Optional `board.json`** in the same folder: `{ "title": "…", "valid_for": 3600 }`. `title`
  replaces the folder name on the card; `valid_for` is in seconds (default 3600).
- **Staleness is the writer's problem, drawn like Health:** when `index.html` is older than
  `valid_for`, the card's title dims and a line reads "no update since …".
- **Re-render on change:** the card reloads its frame when `index.html`'s mtime changes, and only
  then.
- **The App never writes into `~/.aios/boards/`.** `/aios:update` never touches it.

## Isolation

The existing HTML viewer was built for the operator's own exported deliverables, so it lets scripts
run, does not block the network, and loads from `file://`. A board is loaded automatically, so it
gets its own viewer with three rules, each enforced in more than one place:

| Rule | Enforced by |
|---|---|
| **No scripts** | the frame is `sandbox=""` (no tokens); the response's CSP has `default-src 'none'` and a `sandbox` directive |
| **No network, nothing outside the board's folder** | boards are served by a dedicated `aios-board:` protocol, never `file://`. The handler serves only regular files whose real path is inside that board's folder, GET only, from an extension allowlist. The CSP allows images, styles and fonts from that board's own origin and nothing else, so `http(s):`, `file:` and other boards are refused before any request is made |
| **Navigation stopped** | the sandbox has no `allow-top-navigation`, `allow-popups` or `allow-forms`; the main process refuses every navigation of a board frame other than reloading its own `index.html` |

Each board is its own origin (`aios-board://<id>/`, where the id is derived from the folder name), so
one board cannot pull another board's files either.

## Tests

- `src/test/boards.test.ts`: the pure rules (listing, `board.json`, staleness, path confinement, the
  CSP string, the navigation decision).
- `src/test/boardIsolation.e2e.test.ts`: a hostile board loaded in real Chromium, with the same
  protocol handler and navigation guard the App installs. It tries the network, a file outside its
  folder, another board, a script and a navigation, and must reach none of them, while its own
  stylesheet and image must load (the positive control). The same page with the protections removed
  must reach the network, so the test is known to be able to fail.
