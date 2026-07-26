# AIOS

**A desktop app for people who never open an editor.**

AIOS is the surface for [The AIOS](https://github.com/The-AIOS/aios) — a personal operating
system built on one idea: *the quality of context you give an AI determines what it can do for
you.* The framework is a vault that remembers who you are. This app is how you use it without
a terminal.

> **Glass, not engine.** The app runs the real `claude` CLI in real terminals against your real
> vault. It surfaces and triggers; it never reimplements. Every command it runs, you can read.

## Download

**[Latest release for Apple Silicon →](https://github.com/The-AIOS/aios-app/releases/latest/download/AIOS-arm64.dmg)**

Signed with a Developer ID, notarized by Apple, and stapled — so it opens on first launch with
no warning, no right-click, and no terminal. macOS 11+ on an M-series Mac. On Intel? Open an
issue; the build is one flag away.

## Setup is four steps

Open the app with nothing installed and it walks you through:

1. **Install what I need** — Homebrew, the toolchain, Obsidian, Claude Code
2. **Log in to Claude** — the AI that does the work here
3. **Log in to GitHub** — version control, because AI writes a lot and fast
4. **Set up my AIOS** — a Claude session takes over: your vault, the wiring, the tools you
   want, and the interview that teaches it who you are

It was seven steps. Every box removed is a decision someone no longer has to make with
information they do not have.

## What's inside

- **Home** — a greeting that knows your name, and the moves that matter today
- **The panel** — nudges, live sessions, your calendar, what Claude learned, recent outputs,
  and a framework-update pill for when the AIOS itself has moved on
- **Terminals** — real Claude sessions, named so they appear in Running and can be resumed;
  select-to-copy, ⌥-drag over TUIs, and the chords you already know
- **Explorer** — your vault plus any folders you add, with git markers; viewers for markdown
  (rendered ⇄ edit, live checkboxes), HTML, PDF, images and source
- **Four layouts** — Stacked · Facing · IDE · Zen, on ⌘1–4
- **Setup** — every check knows its own fix, and each fix runs where you can watch it
- **Plugins** — browse and install through Claude Code's own plugin system, never a copy of it
- **Auto-update** — checks quietly, installs on next quit, verified through the code signature

Keyboard: `⌘K` palette · `⌘P` open a file · `⌘J` ask · `⌘N` spawn a session · `⌘/` the full sheet.

## Develop

```bash
npm install
npm run rebuild      # node-pty against this Electron — once, and after upgrades
npm start
```

```bash
npm test             # unit — pure core + source invariants
npm run smoke        # boots the app; the only gate that catches a load-time error
npm run dist         # build + verify the PACKAGED artifact
```

Why three: `npm test` reads source and cannot see a runtime failure; `smoke` boots the real
renderer; `dist` checks the artifact you would actually ship, which every other gate runs past.
See [CONTRIBUTING.md](./CONTRIBUTING.md) for the reasoning and [RELEASING.md](./RELEASING.md)
for how signing and distribution work.

## Related

- **[The-AIOS/aios](https://github.com/The-AIOS/aios)** — the framework: agents, skills, rituals, the vault
- **[The-AIOS/aios-glass](https://github.com/The-AIOS/aios-glass)** — the same panel as a VS Code / Antigravity extension, for people who *do* open an editor

The app and the extension are peers, not tiers. App-only is a first-class way to run AIOS — no
IDE required, and it is the topology that was proven end to end first.

---

GPL-2.0-or-later © The AIOS contributors · [Security policy](./SECURITY.md)
