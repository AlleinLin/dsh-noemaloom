# dshell Design Document

Status: contract for implementation. Any change to this document must be
re-confirmed before the corresponding code is written.

## 1. Goal

Build a dsh plugin suite (`dshell-*`) that turns the default chat-style Web
UI into a terminal-first single-stream surface. The user sees one xterm.js
canvas per session. The canvas carries both PTY bytes from a single canonical
"main" shell and agent turn fragments from `session/event`, interleaved in
the order they occurred. The user can choose, per message, whether the next
input goes to the PTY or to `ctx.agents.inject()`, by mode toggle or by an
inline `/agent` / `/shell` prefix.

The plugin suite must not require changes to dsh source. Everything ships as
Cordis plugins and bundles that dsh loads at boot through its profile
mechanism (dsh `architecture.md` § "Profiles and bundles"). Composition
mechanics: `dsh --profile web --dump-config` lists the running tree; each
`dshell-*` row is a patch layer.

## 2. Non-goals

- Multiple browser tabs / windows. The user runs one browser process. dsh
  session isolation is sufficient; per-tab PTY sharing is out of scope.
- PTY state surviving a harness restart. dsh `packages/terminal/terminal/
  README.md` § "Known Limitations and Deferred Work" makes
  `process-local` an explicit decision. dshell accepts this; PTY context
  injected into agent turns is the substitute.
- Multiple user-visible PTYs in one session. Each session has exactly one
  `main` shell. Other PTYs the agent opens are backend-only and never
  rendered.
- Cross-process PTY hosting. No tmux server, no remote shell. If the user
  later needs PTY durability, that is a new design.

## 3. Architectural stance

`dshell-*` extends dsh through already-documented extension points only. The
relevant extension points used:

| Goal | Mechanism | Why this and not a fork |
|---|---|---|
| Render interleaved PTY + session event in one view | `ctx.uiConversation.events.register(...)` + `ctx.uiConversation.views.register(...)` for a new target `terminal` | dsh `architecture.md` row 152 names this exact mechanism for "Add a Web Client Chat node". |
| Direct user actions that skip the agent turn | `ctx.commands.register(...)` | dsh `packages/interaction/commands/README.md` § "Use this package". |
| Forward keystrokes from browser to PTY | `ctx.webServer.registerUpgrade('/dshell/pty', ...)` | dsh `packages/host/webserver/README.md` § "Registering routes". |
| Drive PTY | reuse shipped `ctx.terminals` via `dsh-terminal-bash` backend | dsh `architecture.md` row 142. |
| Inject terminal context into next agent turn | `agent.inject({ ..., source: { kind: 'plugin', plugin: 'dshell-terminal-context' } })` | dsh `architecture.md` row 150; verified in `packages/core/agent-loop/tests/loop.spec.ts:964`. |
| Session persistence | reuse shipped `ctx.sessionPersistence` (`dsh-session-persistence-jsonl`) | dsh `docs/subsystems/persistence.md`. |

Everything the user sees in dshell is either an existing dsh event projected
through a registered target or a PTY byte stream surfaced through a ws
upgrade route owned by `dshell-terminal-bridge`.

## 4. Eleven decisions

### 4.1 Session isolation

Each dsh session is a self-contained working surface. dsh already provides
this: `packages/client/ui-conversation/src/client/conversation/
assembly.ts:220` exposes `binding(source)` returning one
identity-stable binding per `SessionId`. The browser-side
`ConversationViewDefinition.create()` is called once per session per target,
so the `terminal` target gets one `ViewBuilder` instance per session.

Consequences:

- Mode toggle state is held in the per-session store, not in module-scope.
  Switching sessions switches mode.
- The PTY buffer held by each `ViewBuilder` belongs to one session; it
  cannot leak into another session's rendering.
- `dshell-terminal-bridge` looks up the target `ViewBuilder` by the
  `SessionId` carried in ws messages; it never holds a cross-session
  reference.

### 4.2 Main shell ownership

