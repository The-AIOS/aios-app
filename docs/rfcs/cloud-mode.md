# RFC: Cloud mode — the app as a client of an always-on AIOS host

- **Status:** Draft, for discussion
- **Scope:** AIOS App (this repo). Touches the framework only where noted.
- **Code references:** pinned to `16f7b03` (0.9.6)

## 1. Summary

Today the AIOS App is both the screen and the engine: every terminal is a child process of the
Electron main process, the framework and vault are read from the local disk, and the spawn inbox
is fulfilled by the open window. When the machine sleeps or shuts down, the whole system stops.

This RFC proposes an optional **cloud mode**: a headless **AIOS host** that runs on any always-on
Linux machine and owns sessions, the vault, the spawn inbox and scheduled work, and an app that
**connects to that host** instead of doing the work locally. The desktop app keeps every feature it
has today. The protocol is designed from the start so that a mobile client can be added later, and
so that a macOS machine, while it is on, can lend the host the capabilities that only exist there.

Local mode stays exactly as it is. Cloud mode is opt-in.

## 2. Motivation

An AIOS installation compounds value by running work the operator is not watching: long-running
workers, overnight sessions, scheduled rituals, agents that hand work to other agents. All of that
currently depends on one laptop being open, awake and online.

The ways around it today each give something up:

| Workaround | What it loses |
|---|---|
| Keep the laptop awake | Not always-on; the laptop is still the single point of failure. |
| Run the app on a Linux server and view it over remote desktop | Latency, a window inside a window, and a desktop environment to maintain on the server. |
| Point *Settings → Claude CLI command* at an SSH wrapper | Sessions run remotely, but the explorer, panels, session list and spawn inbox still read the local disk. |
| A second machine for night work, syncing the vault through git | Two writers on one repository, divergent `~/.claude` and `~/.aios` state, and no way to move a live session between them. |
| Claude Code's web sessions and cloud routines | No local MCP servers, hooks or long-lived interactive workers; not the app. |

What is missing is the separation that editors solved years ago with remote development: **the
engine lives where it can stay on; the interface connects to it.**

## 3. Goals and non-goals

### Goals

1. **24/7.** Sessions, workers, the spawn inbox and scheduled work keep running with every client
   closed.
2. **No lost features.** The desktop app in cloud mode does everything it does in local mode.
   Anything that genuinely cannot run on the host is served by a local node (§ 5.5), not dropped.
   Parity is claimed only when phase 4 lands (§ 9); until then the gap is listed, not hidden.
3. **Session continuity.** Disconnecting a client never kills a session. Reconnecting — from the
   same or another device — shows what happened while it was away.
4. **One writer.** Only the host writes the vault and commits. Clients request changes.
5. **Mobile-ready protocol.** Nothing in the client–host protocol assumes a desktop, a shell or SSH
   on the client.
6. **Host-agnostic.** Any Linux machine the operator controls: a VPS, a cloud VM, a home server.
7. **Local mode unchanged** for everyone who does not opt in.

### Non-goals (for this RFC)

- Building the mobile client. Its requirements shape the protocol (§ 5.6); the client itself is a
  separate, later RFC.
- Multi-operator hosting. One host serves one operator.
- Exposing the host to the public internet.
- Replacing Claude Code's own Remote Control. Sessions launched by the host keep it, so the
  operator's phone reaches them through the Claude app from day one.

## 4. User journeys

1. **Work from the desktop.** The operator opens the app, which connects to the host. Tabs,
   explorer, panels, the session list and rituals look and behave as they do locally; every
   terminal runs on the host.
2. **Shut the laptop.** Running sessions continue. A worker that was asked to finish a task
   overnight finishes it and commits its result.
3. **Check in from the phone.** Through Claude Code Remote Control today, and later through the
   mobile client, the operator sees the same sessions, answers a permission prompt, starts a
   worker.
4. **Agents spawn agents while nobody is watching.** A session writes a spawn request; the host
   fulfils it with no window open, and the new session is there when a client reconnects.
