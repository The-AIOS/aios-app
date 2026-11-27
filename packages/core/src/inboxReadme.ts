/**
 * The spawn-inbox README: ONE text, whichever surface writes it.
 *
 * `~/.aios/spawn-inbox/` is machine-local runtime state, so nothing in the framework tree can
 * ship this doc. That constraint is the feature: the component that fulfils the requests is the
 * only thing documenting them, so the doc cannot drift from the handler. And CLAUDE.md names
 * this file the protocol's authority, so an agent believes what it says.
 *
 * It used to be two texts, one in each surface, and the rule for who writes left Glass's on
 * disk whenever both were installed. Glass's said nothing of `expect`, `cwd`, `addDirs` or
 * `group`, which the App implements, so an agent following the authority concluded those fields
 * did not exist. Now the body is built here and is the same for both; only the line naming the
 * writer and the trailer differ.
 *
 * WHO WRITES (`shouldWrite`). The trailer carries the contract number and a TEXT REVISION:
 *   · no doc, or an older contract, or an older text revision → write;
 *   · a newer contract or a newer text revision               → leave it: theirs is ahead;
 *   · same contract and same revision                          → leave it, unless it is OURS and
 *     the body moved (a version bump of this surface propagates; two surfaces never trade it);
 *   · a doc from a surface that predates the text revision (a Glass or an App that still carries
 *     its own text) at the same contract → a Glass doc is left alone, as it always was: that
 *     Glass rewrites whenever the text differs from its own, so replacing it would flip the
 *     file on every launch of either. The one text wins on a machine once both surfaces run it;
 *   · anything unrecognised or hand-edited → never clobbered.
 *
 * The literal phrases "written by AIOS Glass" and "written by AIOS App" and the prefix
 * `aios-spawn-inbox: contract N` are read by other versions and by the framework's tests: they
 * are interop, not prose.
 */

import { INBOX_CONTRACT } from './sendQueue';

export { INBOX_CONTRACT };

const MARK = 'aios-spawn-inbox: contract';

/** Bumped whenever the body below changes. A test pins the body to it, so the two cannot part. */
export const README_TEXT_REVISION = 4;

export interface ReadmeWriter {
  surface: 'app' | 'glass';
  /** The surface's own version, e.g. the App's 0.18.0. */
  version: string;
}

const WRITER_NAME = { app: 'AIOS App', glass: 'AIOS Glass' } as const;

/** Machine-readable trailer: the contract, the text revision, and who wrote it. */
export function readmeStamp(w: ReadmeWriter, contract: number = INBOX_CONTRACT): string {
  return `<!-- ${MARK} ${contract} · text ${README_TEXT_REVISION} · written by ${WRITER_NAME[w.surface]} v${w.version} -->`;
}

/** The doc without the two parts that name its writer: what two surfaces must agree on. */
export function readmeBody(doc: string): string {
  /* Only the writer's NAME and VERSION are taken out, in the two places they appear. The rest of
     those two lines is text like any other, and is pinned with it. */
  return doc
    .replace(/^_Written by AIOS (App|Glass) v\S+ /m, '_Written by <writer> ')
    .replace(/· written by AIOS (App|Glass) v\S+ -->\s*$/, '· written by <writer> -->')
    .trim();
}

/**
 * Should this surface write `ours` over `existing`? See the header for the rule and why.
 */
