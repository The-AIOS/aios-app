# DESIGN.md — the Glass-Shell contract

The AIOS App speaks one visual language. Every pixel an agent or a human adds must speak it too.
This page is the contract; `renderer/theme.css` is the implementation.

## The grammar

- **Deep black.** The window is a void (`--bg: #0b0b0d`); content lives on *panes of glass* (`--surface`, `--surface-2`) that catch light on their top edge (`--edge`) and cast soft depth (`--depth`). Hairlines (`--line`, `--line-strong`) + edge-light instead of heavy borders.
- **ONE coral.** `--accent: #ff5d4d` means exactly two things: **action** (buttons, hover invitations, the caret) and **identity** (the brand mark, the active tab's icon). It is **never a status color** — not error, not warning, not "hot". If a thing is red because it *failed*, it is `--st-error`, not coral.
- **Inter** for the interface, `--mono` for paths/hashes/counts. Type whispers: small sizes, letter-spacing on labels, weight over size for emphasis.
- **Motion only as state.** Animation exists to say "something is happening" (a busy dot pulsing), never as decoration. Every animation ships a `@media (prefers-reduced-motion: reduce)` fallback.

## The token-only rule

All color and radius flow through `:root` tokens in `renderer/theme.css`. **No hardcoded hex in style rules anywhere else** — not in other CSS, not in inline `style=`, not in JS style assignments. Enforced by `npm run check:tokens` (`scripts/check-forbidden-tokens.mjs`).

Allowed exceptions (data, not style rules): the xterm ANSI palettes and file-type icon colors in `renderer/app.js` — those are semantic data handed to a canvas/library, and `theme.css` itself, which is where tokens are minted.

## The status vocabulary

Status is a **single-hue-per-state** system, minted once in `:root`:

| Token | Hue | Means |
|---|---|---|
| `--st-idle` | calm green | alive & ready |
| `--st-ok` | green | success / healthy |
| `--st-busy` | amber | working |
| `--st-input` | blue | waiting on the operator |
| `--st-warn` | soft gold | attention soon |
| `--st-error` | real red (`#e5484d`) | failure — deliberately **not** coral |

Consume them two ways:

1. **Direct** — `background: var(--st-busy);` in a rule (session dots, quota fill, git markers do this).
2. **Derived** — put `.status-chip` (tinted pill) or `.status-fill` (solid) on an element plus a `.st-*` modifier (or set the local `--sc` yourself). The class derives text/fill/border for **both light and dark** from `--sc` via `color-mix` against `--ink`/`--surface`, which flip with the theme — one declaration, two themes.

Never mint a new status hue in a component. If a state genuinely has no token, add the token to `:root` first.

## One component per job

Each visual job has exactly one component: tabs = `.tab`, rail buttons = `.ribtn`, panel buttons = `.pbtn`, cards = `.pcard`/`.hcard`, chips = `.chip`, status = `.status-chip`/`.status-fill`, modals = `.modal`. Before styling something new, find the component that already does that job and reuse it — a second slightly-different button family is a bug, not a variation.

## Checklist before you ship UI

1. New color? It's a `:root` token, or it doesn't exist.
2. Red-that-means-failed? `--st-error`. Coral? Only if clicking it does something or it's the brand.
3. Animation? Has a reduced-motion fallback.
4. Light theme? If you used `color-mix` against theme tokens, you already got it — verify, don't fork.
5. `npm run check:tokens` is green.