5. **Work that needs the Mac.** A session asks for an on-device transcription or an action in the
   operator's own browser. If the Mac is online as a local node, it runs there and the result
   returns to the host. If not, the request waits in a visible queue.
6. **Reopen the laptop.** The app reconnects, reattaches every tab to its live session with the
   output it missed, and surfaces anything that finished or is waiting on the operator.
7. **Lose connectivity.** The app keeps a read-only local copy of the vault to browse. Starting
   sessions and editing wait until the host is reachable, and the app says so.

## 5. Architecture

```
                         ┌──────────────── AIOS host (Linux, always on) ────────────────┐
                         │                                                              │
  Desktop app  ◄─────────┤  aios-host                                                   │
  (macOS/Win/Linux)  WS  │   ├─ session supervisor (ptys that outlive clients)          │
                         │   ├─ workspace service (framework + vault files, git, watch) │
  Mobile client ◄────────┤   ├─ spawn inbox fulfiller                                   │
  (future)           WS  │   ├─ scheduler                                               │
                         │   ├─ Claude Code config + connectors                         │
                         │   └─ node broker ──────────────┐                             │
                         └────────────────────────────────┼─────────────────────────────┘
                                                          │ WS (outbound from the node)
                                               macOS local node (the desktop app,
                                               while running): on-device ML, Apple
                                               apps, the operator's browser, Finder
```

### 5.1 The host (`aios-host`)

A headless Node process that takes over the responsibilities the Electron main process has today.
It should be **extracted from the existing main-process code, not rewritten**: the domain logic in
`src/core/` is already pure, and most of `src/main/aios.ts` and `src/main/commandBus.ts` has no
reason to depend on Electron. The app then runs the same services either in-process (local mode)
or through the protocol (cloud mode).

Services:

- **Session supervisor.** Owns every pty. A pty is attached to zero or more clients and is never
  killed by a client disconnecting — only by an explicit kill or by the process exiting. It runs as
  its own process, separate from the rest of `aios-host`, and persists each session's identity and
  lifecycle state (name, Claude session id, cwd, state, input owner). Two restart cases are
  distinct and must not be conflated:
  - **`aios-host` restarts** (upgrade, crash): the supervisor and its ptys keep running; the host
    reconnects to them. Nothing is lost.
  - **The machine reboots**: every process is gone. Named sessions are relaunched with `--resume`,
    the path the app already uses for resumable sessions. That restores the **conversation**, not
    running subprocesses, shell jobs or a pending permission prompt. Any tool call in flight at the
    moment of the reboot is marked *interrupted* and shown to the operator; it is never retried
    automatically.
- **Input ownership.** A session has at most one **input owner**: the attached client that may type,
  resize, answer what the session is waiting for, or kill it. Other attached clients are read-only
  viewers. Ownership is taken explicitly ("take control"), is released when the owner disconnects,
  and the terminal size follows the owner.
- **Workspace service.** File listing, read, write, index, git status and dirty lines, and file
  watching over the framework and vault roots, with the same allowed-roots confinement as today.
- **Spawn inbox fulfiller.** Watches `~/.aios/spawn-inbox/`, publishes the host's surface record,
  and executes `spawn`/`send`/`kill`/`resume` against the session supervisor. **Delivery is
  confirmed on the host**, not by a renderer.
- **Scheduler.** Runs scheduled rituals and agents, with a run log and no overlapping runs.
- **Claude Code config and connectors.** The settings the app reads and writes today, applied to
  the host's `~/.claude`.
- **Node broker.** Tracks connected local nodes, their declared capabilities, and a durable queue of
  capability requests (§ 5.5).

### 5.2 The protocol

- **Transport:** WebSocket, carrying typed request/response messages plus server-pushed events.
  Terminal data rides the same connection as binary frames.
- **Shape:** the current IPC surface, lifted. Every `ipcMain.handle` becomes a request, every
  `webContents.send` becomes an event. The preload (`src/preload/preload.ts`) is already the single
  seam between UI and engine, which is what makes this tractable.
