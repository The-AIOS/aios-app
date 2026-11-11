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
- **Optional `board.json`** in the same folder: `{ "title": "…", "valid_for": 3600, "icon": "chart" }`. `title`
  replaces the folder name on the card; `valid_for` is in seconds (default 3600); `icon` (App 0.15.1) names the card's
  icon. Only a name from the App's own icon set is drawn; an unknown name, a wrong type or no key keeps the board glyph
  (`layout`), with no error line. It is a name, never a path or URL. The names (from `ICONS` in `renderer/app.js`):
  `aios`, `assistant`, `bolt`, `book`, `box`, `brain`, `building`, `calendar`, `chart`, `chat`, `check`, `chevD`, `chevL`, `chevR`, `cmdKey`, `coffee`, `coffeeOn`, `comfort`, `command`, `compact`, `compress`, `copy`, `design`, `docText`, `download`, `expand`, `explorer`, `file`, `folder`, `folderOpen`, `gear`, `guide`, `help`, `html`, `id`, `img`, `inbox`, `keyboard`, `layout`, `logout`, `md`, `megaphone`, `mic`, `moon`, `note`, `panel`, `plug`, `plus`, `robot`, `rocket`, `search`, `shield`, `skill`, `sliders`, `sparkles`, `spawn`, `speaker`, `stack`, `star`, `stop`, `sun`, `sync`, `term`, `trash`, `users`, `wrench`.
- **Staleness is the writer's problem, drawn like Health:** when `index.html` is older than
  `valid_for`, the card's title dims and a line reads "no update since …".
- **Re-render on change:** the card reloads its frame when `index.html`'s mtime changes, and only
  then.
- **The App never writes into `~/.aios/boards/`.** `/aios:update` never touches it.

## The first writer

`sidebar-boards-sample/index.html` is a real board with every line of text replaced: the output of a
script that renders an operator's consolidated state (decisions waiting on them, what shipped today,
another machine's queue, scheduled jobs) every two minutes. Static HTML with an inline stylesheet,
about 4 KB, no scripts, links or external resources.

## Isolation

The existing HTML viewer was built for the operator's own exported deliverables, so it lets scripts
run, does not block the network, and loads from `file://`. A board is loaded automatically, so it
gets its own viewer with three rules, each enforced in more than one place:

| Rule | Enforced by |
|---|---|
| **No scripts** | the frame is `sandbox=""` (no tokens); the response's CSP has `default-src 'none'` and a `sandbox` directive |
| **No network, nothing outside the board's folder** | boards are served by a dedicated `aios-board:` protocol, never `file://`. The handler serves only regular files whose real path is inside that board's folder, GET only, from an extension allowlist. The CSP allows images, styles and fonts from that board's own origin and nothing else, so `http(s):`, `file:` and other boards are refused before any request is made |
| **Navigation stopped** | the sandbox has no `allow-top-navigation`, `allow-popups` or `allow-forms`; the main process refuses every navigation of a board frame other than reloading its own `index.html`, and every navigation *into* a board other than the App's own page mounting a card (so a page in the HTML viewer cannot frame a board either) |

Each board is its own origin (`aios-board://<id>/`, where the id is derived from the folder name), so
one board cannot pull another board's files either.

## Tests

- `src/test/boards.test.ts`: the pure rules (listing, `board.json`, staleness, path confinement, the
  CSP string, the navigation decision).
- `src/test/boardIsolation.e2e.test.ts`: a hostile board loaded in real Chromium, with the same
  protocol handler and navigation guard the App installs. It tries the network (stylesheets,
  `@import`, CSS backgrounds, images, `srcset`, prefetch/preload/preconnect/dns-prefetch/modulepreload,
  scripts, `fetch`, frames, objects, media, SVG, a meta refresh and a `srcdoc` child that refreshes),
  a file outside its folder (`file://` and a symlink), another board, a click on a link with `ping`
  and on a form's button (clicked through DevTools' input domain), its parent pointing the frame at
  the network, and a scripted page framing the board. It must reach none of them, while its own
  stylesheet and image must load (the positive control). The same page opened the HTML viewer's way
  must reach the network, clicks included, so the test is known to be able to fail. It needs the Electron binary and
  a display, so the ubuntu unit job (installed with `--ignore-scripts`) skips it and says why;
  `AIOS_BOARD_E2E_STRICT=1` makes that skip a failure.
- The smoke's **boards** gate runs the same probe through the App's own wiring: the real card in the
  panel, main's protocol handler and main's navigation guard.