The `name: 'main'` PTY belongs to `dshell-terminal-bridge`, not to the
agent. The bridge calls `ctx.terminals.spawn(agent, { type: 'shell',
name: 'main', cwd: agent.cwd })` on first need. The agent may also call
`terminal_open` with `name: 'main'`, but because `ctx.terminals`
discriminates by the `TerminalSessionId` returned by `spawn`, the agent's
call creates a second PTY session, never replaces the bridge's. The
bridge records `mainPtyByAgent: Map<Agent, TerminalSessionId>` and
references that map throughout the session lifetime.

Consequences:

- The user's `main` shell cannot be hijacked by agent behavior.
- `name: 'main'` is the dsh-idiomatic owner-local label (verified in
  `packages/terminal/tool-terminal/src/index.ts:167` and the same package's
  tests). Using it keeps dshell compatible with dsh's documented contract.
- Agent-owned "secondary" PTYs (`name: 'gdb'`, unnamed, etc.) are kept
  alive in `ctx.terminals`, but dshell never subscribes to their output.
  dshell mounts no terminal-tool row, so whether the agent has the tools
  to open one at all is the composition's (a preset's) business — dshell's
  own three tools read the USER's shell and nothing else.

### 4.3 Secondary shell pass-through

PTYs an agent opens through dsh's terminal tools (`terminal_open` and
friends — mounted only where a composition or preset brings
`dsh-tool-terminal`; dshell does not) are not rendered by dshell: only the
`main` shell of a terminal session is. Such a PTY stays accessible to its
agent through those same tools, and its results reach the user
indirectly:

- The agent's tool calls and results land in the session log as
  `tool/call` and `tool/result` events.
- The dshell `ViewBuilder` renders those events as ordinary chat-style
  cards (see 4.4), so the user sees "agent ran `terminal_send` on
  session `pty-7` and got back `hello\n`".

This is enough for the user to know the agent did something in a
secondary shell; the user does not need to see the raw bytes.

### 4.4 Interleaved rendering

`ViewBuilder` for target `terminal` holds a Snapshot with two internal
lists, merged at materialization:

- `sessionNodes: readonly ConversationViewNode[]` — driven by
  dsh's `replace` / `apply` calls. Each node carries an event `time`.
- `ptyRows: PtyRow[]` — owned by dshell. Each row carries a wall-clock
  `time` taken at chunk arrival.

Merge rule: stable ascending sort by `time`; ties broken by `kind`
(`'pty'` before `'session'`, so a PTY byte emitted at the same instant
as a session event shows just above it).

Both kinds of rows are drawn into one xterm.js buffer. Session nodes are
serialized to ANSI sequences with a `┃` left margin and a dimmed tint;
PTY rows pass through verbatim (xterm.js renders them natively with
ANSI color support).

The merge runs in the browser; the host never sees xterm.js state.

### 4.5 Mode state and `/agent` / `/shell`

Two modes per session, `shell` and `agent`, held in a per-session store:

- `shell` mode: composer Enter sends the input as one `startSend` to
  the `main` PTY session.
- `agent` mode: composer Enter calls `agent.inject(userMessage)`.

Prefix interception happens at composer submit, not via
`ctx.commands.register`:

- `/agent <text>` in `shell` mode: switch mode to `agent`, drop the
  `/agent` token, treat the rest as the user message for
  `agent.inject`.
- `/shell <cmd>` in `agent` mode: switch mode to `shell`, drop the
  `/shell` token, run the rest as one `startSend` against `main`.