export function shouldWrite(existing: string | undefined, ours: string, w: ReadmeWriter): boolean {
  if (!existing || !existing.trim()) return true;

  /* Everything is read from the TRAILER, the last line that carries the mark: the body quotes the
     mark and the writers' names too, and a revision or a writer read from the body would decide
     on the wrong document. Contract, revision and writer are still matched independently of each
     other, so a separator change in any writer does not break the others. */
  const markRe = new RegExp(`${MARK}\\s+(\\d+)`, 'i');
  const trailer = existing.split('\n').reverse().find((l) => markRe.test(l));
  if (!trailer) return false;   // a Glass from before stamps, or hand-edited: never clobber
  const stamped = markRe.exec(trailer) as RegExpExecArray;
  const rev = /·\s*text\s+(\d+)/i.exec(trailer);
  const byGlass = /written by aios glass/i.test(trailer);
  const byApp = /written by aios app/i.test(trailer);
  const byMe = w.surface === 'app' ? byApp : byGlass;
  if (!byApp && !byGlass) return false;   // stamped by something else: not ours to touch

  const theirs = Number(stamped[1]);
  // Never DOWNGRADE: a doc declaring a higher contract than we implement is the accurate one.
  if (theirs > INBOX_CONTRACT) return false;
  // An older contract predates a verb or a field, so it is stale whoever wrote it.
  if (theirs < INBOX_CONTRACT) return true;

  if (!rev) {
    /* Same contract, written by a surface that still carries its own text. Our own older
       version: replace it. A Glass that has not adopted the shared text rewrites whenever the
       file differs from ITS text, so writing over it would flip the file on every launch of
       either surface: leave it, as before. Anything else: not ours to touch. */
    return byMe;
  }
  const theirRev = Number(rev[1]);
  if (theirRev > README_TEXT_REVISION) return false;   // a newer text: theirs is ahead
  if (theirRev < README_TEXT_REVISION) return true;    // an older text
  // Same text revision. Only our own doc is refreshed, and only when it actually moved.
  return byMe && existing.trim() !== ours.trim();
}

/**
 * The doc. Contract sections are fulfiller-agnostic on purpose — an agent may be
 * fulfilled by the App or by Glass, and must not learn a surface-specific dialect.
 * Mechanism is stated only where the two genuinely differ.
 */
