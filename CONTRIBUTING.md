# Contributing

**Read the framework's guide first:
[The-AIOS/aios → CONTRIBUTING.md](https://github.com/The-AIOS/aios/blob/main/CONTRIBUTING.md).**
It is the single source for the rules that apply everywhere: the `custom/` rule, what every AIOS
session must keep, commit format, CHANGELOG expectations, licensing and the no-personal-content
discipline. This file adds only what is specific to the App.

## Before you build

- **Look for it first.** Search open and recently closed
  [issues](https://github.com/search?q=org%3AThe-AIOS+is%3Aissue&type=issues) and
  [pull requests](https://github.com/search?q=org%3AThe-AIOS+is%3Apr&type=pullrequests) across
  the organisation, and check the
  [work in flight](https://github.com/search?q=org%3AThe-AIOS+is%3Aopen+label%3A%22status%3A+in-progress%22&type=issues):
  issues labelled `status: in-progress`, and open or draft PRs. The labels are the only status
  source. `duplicate-in-flight` on an issue means it is already being built elsewhere.
- **If something matches, comment there** instead of opening a new one. One line claiming an
  issue before you build can save you a whole PR.
- **Titles.** An issue title reads `Area: what changes`, in under about 70 characters. The area is
  the surface a reader recognises (`Chat view:`, `Setup:`, `Status line:`). After the colon, a
  feature says what is true when it's done; a bug says what goes wrong as the user sees it. No
  type prefixes like `[bug]` or `feat:`, since the `type:` label carries that. Conventional
  Commits stay in commit messages and PR titles.
- **No internal tracking keys or personal names** in commit messages, PR titles, PR bodies or
  issue comments. Refer to issues and PRs by number.

## Is this the right repo?

This is the Electron shell: the window, panel, terminals, explorer, viewers and setup, the main
process behind them, and how the App fulfils the spawn inbox. A change there belongs here, even
when it changes how a command behaves.

A change to an agent, skill, command, hook or template belongs in
[The-AIOS/aios](https://github.com/The-AIOS/aios). A change to the IDE extension belongs in
[The-AIOS/aios-glass](https://github.com/The-AIOS/aios-glass). The App and Glass implement the
same spawn-inbox protocol separately, so a fix to one usually needs a matching PR in the other:
say so in your PR and a maintainer will help line them up.

## Getting it running

```bash
npm install
npm run rebuild      # node-pty against this Electron version — once, and after upgrades
npm start
```

`npm run rebuild` is not optional. `node-pty` is a native module, and a mismatched ABI fails at
terminal-spawn time rather than at install time — a confusing place to learn it.

**If you used `npm ci` and the smoke run hangs forever with no output, this is why.** On macOS,
`npm ci` restores `node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper` at mode `644`, so
every pty spawn fails with `posix_spawnp failed`. That takes down three `busDelivery.e2e` tests
and leaves `npm run smoke` waiting on its pty probe — no error, no timeout, nothing to read. The
`npm run rebuild` above fixes it; so does `chmod +x` on that file if you want to know that was
the cause. Reported by a contributor who lost an evening to it, which is the only reason it is
written down here rather than rediscovered.

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

GPL-2.0-or-later, matching the framework and the Glass extension. See
[LICENSE-AUDIT.md](./LICENSE-AUDIT.md) for what that covers and what keeps its upstream license.
By contributing you agree your work ships under those terms.