- `/new` is a real `ctx.commands` registration; it never reaches the
  agent turn (verified in
  `packages/interaction/commands/README.md` § "Dispatching from an
  adapter") — it opens a new session through dsh's standard creation
  path, with the invoking session's cwd. `/compact` stays dsh's own
  registration and triggers dsh's compaction service. A dshell `/clear`
  existed until the storage phase and was removed: the in-terminal
  `clear` already clears the canvas, and dropping a session drops its
  history.

Composer Enter submit is rewritten by patching the `inputActions` flow
exposed through `ctx.uiSession.provide()` (dsh
`packages/client/ui-conversation/README.md` § "Shell and standard
props"). Submit dispatches to the per-mode handler; the `/agent` and
`/shell` prefix parses happen first.

### 4.6 Terminal context injection

When the user is in `agent` mode and submits a message, dshell injects a
PTY context block immediately before the user message:

- The context is a snapshot of the recent `main` PTY output, anchored on
  the last `$` prompt (or other shell prompt marker configured by the
  user) and bounded to the lines after it.
- Hard cap: 100 lines or 4 KiB, whichever is smaller. The cap is checked
  after UTF-8 boundary alignment.
- Injection uses `agent.inject(createUserMessage({ content: [{ type:
  'text', text: wrapAsContextBlock(buf) }], source: { kind: 'plugin',
  plugin: 'dshell-terminal-context' } }))`.
- `inject()` while idle stages the message into the inbox without
  opening a turn (verified in `packages/core/agent-loop/tests/
  loop.spec.ts:959` "idle inject() durably stages context without
  opening a turn"). The next admitted request includes it.
- The wrapped block uses triple-backtick fencing so the model can
  distinguish context from user message.

The agent reaches a shell through a model-facing tool that returns a
`TerminalSessionId`, because `name` is owner-local display metadata
and not an addressable handle. Phase 8 first pointed that tool at the
bridge's `main` shell; Phase 9.11 moved it to a shell the agent owns
(§ 4.10), so the two never contend for one foreground.

### 4.7 Workspace removal

dsh's workspace registry groups sessions under a user-picked directory,
and the stock web UI gates the composer behind a "选择工作区" picker.
A terminal-first shell has no use for this: the terminal's "workspace"
is the PTY's current directory, which changes constantly. The runtime
half of dsh never reads the registry anyway — agent spawn, PTY, file
tools, sandbox, subagents, ACP, and hooks all consume
`session.header.cwd` (a one-time copy taken at session creation), and
dsh's own docs call the feature optional
(`dsh/docs/subsystems/workspace.md`: "an optional host-side capability,
not part of the agent-loop spine"). Only the web-app bundle mounts it.

The per-session redesign reversed this: dsh's own workspace UI is enabled again,
and the flat session list and the stand-ins that replaced it are gone. The
paragraphs below are kept as the record of the earlier decision.

- The dshell bundle patch disables three of the four web-app rows:
  `workspace`, `ui-workspace`, and `directory-picker`.
  `workspace-controller` stays ENABLED — it is what turns the registry's
  archive calls into the remote commands that drive dsh's own
  archived-session settings page, so dshell carries no archive UI of its
  own (see the archive paragraph below).
- Disabling alone would hang the shell: `session-controller` (host)
  and `ui-conversation` / `ui-sidebar` (client) hard-inject
  `workspaceRegistry` / `workspaces` / `uiWorkspace`, and
  ConversationRoot requires the `slots.provideRoot({ hooks: {
  workspaces } })` root hook. The package therefore provides same-key
  replacement services (Cordis service keys are plain strings): a
  minimal host registry stub covering the consumed surface, and client
  stubs plus the root hook.
- The archive set is upstream's, and the registry's archive half is the
  one part of the stub that is real: archiving writes
  `$DSH_HOME/dshell/tags.json`, and restoring is the stock `已归档会话`
  settings page. The sidebar keeps the 归档 row action and the `待删除`
  group and nothing else — a second list of archived sessions would be a
  second place for the same set to drift.
- The hero picker and sidebar workspace grouping disappear with the
  `ui-workspace` row; the composer's inert gate
  (`sessionId === undefined || (hero && chipTitle === undefined)`)
  reduces to plain "no session open".

Sessions are created via `sessions.create({ cwd })` (workspaceId
omitted) — a stock dsh creation path, workspaceId and cwd being
alternatives by contract.

Consequences:

- Session creation never asks for a workspace. The sidebar falls back to
  dsh's built-in flat session list.
- Session cwd is immutable after creation (`ApiSessionCwdConflict`):
  one session = one fixed agent working root. The PTY `cd`s freely;
  Phase 7's context injection reports the live PTY cwd to the agent so
  it always knows where the user is. Cross-directory work means a new
  session (`/new`) — matching the terminal habit of cd-then-work.
- The removed registry is not backed up or migrated; existing
  `$DSH_HOME/storages/workspace` data is simply no longer read.
- Naming moves to creation time. dshell's new-session dialog asks for an
  optional name and a starting directory before creating the session
  (`sessions.create({ cwd })`, then an immediate durable rename through
  the session face; auto-titling may later overwrite it on first
  message). Both the sidebar list's button and the shell's stock
  New-Session button — which routes through the `uiWorkspace` stand-in —
  open the same dialog.

### 4.8 Terminal layout

The terminal target's canvas is the whole content area. dshell does not
restyle the stock chat scaffold; it replaces the conversation surface
wholesale by shadowing the stock `conversation` slot occupant at a
lower priority (the slots registry supports same-hole shadowing) with
dshell's own terminal scaffold:

- A full-bleed xterm.js canvas (decision 4.4 merge rule) — no chat
  cards, no bubbles, no hero banner. Session events are serialized into
  the stream with the `┃` left margin from 4.4.
- A slim bottom input dock (single line, borderless) as the only
  chat-UI element. It is the per-message mode surface from 4.5: `shell`
  mode forwards Enter to the `main` PTY; `agent` mode calls
  `agent.inject`. Focus follows mode — in `shell` mode the canvas holds
  focus so keystrokes reach the PTY directly; the dock takes focus in
  `agent` mode.
- Cold start with no session shows a minimal centered "create a
  session" affordance, not the stock hero.

The sidebar keeps dsh's shell chrome with the flat session list from
4.7. The scaffold replacement lands with the Phase 4 canvas; the dock
with Phase 5. Until then the stock scaffold remains the interim shell.

### 4.9 PTY scrollback persistence

The main shell's output history is persisted to disk, not held
unbounded in memory. `dshell-terminal-bridge` appends every output
delta to an append-only log per dsh session —
`$DSH_HOME/dshell-pty/<dsh-session-id>.log` — and keeps only a fixed
in-memory window (default 256 KiB / 2000 lines, whichever binds first)
for live rendering and context injection:

- The file is the source of truth; the window is a cache. Writes are
  batched (default 150 ms) and flushed on close; trimming the window's
  oldest lines never touches the file.
- A fresh main shell bound to the same dsh session — including the
  fresh PTY a harness restart must spawn — seeds its window from the
  file tail (default 64 KiB), so the canvas restores recent scrollback
  without unbounded memory.
- The 4.6 context-injection snapshot (100 lines / 4 KiB) reads from
  the window.
- The spawn reset truncates both the window and the file: the init echo
  is discarded and the seeded scrollback is re-appended, which is why
  the persisted log survives a respawn while it never keeps the echo.
- The log and its sidecars are owner-only (`0600` in a `0700` directory,
  Phase 10.10). This is a privacy boundary, not tidiness: the splitter
  records the input side as well as the output, so the transcript holds
  every line typed at the shell — including anything typed at an
  interactive prompt that is not a shell prompt.
- The PTY *process* itself stays process-local (§ 2): a restart
  spawns a fresh shell; only the scrollback history survives. This
  decision narrows the § 2 non-goal — process durability stays out of
  scope; scrollback history persistence is in scope.

### 4.10 Two shells per session (agent-owned terminal)

dsh's terminal service allows exactly ONE active send per PTY, and a
PTY's foreground is single-owner by nature. Phase 8 therefore made the
agent a second writer into the user's own shell, which is precisely the
arrangement that cannot work: the two take turns at the foreground, a
send waits on the other's output to settle, and Ctrl+C in the user's
shell cannot reach the agent's command (the bridge's own send record
does not cover it).

Phase 9.11 gives the agent its own PTY instead, under the same session
Agent but with a distinct owner-local name (`agent` next to `main`):

- **Spawned lazily**, on the agent's first need for a terminal. A
  session whose agent never runs a shell pays nothing, and a device
  session does not open a second ssh connection for a panel nobody
  opened.
- **Forked, not shared**: the agent's shell opens in the directory the
  user's shell is sitting in, read from the user's own prompt (nothing
  on this wire reports a PTY's working directory), and falls back to
  the session directory when that shell is busy.
- **The sync direction stays one-way**: the user's activity reaches the
  agent's context through 4.6, and the agent reads the user's shell
  with `dshell_terminal_read` — read-only. The agent does not type into
  the user's terminal, because that is the same foreground contest.
- **The user can watch it**: a second, read-only stream on the same ws
  route (`bind` with `stream: 'agent'`) feeds the status card's
  terminal row. The panel negotiates the shell's WIDTH only — rows stay
  a full terminal's, since a full-screen program needs them and the
  panel scrolls.
- The shell's bytes never enter the main block log: the user's timeline
  carries the user's shell and the agent's turns, and the agent's
  command output arrives where it was always visible — in its own tool
  results and in the panel.

The model-facing tool is `dshell_get_agent_terminal`; it returns the id
of this shell, and only after the init handshake settled, because the
agent's next act is a send and the backend rejects one that overlaps
another.


## 5. Wire protocol

`dshell-terminal-bridge` exposes a single ws upgrade route at
`/dshell/pty`. The protocol is JSON framed; messages are:

- Client → server:
  - `{ kind: 'bind', sessionId: string, stream?: 'main' | 'agent' }` —
    associate this ws with the dsh session id. Required as the first
    message after upgrade; the server answers with a replay
    `{ kind: 'output', ..., replay: true }` carrying the persisted
    scrollback tail (4.9) before any live frame. Omitting `stream`
    binds the user's `main` shell; `'agent'` subscribes to the
    agent-owned shell's read-only stream (4.10) and is the only reason
    a second ws exists — it accepts `agent-open` (spawn it now) and a
    `cols`-only `resize`, and answers with `agent-info`, `output`,
    `ready` and `closed` frames tagged `stream: 'agent'`.
  - `{ kind: 'input', sessionId: string, text: string }` — forwarded to
    the `main` PTY through `startSend`. Raw control keys ride the text
    (`\u03` = Ctrl+C cancels the active send with SIGINT).
  - `{ kind: 'resize', sessionId: string, cols: number, rows: number }`
    — accepted but currently a no-op: dsh's PTY backends fix rows/cols
    at spawn (terminal-bash config; no resize API). Reserved for a
    future backend capability.
  - `{ kind: 'signal', sessionId: string, signal: 'SIGINT' | 'SIGTERM'
    | 'SIGTSTP' }` — signal the foreground process group.
- Server → client:
  - `{ kind: 'output', sessionId: string, chunk: string, time: number }`
    — PTY bytes to render.
  - `{ kind: 'status', sessionId: string, status: TerminalSessionStatus }`
    — `main` PTY status changed.
  - `{ kind: 'closed', sessionId: string, reason: string }` — `main` PTY
    was closed by either side.

The `SessionId` in every message is part of authorization: a ws frame
naming a session the bridge has not bound is rejected.

## 6. Failure modes

- `main` PTY dies (`session_exit` or signaled): bridge removes it from
  `mainPtyByAgent`; next user input triggers `ensureMainShell` again.
- Browser disconnects: bridge holds the PTY until session disposal.
  Re-connection re-subscribes to byte stream from current scrollback.
- Multiple ws clients connect for one session: bridge accepts the first
  and rejects subsequent binds. Single browser, single ws per session.
- Session disposed by user: bridge closes the bound ws and calls
  `ctx.terminals.kill(agent, mainId)` in the session dispose path.

## 7. Out-of-scope follow-ups (for later)

- Split-pane rendering for multiple user-visible PTYs in one session.
- PTY durability across harness restart (external backend).
- Inline syntax highlighting for shell prompt in xterm.js buffer.
- Per-line agent attribution coloring in xterm output.