export function buildInboxReadme(w: ReadmeWriter): string {
  return `# The AIOS spawn-inbox — the command bus

_Written by ${WRITER_NAME[w.surface]} v${w.version} when it started. **Do not edit** — it is rewritten to match the handler actually running._

Drop a \`*.json\` file in this directory and a trusted AIOS surface fulfils it **natively** — the App opens a real session pane; Glass, if installed, uses \`vscode.createTerminal\`. Either way: no synthetic keystrokes, no permission gate. The file is **claimed** on pickup (renamed out of the way, so two surfaces never pick it up at once) and deleted once the work is done; see *What the files mean* below.

Why this exists: Claude's auto-mode classifier gates agent-invoked \`spawn\`/\`spawn-kill\` (they read as "launch/kill an autonomous agent"), and an agent cannot author its own autonomy grant. So an agent *requests*, and a surface the human already trusts acts. **Request, don't spawn.**

## Four verbs

**spawn** (the default — no \`action\` key) — launch a named session:

    { "name": "designer", "task": "design the hero", "tier": "fast" }

- \`task\` — optional first prompt. \`"model": "<id>"\` **or** \`"tier": "<rung>"\` — optional, routes the worker by cognitive load.
- **The rung names are not listed here on purpose.** This file used to name a closed set of two, went stale when the ladder grew, and then contradicted the handler beside it — while \`CLAUDE.md\` points sessions at this file as the protocol's authority. So an agent reading the authority would have concluded the current rungs were invalid. Ask the one table instead: **\`~/aios/hooks/pipeline/resolve-tier --list\`** prints every rung and what it resolves to, and \`MODEL-ROUTING.md\` says what each is *for*. An unknown rung is refused with a dead letter that lists the valid ones, so a guess is safe — it fails loudly rather than falling back.
- \`cwd\` — optional, **App only**, and only ever the AIOS folder: a bus session always starts there, so it loads the AIOS's own \`CLAUDE.md\`, context floor and limits. Any other folder is dead-lettered naming it. Leave it out (that is the AIOS folder); to work in a repo, list the repo in \`addDirs\`. **Glass dead-letters a request carrying \`cwd\`** unless the App is running, in which case Glass hands it to the App; a sender can pin \`"surface": "app"\`.
- \`addDirs\` — optional, **App only**: more directories the session may work in, each passed to \`claude\` as its own \`--add-dir\`, e.g. \`"addDirs": ["/Users/<you>/dev/repo"]\`. Use it to start in the framework root and still reach a repo, so the worker is not stopped asking for permission to read it. Every entry must be absolute, an existing directory, inside your home once symlinks are resolved, and none of: your home folder itself, a hidden folder (a name starting with a dot), \`~/Library\` or AppData, the AIOS folder, a folder inside it or one containing it. At most 16. Because these paths are typed into the session's shell, a control character is refused everywhere, and on Windows (PowerShell) so is an apostrophe. One bad entry dead-letters the whole request naming it (\`addDirs[1] '…'\`). The session never opens with the others only. Absent or \`[]\` = none, as before. Glass does not honour it, so send \`"surface": "app"\` with it.
- \`group\` — optional, **App only**: the name of a tab group to open the new session in, e.g. \`"group": "Release"\`. The App puts the session's tab in the group with that name (matched without regard to case), and creates the group, with the next free colour, when none has that name. At most 40 characters; control characters become spaces. A value that is not a non-empty string is ignored and logged, never refused: a worker outside its group is still the right worker. An optional \`color\` beside it (one of grey, blue, indigo, purple, pink, coral, orange, yellow, lime, green, cyan, brown; \`red\` reads as coral) is the colour the group gets when this request creates it; it never recolours an existing group, and an unknown value falls back to the next free colour (App 0.17). It also applies to a \`resume\` that reopens a closed session; a session that is already running keeps its tab where it is. Glass has no tab groups, so when the App is running Glass hands a request carrying \`group\` to the App, and otherwise starts the session without a group and logs it. Needs AIOS App 0.15.0 / Glass 0.5.16.
- A name that is already live is *revealed*, never duplicated.
- No \`task\` still bootstraps **when the App fulfils the request** — it sends a first prompt, so the worker runs its Session Start Ritual on turn one instead of sitting idle. Glass boots the session and leaves it at the prompt (the ritual fires on the first turn, and there is no first turn). Pass a \`task\` when you need one rather than relying on a bootstrap the other surface doesn't perform.

**send** — deliver a prompt into a LIVE session:

    { "action": "send", "name": "designer", "prompt": "ship it" }

**kill** — close that session (shell + claude + respawn loop):

    { "action": "kill", "name": "designer" }

- **What a kill closes.** The session is resolved to its pid in the registry. When that pid's **process group** is nothing but the session (\`claude\` leads it; or the \`spawn\` wrapper's launcher does, with only the session inside), the App sends SIGTERM to the group, and SIGKILL if the session is still running five seconds later. That takes the session with its MCP servers and helpers, and the launcher's respawn loop when the launcher leads the group. In every other case (the session shares its group with an editor, an app, a script or a terminal's own shell; another session is in it; Windows) the pid gets one SIGTERM, as before. A session started by the wrapper inside an interactive shell keeps that shell's loop: the loop may start it again.
- **Commands a session ran through its Bash tool are not in that group**: each runs in a group of its own, and a kill sends them nothing. Claude Code may still end them when it exits. **To be sure something outlives its session, start it in a session of its own.** \`nohup cmd &\` does not do that. These do (measured from a non-interactive \`zsh\`, which is what the Bash tool runs):

      perl -MPOSIX -e 'setsid() or die; exec @ARGV' your-command &
      setsid your-command &          # Linux only: macOS has no setsid command

- **Conditional kill** (\`expect\`, AIOS App): say what you saw when you decided the session was done, and the App checks it immediately before killing. That reduces the risk of killing a session someone just wrote to; it does not remove it. If the session changed since, it is **left running** and the request is archived with the reason in \`_archive/<name>-<time>.refused.json\` (\`_refused.reason\`, kept a week). That is the guard working, so it is not a dead letter. A malformed \`expect\`, or a request rewritten after it was claimed, is still dead-lettered (\`kill refused …\`). Keys, each optional but at least one:
  - \`sessionId\` — the registry's.
  - \`status\` — normally \`idle\`.
  - \`idleSince\` — the timestamp of the last user/assistant record you saw, copied as the transcript has it: full date and time with \`Z\` or an offset, at most milliseconds.

  The App also refuses when it cannot verify:
  - an unknown key or an unusable value;
  - a request it cannot re-read;
  - with \`idleSince\`, a transcript that is unreadable, has a line that is not JSON, ends mid-line, has a turn without a valid timestamp, or has no turn at all.

  **Check support first.** Glass and older Apps ignore \`expect\` and kill unconditionally. The App lists \`"kill-expect"\` under \`capabilities\` in \`~/.aios/surfaces/app.json\`, valid only while that file's \`pid\` is running. Send a conditional kill only when you see it, and address it with \`"surface": "app"\` so no other surface takes it.

      { "action": "kill", "name": "designer", "surface": "app", "expect": { "sessionId": "<uuid>", "status": "idle", "idleSince": "2026-01-01T09:00:00.000Z" } }

**Contract 4 — optional fields** (verbs unchanged; a contract-3 request behaves exactly as before):

- \`from\` (send, resume) — the registry name of the session that wrote the request. A claim, never an identity: it is recorded with the delivery so the receiver can see who sent it, and an unusable value is ignored.
- \`effort\` (spawn, resume) — \`low\` · \`medium\` · \`high\` · \`xhigh\` · \`max\` → \`claude --effort <value>\`. Any other value is dead-lettered naming the field.
- \`advisor\` (spawn, resume) — a rung (\`frontier\` Fable 5.1 · \`judgment\` Opus 5.5 · \`scale\` Sonnet 5.5 · \`fast\` Haiku 5.5) or a model id. Passed as a settings file; the advisor must be at least as capable as the worker's model or Claude silently does not use it.

      { "name": "researcher", "task": "…", "tier": "scale", "effort": "high", "advisor": "judgment" }
      { "action": "send", "name": "researcher", "from": "buddai", "prompt": "…" }

**resume** (contract 3) — reopen a session you already had, as the SAME someone:

    { "action": "resume", "name": "designer", "prompt": "pick up the hero work" }

- \`spawn\` gives you a fresh **something**; \`resume\` gives you back the same **someone** — its
  memory of the work, the corrections it absorbed, the shape of the thing you were building.
  Reach for it whenever a closed session has context worth more than a clean start.
- The name is resolved from the transcripts on disk (\`~/.claude/projects/*/*.jsonl\`), not the
  live session registry — the registry only holds RUNNING sessions, and a closed one is the only
  kind this verb is for. A session that renamed itself resolves by its **latest** name.
- **Already running?** It is revealed and your \`prompt\` is delivered into it, exactly as
  \`send\` would. Resuming a live session would give one identity two processes.
- **Any age.** A name is found however old its session is: an index of every transcript, not a
  count of the newest ones. If a session was renamed, its latest name is the one that counts.
  An OLD name is refused with a dead letter that names the current one; it is never reopened
  under the old name (its terminal and tab would disagree, and messages to either would be lost).
- **Nothing to resume?** A dead letter naming the session — never a silent spawn.
  Add \`"fallback": "spawn"\` to opt into starting a fresh one instead:

      { "action": "resume", "name": "designer", "prompt": "…", "fallback": "spawn" }

  The fresh session opens with your \`prompt\` as its first message, exactly as a spawn's \`task\`.
- \`cwd\` (App only) follows the same rule as on spawn: only the AIOS folder. A session that ran in
  another folder (one an older App started there) is best reopened from that folder by hand:
  \`cd <folder> && claude --resume <id>\`. \`addDirs\` works here too, for the reopened session.
- \`addDirs\` (App only) works here too, with the same rules as on spawn, and applies to the
  fallback spawn. A session that is already running cannot gain directories: it is revealed and
  your prompt delivered, without them.
- No \`--name\` and no \`--model\` are passed: a resumed session keeps the identity and the model
  it already had.

**open** (contract 5) — show a file in this surface's viewer, beside the sessions:

    { "action": "open", "name": "<your session>", "path": "/absolute/path/inside/the/framework/note.md", "line": 12 }

- \`name\` is **who asks** (your own session), not a target. \`line\` is optional.
- Only a file inside the **framework folder** (the vault included) is opened, decided on the path with
  every link resolved; never a secret by its name (environment files, keys, tokens, anything under
  \`.git\`, \`.obsidian\` or \`agent-secrets\`), a binary, an executable, a file with a second hard link, or a
  PDF (no surface can keep one inert today).
  A request older than a minute is dropped, and a session gets five a minute. Over twenty a minute from all
  sessions together, the extras are dropped with no dead letter each; one
  \`open-flood-<time>-<pid>.json.undelivered\` gives the count and the last request's \`name\` and \`path\`.
- The file opens as a **read-only copy**; the operator can open it to edit. It never runs, is never handed
  to another application, and the surface never takes the screen from someone typing.
- A refusal is a dead letter that names the check. The full rule is the framework's
  \`skills/aios/orchestration-ladder/inbox-contract-5.md\`.
- Inside a surface (\`$AIOS_GLASS_TERM\` is set), show a file this way instead of \`open\` / \`xdg-open\` / \`start\`.

### An absent action is spawn; an unrecognised one is refused

Omit \`action\` entirely and you get a spawn — contract-1 \`{ name, task }\` requests still work
untouched. But an action that is *written* and not one of the four above is **dead-lettered
naming what you wrote**, never quietly run as a spawn. Contract 2 did degrade it; since
\`resume\` arrived the two outcomes differ, so a typo'd \`"resmue"\` would have handed back a
brand-new session in place of the one you asked to reopen.

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
    request.json.claiming-…    being claimed — a surface took it and is stamping it (an instant; left behind only by a crash, and then put back). Do not rename or edit it by hand: it is put back by itself.
    request.json.holding       claimed — carries _claim {surface,pid,at}
    request.json.undelivered   gave up — carries _undelivered {reason,at,surface}
    (absent)                   delivered and verified

So a held message survives a restart, two surfaces cannot both deliver it, and giving up
leaves something you can read instead of silence.

**How a request is owned.** On pickup a surface *claims* the file: it renames it, stamps \`_claim\` (\`surface\`, \`pid\`, \`at\`) inside it, and it becomes \`<name>.json.holding\`. The rename is atomic, so exactly one claimant wins and the loser backs off — no locks, no shared state. A claim is only adopted by another process when its holder is **dead** or the hold has gone **stale**, so a live wait is never stolen and a message is never delivered twice. If the claimant finds the session live but its terminal in another window, it **hands the request back** (bounded, \`_releases\`) instead of condemning a message a sibling window could deliver.

## Protocol invariants — every fulfiller must agree (contract 2)

These are **contract, not tuning.** They decide *cross-process* behaviour, so a fulfiller that picks its own values reintroduces the bugs the contract removes — measured: one surface holding at 45 min against another at 15 opened a 30-minute window where each side's ownership belief was correct and **both delivered the same message**.

**Timings** — change only in lockstep across every fulfiller, and update this file:

    QUEUE_CEILING_MS 24 h   how long a send waits for a LIVE busy target to reach its next idle
    HOLD_STALE_MS  24 h 45m a .holding older than this may be adopted even if its claimer lives (> QUEUE_CEILING_MS + MAX_HOLD_MS)
    MAX_HOLD_MS    30 min   after the FIRST type: how long to watch for it to verify
    RETIRE_TTL_MS  10 min   when any surface may retire a request addressed to an absent one
    MAX_RELEASES   2        sibling-window handoffs before declaring it undeliverable
    MAX_DELIVERY_ATTEMPTS 3 times the SAME text may be typed — 1 for a slash command (below)

**A slash command is typed ONCE, never re-typed.** Retry only pays when a verification miss is EVIDENCE of a failed send, and for a command the CLI handles client-side it is not: measured 2026-08-14, \`/help\` was delivered (the operator watched the menu appear) while the transcript recorded **zero** user turns containing the marker, so verification failed for a delivery that had plainly succeeded and the command was typed **three times**. The class is not uniform — \`/config\` *does* write a \`<command-name>\` record, \`/help\` does not, and nothing outside the CLI can tell which — so the rule is per-shape: any prompt matching \`/^\\s*\\/[^\\s\\/]/\` gets one attempt and is then WAITED on for the full hold budget. Waiting still catches a command that verifies late; re-typing catches neither and shows the operator a duplicate. Consequence accepted deliberately: a plain-text prompt that begins with \`/\` (a file path) also gets one attempt, so if it were dropped it dead-letters loudly instead of retrying — the safe direction.

**A busy session is waited on, in order.** A \`send\` is never typed into a busy session; it waits for the next idle, however long (up to 24 h), and is typed with its age — \`[queued 47 min ago by <from>]\` — when it waited over 2 min (never on a slash command). Several sends to one session go oldest first, and a newer send from the same \`from\` replaces an older one still waiting. The replaced one is not deleted: it is moved to \`_archive/<name>.json.superseded\`, naming what replaced it (kept 7 days).

**Spawn where you already live.** An unaddressed request goes to whichever surface wins the race, so \`spawn\` could open your worker in the *other* product — measured 2026-08-14: a request written from an IDE session was fulfilled by the App, and the session appeared in a pane instead of the IDE terminal the requester meant. For \`send\`/\`kill\` a mis-race self-corrects (the wrong surface hands it back), but a spawned session lands where it lands.

You cannot be identified by process name — Glass runs inside whatever IDE you use — so each surface announces its pid at \`~/.aios/surfaces/<surface>.json\`. Walk your own ancestry, compare pids, and set \`surface\` to what you find:

    python3 - <<'PY'
    import json, os, glob, subprocess
    def alive(pid):
        # On Windows a signal-0 "probe" is not a probe: it terminates the process. Never send it there.
        if os.name == "nt":
            out = subprocess.run(["tasklist", "/FI", f"PID eq {pid}", "/NH"], capture_output=True, text=True).stdout
            return str(pid) in out.split()
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return False
        except PermissionError:
            pass                          # it exists and is not ours to signal: alive
        return True
    def parent(pid):
        r = subprocess.run(["ps","-o","ppid=","-p",str(pid)], capture_output=True, text=True)
        return int(r.stdout) if r.stdout.strip() else 0
    live = {}
    for f in glob.glob(os.path.expanduser("~/.aios/surfaces/*.json")):
        try:
            d = json.load(open(f))
            if alive(d["pid"]):           # announced but dead => not running
                live[d["pid"]] = d["surface"]
        except Exception:
            pass
    p = os.getpid()
    while p and p != 1:
        if p in live:
            print(live[p]); break
        p = parent(p)
    PY

No match is a legitimate answer, not an error: a session started by the \`spawn\` wrapper in a plain terminal belongs to neither surface. Omit \`surface\` in that case and let them race, which is the old behaviour and still correct.

**Deliverability is an allowlist.** Deliver only on a status measured to accept one — currently \`idle\` and \`shell\` (a session running a Bash command *does* accept a prompt and answers after) — and **hold on anything else, including statuses nobody has characterised yet**. "Not busy" is not the same as "deliverable": the failure is asymmetric, since a wrong *deliverable* guess costs a real message while a wrong *hold* guess costs only latency. Unknown statuses are logged by name so they can be measured and promoted here rather than guessed at forever.

**Verification is a BASELINE COUNT, never a substring check.** Count the target's transcript records that are *user turns* containing your marker, **before** delivering; delivery is verified only when that count **increases**. Two measured reasons: one delivery can produce several substring hits (assistants quote the marker back — 5 hits for 1 delivery), and on a sibling handoff or an adopted hold the marker is *already* present from the earlier attempt, so a presence check "verifies" a delivery it never observed. If the count rises by **more than one**, say so loudly — a double delivery is the worst outcome here, because it produces wrong output rather than missing output. **Count only records at or after your CLAIM.** An unbounded count is unsound whenever the marker is not unique to your delivery, and for a slash command it never is: \`safeNeedle('/config')\` is \`'/config'\`, because the command is shorter than the 24-character run the matcher looks for. Measured across twelve transcripts, 7 of 10 slash-command sends had a marker also present in other user records — invocations forty minutes and five hours apart. Both surfaces also fail *soft* on a transcript read error (baseline 0), so history could read as a fresh arrival: the bus would conclude its send landed, delete the request, and tell nobody. Bounding to the claim shrinks the window from the whole transcript to your own hold. Records without a parseable timestamp are NOT counted — the same asymmetry as the allowlist, since counting one risks a silent loss while skipping it risks only a retry.

**Length: above 1024 bytes a \`prompt\` is delivered as a POINTER, never as text.** Measured, because this was assumed once and the assumption was wrong: a ~2.6KB send arrived **cut at byte 2043**, mid-sentence, with no error anywhere — and the dropped tail carried a *"do NOT push"* instruction. The ceiling is not one number: the App's pty is **1024** in canonical mode (MAX_CANON) and **unbounded** in raw mode (intact at 200 KB), while Glass's \`sendText\` limit lives inside the VS Code extension host and is not measurable from the other surface at all. So the contract does **not** promise a maximum length — a number here would be one dependency upgrade from being wrong while still looking right. Instead: over the threshold, the fulfiller writes the prompt to \`~/.aios/bus-payloads/\` and types a one-line pointer that names the file, says the file *is* the message, and says not to act on the pointer alone. **1024 is the threshold because it is the one ceiling actually measured and reproduced** — it selects the mechanism, it is not a promise about what survives.

**A fulfiller never delivers a partial prompt.** Hold, or fail loudly with a reason — never truncate and report success. A shortened instruction is worse than an undelivered one, because it *looks* delivered: the incident above was caught only because the cut happened to land mid-phrase. If the payload file cannot be written, the send is refused and said out loud.

**Payload files age out** after 24 h, and are written owner-only — they hold arbitrary prompt text.

**Failure writes its reason into the file**, not only to a log: an abandoned request carries \`_undelivered\` (\`reason\`, \`at\`, \`surface\`) alongside its \`_claim\`, so reading the directory tells the whole story.

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
- A **busy** target is never delivered into: text sent mid-turn is dropped, not queued. So a \`send\` to a working session WAITS (you will see \`.holding\` on disk) and lands at its **next idle, however long that takes** (up to 24 h; it dead-letters at once only if the session is gone). A message that waited is typed with its age: \`[queued 47 min ago by <from>]\`.
- **In order, latest wins.** Several \`send\`s to one session are delivered oldest first. A newer \`send\` from the **same \`from\`** replaces an older one still waiting, so a coordinator re-briefing a busy worker gets the latest brief read, not every draft. Without \`from\`, nothing is superseded. The replaced message is not deleted: it moves to \`_archive/<name>.json.superseded\`, naming what replaced it (kept 7 days) — a vanished file means *picked up*, never *dropped*.
- The file disappearing now means delivery was **verified** in the target's transcript — but to check what a session actually DID with it, read that transcript: \`~/.claude/projects/*/<sessionId>.jsonl\` (\`sessionId\` comes from its registry file). When verifying, COUNT occurrences rather than checking presence: exactly one is the pass condition.
- Requests dropped while the App was closed are drained on its next start — the inbox is durable, not live-only.
- If **both** the App and Glass are running they watch the same directory and race per request; whichever picks it up first acts, so the session may open in either surface. Single-surface is the normal case.
- For \`send\` / \`kill\`, \`name\` must match a **live** registry name. Malformed or name-less requests are dead-lettered or ignored, and logged: by the App as \`[command-bus]\`, by Glass in the *AIOS Glass* output channel.

## More

- The contract every session loads: \`CLAUDE.md\` → **Spawning Sessions**.
- Subagent vs workflow vs spawn, and which model to route: the **\`orchestration-ladder\`** skill.

${readmeStamp(w)}
`;
}