- **Versioned.** Client and host negotiate a protocol version on connect, so the app and the host
  can be updated independently and a mismatch is reported instead of misbehaving.
- **Resumable, within stated limits.** Events carry a sequence number and a host epoch that changes
  on restart. A reconnecting client asks for everything after the last event it saw. Output is
  retained per session up to a fixed bound; if the gap is larger than the retained window, or the
  epoch changed, the host says so and sends a **snapshot** of the current terminal screen and
  session state instead of pretending to replay.
- **Commands are recorded before they run.** A command that starts work carries an idempotency key
  and is written durably as *accepted*, then *started*, then *completed*. A retry with the same key
  returns the recorded outcome. A command found *started* but not *completed* after a crash is
  reported as **outcome unknown** and surfaced to the operator, never re-executed silently.
- **Client-agnostic.** No message assumes a desktop, a shell, or a filesystem on the client.

### 5.3 Reaching the host

`aios-host` binds to loopback and, optionally, a private network interface. Clients reach it over
an operator-controlled private network (a mesh VPN or an SSH tunnel). A private network limits who
can reach the port; it is not authentication, so § 7 applies in full regardless. Opening a public
endpoint is out of scope for this RFC and would require its own security review.

### 5.4 The desktop client

- **Mode switch** in Settings: *Local* (today) or *Connected to a host* (address + pairing).
- **Renderer unchanged where possible.** The preload exposes the same `glassShell` API in both
  modes; in cloud mode it is backed by the protocol instead of IPC.
- **Client-side capabilities stay local and are named as such:** clipboard, zoom, devtools, opening
  a URL in the local browser, notifications, dock badge, drag-and-drop. Anything that crosses the
  boundary is an explicit transfer: "reveal in Finder" on a host path becomes "download and
  reveal", a dropped file becomes an upload.
- **Read-only offline cache.** The client keeps a local, read-only mirror of the vault that the
  host refreshes. With the host unreachable, the explorer and viewers work against it, editors are
  read-only, and starting sessions is disabled with a clear banner.
- **Health.** A status surface for host connectivity, running sessions, connected local nodes and
  queued capability requests.

### 5.5 The local node (macOS capabilities)

Some capabilities exist only on the operator's Mac: on-device ML (for example transcription on
Apple Silicon), OCR through system frameworks, Apple app integrations, the operator's own
logged-in browser, Finder. Moving the engine to Linux must not remove them.

- While the desktop app runs on a Mac in cloud mode, it **also registers with the host as a local
  node** and declares the capabilities it can serve.
- A session on the host requests a capability by name (`transcribe`, `ocr`, `browser.open`, …)
  through the host. The node broker routes it to an online node or queues it.
- **Declared capabilities only.** The host can ask a node to perform a named capability whose
  arguments are validated against a schema the node publishes, with per-capability limits (input
  size, allowed paths or URL schemes, timeout). It can never run arbitrary commands on the Mac.
- **Node affinity.** A request may target a specific node (for example, the machine holding a
  particular browser profile). A request without affinity goes to any node declaring the capability.
- **Delivery semantics.** Each request moves through durable states: *queued → leased → running →
  done | failed | cancelled | outcome unknown*.
  - A node **leases** a request for a bounded time and acknowledges start and completion.
  - Every request has a deadline; one that expires while queued fails visibly.
  - **Cancellation** is guaranteed only while *queued*. After it is leased, cancel is best-effort
    and the final state records what actually happened.
  - Each capability declares whether it is **repeatable**. A repeatable request whose lease expires
    is re-queued. A non-repeatable one (anything with a side effect, such as submitting a form in
    the browser) whose node disconnects mid-run becomes *outcome unknown* and is never retried
    automatically.
- **Visible queue.** A request made while no suitable node is online is shown as *waiting for a
  local node*, with its deadline, and can be cancelled.
