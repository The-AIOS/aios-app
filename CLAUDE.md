# CLAUDE.md — AIOS App (repo: `aios-app`)

The one-for-all AIOS interface: a standalone Electron app for **operators who never open an editor** — the best of Obsidian (explorer + markdown), Antigravity (real terminals, chords, pickers), and Glass (the panel, Ask, tasks/routines).

> **Naming:** repo + npm package = `aios-app`; built product = **AIOS** (`AIOS.app` / `AIOS.dmg`, appId `com.the-aios.app`, window title "AIOS"). Brand: coral `#ff5d4d` · Inter · deep black. *Glass, not engine* is the architecture principle (real `claude` CLI + real vault, never reimplemented) — no longer the product name.

**Glass, not engine.** The engines are the `claude` CLI (running in real PTYs) and the AIOS vault. The shell owns only: the window, the service bridge, the viewers. Never reimplement what the AIOS or Claude Code already does.

## Architecture
- `src/main/` — Electron main: window + PTY host (node-pty) + (next) service bridge IPC
- `src/preload/` — the `glassShell` API exposed to renderers
- `renderer/` — the workbench page: panel (left) + terminal grid (right); explorer + viewers next
- **The pulse is native** (renderer/app.js renders PanelHost's feed — the iframe era ended 2026-06-11); `npm run sync-core` keeps the shared pure core flowing from `../aios-glass/src/core/`
- **Action cards** in the pulse (Start · Daily · Quick · Workspaces · About you · Reports) reach parity with the extension's Home; each click reuses a renderer flow that already exists (pickers, ritual-in-primary, ingest, reports)
- **Plugins** (`aios.ts` pluginCatalog/installedPlugins/knownMarketplaces → `openPluginsTab`): glass over `claude plugin`. Reads `~/.claude/plugins/{installed_plugins,known_marketplaces}.json`; installs/updates run the real CLI in a visible terminal. Catalog is the curated front shelf of the-aios.org/plugins (Partner Network: plugins + credentials); `status:'soon'` entries never offer a live install
- Viewers render; **Obsidian edits** (editing is a later, deliberate gate)

## Commands
- `npm start` — compile + launch
- `npm run smoke` — SIX gates: window · pty · state · workbench · pulse · theme (also run against the packaged app)
- `npm test` — unit suite over a fixture vault
- `npm run dist` — unsigned arm64 `.dmg`
- `npm run sync-core` — refresh the shared pure core from aios-glass
- `npm run rebuild` — rebuild node-pty after an Electron version bump

## Discipline
- Conventional Commits; no teammate names in narrative
- **No-leaks**: no personal paths/handles in code or docs beyond `~/aios` convention; repo goes public only after a no-leaks pass
- Tested like the extension: unit (pure logic) + smoke (boot gates) + e2e happy path
