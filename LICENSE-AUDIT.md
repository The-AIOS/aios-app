# LICENSE-AUDIT — what governs what in this repo

> **What this is.** A single reference for *which license covers which part* of the AIOS App, and
> where the boundary sits between AIOS-authored code and third-party code. It complements — never
> replaces — [`LICENSE`](./LICENSE) (the GPL text) and `package.json`. **If this file and those
> disagree, `LICENSE` and the manifests win** — open an issue so this gets corrected.
>
> Sibling to [The-AIOS/aios → LICENSE-AUDIT.md](https://github.com/The-AIOS/aios/blob/main/LICENSE-AUDIT.md),
> which does the same job for the framework and holds the org-wide open-core picture.

---

## 1. This repo — GPL-2.0-or-later, uniformly

Every file authored here is **GPL-2.0-or-later**, matching the framework and the Glass extension.
Three sources must stay in sync:

- [`LICENSE`](./LICENSE) — the GNU GPL v2 text (byte-identical to `The-AIOS/aios` and `aios-glass`)
- `package.json` → `"license": "GPL-2.0-or-later"`
- the footer of [`README.md`](./README.md)

That covers `src/` (main · preload · core · tests), `renderer/`, `scripts/`, `build/`,
`.github/workflows/`, and every document at the repo root.

**Why GPL and not MIT:** the app is a *surface for the framework*, not a library meant to be
embedded in other products. It ships under the same terms as the thing it surfaces, so a fork of
the whole stack stays open. (The website, `The-AIOS/site`, is MIT — different job, different call.)

## 2. Shared code — `src/core/`

`src/core/` is intentionally pure TypeScript with no Electron imports, and some of it is shared
with the [Glass extension](https://github.com/The-AIOS/aios-glass) through `npm run sync-core`.
Both repos are GPL-2.0-or-later, so the sharing raises no licensing question in either direction.
The purity constraint is architectural, not legal: it keeps the logic unit-testable outside an
Electron process.

## 3. Third-party dependencies — installed, not vendored

**Nothing third-party is vendored into this tree.** Every dependency arrives via `npm install`
and keeps its own upstream license; none is redistributed in source form here. The `.dmg`
we publish *does* bundle their compiled output, which their licenses permit:

| Dependency | License | What it does |
|---|---|---|
| `electron` | MIT | the runtime |
| `node-pty` | MIT | real PTYs for terminal sessions |
| `@xterm/xterm` + `addon-fit` / `addon-webgl` / `addon-unicode11` | MIT | the terminal emulator |
| `marked` | MIT | markdown rendering in viewers |
| `electron-updater` | MIT | signature-verified auto-update |
| `electron-builder`, `@electron/rebuild` | MIT | build + native-module rebuild (dev only) |
| `typescript` | Apache-2.0 | build only; nothing ships |
| `@highlightjs/cdn-assets` | BSD-3-Clause | syntax highlighting in the source viewer |

GPL-2.0-or-later is compatible with all of these as a downstream combination. If you add a
dependency under a **copyleft-incompatible or ambiguous** license, flag it in the PR — that is a
decision, not a detail.

## 4. What this repo deliberately does NOT contain

The open-core line for AIOS is a **data** boundary, not a feature paywall — and this repo sits
entirely on the open side of it. It must never contain:

- **an operator's vault content** — declared or observed context, projects, calendar, exports.
  That is the operator's private core, never distributed. The app *reads* a vault at runtime; it
  ships none.
- **credentials of any kind** — no certificates, no `.p12`, no API keys, no app-specific
  passwords. Signing material lives in a keychain or in repository secrets, never in the tree
  (see [RELEASING.md](./RELEASING.md)).
- **personal identifiers** — no operator, teammate or family names in code, comments, tests,
  fixtures or commit messages. `Pulsar Labs (DY7C5S7Z56)` in `package.json` is the *signing
  identity*, which is public in the signature of every build anyone downloads.

## 5. The signed artifact

Releases are signed with a **Developer ID Application** certificate and notarized by Apple. That
signature is an *identity* statement, not a license one: it says who built the binary, while this
file says what terms the source carries. Both are true at once, and neither implies the other.