- The node connects **outbound** to the host, so the Mac needs no open ports.
- **Invocation from the framework.** Existing hooks and skills must reach capabilities without
  being rewritten per call site. The host exposes the broker both as a CLI shim with the same
  interface the local hook has today and as an MCP server; which framework hooks switch to it is a
  framework-side change delivered in the same phase.

### 5.6 The mobile client (future)

Not built in this RFC. Its expected scope — session list and state, attach to a session, answer
what a session is waiting for, start and stop workers, read notes, see queued work — is the test
the protocol must pass: every one of those must be expressible without a shell, SSH, or a
filesystem on the device.

## 6. What moves where

Current coupling to the local machine, grouped by where it goes in cloud mode.

| Today | Where it lives | Cloud mode |
|---|---|---|
| `pty:spawn` / `pty:run` / `pty:write` / `pty:resize` / `pty:kill` — ptys are children of the app process (`src/main/main.ts:215`) | App | **Host**, session supervisor; ptys decoupled from client lifetime |
| Terminal environment, including forced session persistence (`termEnv`, `src/main/main.ts:78`) | App | **Host** |
| Resumable sessions from `~/.claude/projects` (`src/main/main.ts:424`) | App | **Host** |
| `fs:*` — list, read, write, index, git, dirty lines (`src/main/main.ts:492`–`715`) | App | **Host**, workspace service |
| Explorer and Claude config file watchers (`src/main/main.ts:300`–`350`) | App | **Host**; changes pushed as events |
| Framework and vault reading: frontmatter, onboarding, personalization, inbox (`src/main/aios.ts`) | App | **Host** |
| Spawn inbox watch (`src/main/commandBus.ts:890`), surface record (`:189`), process ancestry via `ps` (`:155`), tier resolution hook (`:392`) | App | **Host**, inbox fulfiller |
| Delivery confirmation from the renderer (`busSendResult`, `src/preload/preload.ts:74`) | Renderer | **Host** — must not depend on an open window |
| Connector and MCP registration via the `claude` CLI (`src/main/connectors.ts:386`) | App | **Host** |
| Claude Code settings, including `remoteControlAtStartup` (`src/core/claudeConfig.ts:66`) | App | **Host** |
| Panel watchers on exports and update state (`src/main/panelHost.ts:55`–`98`) | App | **Host**; events |
| Sleep prevention while sessions are busy (`src/main/caffeinate.ts`) | App | **Client-side only**; irrelevant to the host |
| Clipboard, zoom, devtools, open external, reveal in Finder (`shell:*`) | App | **Client**; host paths become explicit transfers |
| App auto-update (`src/main/updater.ts`) | App | **Client**; host updated separately, protocol-versioned |
| On-device ML, system OCR, Apple apps, the operator's browser | Framework hooks on the Mac | **Local node** |

## 7. Security

Cloud mode moves an engine that can write files, run commands and hold credentials onto a machine
that is always on. The design has to assume that is worth attacking.

- **No public listener.** Loopback plus a private network interface only (§ 5.3).
- **Encrypted transport.** TLS on any non-loopback interface, even inside a private network.
  Unencrypted WebSocket is accepted only on loopback, which is what an SSH tunnel terminates on.
- **Pairing.** A device is paired by entering a short-lived, single-use code generated on the host
  (from its CLI). Pairing issues a per-device credential, stored in the client OS keychain. The host
  lists paired devices; revoking one invalidates its credential **and closes its open connections
  immediately**.
- **Handshake.** Every connection authenticates before any other message is accepted, and the host
  rejects browser-originated connections by checking `Origin`, so a web page the operator visits
  cannot talk to a host reachable from their machine.
- **Roles.** A device pairs as a **client** (UI operations), a **node** (register capabilities,
  lease and complete requests) or both. A node credential cannot open terminals or read the vault;
  a client credential cannot register capabilities.
- **Validation and limits.** The IPC boundary used to sit inside one trusted process; now it does
  not. Every message is schema-validated and carries the confinement the app enforces today
  (allowed roots, the single pty chokepoint), with limits on frame size, request size, concurrent
  requests and rate per device.
