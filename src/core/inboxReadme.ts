/**
 * The spawn-inbox README — written by whoever implements the dispatch.
 *
 * `~/.aios/spawn-inbox/` is machine-local runtime state, so nothing in the
 * framework tree can ship this doc. That constraint is the feature: the
 * component that fulfils the requests is the only thing documenting them, so
 * the doc cannot drift from the handler. Glass does this in `activate()`; the
 * App does it beside the same `mkdirSync`, so an operator with NO IDE and NO
 * Glass extension still finds the contract in the directory.
 *
 * Two writers, one file — hence `shouldWrite`. Both sides write only when the
 * content actually differs (Glass since 0.4.5; it does NOT rewrite blindly on
 * every activation), so neither churns the mtime. The App still defers to a
 * CURRENT Glass-stamped doc — the verbs are identical either way — and never
 * touches a file it doesn't recognise.
 *
 * INBOX_CONTRACT is a shared number: Glass emits the same
 * `aios-spawn-inbox: contract N` trailer, and a change to the verbs or fields
 * must bump BOTH sides in the same push, or staleness detection is meaningless.
 * Glass's deference test matches the literal phrase "written by AIOS Glass" in
 * our stamp, and ours matches theirs — treat both substrings as interop
 * contract, not prose, and tell the other side before changing what you match.
 */

import { INBOX_CONTRACT } from './sendQueue';

export { INBOX_CONTRACT };

const MARK = 'aios-spawn-inbox: contract';

/** Machine-readable trailer: lets a later version recognise its own doc. */
export function readmeStamp(contract: number = INBOX_CONTRACT): string {
  return `<!-- ${MARK} ${contract} · written by AIOS App -->`;
}

/**
 * Write policy, as a pure decision so it can be tested without touching disk.
 *
 * - absent                  → write (the case that matters: no Glass, no IDE)
 * - ANY stamp, older contract → write; it predates a verb/field change
 * - Glass, current or newer   → skip; the verbs are identical and Glass keeps it fresh
 * - ours, current             → skip unless the body changed (upgrades propagate, no churn)
 * - Glass with no contract    → skip (pre-0.4.5; clobbering starts a flicker — see below)
 * - anything else             → skip; never clobber a hand-edited or unknown doc
 */
export function shouldWrite(existing: string | undefined, ours: string): boolean {
  if (!existing || !existing.trim()) return true;

  // Identity and contract are matched INDEPENDENTLY: keying on the exact trailer
  // layout would break on a separator change in either codebase.
  const stamped = new RegExp(`${MARK}\\s+(\\d+)`, 'i').exec(existing);
  const byGlass = /written by aios glass/i.test(existing);
  const byApp = /written by aios app/i.test(existing);

  if (stamped) {
    const theirs = Number(stamped[1]);
    // Never DOWNGRADE: a doc declaring a higher contract than we implement is the
    // accurate one, whoever wrote it — stomping it replaces correct instructions with
    // stale ones. (Glass's shouldWriteDoc enforces the same rule from its side.)
    if (theirs > INBOX_CONTRACT) return false;
    // Older contract than ours means the doc predates a verb/field change, so it
    // is stale whoever wrote it — replace it rather than treat it as current.
    if (theirs < INBOX_CONTRACT) return true;
    if (byGlass) return false;                        // current Glass doc — defer
    if (byApp) return existing.trim() !== ours.trim(); // ours — rewrite only if the body moved
    return false;                                     // stamped by something else — leave it
  }

  // Glass before 0.4.5 stamped no contract. Deliberately defer rather than assume
  // stale: that Glass rewrites whenever content differs, so clobbering it would
  // start a launch-for-launch flicker between the two surfaces. Once both sides
  // emit the trailer, the check above does the real work.
  if (byGlass) return false;
  return false;   // hand-edited or unknown writer — never clobber
}

/**
 * The doc. Contract sections are fulfiller-agnostic on purpose — an agent may be
 * fulfilled by the App or by Glass, and must not learn a surface-specific dialect.
 * Mechanism is stated only where the two genuinely differ.
 */
