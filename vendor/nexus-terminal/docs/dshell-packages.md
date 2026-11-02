# dshell Plugin Inventory

This document lists every package that dshell introduces. Each entry
states its role, the dsh service it depends on, and the phase in
[`dshell-roadmap.md`](./dshell-roadmap.md) that brings it in.

All packages follow the dsh monorepo conventions laid out in
[`docs/cookbook/adding-a-package.md`](../../dsh/docs/cookbook/
adding-a-package.md): each lives under `packages/<group>/<pkg>/`, has a
`package.json` with `dsh.bundle` (where applicable), exposes a default
Cordis plugin, and ships a `README.md` with the Model Experience section
when it contributes to model-visible state.

## Naming

- Host-side packages: `@deepseek-ai/dsh-*` names follow the dsh
  convention. The dshell packages live in the `dshell` group and use
  `@nexus-aethra/dshell-*` to match the existing `@deepseek-ai/dsh-*`
  pattern.

  Pragmatic note: until a dsh contribution slot is open, the dshell
  packages live in this separate workspace and use a different name
  prefix (`dshell-*`) so they are unmistakable as the dshell extension
  set.

- Each package name uses one dash-separated role token after `dshell`:
  `std`, `bundle`, `conversation`, `terminal-bridge`, `mode`, `commands`,
  `ssh`, `buffer`, `files`, `usage`.

## The packages

### `dshell-std`

- Role: **the standard layer**. It owns what every other package would
  otherwise re-implement: the `/api/dshell/*` paths and the wire shapes
  that cross them (`src/contracts.ts`), the shell line's own reading
  (`src/shell-line.ts`: tokenizer plus position classifier, a pure
  function both halves of completion call so neither keeps its own copy
  of the rule), and — as the refactor continues —
  the dsh seam adapters (route definition, session/world addressing,
  capability probing).
- Why it exists: a dsh interface change used to land N times, once per
  package that had grown its own copy of the seam. Measured before the
  split: six `respond()` helpers, five per-package protocol modules and
  six path constants, two independent session/world resolvers, 61
  type-only merge imports with no registry, and two styling systems on
  the browser side. The browser faces even restated host contracts by
  hand because there was nowhere shared to put them — drift there is a
  404 at runtime, not a compile error.
- The rule that keeps it useful: it declares FACTS (paths, shapes,
  adapters) and the pure readings two halves of one feature must agree on
  (the shell line), never feature behaviour — nothing in it talks to a
  service, a filesystem, or the network — and it is the only dshell
  package allowed to care how dsh spells things.
- dsh services depended on: none. This is deliberate — it is the layer
  that absorbs dsh changes, so it must not be spread across the graph.
- Introduced in: the standard-layer refactor (contracts extraction,
  2026-09-12). Feature packages keep their own `protocol.ts` as a
  re-export shim, so the single declaration lives here while existing
  import sites stay unchanged.
- Touches decisions: for the browser bundle, `dshell-std` is always
  inlined (see `tsdown.dshell.preset.ts`) because dsh's client module
  table only serves its own PLATFORM_MODULES plus registered client
  plugins; a `require` of a support package fails the plugin load.

### `dshell-storage`

- Role: **the storage engines.** It owns the medium behind the storage
  contract that `dshell-std` declares (`src/storage.ts`): today one SQLite
  database per harness home holding every session's command history.
- Why it exists: the per-session `.history.json` array had no index — a read
  parsed the whole list into memory, a write rewrote it in full, and staying
  bounded meant dropping the oldest commands at a fixed 200-entry cap, which is
  lossy exactly where a query would want them. A table answers the two shapes
  the feature needs — the newest N of one session, and prefix matching for the
  shell's up-arrow gesture — with a working set bounded by the query's `limit`
  instead of by everything ever stored.
- The engine is Node's built-in `node:sqlite`: no native dependency and no
  install script, and FTS5 is present on both the host runtime and the packaged
  desktop runtime (v24.17.0), which is what a later full-text search over
  history would use.
- The rule that keeps it useful: the contract (record shape, store surface, file
  naming, layout version, failure vocabulary) lives in `dshell-std`; a feature
  package imports only `openHistoryStore` / `closeHistoryStore` and never names
  a file, a pragma or a schema.
- dsh services depended on: none — it is a library, not a plugin, so it has no
  bundle row. It is host-only by construction (`node:sqlite` cannot appear in a
  client bundle), which is the second reason the contract lives separately.
- Introduced in: the shell-history storage work (2026-09-13). Before the store,
  `terminal-bridge` wrote `${logPath}.history.json`; those files are now read
  once per session on first open (idempotent by `(session_id, seq)`) and never
  written again.
- Format: `PRAGMA user_version = 3`; `commands(session_id, seq, command,
  command_norm, exit_code, at)` keyed by `(session_id, seq)` plus
  `commands_session_prefix(session_id, command_norm)`, and
  `command_output(session_id, seq, output, bytes, dropped)` holding each
  command's retained output tail. Layout 1 also had `commands_at(at)` for a
  cross-session time query that was never built and that nothing read; layout 2
  dropped it, and layout 3 added the output table. Older layouts are migrated in
  place, one step at a time; an unknown layout is refused.