- **Local node is capability-scoped.** See § 5.5: schema-validated arguments, per-capability
  limits, no arbitrary execution, and a queue the operator can see and cancel.
- **Credentials stay per service.** The host holds only the credentials its sessions need. Copying
  a whole keychain or every `.env` is explicitly not the model.
- **Web content is untrusted input.** Browser capabilities return content to a host that also holds
  the vault; that path should be treated as a prompt-injection boundary.

## 8. Failure modes the design must handle

| Failure | Required behaviour |
|---|---|
| Client disconnects mid-session | Session keeps running; reattach replays missed output, or sends a snapshot if the gap exceeds retention. |
| Input owner disconnects | Ownership is released; viewers stay attached and one can take control. |
| `aios-host` restarts | Supervisor and ptys keep running; clients reconnect with no loss. |
| Machine reboots | Named sessions relaunch with `--resume`; in-flight tool calls are marked *interrupted*; clients see *restarted*, not *gone*. |
| Command retried after a dropped connection | Recorded outcome is returned; nothing runs twice. |
| Crash between starting and recording a command | Reported as *outcome unknown*; not re-executed. |
| Spawn request with no client connected | Fulfilled by the host. |
| Capability request with no suitable local node online | Queued with a deadline, visible, cancellable. |
| Local node disconnects during a non-repeatable capability | *Outcome unknown*; never retried automatically. |
| Revoked device still connected | Connection closed at revocation. |
| App and host on different versions | Negotiated; a mismatch is reported with what to update. |
| Host unreachable | Read-only offline cache; new work disabled with a clear state. |

## 9. Phases

Each phase ships something usable on its own.

1. **Headless host, one client, safe to use.** Extract the main-process services into `aios-host`
   and the session supervisor; the desktop app connects to it. Included from the start, because
   ordinary disconnects happen on day one: pairing, encrypted transport, handshake, roles and
   message validation (§ 7); input ownership; reconnect with snapshot; recorded, idempotent
   commands; protocol versioning; both restart cases (§ 5.1); the spawn inbox fulfilled on the
   host. **Acceptance:** with every client closed, a running session finishes its task, a spawn
   request is fulfilled, and an `aios-host` restart loses nothing.
2. **Scheduling and full replay.** The host scheduler with run log and no overlapping runs
   (**acceptance:** a scheduled job runs with no client connected and its result is visible on
   reconnect); retained output replay beyond snapshots; multiple viewers per session.
3. **Host-side desktop parity.** Explorer, panels, notes, setup and connectors over the protocol;
   the read-only offline cache; explicit file transfers; health surface. Features that need a Mac
   are listed as pending phase 4.
4. **Local node — full parity.** Capability registration, broker, delivery semantics (§ 5.5), the
   CLI shim and MCP server, and the framework-side switch of the hooks that need a Mac. **Acceptance:**
   every feature available in local mode is available in cloud mode, with a Mac node online.

The mobile client follows in its own RFC, on this protocol.

## 10. Alternatives considered

- **Remote desktop to the Linux build.** Works today with no code, and is a reasonable stopgap. It
  keeps a desktop environment on the host, adds latency, and cannot become a mobile experience.
- **SSH transport for ptys and SFTP for files, driven from the local app.** Small to prototype, but
  `fs.watch`, `ps`, hook execution and the inbox all still run on the wrong machine, and it is not
  usable from a phone.
- **Two machines syncing the vault through git.** Avoids app changes, but creates two writers and
  cannot move a live session.

## 11. Open questions

1. Session supervision: embed a supervisor in `aios-host`, or build on an existing multiplexer
   (tmux, dtach)?
2. Should local mode also run the extracted host in-process, so there is one code path, or keep the
   current IPC path and add the protocol beside it?
3. Is the Glass extension expected to follow the same host protocol, given that it implements the
   same inbox contract independently?
4. Which framework hooks need a local node today, and does any of them have a Linux equivalent good
   enough to run on the host instead?
5. Packaging and installation of the host: a script, a container image, or both?
