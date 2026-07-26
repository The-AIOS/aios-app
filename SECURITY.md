# Security

## Reporting a vulnerability

Please **do not open a public issue** for a security problem. Use GitHub's private
reporting instead — [Report a vulnerability](https://github.com/The-AIOS/aios-app/security/advisories/new)
— which reaches the maintainers without disclosing the issue first.

Expect an acknowledgement within a few days, and a fix or a clear explanation of
why something is working as intended.

## What this app can do, so you can judge the risk

AIOS is deliberately not sandboxed, and that shapes its threat model. It:

- **spawns real processes** — the `claude` CLI in real PTYs, and setup scripts you press a button to run
- **reads and writes your vault** — the framework directory (`~/aios` by default) and any workspace folders you add
- **reads Claude Code's own config** — `~/.claude/settings.json` and `~/.claude.json`, to show and change settings you already own
- **writes shell startup files** — a PATH line in `~/.zprofile`/`~/.zshrc` during setup, when you ask it to

None of that is hidden: every command runs in a **visible terminal** you can read, and
the app never types into a session you cannot see. That is a design constraint, not a
convention — a surface that runs commands on your behalf must show its work.

It is also why the app is **not** on the Mac App Store: App Sandbox forbids all of the
above. Distribution is a Developer-ID-signed, notarized `.dmg` from this repository's
Releases, and the app verifies its own updates through that signature.

## Scope

In scope: anything that lets a third party run code, read files, or reach credentials
through the app — a malicious vault file that executes on render, a command-injection
path through a filename, an update that installs unverified.

Out of scope: the app doing what it says on the tin (running `claude`, reading your
vault), and vulnerabilities in Claude Code itself — report those to Anthropic.