- Output retention: the newest 1000 outputs per session, 64 KiB each (the store
  cap equals the splitter's pending bound, so storing it costs no extra memory).
  Eviction loses the text, never the fact that a command ran. The injected
  preview and the in-memory window use a smaller cap (16 KiB, and 2 KiB in the
  block) — the same output, deliberately read at three sizes.
- Trap worth remembering: prefix matching is a **range predicate**
  (`command_norm >= ? AND command_norm < ?`), not `LIKE 'x%'`. SQLite refuses
  the LIKE optimization for a bound parameter, so with a session filter the
  index serves only the session term and every row of that session is tested
  against the pattern — cost that grows with history size, which is the thing
  the store exists to avoid. The range seek alone is still not the whole
  answer: the index is ordered by `command_norm`, so "the newest matches" needs
  a sort of every match (`USE TEMP B-TREE FOR ORDER BY`). `matchPrefix` scans
  newest-first through the primary key with an early exit, and falls back to the
  range seek for a sparse prefix — Phase 10.7, measured there. Its budget is
  derived rather than fixed (`sqrt(limit * N * b/a)`, `N` from `max(seq)`),
  because a constant is only right at one size; Phase 10.8 has the calibration
  and the honest trade it makes in the mid-density band.

### `dshell-bundle`

- Role: dsh `bundle` package that lists every other dshell package as a
  Cordis patch row. This is the single install point — users add this
  package and dshell comes online.
- dsh services depended on: `dsh-web-app` (or whichever profile is in
  use) — bundle patches land on the active profile.
- Introduced in: Phase 1.
- Touches decisions: none directly; exists to satisfy dsh's bundle
  composition.

### `dshell-conversation`

- Role: the `terminal` target. Two-faced Cordis package:
  - **Host face** registers a `ConversationViewDefinition` for target
    `terminal`. Its `ViewBuilder.create()` returns a builder that
    consumes both `replace` / `apply` from the dsh engine (session
    events) and the PTY byte stream from `dshell-terminal-bridge`.
    Merge happens in the Snapshot per design 4.4.
  - **Browser face** materializes the Snapshot into one xterm.js
    buffer. Session nodes are serialized to ANSI sequences; PTY bytes
    pass through verbatim.
- dsh services depended on: `ctx.uiConversation.events`,
  `ctx.uiConversation.views`, `ctx.uiSession`, browser-side xterm.js.
- Introduced in: Phase 1 (host empty); expanded in Phases 2, 4.
- Touches decisions: 4.1 (per-session ViewBuilder), 4.4 (interleaved
  rendering).

### `dshell-terminal-bridge`

- Role: host-side bridge between the browser and `ctx.terminals`. Owns
  one `main` PTY per session (the user's shell) and, spawned lazily,
  one `agent` PTY (the agent's own shell, Phase 9.11), each with its
  own persisted buffer and block log. Serves the frame protocol on two
  carriers: the ws upgrade route at `/dshell/pty` (where a `bind` frame
  names the stream, `main` or `agent`) and the `ctx.connection.fetch`
  routes `/api/dshell/stream` + `/api/dshell/stream/send`, whose GET
  carries the bind as query parameters. The browser face keeps ws where
  the page can reach it and falls back to the stream everywhere else —
  in particular the desktop shell, which composes `connection` but not
  `webServer`. Implements the wire protocol in `dshell-architecture.md`
  § 4. It also reads what is ON the session's terminal (`foreground.ts`:
  the PTY's foreground process group from `/proc`, plus the alternate
  screen in the byte stream) and broadcasts the resulting `tui` frame —
  the reading that lets the browser hand the whole surface to a
  full-screen program, and the reason those bytes stay out of the block
  log (§ 18).
- dsh services depended on: `ctx.connection` (frame stream + history
  read, the composition-independent path), `ctx.webServer` (the ws fast
  path), `ctx.terminals` (PTY lifecycle), `ctx.agents` (resolve agent by
  sessionId), browser-side `dshell-conversation` (channel for byte
  push).
- Introduced in: Phase 2 (host only); expanded in Phase 3 (browser
  ws), Phase 9.11 (agent shell + agent stream).
- Touches decisions: 4.2 (main shell ownership), 4.3 (secondary pass-
  through), 4.4 (host half of byte stream), 4.10 (two shells per
  session).
- Everything it persists is owner-only (Phase 10.10): the
  `$DSH_HOME/dshell-pty/` directory is `0700` and `<id>.log` plus its
  `.timeline.json` / `.blocks.json` / `.history.json` sidecars are `0600`,
  written through `src/private-file.ts` — which tightens a file an earlier
  build left at `0664` rather than only fixing new ones. The transcript is
  the most sensitive artifact here: the splitter records the input side, so
  it holds every line the user typed.

### `dshell-mode`

- Role: per-session mode state (`shell` / `agent`) and composer Enter
  dispatch. Patches the `inputActions` exposed by
  `ctx.uiSession.provide()` to route Enter according to mode. Handles
  `/agent` and `/shell` prefix parsing. On agent-mode submit, injects
  the truncated PTY context block before the user message. Its view
  also carries the status card (Phase 9.11): a permanent one-line head,
  with plan / AI terminal / subagents / breakpoint / pipe-task / link
  rows whose details open on click.
  In shell mode the composer additionally owns two reading gestures,
  both in this package's browser face: Tab completion
  (`completion.ts`, which reads the position off the line with the
  standard layer's scanner and has `dshell-files`' `complete` resolve it
  in the session's own world)
  and the command hint (`command-hint.ts`) — the tail of a recent
  command ghosted at the caret and taken one word at a time with the
  right arrow, read from the terminal bridge's per-session history.
  The `↑` history list rides the completion list's own state under a
  second source. The hint's ghost is deliberately not a node inside the
  editor: the composer is a Lexical contenteditable, so the tail is a
  span in the composer's floating overlay placed from the caret's rect.
  Each of the three is switchable, and those switches live in the
  `dshell` settings document: the `dshell-mode` row's configuration page
  in the Plugins panel edits them beside the palette (`settings-card.ts`,
  mounted by `config-page.ts` with the data-directory card), and
  `shell-settings.ts` holds the
  client store with a pre-paint cache, and the key interceptor reads it
  through a ref so a flip cannot go stale.
  The view seat is `terminal-view.ts`, which chooses between the
  timeline and a full-screen program's own screen (`tui-surface.ts`):
  the timeline is UNMOUNTED rather than hidden, because it is what pushes
  the grid to the PTY, and `tui-css.ts` puts dsh's composer away for as
  long as the program holds the terminal (`tui.ts` keeps the reader's own
  decision about it) — § 18.
  The host half also owns the terminal-session identity table
  (`terminal-mode.ts`, document `terminal-mode.json` under the data
  root): one record per session that runs the integrated terminal,
  keyed by the dsh session id and carrying its origin (`section` for
  the sidebar's own button, `workspace` for one dsh created inside the
  adopted workspace, `legacy` for the id list this table replaced),
  its directory, the name dshell gave it, dshell's own archive and
  started bits, and the composer mode — which is why `shell` / `agent`
  survives a reload. dsh gives a plugin no durable per-session field
  of its own: `SessionCreateRequest` carries no metadata, a projection
  can only fold logged events, and an event type declared outside the
  dsh repository is unknown to its generated vocabulary, so a log
  carrying one is refused on the next cold read (`ignorable` is the
  escape hatch and live `append` cannot set it). The table is written
  through a temp file and `rename`, every mutation runs on one
  serialized chain, and a start-up reconciliation checks it against
  `sessionQuery`'s catalog: a record whose session is gone moves to
  `orphans` — reported, and dropped on the next reconciliation that
  still misses it — rather than being deleted on the spot.
- dsh services depended on: `ctx.uiSession`, `ctx.agents.inject`,
  `dshell-terminal-bridge` (for main PTY id, the agent stream and
  context buffer read), `ctx.sessions` (the status card's session
  titles, running bit and subagent catalog), `dshell-buffer` (its pipe
  rows; optional, reached through a late-binding seat),
  `ctx.get('workspaces')` (the browser half's membership test for a
  session dsh created in the adopted workspace) and
  `ctx.get('sessionQuery')` (the reconciliation's catalog; optional,
  and its absence means "cannot answer", never "nothing exists").
  The section's rows carry two more things. A pill at the row's end
  says where that shell runs — the device's name, or `本机` — on the
  metrics `dshell-ssh` already uses for the same pill on dsh's native
  rows, and read-only, because the host refuses to move a session that
  has history and a session that has none answers the question on its
  initialization page. And a rename: the row's title takes a
  double-click (dsh's own gesture) and its `⋯` menu offers the same
  action, both raising one `shell.overlay` entry that renders dsh's
  `Modal` and writes through `SessionFace.rename`, under a reference
  source this package declares (`dshellRename`). dsh's own rename
  dialog cannot be reused: its request channel is a local of
  ui-workspace's apply, not a service.
- Introduced in: Phase 5 (state and dispatch); expanded in Phase 7
  (injection), Phase 9.11 (status card), Phase 10.12 (Tab completion
  folds capitals), Phase 10.13 (the command hint) and Phase 10.14 (the
  assist switches).
- Touches decisions: 4.5 (mode state and prefix handling), 4.6
  (injection), 4.10 (status surface).

### `dshell-commands`

- Role: registers `/new` on `ctx.commands` (`/compact` is dsh's own
  command and is not re-registered), and three model-facing tools on
  `ctx.tools`: `dshell_get_agent_terminal` (Phase 9.11; it was
  `dshell_get_main_terminal` while the agent shared the user's shell),
  `dshell_terminal_read` (the user's shell: a delta from a cursor, or the latest
  commands), and `dshell_terminal_output` (Phase 10.9 — `(cursor, seq, offset,
  limit)` into one command's stored output, so a long command is read in bounded
  slices instead of injected whole).
- dsh services depended on: `ctx.commands`, `ctx.tools`,
  `dshell-terminal-bridge` (for the agent shell's PTY id returned by
  the tool, the read-only view of the user's shell, and the stored output
  slices).
- Introduced in: Phase 6 (commands); expanded in Phase 8 (tool),
  Phase 9.11 (own shell), Phase 10.9 (output slices).
- Touches decisions: 4.5 (real commands), 4.6 (agent access to a PTY
  id), 4.10 (agent-owned shell).


### `dshell-ssh`

- Role: device sessions. Two-faced Cordis package:
  - **Host face** owns the durable device registry (name, host, port,
    user, remote directory, login method; secrets in separate 0600 files
    under `$DSH_HOME/dshell/ssh/keys/`), the durable session→device
    assignment, and three seams: a wrapped `ctx.shell.resolve`, a
    subprocess route for `glob`/`grep`, and a replacement `ctx.fs`
    provider that resolves a bound session's tree over SSH. It also
    publishes `dshellSshRouting` for packages that need to know which
    device a session runs on.
  - Every remote action goes through `src/transport/`, an in-process
    `ssh2` client — there is no host `ssh` binary, no `~/.ssh/config`
    and no ssh agent anywhere in the stack. See
    [`dshell-architecture.md`](./dshell-architecture.md) § 19 for the shape
    and for what that excludes.
  - An assignment always carries the local **mount** directory that stands
    in for its device tree, because the `ctx.fs` seam refuses to guess one:
    a binding without a mount routes the shell only, and every file
    operation of a session that is visibly on a device then silently lands
    on this machine. `bind` derives it (`mountPath`) and creates it when
    the caller names none — no caller does — and the load repeats the
    derivation for assignments written before that rule, so a device
    session keeps its files on the device across the upgrade. An
    assignment whose device is gone is left alone.
  - **A device session has no local half.** All three seams (files,
    byte-level device ops, subprocess spawn) plus the shell `resolve` wrap
    and the visible terminal's spawn plan distinguish "not bound" from
    "bound to a device nothing can serve" — the device was deleted, or the
    binding has no mount — and the second is a refusal
    (`route.noDevice`), never a fallback. Falling through to `super` would
    hand a device session this machine's disk while every layer above
    reports a successful operation on the device, which is the risk this
    package exists to remove.
  - **A binding that lands late replaces the shell it missed.** A session's
    terminal is spawned when the session is opened, and the creation page
    records the assignment a round trip after the session exists — so the
    plan the shell was spawned under can be the *local* one. The bind route
    therefore asks the terminal bridge (`respawnMain`) to replace a live
    shell whenever the assignment's device or mapping actually changed; the
    replacement is an ordinary respawn, so the scrollback survives. Without
    it the spawn-plan seam's whole promise — no local shell behind a
    device's name — would hold only for sessions born on a device.
  - **The bindings document is shared by every host on the machine, so it
    is read-modify-write.** The web host and the desktop host run side by
    side over one `bindings.json`; a store that caches it at startup and
    writes the cache back whole turns the other host's binds into
    deletions, and a session whose row vanished keeps its live shell while
    its pill falls back to this machine — the pill naming one machine and
    the terminal answering from another. Every mutation therefore applies
    to what is on disk now, and every listing re-reads, so two hosts keep
    each other's rows.
  - **A shell's death never takes the host down.** Teardown kills the PTY
    and the exit callback then fires into a stopped context; demanding a
    required service there throws, and an uncaught throw in an exit
    handler used to exit the whole host — every session in it "dropping"
    at once. `markDead` treats the reservation release as best-effort.
  - **The mapping has an alias root** (`mappingFor`, the one place a
    mapping is built): a session created first and pointed at a device
    later — every session of the sidebar's terminal section — has a
    working directory on this machine that the harness cannot move, and
    dsh's file tools resolve relative paths against it. That directory is
    therefore translated as the device's root, so `read notes.md` reaches
    the device's `<remoteRoot>/notes.md` instead of a `/home/reader` the
    device may really have. The mount wins where the two overlap (dshell's
    mount tree lives under the reader's home), and any other absolute path
    still travels unchanged, because addressing the device directly is the
    point of the session. The model needs no idea this happens.
  - Credential and host-trust posture (see `src/transport/auth.ts`,
    `src/transport/known-hosts.ts`): a device with a stored key connects with
    **only** that key (a key credential means key auth; a password credential
    means password auth — the pair is derived when the device is saved, so a
    mismatched one cannot be stored), a password is handed to the client
    directly rather than through an askpass helper or a command line, host keys
    are trusted into `$DSH_HOME/dshell/ssh/known_hosts` (OpenSSH's hashed
    format, read and written by this package) rather than the user's personal
    file, and connections are pooled per device and rebuilt when the credential
    changes. A successful connection **test** reports the fingerprint it trusts
    — `主机密钥 SHA256:…（首次信任…／已信任）` — read back from that store, since
    trust-on-first-use otherwise records a first contact silently. Hardware keys
    (`sk-*`, PKCS#11), `~/.ssh/config` (ProxyJump, ProxyCommand, Include) and
    agent forwarding are NOT supported; see `dshell-architecture.md` § 19.
  - **Browser face** provides the `dshell-ssh` row's configuration page in
    the Plugins panel (dsh's `plugins.row.config` seat, keyed
    `<bundle>#dshell-ssh`) — the device registry is configured beside the
    plugin it belongs to — and the `dshellSsh` service the session picker
    and the new-session dialog read.
- dsh services depended on: `ctx.settings`, `ctx.shell`,
  `ctx.subprocess`, `ctx.fs`, `ctx.agents`, `ctx.connection.fetch`.
- Introduced in: Phase 9.6; connection failure handling in Phase 9.7.

### `dshell-buffer`

- Role: the cross-session pipe. Two-faced Cordis package:
  - **Host face** owns links (created only by the user, never by an
    agent), deferred requests with a claim/progress/finish/fail
    lifecycle, scoped revocable grants, and the watchdog that
    settles anything nobody settled. It contributes one model-facing
    tool, `dshell_buffer`, as the single door to all of it, plus one
    system-prompt section stating the protocol. Every granted area is
    named at creation (`as`, or the path's last segment, suffixed to
    stay unique on the grantee's side) and that name is the whole
    contract between the two sessions: the buffer namespace is rooted at
    `/`, one namespace per session, and grant ids never leave the host.
  - **Browser face** provides the pipe panel in the frame-wide
    `shell.overlay` seat and the `dshellBuffer` service the entry button
    toggles — that button is the link glyph first in dshell-mode's
    terminal section header, the only chrome dshell owns in the sidebar.
    The panel drops any session the host reports
    as `departed` — a session dsh disposed — from the graph nodes and the
    endpoint pickers. A disposal hides at once and settles its pipes only
    after a grace, because `session/disposed` is also how a host shutdown
    says goodbye and must never persist "every ticket failed"; whatever
    the grace never saw, a boot reconciliation against dsh's cold session
    catalog (`sessionQuery.listSessions`, the same listing the sidebar is
    built from) settles, so state older than this path heals too.
    Archived sessions are filtered the same way, from both dsh's archive
    set and dshell's own archive bit — an archived session is put away
    rather than wired, and only one that already holds a pipe keeps its
    node, so a live pipe never loses an end. The graph itself opens on
    the related sessions (piped, plus this one) with a header toggle for
    the full list, follows the app theme, lays out on a grid and carries
    React Flow's zoom controls; wires are drawn by dragging a node's
    handle onto another node, or created from the list view's form.
- A pipe joins dshell's terminal sessions only, and the host enforces it
  (`createLink` refuses an end the terminal-mode registry does not list): a
  plain dsh conversation or a subagent is not something the rest of dshell can
  serve a request from, and the panel filters the same set out of its graph
  and its endpoint pickers. A composition without dshell-mode has no such
  registry, and then nothing can tell — the check is skipped.
- A pipe carries a name and a short purpose, and both ends write them: the
  user from the panel (at creation or in the pipe's detail), an agent with
  `dshell_buffer action="describe"` — which is how a model that has learned
  what a pipe is for records it for its peer. The purpose is what the peer's
  assembled prompt states next to the pipe, and `annotatedBy` keeps a peer's
  words from reading as the user's in the panel.
- dsh services depended on: `ctx.tools`, `ctx.systemPrompt`, `ctx.fs`,
  `ctx.agents`, `ctx.sessionController`, `ctx.sandboxPolicy` (optional),
  `ctx.shell` (cross-world byte transfer), `ctx.connection.fetch`; the
  browser face uses `ctx.slots`, `ctx.sessions`, and reads
  `ctx.workspaces` and dshell-mode's `ctx.dshellTerminalMode` structurally
  for the two archive sets it filters sessions by.
- Reads `dshellSshRouting` structurally when present, to probe a
  device-bound target before admitting a delegation; a composition
  without dshell-ssh simply has no device to check.
- Cross-world byte moves (`download` / `upload`) write into the target
  world by one of three lanes: `ctx.deviceFs` while the device's helper
  is up, `ctx.shell` with the bytes as base64 on stdin when it is not,
  and `node:fs` only for a world that runs on this machine — a device
  spelling must never reach the host filesystem. Above the inline
  ceiling the bytes move in chunks, verified by a sha256 each world
  computes in its own terms.
- Introduced in: Phase 9.8.

### `dshell-files`

- Role: the right sidebar's file navigator, roaming without bound, plus
  the two-pane file transfer beside it. Two-faced Cordis package:
  - **Host face** registers two connection routes. `/api/dshell/files`
    has four actions. `list` resolves the session's agent, then inside
    `withInitiator` resolves `stat` (must be a directory) and `listDir`
    and answers with the canonical absolute path in that session's own
    execution world. A request that names no directory gets the one the
    session stands in, spelled in that world (`sessionDirectory`): for a
    device-bound session whose own working directory is a path on this
    machine — a terminal session is created in the reader's home and only
    afterwards pointed at a device — that is the device's root, since the
    local path is not a place the device has. A session created inside the
    mount keeps its directory, which the seam translates. `cd` sends the
    session's main shell into one such
    directory, through the terminal bridge's own input path — the same
    one a keystroke takes, so the command is tracked and rendered like
    any typed command. `complete` answers one line's Tab: the standard
    layer's scanner reads what the line expects at the caret (a command
    name, an argument, a flag, or a redirection's target), the route
    picks the source accordingly — the world's `PATH` plus builtins for a
    command, one directory read in that world for a path, directories
    only after `cd`, and, in a second `refine` pass, the session's own
    shell (`shell-completion.ts`: a `bash -c` probe in that world, whose
    line travels as an argument and never as script text) for the flags
    and subcommands only bash-completion knows — and returns the span,
    the position and the candidates — **matched with ASCII
    capitals folded**, because the comparison is a guess about what the
    reader meant while every path it looks up stays exact, and a
    candidate keeps its real spelling so choosing it (or being the only
    one, which applies it) corrects the line. `resolve` canonicalizes one
    path, which is how the composer learns what a `cd` did; it answers
    only for a directory, so a `cd` that failed cannot move that mirror.
    The route exists because dsh's own
    `workspaceFiles.list` is fenced to the workspace root; `ctx.fs` is
    the same seam, just without that fence, and the sandbox only fences
    writes, so listing is at the same trust level as `read`.
    `/api/dshell/transfer` serves the transfer view: `state` (both roots,
    the device, whether a transfer is possible at all), `list` (one side's
    directory), `copy` (starts a job and answers with it), `job` and
    `cancel`. Its two worlds are the session's own (a device tree over the
    same routing, this machine otherwise) and **this machine**, reached
    through the explicit agentless boundary; reads go through `ctx.fs` as
    each side, and writes go through `ctx.shell` with the payload riding
    stdin as base64 (the filesystem seam has no byte write) for a device
    destination, and through `node:fs` in process for a local one — which
    is what that world already is, the same assumption the local pane's
    root makes by asking `os.homedir()`.
  - **Browser face** registers its own `SidebarRightTabDefinition` for
    the `files` kind at `priority: 'extension'`, shadowing the stock
    body (which resumes if this row is removed) and contributing the
    required guide entry that keeps the pane's default page. The pane
    draws a `..` row, clickable path crumbs, back/forward history and a
    reload button, plus a jump button that moves the session's shell
    into the directory on screen — drawn only when the host reports it
    can (no terminal bridge, no button) — and, for a device session, the
    button that opens the transfer tab. Directory rows and the `..` row
    are drag sources for the same jump, carried by pointer events rather
    than HTML5 drag and drop (a native drag session cannot be observed or
    corrected when the browser refuses the drop), released over the
    terminal view the block view mounts, which is outlined while the
    pointer is over it. Navigation state lives in a declared
    per-session store bucketed by tab id, because the pane unmounts the
    inactive tab's body but the store survives. The listing that opens a
    tab names no directory: the browser only knows the session's directory
    as this machine spells it, so the host answers with the one that
    session's world has and the store re-bases the tab onto the path it was
    given — a device session's pane opens on the device's root rather than
    on the local home it was created in. Every later listing names its
    path, including a walk back to a device directory that happens to spell
    like the local one.
  - The transfer tab is the same package's second `SidebarRightTabDefinition`
    (`kind: 'transfer'`, a page type, and deliberately **no guide entry**:
    the pane's default page is the sole guide entry's kind, so a second entry
    would move every session's default page onto the guide). Its body draws
    two trees — this machine on the left, the device on the right — over the
    navigator's own rows and levels, and drags an entry from one to the other
    with the same pointer-event technique; a drop lands in the directory row
    under the pointer, or in the receiving pane's own directory. Copies are
    jobs the view polls, so a long directory copy has a progress line, a
    cancel and a conflict question ("overwrite?") instead of a request that
    hangs; the two tab types share one store instance.
- dsh services depended on: host — `ctx.connection.fetch`,
  `ctx.agents`, `ctx.sessionController`, `ctx.fs`, `ctx.shell` (the
  byte-write seam of the transfer), optionally
  `ctx.dshellTerminalBridge` for the shell jump and `ctx.dshellSshRouting`
  for the device side of a transfer; browser — `ctx.slots`, `ctx.locale`,
  `ctx.sidebarRightTabs`, optionally `ctx.dshellSsh` (is this session a
  device session with a mount?), and the `sidebar.right.pane.tab` standard
  props (`ctx.sessions` for the session id and cwd).
- Introduced in: Phase 9.9.

### `dshell-usage`

- Role: the Settings → 用量 page — a daily calendar heatmap and the
  headline figures over the whole window, a per-model curve, a share pie,
  and a per-route table. Two-faced Cordis package:
  - **Host face** owns one SQLite index under dshell's data root
    (`<root>/usage/usage.sqlite`, `PRAGMA user_version = 1`), a scanner
    over `ctx.sessionQuery`, and `/api/dshell/usage`. Reading is a
    `summary` action; the page's rebuild is a `scan` action, because the
    scan belongs where the events already are.
  - **Browser face** registers one `settings.section` entry — the same
    seat dsh's own Plugins page takes — paints the calendar as plain DOM
    and the charts as hand-rolled SVG (`buffer`'s `pipe-graph.tsx` is the
    only other `.tsx` in the tree), and patches its own navigation row's
    icon (see below). It scans once when the page opens, so a reader who
    never presses 「重新聚合」 still sees current numbers.
- Where the numbers come from: dsh attaches provider-reported accounting
  to the `assistant/message` event itself (`data.usage`) and the same
  event's `data.message.source` names the route, so usage and route
  travel together and nothing is paired up or inferred. A turn that
  reported no usage, or no route, is skipped rather than bucketed under
  nothing.
- Incremental by session: the index keeps the highest seq counted per
  session, so a rescan skips a session whose log has not grown after a
  cheap metadata listing. `day` is `YYYY-MM-DD` in the **host's** local
  time, decided at scan time.
- One unreadable log does not stop the accounting: dsh refuses to
  migrate some older artifacts, and a scan that let that refusal escape
  wrote nothing at all (the index sat a week stale while the pipes ran).
  A session the scanner cannot decode is counted as `skipped`, keeps its
  cursor so a later scan retries it, and travels to the page in the scan
  report — the page says the totals are partial, and why, instead of
  presenting them as the whole.
- The page reads the calendar from its own all-time day totals (`heat` in
  the summary): a fixed 26-week rectangle filled top-to-bottom then left
  to right, so the newest day is always the bottom-right cell and moving
  the range chips never re-shapes it. The range, the headline figures,
  the curve, the pie and the table are windowed; the calendar is not.
- The 用量 navigation row draws its own gauge: dsh's settings shell picks
  a nav icon from a map of the section ids IT ships and draws a generic
  gear for every other id, and rc.2's `settings.section` seat carries no
  icon — so `client/nav-icon.ts` patches that one row's svg (the artwork
  copied verbatim from the primitives package). It exists only until that
  seat accepts an icon.
- Writes are batched on purpose: a scan folds in memory and calls the
  store once, and concurrent triggers share one flight behind a
  minimum interval (30 s) plus a debounce — a host with a busy agent
  still writes at most once per window, never once per model turn.
- Introduced in: the 0.1.6 line, after the alpha.2 alignment. It has no
  roadmap phase yet — the page exists and is verified by
  `packages/dshell/usage/tests/`, not by a phase entry.


### The publishing environment (this deployment)

- **An alpha never reaches GitHub.** An alpha goes to npm under the `alpha`
  dist-tag and stops there: no git tag, no GitHub release. The npm dist-tag
  is the whole of the alpha's reach, and it is enough — it is where a tester
  installs from, and it is what a rollback returns to.

  The reason is the audience. A GitHub release is announced to everyone who
  starred the repository, and a star is a statement about the project, not
  about a release candidate. Every star of this repository would get a
  notification about a build nobody asked for, and the second one would be
  the one that taught them to ignore the channel. A git tag is quieter but
  not silent — it shows up in the releases list and in every clone — so the
  alpha does not get one either.

  A stable release is different: it gets the git tag and the GitHub release,
  because that is what a star IS a subscription to.

- The npm CLI here defaults to the **npmmirror** registry: `~/.bashrc` exports
  `npm_config_registry="https://registry.npmmirror.com/"`. That mirror is
  read-only, so every publish must pass `--registry=https://registry.npmjs.org/`
  explicitly (installs may keep using the mirror). Symptom of forgetting: `npm
  whoami` answers "need auth", because the npmjs-scoped token is not sent there.
- The account is `nexus-aethra` and its 2FA is `auth-and-writes`, so a publish
  needs either a one-time code (`--otp=`) or a granular access token with
  "Bypass 2FA" enabled.
- The packages publish under that account's own org scope
  (`@nexus-aethra/dshell-*`). `@deepseek-ai/…` is dsh's own npm org and is not
  publishable by an outside account.
- Publish order is dependency order — `dshell-std` first, `dshell-bundle` last —
  because each package's `workspace:^` edges become `^<version>` ranges that must
  already resolve.
- **Publish with `pnpm publish`, never `npm publish`.** Only pnpm rewrites the
  `workspace:` protocol into a real range on the way out; npm ships the specifier
  as written, so every published manifest keeps `"@nexus-aethra/dshell-std":
  "workspace:^"` and every install of the result dies with
  `EUNSUPPORTEDPROTOCOL: Unsupported URL Type "workspace:"`. 0.1.4 was lost this
  way. The check that would have caught it before publishing: pack the tree and
  grep the tarballs for a surviving `workspace:`

  ```bash
  for d in packages/dshell/*/; do (cd "$d" && pnpm pack --pack-destination /tmp/dshell-packs); done
  for f in /tmp/dshell-packs/*.tgz; do
    tar -xzOf "$f" package/package.json | grep -q 'workspace:' && echo "STILL workspace: $f"
  done
  ```

- **A bad version cannot be withdrawn here.** `npm unpublish` is refused for the
  release token: it is a granular token with 2FA bypass, and npm answers
  `403 Granular access tokens that bypass two-factor authentication may not
  perform this action`. Withdrawing needs a session login (password + OTP) in a
  browser, which the release flow does not have. `npm deprecate` *is* permitted
  and is the available mitigation — so a broken version stays on the registry
  under a warning, and the fix ships as the next version number.

### Verifying a published artifact

`scripts/local-registry.mjs` serves packed tarballs over the npm registry
protocol (metadata + tarball endpoints, everything else proxied upstream), and
the check is: pack, install from that registry into a profile whose core
packages are linked to the checkout, then boot it.

```bash
for d in packages/dshell/*/; do (cd "$d" && pnpm pack --pack-destination /tmp/dshell-packs); done
node scripts/local-registry.mjs --port 4873 --dir /tmp/dshell-packs   # another shell
pnpm add @nexus-aethra/dshell-bundle --save-exact \
  --config.registry=http://127.0.0.1:4873
```

A pass looks like: the install succeeds, `dsh.profile.bundles` gains
`@nexus-aethra/dshell-bundle`, the booted profile answers
`/api/dshell/buffer`, `/api/dshell/files` and `/api/dshell/stream` (the stream
one holding the connection open), and the served client bundle
(`/plugins/??<list>&rev=<rev>`) contains the dshell faces.

The desktop application itself can only talk to `https://registry.npmjs.org/`
(`DESKTOP_REGISTRY` is a constant in `apps/desktop/src/project-manager.ts`), so
a private registry is not reachable from its plugin window without an upstream
change; `dsh plugin` plus `--config.registry` is the equivalent path the recipe
uses.

## What is not a dshell package

The following dsh components are reused unchanged. They are listed here
so the inventory is complete; do not introduce wrappers for them.

- `dsh-terminal` — the PTY service and backend registry (`ctx.terminals`).
  dsh's web surface mounts it only inside the minimal preset's isolated
  `terminals` realm, so the dshell bundle's patch names it at the host
  plane and the installer adds the package to the profile; dshell's bridge
  registers the backend dsh then drives. `dsh-terminal-bash` (a bash
  backend) is deliberately NOT mounted: it would race that bridge for the
  same `shell` backend name (DUPLICATE_BACKEND).
- `dsh-session-persistence-jsonl` — supplies session log storage.
  dshell never touches this; the session log stays where dsh puts it.
- `dsh-compaction` and `dsh-session-title-*` — used unchanged by
  `/compact` and by session naming. dshell does not override them.
- `xterm.js` — third-party browser dependency. Imported from
  `dshell-conversation`'s browser face; not a Cordis package.

## Dependency graph

```
dshell-std                    (the standard layer: contracts + seam adapters)
  ▲
  │ every package below imports its wire contracts from here
  │
dshell-bundle
  ├── dshell-conversation
  │     ├── dshell-terminal-bridge (host face)
  │     └── xterm.js (browser face)
  ├── dshell-mode
  │     ├── dshell-conversation
  │     └── dshell-terminal-bridge
  ├── dshell-commands
  │     └── dshell-terminal-bridge
  │     └── dshell-buffer     (optional: the sidebar `管道` entry)
  ├── dshell-buffer           (optional: reads dshell-ssh's routing face)
  │     └── dshell-ssh        (optional: target reachability probe)
  └── dshell-files            (shadows the stock `files` sidebar tab; also
        │                       registers the `transfer` page type)
        ├── dshell-terminal-bridge  (optional: the pane's shell jump)
        └── dshell-ssh              (optional: the device side of a transfer,
                                     read as a structural seat)
  └── dshell-storage          (library, not a row: the SQLite medium behind
                                dshell-std's storage contract, consumed by
                                dshell-terminal-bridge)
  └── dshell-usage            (the Settings → 用量 page: its own SQLite index
        │                       over every session's reported usage)
        └── dsh-session-query       (optional: reading history's events)
```

There are no cycles. `dshell-std` has no dependency at all: it is the
  layer that keeps a dsh change from landing once per package.
  `dshell-bundle` is the install root; the others are leaves or
  single-level consumers of the bridge. The optional edges exist only
  when both rows are composed — each side reads the other through a
  structural seat, never an import. Every edge to `dshell-ssh` is
  a runtime seat: no package depends on it at build time any more.

## Cordis `ctx` keys dshell publishes or subscribes to

### Subscribes to

- `ctx.uiConversation.events` — registers the target `terminal`'s
  NodeDefinitions (in `dshell-conversation`, host face).
- `ctx.uiConversation.views` — registers the `terminal` ViewDefinition
  (in `dshell-conversation`, host face).
- `ctx.connection` — registers the frame stream and the history read
  (in `dshell-terminal-bridge`, host face): `/api/dshell/stream`,
  `/api/dshell/stream/send`, `/api/dshell/pty`.
- `ctx.webServer` — registers the `/dshell/pty` ws upgrade (in
  `dshell-terminal-bridge`, host face; the browser's fast path).
- `ctx.terminals` — `spawn` / `startSend` / `readOutput` /
  `signal` / `kill` / `list` (in `dshell-terminal-bridge`).
- `ctx.agents` — `inject` (in `dshell-mode`) and session id lookup
  (in `dshell-terminal-bridge`).
- `ctx.commands` — registers commands (in `dshell-commands`).
### Publishes

- `ctx.dshellMainPty` — `Map<Agent, TerminalSessionId>`. Read by
  `dshell-mode` and `dshell-commands`. Exposed for inter-plugin
  coordination only; not a service consumed by dsh.
- `ctx.dshellPtyBuffer` — per-session rolling buffer of recent
  `main` PTY output (≤ 100 lines / 4 KiB). Read by `dshell-mode`
  when injecting context.
- `ctx.dshellSshRouting` — dshell-ssh's router, so dshell-buffer can ask
  which device a session runs on and probe it before admitting a
  delegation.
- `ctx.dshellBuffer` (client) — the pipe state and its mutations. Read by
  the terminal view's status card, and by the terminal section's header
  entry (the link glyph, leftmost), which is where the `管道` button lives
  now that dshell-workspace is gone.

### Replaces

Nothing. dshell replaces no stock service any more: the workspace stand-ins went
with the stock rows they stood in for (both are enabled again), and the browser
provider went with the browser rows. The only stock row dshell still owns is
`fs-sandbox`, and it is disabled so `dshell-ssh` can hold the single `ctx.fs`
provider (see the bundle patch).


No new public `ctx` key is added to dsh itself.