export function buildInboxReadme(appVersion: string): string {
  return `# The AIOS spawn-inbox — the command bus

_Written by AIOS App v${appVersion} on startup. **Do not edit** — it is rewritten to match the handler actually running._

Drop a \`*.json\` file in this directory and a trusted AIOS surface fulfils it **natively** — the App opens a real session pane; Glass, if installed, uses \`vscode.createTerminal\`. Either way: no synthetic keystrokes, no permission gate. The file is **consumed (deleted)** on pickup.

Why this exists: Claude's auto-mode classifier gates agent-invoked \`spawn\`/\`spawn-kill\` (they read as "launch/kill an autonomous agent"), and an agent cannot author its own autonomy grant. So an agent *requests*, and a surface the human already trusts acts. **Request, don't spawn.**

## Three verbs

**spawn** (the default — no \`action\` key) — launch a named session:

    { "name": "designer", "task": "design the hero", "tier": "mechanical" }

- \`task\` — optional first prompt. \`"model": "<id>"\` **or** \`"tier": "mechanical" | "judgment"\` — optional, routes the worker by cognitive load.
- A name that is already live is *revealed*, never duplicated.
- No \`task\` still bootstraps **when the App fulfils the request** — it sends a first prompt, so the worker runs its Session Start Ritual on turn one instead of sitting idle. Glass boots the session and leaves it at the prompt (the ritual fires on the first turn, and there is no first turn). Pass a \`task\` when you need one rather than relying on a bootstrap the other surface doesn't perform.

**send** — deliver a prompt into a LIVE session:

    { "action": "send", "name": "designer", "prompt": "ship it" }

**kill** — close that session (shell + claude + respawn loop):

    { "action": "kill", "name": "designer" }

The filename is arbitrary (must end in \`.json\`) — use a distinct one so concurrent requests never collide.

## Addressing a surface (contract 2, optional)

Two fulfillers can be running — AIOS Glass in the IDE, and the AIOS App — and they race for
an unaddressed request. Add \`"surface"\` when it matters WHERE the work happens:

    { "action": "send", "name": "designer", "prompt": "ship it", "surface": "app" }

- \`"glass"\` or \`"app"\`. Only that surface fulfils it; the other leaves the file completely
  alone (the addressee may still be starting up).
- Omit it and either surface may take it — exactly the old behaviour, so nothing that worked
  before needs changing.
- A request addressed to a surface that never shows up is retired to \`.undelivered\` by
  whichever surface is around, after ~10 minutes. Fulfilment is targeted; retirement is
  shared, so nothing rots silently.

## What the files mean

A request is **claimed, not consumed** — renamed out of the \`*.json\` watch glob so exactly
one surface can win, and deleted only once delivery is VERIFIED:

    request.json               waiting for a fulfiller
    request.json.holding       claimed — carries _claim {surface,pid,at}
    request.json.undelivered   gave up — carries _undelivered {reason,at,surface}
    (absent)                   delivered and verified

So a held message survives a restart, two surfaces cannot both deliver it, and giving up
leaves something you can read instead of silence.

## Addressing — who is live, and what is their real name

The session registry is the **only** truth. One file per pid:

    ls ~/.claude/sessions/*.json    # each: { "name", "pid", "status", "sessionId", "cwd" }

Do **not** use \`pgrep\`, and do **not** trust a terminal tab title: a **resumed** session keeps whatever its tab was called, so matching by process or tab name silently fails and a live session looks dead. \`kill\` resolves the target's pid from the registry, which is what lets it reach resumed and externally-started sessions — not just ones this surface spawned.

## Replying to whoever requested you

A spawned worker messages its coordinator back the same way — \`send\` to the coordinator's registry name. The reply arrives in that session as a new prompt. This works for long-lived and resumed coordinators, so agents hold real multi-turn conversations.

## Gotchas (each one cost a real bug)

- Keep \`prompt\` on **one line** — multi-line text is delivered to a terminal as multiple Enters.
- A long or multi-line \`task\` is handed off via a temp file rather than typed, so quoting can't mangle it.
- **A \`prompt\` over 1024 bytes is delivered as a POINTER, not as text** — the fulfiller writes it to \`~/.aios/bus-payloads/\` and types one line naming that file. Measured, because it was assumed once and the assumption was wrong: a ~2.6KB send arrived **cut at byte 2043**, mid-sentence, with no error anywhere, and the lost tail carried a *"do NOT push"* instruction. There is no single ceiling to promise — the App's pty is 1024 in canonical mode and unbounded in raw, while Glass's limit lives inside the VS Code host — so 1024 selects the *mechanism* rather than promising what survives. **Nothing is ever truncated:** if the payload can't be written the send is refused, loudly. Payload files are owner-only and age out after 24 h.
- **If you RECEIVE a pointer**, the file it names IS the message — read it and follow what is inside; the line you were sent is not the instruction.
- A **busy** target is never delivered into: text sent mid-turn is dropped, not queued. So a \`send\` to a working session WAITS (you will see \`.holding\` on disk) and lands when it goes idle. If it stays busy ~10 minutes the request is marked \`.undelivered\` rather than forced through.
- The file disappearing now means delivery was **verified** in the target's transcript — but to check what a session actually DID with it, read that transcript: \`~/.claude/projects/*/<sessionId>.jsonl\` (\`sessionId\` comes from its registry file). When verifying, COUNT occurrences rather than checking presence: exactly one is the pass condition.
- Requests dropped while the App was closed are drained on its next start — the inbox is durable, not live-only.
- If **both** the App and Glass are running they watch the same directory and race per request; whichever picks it up first acts, so the session may open in either surface. Single-surface is the normal case.
- For \`send\` / \`kill\`, \`name\` must match a **live** registry name. Malformed or name-less requests are ignored (logged as \`[command-bus]\`).

## More

- The contract every session loads: \`CLAUDE.md\` → **Spawning Sessions**.
- Subagent vs workflow vs spawn, and which model to route: the **\`orchestration-ladder\`** skill.

${readmeStamp()}
`;
}
