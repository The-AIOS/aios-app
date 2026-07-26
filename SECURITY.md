# Security

**To report a vulnerability, follow the organisation policy:
[The-AIOS/.github → SECURITY.md](https://github.com/The-AIOS/.github/blob/main/SECURITY.md).**
It is the single reporting channel for every repo here, including this one — please don't open a
public issue. This file adds only what is specific to *this* app.

## What this app can do, so you can judge the risk

AIOS is deliberately not sandboxed, and that shapes its threat model. It:

- **spawns real processes** — the `claude` CLI in real PTYs, and setup scripts you press a button to run
- **reads and writes your vault** — the framework directory (`~/aios` by default) and any workspace folders you add
- **reads and writes Claude Code's own config** — `~/.claude/settings.json` and `~/.claude.json`, to show and change settings you already own
- **appends to shell startup files** — a PATH line in `~/.zprofile` / `~/.zshrc` during setup, when you ask it to
- **marks one directory as trusted for Claude Code** — the vault you asked it to set up, at the moment you press the button, so a first-run dialog cannot swallow the setup instruction

None of that is hidden: every command runs in a **visible terminal you can read**, and the app
never types into a session you cannot see. That is a design constraint rather than a convention —
a program that acts on your behalf should show its work.

It is also why this is not a Mac App Store app: App Sandbox forbids all of the above.
Distribution is a Developer-ID-signed, notarized `.dmg` from this repository's Releases, and
updates are verified through that same signature (see [RELEASING.md](./RELEASING.md)).

## Especially interesting to us

- anything that makes the app **run code it wasn't asked to** — a crafted filename reaching a
  shell, a vault file that executes on render, a path that escapes the allowed roots
- anything that lets an **update install unverified**, since the updater's trust rests entirely
  on the code signature
- anything that **writes outside the operator's own directories**

## Out of scope

The app doing what it says on the tin — running `claude`, reading your vault, opening terminals.
And vulnerabilities in Claude Code itself, which belong to Anthropic.
