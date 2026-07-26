# Contributing

**Read the organisation guide first:
[The-AIOS/.github → CONTRIBUTING.md](https://github.com/The-AIOS/.github/blob/main/CONTRIBUTING.md).**
It carries the rules that apply everywhere here — the `custom/` rule, commit format, CHANGELOG
expectations, GPL-2.0-or-later inbound terms, and the no-personal-content discipline. This file
adds only what is specific to this repo.

**And check you're in the right one.** This is the Electron shell: window, panel, terminals,
explorer, viewers, setup. If your change is to an agent, skill, command or template, it belongs in
[The-AIOS/aios](https://github.com/The-AIOS/aios).

## Getting it running

```bash
npm install
npm run rebuild      # node-pty against this Electron version — once, and after upgrades
npm start
```

`npm run rebuild` is not optional. `node-pty` is a native module, and a mismatched ABI fails at
terminal-spawn time rather than at install time — a confusing place to learn it.

## The gates, and why each exists

```bash
npm test              # unit — pure core + source invariants, against a fixture vault
npm run smoke         # boots the app: window · pty · state · workbench · panel · theme · setup
npm run check:tokens  # every pty submit goes through one chokepoint
npm run dist          # build, then verify the PACKAGED artifact
```

Run all four. They are not redundant, and the reason is worth internalising:

- **`npm test` reads source.** It cannot see a runtime error. A `const` used before its
  declaration, or a stray `async` before a comment, parses fine and throws at module load — the
  suite stays green while the app is dead.
- **`npm run smoke` boots the real renderer.** It is the only gate that catches the above, and it
  opens the Setup tab and counts what a person could actually click.
- **`npm run dist` verifies the artifact, not the source.** Everything else runs against
  `node_modules/electron`, whose bundle and `Info.plist` are upstream's — so a packaging mistake
  is invisible to them by construction. This has shipped a build that was dead on arrival while
  every other gate passed.

The through-line: **a check that reads the wrong thing is worse than no check**, because it reports
confidence about something it never examined. If you add a gate, make it fail on a build you know
is broken before you trust it on one you think is fine.

## House style

- **Comments explain WHY, especially the non-obvious.** If a line exists because of a platform
  quirk or a bug that cost someone an afternoon, say so. This codebase is written to be read by
  whoever inherits it, including its own authors six months on.
- **Verify against reality, not against the docs.** Measure the thing; don't reason about what it
  probably does. Several of the sharpest fixes here came from checking a working reference
  implementation instead of designing forward.
- **One chokepoint per concern.** Terminal spawns go through `pty:spawn`; readiness gating goes
  through `createPane`. Fixing something per-caller leaves the next caller to rediscover the bug.
- **Describe the role, never the person** — "the operator", not a name. That applies to code,
  comments, tests, fixtures and commit messages alike.

## Pull requests

Small and focused beats large and complete. Say what broke, how you reproduced it, and how you
verified the fix — a PR that demonstrates the failing state before the fix is worth several that
assert success.

## Licensing

GPL-2.0-or-later, matching the framework and the Glass extension — see
[LICENSE-AUDIT.md](./LICENSE-AUDIT.md) for what that covers and what keeps its upstream license.
By contributing you agree your work ships under those terms.
