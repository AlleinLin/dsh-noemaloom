# dshell Development Roadmap

Each phase ends with a runnable artifact that exercises a real slice of
dsh's existing extension points. Do not move to the next phase until the
current one ships its acceptance check.

The phases are ordered so that each one adds one decision from
[`dshell-design.md`](./dshell-design.md). Skipping ahead risks rebuilding
because decision points become load-bearing later.

## Phase 0 — Repo scaffold

Goal: the dshell workspace exists as a sibling to `dsh/` and pnpm picks
it up.

Deliverables:

- `/home/wpp/nexus/Nexus-Shell/` initialized as a pnpm workspace.
- A workspace `package.json` that references `dsh/` as a local workspace
  root or pulls dsh packages via npm `@deepseek-ai/dsh-*` ranges.
- One placeholder `packages/dshell-meta/` package with an empty plugin
  to prove the workspace builds.

Acceptance check:

```
cd /home/wpp/nexus/Nexus-Shell
pnpm install
pnpm -F @deepseek-ai/dsh-* run build
# (dsh's bundled CLI runs against this workspace)
npx @deepseek-ai/dsh web
# Web UI loads at 127.0.0.1:3080
```

## Phase 1 — Bundle + empty target

Goal: register a `terminal` target that renders nothing yet, but proves
the target registration path works.

Covers decision: 4.1 (session isolation) at the registration level.

Plugins touched:

- `dshell-bundle` (new) — patches the `web` profile to include the
  browser half packages.
- `dshell-conversation` (new, host face only) — registers a
  `ConversationViewDefinition` for target `terminal` whose
  `ViewBuilder.empty` returns a `Snapshot` with an empty `rows` array.

Acceptance check:

```
npx @deepseek-ai/dsh web --profile web
# Sidebar lists sessions. Main panel shows the new "terminal" target
# (selected via settings) with an empty viewport. session/event still
# drives the chat target because nothing changes that one.
```

## Phase 1.5 — Workspace removal

Goal: the workspace concept is gone from the running shell — no picker
gate, no sidebar grouping, sessions created directly by cwd.

Covers decision: 4.7 (workspace removal).

Plugins touched:

- `dshell-workspace` (new, two-faced) — host face provides a minimal
  `workspaceRegistry` stub so `session-controller`'s inject resolves;
  client face provides `workspaces` + `uiWorkspace` stubs and the
  root `workspaces` hook that ConversationRoot requires.
- `dshell-bundle` — inserts the `dshell-workspace` row and disables
  the stock rows `workspace`, `workspace-controller`, `ui-workspace`,
  `directory-picker`.

Acceptance check:

- dsh web boots with the four stock rows disabled and dshell's
  replacements active; no pending-fiber hang, no missing-root-hook
  crash.
- The composer is live without any workspace pick; creating a session
  goes through `sessions.create({ cwd })` with no workspace attached.
- The sidebar shows one flat session list; no workspace picker or
  grouping anywhere in the UI.

## Phase 1.6 — New-session dialog

Goal: session naming, start directory, and agent preset are chosen at
creation time.

Covers decision: 4.7 (naming paragraph).

Plugins touched:

- `dshell-workspace` (browser face) — the flat list gains a new-session
  dialog (optional name + starting directory + agent-preset picker);
  `uiWorkspace.startSession` (the shell's stock New-Session button)
  opens the same dialog instead of creating silently; the stock hero
  workspace chip is hidden by an interim stylesheet until the Phase 4
  scaffold takeover removes the whole hero row. The preset roster comes
  from `ctx.remote.agentPresets.list()` (injected as
  `remote.agentPresets`), broken compositions are dropped from the
  picker, and the choice is applied with `select(sessionId, presetId)`
  while the session is still blank — a started session refuses the
  switch. The name falls back to the start directory's basename, so an
  empty name still pins a title and the first message's automatic
  title cannot rename the session.

Acceptance check (verified in the browser):

- `＋ 新会话` (list header) and the shell's `新会话` button both open the
  dialog.
- The preset picker lists `跟随默认` + the shipped roster
  (`标准模式（默认）` / `PTC 模式` / `极简模式` / `创造模式`); picking
  `极简模式` shows that mode in the session header.
- Creating with a name lands in the sidebar under that name; creating
  with a custom directory creates the session in it; creating with no
  name lands under the directory's basename and keeps it after the
  first agent turn.
- The hero workspace chip no longer renders.

## Phase 2 — Main shell lifecycle

Goal: bridge owns a `name: 'main'` PTY for the active agent; the PTY
streams bytes into a host-side buffer; nothing is rendered yet.

Covers decision: 4.2 (main shell ownership).

Plugins touched:

- `dshell-terminal-bridge` (new, host face) — owns
  `mainPtyByAgent: Map<Agent, TerminalSessionId>`; calls
  `ctx.terminals.spawn` lazily; reads bytes through `readOutput`.
- `dshell-conversation` (host face) — exposes a typed channel from the
  bridge's PTY buffer to the browser-side `ViewBuilder`.

Acceptance check:

- A test agent (`ctx.agents.create({ sessionId })`) gets a main shell
  on first access; `ctx.terminals.list(agent)` contains
  `{ name: 'main' }`.
- A second `terminal_open({ name: 'main' })` from the agent creates a
  separate session; `mainPtyByAgent` is untouched.
- The bridge's per-session buffer accumulates bytes after `startSend`.
- The buffer persists to `$DSH_HOME/dshell-pty/<session-id>.log`
  (design 4.9; owner-only — `0600` files in a `0700` directory since Phase 10.10,
  which also tightens files an earlier build left `0664`); memory holds only the
  fixed window; a fresh main shell
  for the same session seeds from the file tail, and the prompt-rewrite
  init restores that snapshot instead of emptying the log — truncating
  it wholesale (the first cut) erased the previous shell's scrollback on
  every harness restart, since the seed had already been loaded.

Status: implemented together with Phase 3 (the ws transport is the
first consumer of the buffer and the tail loop).

## Phase 3 — WebSocket transport

Goal: a browser running the dsh Web UI can connect a ws to
`/dshell/pty` and see main shell bytes stream into the page.

Covers decisions: 4.2 (routing), 4.4 (delivery, host half).

Plugins touched:

- `dshell-terminal-bridge` (host face) — adds `registerUpgrade` on
  `ctx.webServer`.
- `dshell-terminal-bridge` (browser face, new) — opens ws from the
  active session binding; relays bytes to a console log first, before
  any rendering.

Acceptance check:

- With dsh web running, opening the browser console shows PTY bytes
  arriving as the agent (or a test agent) writes to `main`.
- The ws respects `{ kind: 'bind', sessionId }` authorization: a bind
  with a wrong id is rejected and closed.

## Phase 4 — Fused terminal surface

Goal: dshell owns the conversation surface without forking dsh's
layout. The stock `conversation.bar` composer stays in place — it is
dsh's InputBar, and dshell borrows it wholesale for its `/` | `@`
trigger popup, context-occupancy ring, model select, attachment
surface, and send/stop. dshell contributes exactly two entries into
the stock slot tree:

- `conversation.input.left` — the dual-mode chip (`$ shell` /
  `✦ agent`) plus the shell-mode hint.
- `conversation.view` (id `chat`, shadowed) — the PTY canvas takes
  over the stock chat cell rather than registering a sibling tab:
  the view preference falls back to `chat`, so the canvas is what
  renders there with no second view and no tab split. The canvas
  interleaves PTY output with session records (design 4.4) and long
  assistant/tool records render collapsed with a click-to-expand
  header. The terminal background is transparent so the canvas blends
  with the app surface instead of painting its own card.

The earlier attempt to shadow `conversation.composer.bar` with a
self-built dock was abandoned: it dropped every stock composer feature
(no `/` popup, no context meter, no model select) and left the page
layout to hand-written CSS overrides that fought the stock flex chain.
Borrowing the composer and adding slots keeps the stock layout intact.

Covers decisions: 4.1 (terminal-first surface), 4.5 (mode state),
4.8 (terminal layout).

Plugins touched:

- `dshell-mode` (browser face) — registers the mode chip, the canvas
  view, the `/shell` `/agent` slash source, and the Settings palette
  row. The per-session mode store (`shell` | `agent`, default `shell`)
  drives both rendering and input: in `shell` mode a capture-phase
  listener routes the composer's Enter (and its primary send button) to
  the bridge PTY and clears the stock draft through
  `inputActions.setDraft`; a leading `/` is always left to the stock
  trigger pipeline so `/new`, skills, *and* dshell's own
  `/shell` `/agent` keep working. In `agent` mode the stock submit path
  runs untouched.
  - `/shell` and `/agent` are **client-side** commands, not host
    `ctx.commands` rows: they flip a browser store, which no host
    handler can reach. Registered through `ctx.inputTriggers` as a `/`
    source (`name: 'dshell'`): menu rows in the `/` popup plus a
    `matchEnter` claim whose local `CommandClaim.submit` sets the mode
    and returns a notice — no RPC and no durable `command/run`/`done`
    pollution. `/terminal` stays a typed alias for shell; typed args
    (`/shell ls`) run immediately after the switch.
  - The palette picker is a `settings.general.item` row (Settings ›
    General), not a composer chip: four palettes write the module-level
    theme store, and the canvas view + mode chip read it through a
    `useSyncExternalStore` hook, so a palette change re-themes xterm in
    place.
- `dshell-conversation` (browser face) — registers the no-renderer
  `ConversationViewDefinition` on target `terminal` (`isActive` →
  `true`) and re-asserts `terminal` activation on every sessions-list
  and view-slot change. Activation must not race the stock `chat`
  fallback: the strip offers the user a real choice between `会话` and
  `轨迹`, but `会话` is the default, so the terminal target is asserted
  rather than merely offered.
- `dshell-workspace` (browser face) — hero chrome hiding
  (`heroWorkspaceRow`, `headline`), the hero composer bottom-pin, and
  the composer's input-line restyle: the stock card's 22px radius,
  surface fill, elevation shadow, and hairline stroke are stripped and
  replaced with a single bottom rule spanning the column (design 4.8).
  The submit button is restyled the same way: the stock 34px filled blue
  circle with an up arrow promises "send a chat message", which is the
  wrong reading for a composer whose text goes into a shell, so it
  becomes a transparent return-key glyph that agrees with the Enter key
  that actually submits. Send and Stop share the `primary` class, so the
  glyph is selected by SVG shape (`:has(svg path)` — the stop icon is a
  `rect`) rather than by the aria-label, keeping it locale-independent.
  The old `[data-phase="active"]` overrides (including `viewArea
  { display: none }`) are gone: the stock active layout is where the
  canvas and composer belong. The `uiWorkspace` stub also implements
  dsh rc.1's added navigation actions (`openSession`, `openWorkspace`,
  `forkSession`) against the cwd-session model: selecting a session is
  the stock `open`, "open workspace" lands on the terminal-continuity
  blank session, and fork uses the session controller's `fork`.

Acceptance check (current state — see screenshot in conversation):

- New session creation opens straight into a full-column fused
  terminal: PTY scrollback fills the column above an input line pinned
  to the bottom, separated by one rule rather than a dialog card. The
  hero banner ("探索未至之境") and centered composer are gone.
- Shell input roundtrips: typing `echo hi` and pressing Enter sends to
  the main PTY; the next prompt appears in the scrollback above.
- Mode toggles: clicking the `$ shell` / `✦ agent` chip flips mode;
  typing `/shell` and `/agent` in the composer flips mode with a
  notice; the two commands also appear in the `/` popup under a
  "dshell" group.
- Model chip lists the shared directory and updates selection in
  sync with `/model`.
- Settings › General carries the "终端配色" row; picking a palette
  re-themes the canvas and the mode chip.

### 4.x Shell-interaction mechanics (hard-won constraints)

- **The main shell is a push-based raw PTY, not a polled tail**
  (superseded in Phase 5). The bridge registers its own
  `TerminalBackend` (`dshell-pty`: plain node-pty bash,
  `TERM=xterm-256color`) and pushes raw ANSI chunks to the browser
  canvas. The original pull model — poll `ctx.terminals.read`, diff
  the retained text against the previous tick, broadcast the prefix
  extension — existed because dsh's scrollback is a mutating stream:
  the trailing prompt is a partial line that grows in place, echo
  completion rewrites the last line, and `split('\n')` counts all of
  it. A seen-lines cursor double-consumed the prompt line (duplicate
  prompts/commands) and consumed phantom empty lines (lost echoes);
  even the content-diff variant lagged a tick behind. Raw push
  deleted the whole class: ANSI colors reach xterm.js untouched, and
  agent-facing reads strip ANSI on demand.
- **`clear` is a bridge operation, not bash's ANSI clear.** The
  sanitizer historically stripped ANSI clear from scrollback, so the
  bridge owns the wipe: truncate the retained buffer, broadcast a
  replay (the canvas redraws the merged timeline), queue a newline so
  bash prints a fresh prompt. Init writes the custom PS1 +
  `PROMPT_COMMAND` (OSC 133;D marker) once, then `clear`; every
  session open starts from a replayed clean prompt.
- **Focus follows mode (design 4.8), and the terminal chords work from
  both focus owners.** Shell mode focuses the xterm canvas so raw keys
  reach the PTY: `term.onData` forwards them while the mode ref says
  `shell`, so Ctrl+C arrives as `\x03` (SIGINT), and Tab / arrows /
  every readline key pass through untouched. `agent` mode blurs the
  canvas and focuses the stock composer editor. A 400 ms heartbeat
  re-claims the keyboard only when focus has fallen back to `body`
  (page load, a modal closing), never stealing a deliberate click.
  Because the composer is also an input line, its capture-phase router
  mirrors the terminal chords in shell mode: Ctrl+C clears the draft
  and sends `\x03`; Ctrl+Shift+C copies the canvas selection
  (`term.getSelection()` through the module-level live-terminal
  handle); Ctrl+Shift+V pastes into the PTY. The old dock's readline
  key mapping is gone — raw mode makes it unnecessary.
- **Selection is reverse video in the active palette.** xterm paints
  the selection with the theme's `selectionBackground`; the old
  12%-alpha accent was effectively invisible, and the *inactive* pair
  is what shows while focus sits in the composer. Both pairs now use
  the palette's `accent` for the highlight and `menuBg` for the glyphs,
  so a selection reads as part of the current theme (`森林` highlights
  green, `神秘` pink, …).
- **Send settle with a custom PS1 (now agent-side only):** dsh's fast
  settle needs the stock `dsh> ` cue after the OSC 133;D marker
  (`promptTextSeen`); a custom PS1 disables it permanently, so sends
  held the exclusive startSend slot until the 3s `inferred_idle`
  timeout and back-to-back commands crawled. The bundle patch pins
  the dshell-terminal-bash row — since Phase 5 only the agent's
  `terminal_send` path; main shells moved to the raw backend — to
  `idleSilenceMs: 300` / `handoffGraceMs: 50`. The raw backend
  settles its own sends instead: marker + 60ms quiet fast path,
  350ms inferred-idle fallback, 15s timeout.
- **The ws client must guard socket handover:** `sessions.list` churns
  several times around a session switch, and a redundant `openSocket`
  used to leave two live sockets feeding one history (every frame
  ingested twice). `bind` is idempotent while the session's socket is
  connecting/open, and a superseded socket's frames/closes are ignored.
- **Dev-workflow trap:** composite `tsbuildinfo` caching silently skips
  tsc/tsdown emit — a rebuilt lib can stay stale (the browser then runs
  old client code and everything looks "already broken"). When in doubt
  `rm -rf packages/dshell/*/lib packages/dshell/*/tsbuildinfo lib types`
  and `pnpm build` fresh; verify the change actually landed in
  `lib/client.js` before restarting dsh.

## Phase 5 — ANSI canvas (raw PTY backend + xterm.js + 4.4 merge)

Goal: the conversation column becomes a real terminal canvas — raw
ANSI PTY bytes stream into a full-bleed xterm.js instance, and durable
session events interleave as rule-marked rows (design 4.4).

Covers decisions: 4.4 (interleaved rendering), 4.8 (terminal layout).
Retires the Phase 4 pull-model tail (see 4.x).

Plugins touched:

- `dshell-terminal-bridge` (host face) — registers its own
  `TerminalBackend` (`type: 'dshell-pty'`) on `ctx.terminals` next to
  dsh's bash backend: plain node-pty `/bin/bash -i` with
  `TERM=xterm-256color`. Output pushes to subscribers raw
  (`onOutput`), exit pushes (`onExit`), resize is real (the canvas
  drives cols/rows), agent-facing reads strip ANSI on demand, and
  sends settle on the bridge's own logic (marker + 60ms quiet fast
  path, 350ms inferred-idle fallback, 15s timeout; Ctrl+C cancels the
  active send). The bridge spawns one `main` shell per dsh session;
  init sets the PS1 + `PROMPT_COMMAND` marker once and replays a
  clean prompt, and the same truncate + replay is the spawn reset that
  keeps the init echo out of the persisted log.
- `dshell-mode` (browser face) — the dock's scrollback div becomes a
  full-bleed xterm.js canvas. xterm.js and its CSS are inlined into
  the client bundle (rolldown `noExternal` + CSS-as-string module —
  the combo loader only resolves dsh platform modules, so anything
  else must ship inside the bundle). A hidden probe span measures
  char width; the cell height comes from the rendered `.xterm-screen`
  (its height is rows × cell height), because xterm's own measurement
  is 16px where the probe's CSS line box is 15px. A ResizeObserver
  fits cols/rows from the container minus its computed padding and
  resizes the PTY. Trusting the probe overshot by a row or two, and
  the overflow was clipped — the live prompt vanished under the
  composer as soon as output filled the canvas.
  The theme maps the dock palette (bg/text/cursor/selection).
- `dshell-mode` (browser face, 4.4 merge) — `PtyCanvas` subscribes to
  the session's event window (`sessions.binding(id).eventSource`,
  retried until the binding materializes — it is `undefined` for a
  session neither listed nor scoped) and draws the agent's work as task
  blocks. One block covers one turn: it opens on the request (or
  `turn/start`, whichever comes first — a request adopts the empty
  block), splits when `todo/write` moves the `in_progress` item (a
  supervised phase), and closes on `turn/end` with a one-line notice at
  the timeline's tail (`✓ AI 回答完成 · N 步 · M tok · HH:MM`; `◼` for
  aborted, `✗` for failed). Rows inside a block keep their roles: `你`
  (user), `AI` (assistant), `⎿ 思考过程` (reasoning), `→ <tool>`
  (call), `← <tool>` (result), `⚡ 命令` (command run/done).
  A collapsed block is **exactly three lines** — a status header plus
  the newest two content lines — and that fixed height is the contract:
  while the model is still writing, the block is repainted in place
  (`ESC[s` → CUU → rewrite each row with `ESC[K` → `ESC[u`), so the
  shell's rows below never move. The repaint is skipped when the view
  is scrolled away or the block is off-screen; the next full replay
  corrects it. Clicking a block unfolds it to every row (each row keeps
  its own fold and click identity) through a full replay, and clicking
  again folds it back. Live `assistant/live-chunk` transients
  (`text-delta` / `reasoning-delta`) feed a streaming row at the block's
  tail, coalesced to ~80ms and dropped on `settle-assistant` or the
  durable `assistant/message`, so progress shows during a step instead
  of only between steps.
  Each block's rule is a CSS band painted per buffer row
  (`paintGutter`, repainted from `onRender`), not the `┃` glyph: a
  stacked glyph inks ~14px of the 16px cell and reads as a dashed line,
  while the band fills the row box and stays unbroken across blank
  lines and column re-wraps. The gutter only reads as a separator when
  no glyph ever reaches it, which takes three rules: every logical line
  is hard-wrapped to `cols - 2` and indented, so xterm's soft wrap
  never restarts a continuation at column 0 under the rule; a block
  starts on its own line whenever the pty did not end its last line
  with `\n` (a bare `\r` means readline still owns that line and will
  erase it); and row text is sanitized — captured terminal output
  carries real `\r`s that otherwise rewind to column 0 and overwrite
  the row's own indent and fold hint. Window `replace`/`prepend`
  replays the merged timeline (pty chunks + blocks, stable sort by
  time, pty first on ties) and anchors the event watermark at the
  window's newest seq, so an append can never re-fold history into
  duplicate blocks. A pty replay chunk schedules one coalesced redraw
  (~150ms) and suppresses block appends meanwhile, so a command's rows
  never interleave with the prompts its wipe just printed. Reload
  replays the persisted window the same way. The pty side of that merge
  is timed by arrival frames, not by the replayed chunk: a bind replay
  is a single frame, so timing it by the chunk would drag the whole
  scrollback to the bind moment and bunch every shell record after
  every block. Each live frame's `(time, length)` is persisted per
  session in localStorage, and the replayed text is sliced back into
  timed segments from the end (`segments()`); a resync trims the
  timeline to what the replayed text still covers, and a session this
  browser never watched falls back to its raw chunks. Verified in
  `block-test`: shell output injected between two turns keeps its place
  across a reload.

Blocks as the view's primary unit. The single-canvas surface caps
presentation at the character grid — per-cell colour, no rounded
corners, no element-level type, no hover states. The block view
(`block-view.ts`) makes a DOM column the surface, and a block is a
*stretch of the session*, not a command:

- Everything the terminal printed between two agent tasks is one shell
  region, rendered by a real xterm (`block-terminal.ts`) with no chrome
  of its own: PS1 line, command echoes and output exactly as the shell
  produced them. Regions are cut by wall-clock task boundaries
  (`splitByTime` in the bridge), so a stretch spanning several tasks is
  split between them and interleaving survives — verified live with a
  shell/agent/shell/agent run yielding `S A…A S A S A`.
- An agent task is a card: coloured, labelled rows in the canvas's own
  role palette, a two-line preview folded, every row expanded, and its
  closing line.
- The seat mirrors the canvas's view shell. Its scrolling column is
  absolutely positioned so it contributes no intrinsic height — without
  that the view area grows to content and the composer lands on top of
  the output (522px view area vs a composer starting at 604px).

Dropped along the way: slicing shell output per command. A block per
`OSC 133;D` run gave every command a synthetic header card and destroyed
the terminal's own design; the marker scanner and its `commands()` API
were removed again.

The block view occupies the stock `chat` view cell (same id, lower
priority), which is `DEFAULT_VIEW_ID` in
`ui-conversation/src/client/view-selection.ts`. That placement is
load-bearing, not cosmetic: a sibling tab is reachable only through a
stored view selection, so while the canvas held `chat` a fresh session
silently opened the old surface.

The strip is visible again, because a session has two worthwhile
readings — the terminal (`会话`) and the trajectory ledger (`轨迹`,
`ui-trajectory`) — and dsh already draws that switcher. One dsh detail
had to be worked around: `viewTabs()` in `ui-conversation/apply.ts`
builds the tab list from the RAW slot entries rather than the shadowed
ones, so a shadowing registration shows up as a *second* tab instead of
replacing the first. The stock `ui-chat` row is therefore disabled in
`packages/dshell/bundle/cordis.patch.yml`; its two child slots
(`conversation.chat.node`, `conversation.message.images`) go with it,
which costs nothing because the block view renders neither.

The canvas is now deleted — `canvas.ts`, its `DshellTerminalView`, the
ANSI block renderers in `blocks.ts` (`blockSegments`, `renderNotice`, the
gutter/colour helpers) and `activeTerm`, which existed only so the
composer could copy the canvas selection. The block view is the only
conversation surface.

How the block view stays live (each of these was a visible defect before it
was written down):

- **Streaming.** The event window delivers the model's partial answer as
  client-only `transient` entries (`assistant/live-chunk`); the durable
  `assistant/message` only lands when the attempt settles. The view folds the
  deltas into `TurnBlock.stream` and drops that line the moment the message
  arrives (`settle-assistant` carries it), so the answer grows token by token
  and is then replaced in place rather than duplicated. The fold is advanced
  incrementally with a durable watermark and renders on one `requestAnimationFrame`
  at most, instead of re-folding the whole window per event.
- **A sent message is on screen immediately.** The durable `user/message` is
  appended when the first step begins — measured at 8–11 s after `turn/start` on
  this route — so waiting for it left the request invisible for that whole
  window. Three sources cover the path, all keyed by prompt id (`rpcId`) and all
  retired by the durable row: the durable `agent/inbox/spliced` event (the host
  admitting the prompt, ~1 ms after the turn opens), the host queue, and the
  client's local submission echo (`beginSubmission`). A rejected prompt clears
  them via `promptError`.
- **A shell region renders at the width its output was produced at.** The grid
  spans the column and widens only as far as a *redraw* needs (a stretch drawn
  and then drawn again), measured by simulating the cursor column: `\r` and
  `ESC 8` rewinds are what move a repaint's origin, while a long echoed line that
  merely ends with a carriage return is left to wrap. Without this a padded
  progress bar stacked one row per repaint. The PTY itself is
  driven to the same width, so this normally matches; see Phase 9.6 for the
  resize path.
- **The font size is one value for the whole view.** A session's PTY width
  changes over its life — it starts at the backend's default and is resized to
  the column once the view measures one — so historical regions legitimately
  hold lines printed at a different width than today's. Scaling each region's
  font to fit its own widest line rendered those stretches at different sizes in
  the same view (13px for the ones at the column's width, 9px for the ones
  printed wider), which reads as a broken terminal rather than as history. Every
  region now renders at the base size, and a grid wider than the column scrolls
  horizontally instead: correct redraws are unaffected, since the grid is what
  keeps them on one row, not the font.
- **Regions update in place.** A region's React key is its identity alone: keying
  it by the PTY version remounted every terminal on every output chunk, which
  threw away its scroll position and re-parsed the whole region per frame.

Still open: terminal input parity (`onData` for Tab, arrows and Ctrl+C
had no owner once the canvas went: shell input goes through the composer,
so interactive full-screen programs still need a terminal that owns the
keyboard), full-screen programs (PTY rows follow the seat, but a region
renders at its own content height), per-row folding inside an expanded
task card, virtualizing long sessions, and image attachments on a
not-yet-durable bubble (its text shows, its previews do not).

## Phase 6 — Real commands (`/clear`, `/new`, `/compact`)

Goal: the three dsh commands that dshell exposes are real
`ctx.commands` registrations.

Covers decision: 4.5 (commands).

Plugins touched:

- `dshell-commands` (new, host face) — registers `/clear`,
  `/new`, `/compact` on `ctx.commands`.

Acceptance check:

- `/clear` clears the xterm buffer and the main PTY scrollback in one
  operation. *(Retired in Phase 10.6 — the in-terminal `clear` already
  clears the canvas, and the command's epoch reset was the only thing
  that could drop persisted history mid-session.)*
- `/new` opens a new session through dsh's standard creation path;
  the new session starts in `shell` mode with no PTY until first
  access.
- `/compact` triggers dsh's compaction service and reports its result.

## Phase 7 — Terminal context management (cursor + command records)

Goal: agent turns carry the main shell's activity **incrementally** — only
what the model has not seen — and the agent can look back at commands on
demand.

Covers decision: 4.6 (injection).

Plugins touched:

- `dshell-terminal-bridge` (host face) — the bridge now owns a per-shell
  **absolute cursor** on top of the PtyBuffer window:
  - `absOffset` counts every appended byte and survives window trims, so
    an offset means the same thing after retention slides;
  - a pure splitter (`commands.ts`) joins the two streams the bridge
    already sees — the input it forwards to the PTY and the raw output —
    into `{command, exitCode, output}` records. Bash's own
    `OSC 133;D;<code>` prompt marker (already installed by the init PS1)
    closes each record; input is assembled through backspace / Ctrl+C /
    Ctrl+U / CSI handling. Untracked commands (history recall, an
    external writer) still yield a record with empty `command` and real
    output;
  - `since(sessionId, cursor?)` returns the delta: sanitized text,
    commands closed since the cursor, `dropped` when retention slid past
    the request, `cleared` when the cursor belonged to an earlier
    **generation** (a respawn takes a fresh generation);
  - `history(sessionId, limit)` returns the latest retained commands;
  - both never spawn a shell, so subagent and never-opened sessions stay
    context-free.
- `dshell-mode` (host face) — keeps a per-Agent **watermark**. On
  `agent/pre-step`, a step carrying a genuine `source.kind === 'user'`
  message injects one plugin-sourced (`form: 'notice'`, summary
  "主终端增量") message with the command summary and the sanitized new
  output, then advances the watermark. A first read (no watermark)
  delivers the retained window once; a stale cursor (`cleared`) advances
  and injects nothing, so a respawn never replays the seeded scrollback.
  Output is capped at 8 KiB, kept from the newest end.
- `dshell-commands` (host face) — `dshell_terminal_read({cursor?, limit?,
  includeOutput?})`: without a cursor, the latest commands; with one, only
  what happened since. The tool result ends with the new cursor so the
  model can continue from it.
- `dshell-mode` (browser face) — filters `user/message` events whose
  source is not `user` out of the canvas row extractor, so injected
  context and guard notices never paint as fake `你` rows.

The old whole-tail snapshot (re-sent every turn, escaping control codes
and prompt markers into the prompt) is gone. The Phase 7 client-side
deviation (a fence prepended to the user's own message) stays gone:
injection is host-side at the step, where the message source is durable.

Acceptance check (verified end-to-end with a live model):

- `echo ctx-one` then `pwd` in shell mode, then an agent turn: the
  durable log shows one injected block listing exactly those two
  commands with exit codes and sanitized output (no `\u001b]133;D`
  markers, no `\r`).
- A second command + turn injects only the new command — no repetition
  of the first block.
- `dshell_terminal_read` called by the model returns the command records
  plus a `g<generation>:<offset>:<seq>` cursor.
- The injected block does not appear as a user row in the canvas.
- 12 pure-function checks cover the splitter and window math:
  `pnpm tsx packages/dshell/terminal-bridge/scripts/check-commands.ts`.

## Phase 8 — `dshell_get_main_terminal` tool

Goal: the agent has a reliable way to learn the `main` PTY session id.

Superseded by Phase 9.11: pointing the agent at the user's own shell is
the arrangement that could not work (one PTY has one foreground), so the
tool is now `dshell_get_agent_terminal` and returns the id of a shell the
agent owns. Everything below describes the shell the agent used to share.

Covers decision: 4.6 (agent access to `main`).

Plugins touched:

- `dshell-commands` (host face) — adds a model-facing tool registered
  on `ctx.tools`.

Acceptance check:

- After agent start, `dshell_get_main_terminal()` returns the
  `TerminalSessionId` of the bridge's `main` PTY.
- Agent can call `terminal_send` against that id to run a command in
  the user's shell; the bytes stream back into the user's xterm.

## Phase 9 — Hardening

Goal: failure modes from `dshell-design.md` § 6 are observed and
handled.

Plugins touched:

- `dshell-terminal-bridge` (host face) — handles `session_exit`,
  signal-driven close, browser disconnect, and session disposal.
- `dshell-mode` (browser face) — UI feedback when the `main` PTY
  restarts.

Acceptance check:

- `exit` in `main` shell: ws receives `{ kind: 'closed' }`; next user
  input opens a new `main` PTY automatically.
- Browser reload: bridge keeps `main` alive; on reconnection, ws
  re-subscribes to byte stream.
- Closing a session in the sidebar: bridge closes ws and calls
  `ctx.terminals.kill(agent, mainId)` cleanly.

## Phase 9.5 — Session panel (archive + purge)

Goal: the sidebar can put a session away and remove one.

Shipped:

- Archive is a dshell-owned durable tag (`$DSH_HOME/dshell/tags.json`),
  rendered as the collapsible `已归档` group; dsh's own archive lives on
  the disabled workspace registry, so it is unusable here. (The
  scheduled-removal state this phase kept inside that group became its own
  `待删除` group in Phase 10.11.)
- Purge removes the session directory, its projection-cache entry and
  the dshell PTY log plus sidecars (`dshell-workspace/src/purge.ts`),
  and frees the session's shell via
  `DshellTerminalBridge.releaseSession`.
- Both travel over one exact `/api/dshell/sessions` route behind dsh's
  own trust fence, not the Typert Remote table (whose client artifacts
  are generated from dsh's packages).

Hard-won constraint — a *loaded* session cannot be deleted immediately:
dsh discards the only teardown capability at
`packages/api/session-controller/src/agent.ts` (`(await
ctx.agents.resume(...)).agent` throws the `AgentHandle` away), and
`SessionStore` exposes no per-session detach. So while a session is in
`ctx.sessions`, its log writer stays open and would recreate a deleted
directory on the next event. The delete branch therefore has three
outcomes: running → refused; loaded-and-idle → terminal released now,
log removal scheduled and executed at the next start (before any client
can resume); cold → purged immediately.

## Phase 9.6 — SSH device sessions

Goal: a session can run on a remote device instead of this machine.

Shipped:

- `dshell-ssh` (new host+client package): a durable device registry
  (name, host, port, user, remote directory, login method) whose secrets
  are separate 0600 files under `$DSH_HOME/dshell/ssh/keys/`, a card in
  the Plugins settings section to add/edit/test/delete them, and a durable
  session→device assignment chosen in the new-session dialog (the row then
  wears an `SSH` badge ahead of its title). The badge is the whole marking:
  no device name and no remote path, because the row's job is to identify the
  session and say which kind it is, and a host plus a path is a fact about the
  device — the SSH settings card and the connection screen already own those,
  and printing them squeezed the session's own title down to `pipe-…`. The
  badge is the theme's info colour rather than the row's inherited text colour,
  so a glance down the list separates local shells from ssh ones. The dialog
  asks for the run target first —
  a 本机 / SSH 设备 slider — and only shows the device list once SSH is
  chosen, with a 远端目录 field beside it (it follows the device until the
  user types their own). An SSH session's local directory is not the user's
  to choose: it is the mount directory described below.
- Login method is per device: `key` (stored private key, or the harness
  user's own agent/config when none is stored) or `password` (stored
  0600, handed to ssh through OpenSSH's askpass hook — ssh has no password
  flag, and the secret never appears in a command line).
- Routing: `ctx.shell.resolve` is wrapped, so a bound session's shell
  commands are rewritten to `ssh … 'cd <dir> && exec bash -lc <command>'`
  and the stock executor keeps owning timeouts, caps, streaming,
  background handles and cancellation. The target is resolved per call
  from `ctx.agents.currentInitiator()`, so nothing about tool signatures
  or registrations changes.
- The local hop runs unconfined (`danger-full-access`): the session's
  access mode describes THIS machine, and confining the `ssh` client
  would deny it the network while the command that matters executes
  under the device's own policy.

Verified live against a private sshd on 127.0.0.1:2222 with its own host
and client keys: a bound session's `echo $SSH_CONNECTION` returns the
tunnel's addresses, an unbound session returns nothing.

Shipped since (the session now works in ONE place):

- The **mount directory**: a bound session's own directory is a local,
  empty directory standing in for the device tree
  (`$DSH_HOME/dshell/mnt/<device>/<remote path>`), and `remoteRoot` +
  `mount` travel together in the binding. The harness owns the session
  directory — it creates it at session creation and reads it later for
  instruction files, project discovery and sandbox roots, all locally — so
  a remote path fails those reads (EACCES on `/root/.git`) and a
  coincidentally existing local path would silently be the wrong tree. An
  empty local directory satisfies every one of those readers while
  claiming nothing: the `.git` walk finds no marker and stops at the
  session directory instead of reaching upward. This is why no preset has
  to be forked.
- **`ctx.fs` is dshell's provider**: loaded in place of the stock
  `fs-sandbox` row and extending it, so an unbound session's calls are the
  stock implementation verbatim while a bound session's
  resolve/stat/read/list/write/edit run on the device over ssh
  (`RemoteFileSystem`). Dispatch is by `ctx.agents.currentInitiator()`,
  the same ambient signal the shell seam uses, because a filesystem call
  carries no session field. The literal-edit and line-ending rules are
  mirrored in `literal-edit.ts` (the local backend exposes them only
  through its source subpath, which an emitting build cannot import) and
  the per-call sandbox mode is enforced against the device's own tree.
- **`ctx.subprocess.spawn`** is wrapped for the search tools: `glob`/`grep`
  spawn ripgrep directly rather than through `ctx.fs`, so a bound session's
  `rg` run is rewritten into `ssh … 'cd <dir> && exec rg …'`. Paths need no
  translation — ripgrep prints them relative to the directory it ran in,
  and a relative path means the same place to the session's file
  operations. The shell path is deliberately not re-routed here (it is
  already an `ssh` line). **The device needs `rg` on PATH**; a missing one
  fails with a message that says so (install ripgrep on the device, or the
  search tools have nothing to run).
- **Connections are multiplexed** (`ControlMaster`, one socket per *device*
  under `$DSH_HOME/dshell/ssh/ctl/`, named by a digest of the destination and the
  device id — Phase 10.10): one file read is a
  resolve, a stat and a cat, and a fresh connection each time costs a full
  handshake and authentication.
- The new-session dialog keeps the run target visible when no device is
  registered (hiding it made SSH undiscoverable exactly when it was
  needed) and links to Settings → 插件, scrolled to the device card. That
  jump is best-effort — the settings panel keeps its open state and
  selected section in component state, so its own controls are the only
  way in — and falls back to naming the path.

Verified live against the same private sshd: a bound session's relative
`read` resolves to the device's file while the local mount directory stays
empty, a relative `write` lands in the device's tree, and `grep` over `.`
returns the device's files (the mount is empty, so those results could only
come from the device). An unbound session's `read` and `glob` are unchanged.

The visible terminal, too:

- The main PTY now runs the **device's** shell when the session is bound:
  `DshellPtyBackend` asks for a spawn plan per session, and dshell-ssh hands
  it `ssh … -t 'cd <dir> 2>/dev/null || echo …; exec bash -l'` (with the
  askpass environment for password logins). The local pty is unchanged — the
  harness spawns `ssh` inside it, so line discipline, resize and Ctrl+C stay
  local while the remote shell gets a tty of its own. Interactive commands
  verified on the device (`pwd`, `hostname` → `VM-0-6-ubuntu`, `whoami` →
  `root`), and an unbound session's terminal is still the local shell.
- The plan is resolved by **session identity** (`spec.owner.id`), not by
  directory: one device tree's mount directory is shared by every session
  bound to that device and root, so a directory match cannot tell a bound
  session from an unbound one whose cwd merely looks like a mount — and the
  latter would get a device shell it has no binding for. The resolver may also
  *wait* briefly (≤1s) when the session's cwd is already a mount path but its
  assignment has not landed yet, because creating a session and recording its
  binding are two round trips and the terminal can attach in between.
- The `cd` is tolerant and the remote root is created **before** the binding
  is recorded: the assignment is what makes a session routable, so a binding
  that exists must imply the directory exists. Without that ordering the shell
  spawned in the window between the two, failed to `cd`, and silently landed
  in the login directory.
- Consequences worth knowing: PS1 and PROMPT_COMMAND are still rewritten by
  the bridge right after startup, so a remote prompt looks identical to a local
  one (that rewrite is also what drives the send settle); an unreachable device
  fails the terminal spawn instead of quietly falling back to a local shell;
  and a terminal's first prompt is pushed as a snapshot when it opens a block,
  so a brand-new session renders immediately instead of staying blank until
  the next reload.

Not routed yet:

- The persona's prompt variable `{{cwd}}` still renders the session's own
  directory, which for a bound session is the mount path. Overriding it
  needs a per-agent registration (`ctx.agents.get` returns a bare agent and
  the variable is registered per agent by the agent loop), so the honest
  fix is a dshell-owned preset row — the one place a preset fork would pay
  for itself.
- Remote instruction files and project skills are not loaded: the mount
  directory is empty by design, so `agent-instructions` and
  `skill-filesystem` find nothing there. The model can read them with the
  file tools, which now work on the device.
- `@`-file references index the empty mount directory, so a bound session
  gets no candidates until file-reference search has its own seam.
- Remote commands assume a POSIX/GNU userland (`stat`, `realpath`, `find`,
  `mktemp`, `chmod --reference`).

## Phase 9.7 — Connection failures and reconnection

Goal: a device session that cannot connect says so, in the right place, and
offers the one action that can fix it.

Before this phase the failure was silent in three separate ways: a failed
`bind` was published on the snapshot and never thrown, so the new-session
dialog closed over a session that had no assignment and whose directory was a
device mount (its shell — and the agent's `bash` — then ran on the local
machine inside an empty stand-in directory); a shell that died during startup
lost ssh's own stderr with the discarded session and reported only "the shell
exited"; and the browser retried the socket every two seconds forever, which
is indistinguishable from a hang.

Decisions:

- **The connection is proved before the session exists.** The dialog runs one
  real ssh round trip (`test`) *plus* the session's remote directory
  (`ensureRemoteRoot`) before `createSession`. A device that answers but
  cannot host the directory is therefore a refusal in the dialog, not a broken
  session later. `SshClientService.send` gained a `strict` mode so
  `test`/`mountFor`/`bind` throw while the settings card keeps rendering the
  published `error` (its Test button catches, since the refusal is already on
  screen).
- **The host classifies the death, because only the host can.** A device
  session's "cannot connect" is an `ssh` process that printed a line and
  exited; node-pty reports an exit code only. So `markDead` ships
  `{reason, detail, ready}`: the reason from the exit (signal first, since
  node-pty calls a SIGHUP `exitCode: 0`), the last ssh diagnostic found in the
  output (`diagnosticTail`, patterns only — a line that is not a diagnostic is
  never presented as the cause), and `ready`, whether that shell ever reached
  a prompt (the init send settles only once the shell answers).
- **`ready` decides which of two presentations a failure gets.** A shell that
  *had* reached a prompt gets a marker appended after the output the reader was
  looking at; one that never did has nothing to append to, so it gets the
  intermediate screen. `connectionView` in the mode client is the single place
  that turns `{status, ready, attempt, bound}` into one of `none | panel |
  notice`.
- **`bound` is what separates remote from local, and it is read from the
  session, not the wire.** A bound session's terminal is an `ssh` process: a
  handshake that takes seconds, can stall, and has a host worth naming, so its
  startup is an event the user gets a screen for. A local shell is a fork of
  this very process — up in milliseconds — so it never gets the panel, and its
  first bind is not narrated either; only a *retry* is, because that only
  follows a real failure. The binding comes from `ssh.bindingOf(sessionId)`
  without the "is the PTY on this session yet" gate the wire facts carry: which
  connection UI a session is even eligible for must not depend on the PTY
  having caught up. A rebind of a shell that had already answered reports
  `connecting`, not `exited` — a live shell being re-attached is not a death.
- **A bind can arrive before its session's agent exists.** The browser opens a
  session and binds its shell in the same tick, while the host is still
  composing the agent, and a session *switch* publishes the new current session
  one tick before anything is built for it. The bridge waits (50ms poll, 4s
  budget) for the agent instead of throwing: erroring turned that ordinary race
  into a reported connection failure, which cost the client a retry attempt and
  a 1s backoff before opening the shell it was always going to get — and drew a
  "正在自动重连（第 1/3 次）" line on plain local session switches.
- **Reconnection is bounded and visible.** The client spends at most three
  automatic attempts (1s / 2s / 4s) on whichever layer is broken — a live
  socket means the shell died, so the host is asked for a new one with a new
  `reconnect` frame; a dead socket is reopened — and then stops and says so
  ("自动重连已停止（3 次均失败）"). The button (`PtyStreamService.reconnect`)
  clears the budget and tries immediately, which is also the only way out of
  the exhausted state.
- **A spawn failure no longer closes the socket.** `bindClient` keeps the
  client bound and answers with an `error` frame instead of `close(1008)`;
  closing threw away the connection the retry needs and made the client
  reconnect into the same wall.
- **No silent local fallback.** `interactiveShellPlan` and the shell seam's
  `resolve` now refuse a session whose directory is under the mount base but
  which has no assignment, naming the reason. That state is reachable by
  deleting a device, and previously produced a local shell (or local `bash`
  tool calls) inside an empty directory that looks like a working terminal.
- **The dialog stops inheriting a mount.** Clearing the directory field was
  not enough: dsh then inherits the *current* session's cwd, which can be the
  mount the dialog just refused to prefill. The list now offers the most recent
  non-mount directory, and a local session with an empty directory that would
  inherit a mount is refused with the reason.

Acceptance check (driven from the browser):

- A device pointed at a closed port: the dialog reports
  `ssh: connect to host 127.0.0.1 port 9: Connection refused`, stays open, and
  no session is created.
- A session that never connected (page reloaded while the device is down) shows
  the centred screen — `⚠ 无法连接到 <device>`, the ssh diagnostic,
  `已自动重试 3 次均未成功。`, 重试连接 / 去设置 — and nothing behind it.
- A session that *had* a working terminal and lost it gets the red marker at
  the end of its output (`连接已断开 · <reason>`, the diagnostic, the retry
  count, then the exhausted line), with the scrollback intact above it.
- Restarting the device and clicking 重试连接 brings the terminal back at the
  same place in the history; a local session shows neither treatment.

## Phase 9.8 — Cross-session pipe

Goal: one session's agent can hand a task to another session's agent, wait
without blocking, and get an outcome back — with the files it opens to the
other side scoped and automatically reclaimed.

Shipped:

- `dshell-buffer` (new host+client package): a durable link between two
  sessions that **only the user** can create (there is no agent-facing
  linking action at all), a deferred-request queue with claim / progress /
  finish / fail, and scoped revocable folder grants.
- The pipe panel enters the frame-wide `shell.overlay` seat, opened from the
  sidebar header — the duplicated `＋ 新会话` button there becomes `管道`
  (the stock shell already offers session creation). A composition without
  `dshell-buffer` keeps the original button.
- The wait semantics follow the one constraint dsh imposes: **a turn cannot
  be suspended and resumed**. So `delegate` returns a ticket id immediately
  and the requester's turn ends naturally; when the ticket settles, the
  buffer delivers a new message that reopens the turn — the same
  completion-delivery policy dsh's own job registry uses (idle → `followup`,
  busy → `inject`).
- Reachability is checked, never guessed: `ctx.sessionController.resolveAgent`
  is dsh's own resume path, and a device-bound target is probed over its SSH
  connection before admission, so an unreachable target is refused with the
  real reason instead of timing out later.
- Nothing can wait forever: a ticket past its deadline is settled `timeout`
  by the host watchdog, a disposed worker session settles its live tickets
  `failed`, and every settlement path wakes the requester.
- Grants are directories in the **granter's** namespace, resolved as the
  granter (so a device session's tree is read over its own route), with
  containment checked on the canonical target keys — `..` and symlinks in a
  request cannot escape the granted area. A write is fenced by the granter's
  own sandbox policy, so a grant can never widen it.
- Grants are reference-counted by unsettled tickets: count 0 revokes
  immediately, and the panel's 回收 button is the manual escape hatch.
- **Transfer** moves one file, bytes intact, between the granted area's
  execution world and the caller's own. `ctx.fs` has no byte write (both
  its mutations take text), so the bytes ride base64 on the `ctx.shell`
  seam's stdin and the destination world's own `base64 -d` decodes them.
  That seam rather than a new filesystem method because it already routes
  per initiator — a device session decodes on the device with no new
  transport — and it already fences the run by the session's resolved
  policy, so a transfer is bounded exactly where `writeText` is. With no
  `dest` the file lands at the same relative path, i.e. the corresponding
  location in the other world; binary files travel, which read/write
  cannot carry. `side="from"` needs read, `side="to"` needs write, and
  one call is capped at 8 MiB by default (32 MiB hard cap).

Model experience: one `dshell_buffer` tool with five families of action
(links, ticket lifecycle, the grant view, granted file access, transfer)
plus one system-prompt section stating the protocol — delegate
asynchronously, never wait, and always settle a request you received.

Acceptance check (driven from the browser, two local sessions):

- The `管道` button opens the panel; two sessions are connected there and the
  connection survives a reload.
- A `delegate` in one session wakes the other with a framed request; `tickets
  direction="in"` shows it, `claim` / `progress` / `finish` advance it, and
  the requester receives the result as a new message.
- A request nobody answers, with a short `deadline_ms`, is settled `timeout`
  and the requester is still woken.
- A grant is visible to the grantee with the granter's description, areas and
  remaining count; `read` returns the granter's file text, `write` writes
  back, and a path outside the granted area is refused.
- `transfer` pulls the granter's file to the grantee's machine and pushes it
  back, byte-for-byte including a binary file, with no `dest` landing on the
  same relative path; a source over `max_bytes` is refused, and `side="to"`
  without a write right is refused.
- Settling the ticket removes the grant from `grants` and from the panel.

## Phase 9.9 — Unbounded file navigator

Goal: the right sidebar's file pane moves like a file browser — up with
`..`, sideways through clickable path segments, back and forward through
visited directories, and on a device session through the **device's**
tree, all the way to `/`.

Shipped:

- `dshell-files` (new host+client package). The host face adds one
  connection route, `/api/dshell/files`, action `list`: it resolves the
  session's agent, then inside `withInitiator` — so a device session
  lists over its own SSH route with no new transport — resolves the
  target, requires it to be a directory, and answers with the canonical
  absolute path in that world plus the entries and a `truncated` flag.
- Why a dshell route rather than dsh's `workspaceFiles.list`: that
  endpoint is deliberately fenced to the session's workspace root
  (`workspace-file/outside-workspace`), and the request was to walk to
  `/`. `ctx.fs` is the same seam underneath without the fence, the
  sandbox fences only writes, and `toRemotePath` passes an absolute path
  outside the mount through unchanged, so `..` out of the mount on a
  device means the device's own `/`. Listing is therefore at the same
  trust level as the `read` tool, which already reaches outside the
  workspace.
- The browser face registers its own `SidebarRightTabDefinition` for the
  `files` kind at `priority: 'extension'`. dsh is built for this: an
  extension-band definition shadows the builtin of the same kind, the
  pane's keyed seat switches to the extension's id, and removing the row
  restores the stock body. The definition also contributes the required
  guide entry, which is what keeps the pane's default page — the seed
  takes the sole guide entry's kind.
- Interaction: a `..` row drawn like a folder (hidden at `/`), single
  click on a folder still expands or collapses it, double click on a
  folder makes it the new root, double click on `..` goes to the parent
  as an ordinary navigation (so back returns), a file click still opens
  the preview, clickable path crumbs jump anywhere on the path, and
  `←` / `→` / `⟳` drive history and reload. Two clicks on a folder
  cancel out, so no double-click delay is imposed on expand.
- Navigation state (root, history stack and index, per-path level cache,
  expanded set) lives in a declared per-session store bucketed by tab
  id, because the pane mounts only the active tab's body while the store
  outlives tab switches. Forward history is truncated on a new
  navigation, browser-style; a revisited level draws from the cache.
- Listings are generation-guarded per (tab, path) so the latest request
  wins, and the tab record's abort signal ends a bucket: no request is
  made for a dead tab and no late settlement writes to one.
- One listing is capped at 1000 entries with a `truncated` notice, and
  failures are graded by cause (missing / not a directory / permission /
  other). Read-only: no delete, rename, or create.
- A jump button left of the reload button sends the session's shell into the
  directory on screen, so browsing to a place and working there are one
  gesture. It has to be input, not a command: a shell's working directory is
  process state, so a command run through the shell seam would not move the
  interactive shell. The line goes to the terminal bridge's own input path —
  the same one a keystroke takes — so it is tracked and rendered like any
  command the user types, and it is the canonical path of the session's own
  world, so on a device session the device's shell cds on the device. The
  listing carries `canCd` so a composition without the bridge draws no button
  rather than a dead one, and a refused jump says why in the pane, because the
  shell moves off-pane and would otherwise look like a dead click.
- Directory rows and the `..` row are also drag sources: dropping one on the
  terminal runs the same jump. It is **pointer events, not HTML5 drag and
  drop**. A native drag session is a black box — when the drop is refused there
  is no event to observe and no handler to correct, only the "no drop" cursor,
  which is exactly what a real mouse hit here (the drag started, carried the
  right payload and reached the terminal, and the browser still refused the
  drop; nothing in the page or in dsh could account for it). Pointer events
  carry the same gesture with nothing to arbitrate: the press, the move and the
  release are the pane's own, the target is decided by where the pointer is,
  and touch and pen work by the same code. The gesture stays a click until it
  moves past a threshold, so one click still expands a folder and two still
  open it. The pane installs the listeners while it draws a tree whose host can
  drive a shell; the terminal view gets an outline and the page cursor says a
  drop is possible, and both are put back when the gesture ends. File rows are
  not drag sources — there is no directory to jump to.

Acceptance check (driven from the browser):

- The right sidebar's file tab draws the new pane with its chip and its
  guide capsule, and the stock file tree is not reachable.
- `..` walks from the session's working directory to `/`; the row is
  absent at `/`; a path crumb jumps to that ancestor; double-clicking a
  folder inside current root makes it the root, and `←` returns.
- Single click still expands a folder, a file click still opens the
  preview, `⟳` re-lists the current root, and switching to another tab
  and back keeps the current directory.
- In a device session the same pane lists the device's tree — entering
  `/etc` proves the listing was inherited from the session's routing.
- The jump button sits between the path and the reload button; on the local
  session it moves that session's shell to the directory on screen, and on the
  device session the device's shell — the prompt's own `cwd` report moves with
  it — while the command shows up in the session's terminal record like a typed
  one.
- Dragging a directory row onto the terminal moves the shell there too, with
  the drop area outlined while the pointer is over it and the cursor changed
  until the release; releasing the same row over the sidebar does nothing at
  all, and file rows cannot be dragged. The folder still expands on one click
  and still opens on two — the drag is the only thing the pointer tracking
  adds.

## Phase 9.10 — Two-pane file transfer

Goal: in a device session's sidebar, move files between this machine and
the device by dragging them — SFTP's job, done with the seams dshell
already has, and offered only in the UI (no model-facing tool).

Shipped:

- `dshell-files` grows a second sidebar type (`kind: 'transfer'`, a page
  type) and a second route, `/api/dshell/transfer` (`state`, `list`,
  `copy`, `job`, `cancel`). It is the same package rather than a new one
  because it is the same subject seen twice: the two panes draw the
  navigator's own rows and levels, and the two types share one store
  instance, so neither view can hold a stale idea of which session it
  belongs to.
- **The two worlds are reached by the seams that already exist**, so the
  transfer adds no transport. The device side is the session's own world:
  `ctx.fs` reads and lists inside `withInitiator`, exactly as the
  navigator does. This machine is the **explicit absence** of an initiator
  (`ctx.agents.withoutInitiator`), stated rather than assumed, because a
  request that happened to inherit a session would otherwise read the
  device behind the local pane's back. Writes go through `ctx.shell` with
  the payload on stdin as base64, because `ctx.fs` has no byte write —
  both of its mutations take text — which is the same byte transport
  `dshell-buffer` settled on for its cross-session copies.
- **A local destination is written in process** (`node:fs`), and the
  reason is measured rather than aesthetic: each harness-born process
  costs roughly 0.4 s in this deployment, so the shell seam charges that
  for every file, and the local side is not a place that needs a process
  at all — it IS this process's filesystem, the same assumption the local
  pane's root already makes by asking `os.homedir()`. A device
  destination still gets one `ssh`-borne command per file, and that
  command creates the parent, decides whether the target may be replaced,
  decodes the payload and publishes it, because asking `ctx.fs` for a
  resolve and a stat first would be two more round trips for answers the
  command already has.
- Bytes are published through a temporary file in the destination
  directory and a rename, so a transfer that dies halfway cannot destroy
  the file it was replacing; an overwrite keeps the target's mode and a
  new file gets 0644 (a `mktemp` file's own 0600 would make every transfer
  arrive private). The local world passes `danger-full-access` explicitly:
  the actor here is the user — the route sits behind dsh's authenticated
  fence, no tool reaches it — and the alternative, the session's own mode,
  describes what the MODEL may do on this machine and defaults to the
  session's mount directory.
- A copy is a **job**, because a directory copy is a walk plus one write
  per file and can outlast any sensible request. `copy` answers with the
  job immediately, the view polls it every 400 ms, and the walk's entry and
  byte totals are known before the first byte moves — so the line reads
  `xfer-src → 传输中 16 KB 1/400 项` with a bar and a cancel. Cancel
  aborts the run (the signal reaches the seam calls); a cancelled or failed
  copy leaves whatever it had already written, which is why the conflict
  question exists rather than a silent overwrite. A settled job stays
  readable for five minutes, then the registry drops it: this state belongs
  to the boot that started it.
- Semantics worth stating: a dragged folder is copied **as itself** into
  the destination directory (the reader sees the folder appear by name), a
  drop lands in the directory row under the pointer or in the receiving
  pane's own directory when there is none, files are capped at 32 MB
  (the base64-stdin payload, the same ceiling as the buffer's copy), a
  plan is capped at 20 000 entries and 2 GiB, and anything that is neither
  a file nor a directory (a symlink, a socket) is skipped and counted.
- The way in is a button in the navigator's header, drawn only when the
  transfer type is registered AND the session is device-bound with a mount
  directory — a binding without one routes only the shell, so its file
  operations stay local and a transfer would silently mix the two
  machines. A local session therefore shows no button at all. The transfer
  type contributes **no guide entry** on purpose: the pane seeds its
  default page from the sole guide entry's kind, so a second entry would
  move every session's default page onto the guide itself.
- The drag is the navigator's technique again — pointer events, not HTML5
  drag and drop — extended for two panes: any row (files included) is a
  drag source, the receiving pane is outlined and the directory row under
  the pointer is washed while the pointer is over it, and the target pane
  is told from the source pane by the two panes' own data attributes. The
  gesture stays a click until it moves past a threshold, so a folder still
  expands on one click and opens on two.
- Two things were corrected after watching it in the browser. A folder
  copied into the drop directory used to spread its *contents* there; it is
  now copied as itself, one level below. And the view must **fill** the
  pane it is mounted in: the docking kit puts a tab body in a BLOCK pane
  body that scrolls, so `flex: 1` alone left the view at its content
  height and pushed the progress strip below the fold — `height: 100%`
  makes each tree scroll inside its own column and keeps the strip in
  view. The panes have no separate "up" button either: the crumb line is
  clickable, so an up control next to it was one control too many.

Acceptance check (driven from the browser, against the throwaway local
`sshd` rig as the device):

- A device session's file pane shows the transfer button; a local
  session's does not.
- Opening it draws two trees — 本机 on the left at the harness user's
  home, the device on the right at the session's directory on that device
  — each with its own crumbs and reload, scrolling inside its own column.
- Dragging a local folder onto the device pane creates that folder (with
  its subdirectories) in the drop directory, byte-identical (`diff -r`);
  dragging a device file onto the local pane lands it in the local
  directory with a matching `md5sum`.
- Dropping onto a directory row puts the entry **inside** that
  directory; dropping on the pane's own area puts it in the pane's
  current directory. Clicking an ancestor crumb moves that pane up.
- A 400-file folder reports its totals and progress, and 取消 stops it
  (state `cancelled`).
- Copying a name that already exists fails with the overwrite question;
  覆盖 replaces it and keeps the file's previous mode.
- Files above 32 MB are refused by name; a symlink is skipped and counted.

## Phase 9.11 — The agent's own terminal, and the status card

Goal: make "the terminal stays usable while the agent works" actually
true, and give the session one place where its state is visible. The
first half is what makes the second possible: once the agent prints into
a shell of its own, the user's timeline is the user's again — and the
agent's shell becomes something worth watching.

Shipped:

- **Two shells per session** (`dshell-terminal-bridge` host). The
  bridge already owned `main`; it now also owns `agent`, the same
  session Agent's second PTY under a different owner-local name,
  spawned **lazily** on the agent's first need for a terminal (a
  session whose agent never runs a shell pays nothing, and a device
  session does not open a second ssh connection for a panel nobody
  opened). It gets its own persisted log
  (`<dsh-session-id>.agent.log`), the same prompt/PS1 init and the same
  settle marker — `runInit` was generalized so both shells share one
  implementation, differing only in who hears about the frames and what
  the owner fixes up after the seeded scrollback is restored.
- **The agent's shell forks the user's**: it opens in the directory the
  user's shell is sitting in, read from the user's own prompt line
  (`user@host:dir$`, `~` rebuilt as `"$HOME"` so it still expands),
  because nothing on this wire reports a PTY's working directory. Best
  effort by design: a shell in the middle of a command ends in output,
  not in a prompt, and the fork then stays in the session's own
  directory.
- **The sync stays one-way and read-only.** The user's activity keeps
  reaching the agent's context through Phase 7's `主终端增量`
  injection, and `dshell_terminal_read` keeps reading the user's shell.
  The agent does not type into it: that is the same foreground contest,
  in the other direction.
- **The agent's stream is a second, read-only stream** on the same
  `/dshell/pty` route (`bind` with `stream: 'agent'`; `agent-open` to
  spawn it, `cols`-only `resize`, `agent-info`/`output`/`ready`/`closed`
  back). The panel drives the shell's width so it wraps where the reader
  sees it, and never its rows — a full-screen program needs a full
  terminal's rows, and the panel scrolls.
- **`dshell_get_agent_terminal`** (`dshell-commands`) replaces
  `dshell_get_main_terminal` and waits for the init handshake to settle
  before returning the id, because the agent's very next act is a send
  and the backend rejects one that overlaps another.
- **The task card became the status card** (`dshell-mode` browser): an
  integrated status list rather than a terminal window. It is
  permanent — idle says so and stays openable — one narrow line while
  collapsed (the phase of the running plan, else the parked/pipe/shell/
  link state, else `空闲`), and rows when expanded: 计划, AI 终端 (its
  detail is the live read-only terminal), 智能体 (dsh's subagent
  catalog, fetched when the row opens), 中断点 and 管道任务 (the
  cross-session pipe's effect on this session) and 连接. A row opens
  its detail; nothing opens by itself. The column reserves the
  collapsed card's height, so a floating pill never sits on the
  terminal's first line, and a `StatusCardBoundary` contains any fault
  to the card instead of the view.
- **中断点 is the pipe's parked state, made visible.** A ticket this
  session asked for and did not get an answer to is a breakpoint: the
  agent delegated, ended its turn on purpose and waits for the reply
  that reopens it — without this row the session looks idle while it is
  in fact suspended. The row's detail lists each outstanding ticket with
  its peer, state, remaining deadline, progress count and a 撤回; 管道任务
  is the other direction, the work another session handed to this one,
  and its detail opens the pipe panel. Both read the same pipe snapshot
  the panel does, polled by the card only while this session actually
  has a pipe.
- **The fake agent block is gone.** A turn whose rows are all command
  echoes — what `/permission <preset>` produces, since it submits a real
  turn with no model work in it — renders as one quiet line
  (`▸ /permission … · preset …`); a closed turn with no rows, steps or
  tokens renders nothing at all.

Covers decision: 4.10 (two shells per session, agent-owned terminal).

Plugins touched:

- `dshell-terminal-bridge` (both faces) — the agent shell, its record,
  teardown paths, the agent stream and its frames; the client service
  gains `.agent`, `.agentText()`, `.watchAgent()`, `.openAgentTerminal()`,
  `.resizeAgent()`.
- `dshell-commands` (host face) — the renamed tool and its description.
- `dshell-mode` (browser face) — `status-card.ts` (rows, details, the
  card's own terminal view), `agent-terminal.ts` (the read-only xterm),
  the block model's command-only line, the view's reserved top space.

Acceptance check:

- While an agent turn runs, `Enter` in shell mode executes in the user's
  shell immediately (measured 34 ms from keypress to echoed output) and
  the agent's own command still completes; the two shells have separate
  foregrounds and separate Ctrl+C.
- `dshell_get_agent_terminal()` returns a PTY id whose prompt is the
  directory the user's shell was in; commands sent there appear in the
  status card's AI 终端 row within a frame.
- `/permission <preset>` adds one line to the timeline and no task card.
- The status card is present on every session (collapsed ~35 px tall,
  ≤330 px wide), and expanding it lists the rows without opening any
  detail.
- With a delegate outstanding and the worker still busy, the requester's
  card reads `⏸ 等待 <peer> 回信` (row detail: peers, state, remaining
  deadline, progress, 撤回) and the worker's reads `⇄ N 个管道任务待处理`;
  once the worker finishes, both rows are gone.

## Phase 10 — Packaging

Goal: `dshell-*` packages install with `pnpm add` and dsh loads them
through `dsh.bundle`.

Deliverables:

- Each `dshell-*` package's `dsh.bundle` row in `package.json`.
- A combined `dshell-suite` bundle package that lists every
  `dshell-*` package as a bundle row.
- A README at the repo root with installation instructions:
  ```
  pnpm add -D @deepseek-ai/dsh-shell-suite
  dsh web --profile web
  ```

Acceptance check:

- `pnpm run constraints && pnpm run typecheck && pnpm run lint`
  passes.
- `pnpm run doc-sync` generates catalog entries without warnings.
- A clean dsh install with only `@deepseek-ai/dsh-shell-suite` added
  loads dshell with no manual config.

## Phase 10.1 — Desktop transport (P0)

Goal: the terminal survives a composition without `webServer`, so the page can
run inside the desktop shell.

Deliverables:

- `dshell-terminal-bridge` host: the frame protocol served on
  `ctx.connection.fetch` routes — `GET /api/dshell/stream` (long-lived
  newline-delimited body) and `POST /api/dshell/stream/send` (one client frame
  per request, correlated by the client's own `clientId`) — registered in a
  `ctx.inject(['connection'])` scope rather than inside the `webServer` scope.
  The `/dshell/pty` upgrade stays for the browser.
- The subscriber is a carrier, not a socket: one interface (`open` / `send` /
  `close`) implemented by a ws wrapper and by a Response-body writer, so
  spawning, buffering, block order and reconnect logic are untouched.
- Browser face: a channel abstraction over the two carriers, chosen by what the
  page can reach (ws only from an http(s) page), with
  `localStorage['dshell.transport']` and `__DSHELL_PTY__.useTransport()` as the
  override that makes the stream path testable from a browser.
- Wire contracts for the two paths live in `@nexus-aethra/dshell-std`.

Acceptance check:

- Browser: `__DSHELL_PTY__.carrier()` reports `ws` by default; a command runs
  and its output returns.
- `useTransport('stream')` rebinds both the main and agent streams to the
  stream carrier with the identical replay, `status: open`, `ready: true` and
  no retry; `echo …` returns over it; `openAgent()` spawns the agent shell on
  the agent stream; `reconnect()` answers with a fresh snapshot. Switching back
  to `auto` returns to ws with no retry.
- Route-level: the GET streams NDJSON behind dsh's own auth gate (401 without a
  cookie), and the POST answers 400 for a malformed or `clientId`-less frame
  and 204 for a `clientId` with no live stream.
- The desktop shell is verified in P2, once a Linux target exists to launch.

## Phase 10.2 — Publishable packages (P1)

Goal: the dshell packages are installable from a registry by the desktop plugin
window, not only linkable into a dev profile.

Deliverables:

- Manifests rewritten for publication: `private` dropped, `publishConfig.access`
  public, `files: ["lib"]` (the old list shipped only the two entry bundles and
  omitted every host module the entry imports), first-party dsh packages as
  exact-pinned peers with a matching `devDependencies` list, cordis as a peer,
  dshell edges as `workspace:^`.
- Root `pnpm.overrides` mapping every first-party name to the local `dsh/`
  checkout, so development keeps linking while the manifests carry what a
  consumer resolves.
- `scripts/local-registry.mjs`: a registry-protocol server over packed
  tarballs, with upstream passthrough for third-party dependencies.

Acceptance check:

- `pnpm typecheck` and `pnpm build` pass with the rewritten manifests.
- `pnpm pack` output installs from the local registry into a profile whose core
  packages are linked to the checkout (`+ @nexus-aethra/dshell-bundle 0.1.0`,
  `dsh.profile.bundles` gains the bundle).
- That profile boots and serves the dshell host routes
  (`/api/dshell/buffer` 200, `/api/dshell/files` 200, `/api/dshell/stream` 200
  holding open, `/api/dshell/stream/send` 400 for a body without `clientId`)
  and a combined client bundle containing the dshell faces.
- Known limit: the desktop plugin window hardcodes the npmjs registry, so a
  private registry needs an upstream change to be usable from the app UI.

## Phase 10.3 — Linux packaging (P2)

Goal: produce a Linux artifact from this checkout; dsh ships mac and win targets
only, and `dsh/` is a read-only reference, so the work lives here.

Measured blockers — every stage of dsh's desktop pipeline resolves its target
through a closed registry, and all three close over mac/win:

| where | what it gates | observed failure on Linux |
|---|---|---|
| `apps/desktop/scripts/package-target.ts` (`TARGETS`, `hostTargetName`) | the packaging command itself | `pnpm package:dir` → `desktop package: unsupported build host linux-x64`; the delivered shape drives the stages itself, so this registry is never loaded |
| `apps/desktop/scripts/desktop-build-paths.mjs` (`SUPPORTED_TARGETS`) | every artifact, runtime and download path | `pnpm prepare:runtime` → `desktop build paths: unsupported target linux-x64` |
| `apps/desktop/scripts/desktop-auto-update-environment.mjs` (`UPDATE_TARGETS`) | `createElectronBuilderConfig` and the release record | `resolveDesktopAutoUpdateTarget` throws for anything but `darwin`/`win32`; the config module also demands a full release environment (app id, update origin, signing) just to be imported |

What is already platform-general, and therefore worth reusing rather than
rewriting:

- `prepare-runtime.ts` handles `linux` (downloads `node-v24.17.0-linux-x64`,
  verifies it against `SHASUMS256.txt`, copies the pinned pnpm).
- `electron-builder.config.mjs` already declares `linux: { target:
  ['AppImage'] }`.
- `prepare-package-set.ts` and `prepare-seed.ts` do not branch on platform —
  they inherit the paths registry and nothing else.

Download path notes for this network: `prepare-runtime` hardcodes
`https://nodejs.org/download/release/...` (reachable here, HTTP 200); Electron's
binary is not in the local store yet (`electron@44.0.0`/`44.3.0` are installed
without a `dist/`), and electron-builder fetches its AppImage tooling from
GitHub releases, which this network resets — both are mirrored by npmmirror
(`/mirrors/electron/`, `/mirrors/electron-builder-binaries/`, both reachable) and
are honored through `ELECTRON_MIRROR` and
`ELECTRON_BUILDER_BINARIES_MIRROR`.

Chosen shape: `scripts/package-linux.mjs` in this repo, with a Node module
loader that widens the two reachable registries (`desktop-build-paths`,
`desktop-auto-update-environment`) with a synthetic `linux-x64` target, so dsh's
own prepare scripts and its electron-builder config run unmodified. The
alternative — duplicating the path/seed logic here — is ~400 lines of upstream
logic to keep in sync. mac artifacts stay on a Mac/CI host.

Delivered as planned, with the wrapping-config addition the AppImage forced:

- `scripts/linux-target-hooks.mjs` — a `load` hook that widens `SUPPORTED_TARGETS`
  and `UPDATE_TARGETS` as their source passes through; `scripts/linux-target-patch.mjs`
  registers it for `--import`. Each widening is announced on stderr, so a build log
  states which registry accepted linux.
- `scripts/package-linux.mjs` — resolves the pinned Node version out of
  `prepare-runtime.ts`, presees the tarball from npmmirror, asks upstream (under
  the hook) for the linux-x64 build paths as a first-step assertion, then runs
  upstream's stages in upstream's order: `build:official` → `release:pack`
  {dsh,vendor} → pack `desktop-host` → landlock → `prepare:runtime` →
  `prepare:packages` → `prepare:seed` → electron-builder. `--dir` stops at an
  unpacked directory, `--prepare-only` at the seed, `--from=<step>` resumes.
  Exposed as `pnpm package:linux`, `package:linux:dir`, `package:linux:prepare`.
- `scripts/electron-builder.linux.config.mjs` — upstream's config factory plus two
  fields. Upstream's package name `@deepseek-ai/dsh-desktop` makes electron-builder
  derive `executableName` `@deepseek-aidsh-desktop`, which the **AppImage target
  rejects** (`executableName contains characters that cannot be safely used in
  file paths`) even though `--dir` tolerates it; the wrapper names the executable
  `deepseek-harness`, matching the `artifactName` upstream already sets. The second
  field is the application icon, which upstream never sets at all — Phase 10.28.

Traps worth knowing for any future cross-target work here:

- **The hook must not travel in `NODE_OPTIONS`.** With `--import <hooks>` in the
  environment, pnpm 11 — which re-executes itself for nested `pnpm run` calls —
  fails at the first nesting with `Error during pnpmfile execution … Cannot find
  module '<dsh>/.pnpmfile.mjs'`. The file does not exist and nothing references
  it; an innocuous `NODE_OPTIONS="--no-warnings"` builds fine. Command-line
  `--import` on the four target-resolving leaf processes avoids it entirely, which
  is why this script orchestrates those steps instead of calling `package:dir`.
- **`tsx` as a CLI forks a child that a command-line `--import` does not follow**,
  so the prepare scripts get `--import tsx` (the loader module) instead. They need
  real transpilation: the desktop sources use parameter properties, which Node's
  strip-only TypeScript mode rejects (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` in
  `apps/desktop/src/project-manager.ts`).
- Node's tarball and electron-builder's AppImage tooling both come from npmmirror
  here; electron-builder re-downloads Electron even though `electron` is installed
  without a `dist/`.

Acceptance check:

- `pnpm package:linux:dir` → `.desktop-build/targets/linux-x64/artifacts/linux-unpacked`
  (672 MB) with `resources/runtime` (Node 24.17.0 + pnpm 11.7.0),
  `resources/seed` (503 packages, `store-archives`, `integrity.json`) and
  `resources/app.asar`; the bundled `runtime/node/node --version` answers
  `v24.17.0`.
- `pnpm package:linux` → `deepseek-harness-0.1.5-rc.1-linux-x86_64.AppImage`
  (245 MB) plus `rc-linux.yml`; the AppImage's sha512 matches the value in that
  metadata, and `--appimage-extract` yields `AppRun`, the `deepseek-harness`
  binary, a `.desktop` entry and the same `resources/` payload. (Verified again at
  `rc.2` in Phase 10.4.)
- Not yet done, and blocked on something else: launching the desktop shell and
  exercising the dshell terminal inside it. The app installs plugins from
  npmjs.org only (the registry is hardcoded), so that check needs the published
  `@nexus-aethra/dshell-*` packages — see Phase 10.1's last acceptance item.
- Cosmetic and left as upstream has it: no application icon is set (the default
  Electron icon is used, as on mac and win) and the executable-only `@`-mangling
  warning about `desktopName`/`syncDesktopName` remains.
- The update feed in the AppImage points at upstream's production origin
  (`https://download.deepseek.com/_/harness/desktop/stable/linux-x64/`); override
  `DSH_DESKTOP_APP_ID` and `DSH_DESKTOP_AUTO_UPDATE_ENV` for a real release.

## Phase 10.4 — Following dsh to 0.1.5-rc.2

Goal: move the dsh baseline off `0.1.5-rc.1` and find what that breaks, before
publishing dshell against it.

Where we started: the checkout was 134 commits behind `master`, upstream had
tagged `dsh-v0.1.5-rc.2` (2026-09-10, 272 manifests bumped rc.1 → rc.2), and
master was a further 139 commits past that tag. **The target is the rc.2 tag, not
master**: between the two, the desktop pipeline renames `prepare-seed.ts` to
`prepare-dsh.ts` and the `seed`/`seedPnpm` build paths to `dsh`/`dshPnpm`, and adds
`package-macos.ts`, `runtime-file-policy.ts`, `smoke-runtime.ts`, `installer.nsh`
and a Windows-only `DSH_DESKTOP_UNSIGNED` — all of which would invalidate
`scripts/package-linux.mjs`. rc.2 keeps the layout that script was written for.

What the follow-up consisted of:

- `dsh/` checked out at the tag: detached HEAD, working tree clean, version
  `0.1.5-rc.2`. Only `git fetch --tags` had touched the checkout before that.
- The ten `dshell-*` manifests move their exact dsh pins rc.1 → rc.2 (190 pins).
  `dshell-std` carries none — it is the pure contract layer.
- rc.2 changes no dependency edge: `pnpm-lock.yaml` and `pnpm-workspace.yaml` are
  byte-identical between the two tags, so nothing needed reinstalling. Trap worth
  knowing: `pnpm install --frozen-lockfile` in `dsh/` fails under the ambient pnpm
  9.15.0 with `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`, because pnpm 9 strips the
  `overrides`/`patchedDependencies` blocks pnpm 11 wrote. The declared pnpm
  (11.7.0, at `dsh/node_modules/.pnpm/pnpm@11.7.0`) validates the same lockfile
  fine, and `pnpm run` is unaffected either way.
- All 46 `link:` overrides still resolve, including the
  `node-pty@1.2.0-beta.15` store path pin.

The one real incompatibility — a latent bug of ours that rc.2 exposed:

`dshell-mode` registers the `single` slot `sidebar.brand.name` (the empty
placeholder that hides dsh's local-build label) at the default priority 0, where
dsh's own `ui-brand-official` already has an occupant. `ui-slots` throws when a
second `single` registration lands on the *same* priority, and only a different
priority shadows (lowest renders). That rule is identical in rc.1 and rc.2, so
this was never version drift — rc.1 happened to order our registration first.
rc.2 ordered it second, so the mode plugin failed to apply and the client showed
the Failed-to-load-plugins overlay while the other nine plugins loaded. Registering
at `priority: -1` makes the shadow explicit and order-independent. The audit of our
other registrations found no further exposure: everything else lands on `list` or
`keyed` slots (which collide only on `id`+priority), or on the `single`
`sidebar.workspaces`, which has no stock occupant.

Acceptance check — `pnpm typecheck`, `pnpm build`, browser, `pnpm package:linux`:

- Static: typecheck and build pass; client bundles keep `std` inlined and
  externalize only `cordis`, `client-store` and `ui-primitives`, all rows of
  rc.2's platform module table (which also still carries `react*`, `ui-slots`,
  `ui-dockkit`).
- Change surfaces checked, no action needed: `ui-primitives` still exports
  `FileTypeIcon` (the files panel's icons) beside the new code-file artwork;
  `ui-slots`/`ui-sidebar`/`ui-layout`/`ui-session` changed only their manifests;
  the `connection` client transport hooks gained an optional `rpc` and made
  `fetch` optional, but dshell touches neither — the host-side
  `connection.fetch.register` is unchanged.
- Browser against rc.2: ten of ten plugins load; the ws carrier reports
  `open`/`ready` with `attempt: 0`; `useTransport('stream')` rebinds to the stream
  carrier with `attempt: 0` and `echo rc2-stream-ok` returns over it; the files
  panel lists `/home/wpp/nexus` with a `ui-primitives` icon on every row.
- Host routes, after the cookie handshake: `/api/dshell/buffer` 200,
  `/api/dshell/files` 200 for a POST naming a live session (404 on GET is correct —
  the route registers POST only), `/api/dshell/stream` 200
  `application/x-ndjson` holding open with 130 KB of replay, and
  `/api/dshell/stream/send` 400 `clientId is required` without one; 401 without
  the cookie.
- Packaging: `pnpm package:linux:dir` succeeds on rc.2 with the same payload
  (Node 24.17.0 + pnpm 11.7.0), and `pnpm package:linux` →
  `deepseek-harness-0.1.5-rc.2-linux-x86_64.AppImage`.

Not addressed here: the checkout is pinned at the rc.2 *tag*, not master. Moving
to master is a separate change that first needs the desktop-pipeline renames above.

## Phase 10.5 — A storage engine for shell history

Goal: replace the per-session `.history.json` array with a dshell-owned store
that has an index, so history can grow past a cap and be queried — the shell's
up-arrow prefix search now, an agent-facing query later.

The problem, measured: `history.ts` kept `[{seq, command, exitCode, at}]` as one
JSON array per session, capped at `MAX_COMMAND_HISTORY = 200`. A read parsed the
whole array into memory and a write rewrote it in full (debounced), so the cap
was what kept it bounded — and the cap is what made history **lossy**: the route
could not answer for anything older than the newest 200 per session. The files
were also `0644` inside a `0775` directory, while command lines routinely carry
secrets.

Layering (the std-tier split, so a feature never owns a file format):

| layer | package | owns |
|---|---|---|
| contract | `dshell-std` (`src/storage.ts`) | record shape, store surface, file name, layout version, failure vocabulary — isomorphic, no Node builtin |
| medium | `dshell-storage` (new) | the SQLite engine; host-only, because `node:sqlite` cannot enter a client bundle |
| caller | `dshell-terminal-bridge` | `CommandHistory` as a facade: a bounded in-memory window for the keystroke path, the store behind it |

Nothing in `dshell-std` or `dshell-storage` names a dsh service: the engine is a
library, not a plugin, so it has no bundle row and does not appear in
`cordis.patch.yml`.

Format — `PRAGMA user_version = 1`, WAL, `synchronous = NORMAL` (history is
best-effort by contract; the session log owns durability), owner-only file:

```
commands(session_id, seq, command, command_norm, exit_code, at)
  PRIMARY KEY (session_id, seq)
commands_session_prefix(session_id, command_norm)
commands_at(at)
```

Three facts that shaped it, each verified rather than assumed:

- `LIKE 'x%'` with a bound parameter **never uses the prefix index**: SQLite
  refuses the LIKE optimization for a bound parameter, so with a session filter
  the plan is `SEARCH … USING INDEX commands_session_prefix (session_id=?)` — the
  index serves the session term and every row of that session is tested against
  the pattern. The range form `command_norm >= ? AND command_norm < ?` turns the
  prefix itself into an index seek. (The first draft of this note claimed a full
  table scan; the check caught that the composite index does serve the session
  term, and the honest statement is the one above.)
- Prefix matching is **strict** (`startsWith`), and under a strict prefix every
  match shares the whole draft, so there is nothing to rank — recency is the
  only meaningful order. The earlier design walked k downward from the draft's
  length to rank by shared-prefix length, but the weaker k-bands let
  `grep -r git .` into an answer for the draft `git` (caught by the check).
  Fuzzy ranking is a different query and belongs with the caller over a bounded
  candidate set. *(Phase 10.7 replaced the single range query this originally
  ran with a newest-first scan, keeping the range query as the fallback.)*
- Answers come back in **timeline order** (oldest first), the same convention as
  `recent` and the same order the history route already sends, so a caller
  filters without reordering.

Migration and the deletion contract: a session's legacy file is imported on its
first open after the upgrade, idempotently by `(session_id, seq)`, and never
written again — the file stays in place as a rollback. Deleting a session drops
its rows **and**, synchronously, its legacy file: `releaseSession` runs at
teardown, where a deferred unlink or a late debounced write would race the
process exit that is removing the session. Deletion had never dropped either
copy — the purge's PTY suffixes did not cover `.log.history.json`, and nothing
dropped store rows — which mattered more once `/clear` stopped being the manual
purge (Phase 10.6). A store that cannot be opened at all (read-only home,
foreign layout) degrades to the file path rather than losing history.

Acceptance check:

- 30 behavioural checks pass against the built libs: append/recent/count,
  idempotent re-append, strict-prefix matching (only the draft's prefix, no
  substring hits, case-insensitive, `limit`-bounded), timeline order,
  `clearSession` scoped to one session, the composite index in the plan for the
  range form and not for `LIKE`, the database file at `0600`, migration from a
  legacy file (blank commands dropped, idempotent on reload), the 200-entry
  window still capping memory while the store keeps everything, a foreign
  `user_version` rejected as `version-mismatch`, and the JSON fallback when the
  store path is unusable.
- In the running harness: `history.sqlite` is created `0600` in WAL mode with
  `user_version = 1` and the three declared indexes; the resumed session's legacy
  file had already been imported (9 rows, including a command from the earlier
  transport test); a command sent through the real PTY landed as row 10; a
  prefix range query answered exactly `echo history-store-ok`; the legacy file
  was not rewritten (no marker in it); and the history route still returns the
  newest commands, so the up-arrow gesture is unaffected.

Not addressed here, deliberately, and in this order:

1. ~~The protocol~~ — **done in Phase 10.7**: the request carries `draft` and
   `limit`, and the route answers from the store, so the response is bounded by
   `limit` rather than by the window.
2. Uncapping and a retention window (the store already keeps everything; the
   in-memory window still trims at 200 as a cache, not as the answer).
3. The query surface for agents (FTS5 is available on both runtimes for
   full-text, `commands_at` for cross-session time queries). The
   `commonPrefix > 0` vs strict-prefix question is **decided in Phase 10.7**:
   strict prefix, in the store and in the client's fallback window.
   A token prefix tree is **not** on that list: for the up-arrow path the
   B-tree range seek above is already the optimal structure for a strict
   prefix, and a trie would be a second in-memory format to rebuild, not a
   faster query. A trie only pays for *fuzzy* prefix ranking or word/token
   search — and for the token half FTS5 (present on both runtimes, persistent,
   ACID) already provides the inverted index, with usage-count/recency ranking
   as a scoring layer over either structure. If an in-memory index is ever
   added it should be a bounded cache over the store, never a second source of
   truth.

## Phase 10.6 — Retiring `/clear`

Goal: stop exposing a dshell `/clear` command. The in-terminal `clear` already
clears the canvas natively, so the slash command's only distinct effect was
dropping the persisted scrollback and resetting the shell epoch — an operation
the terminal no longer needs, and one that cost a whole set of clear-only code
paths in the bridge.

Plugins touched:

- `dshell-commands` (host face) — the `clear` registration is removed; `/new`
  and the two model tools remain.
- `dshell-terminal-bridge` — `clearSession()` and `performClear()` are deleted.
  `CommandHistory.clear()` survives with a new caller: `releaseSession()`, so
  deleting a session drops its store rows and its legacy file (see the deletion
  contract in Phase 10.5). `BlockSplitter.clear()` — dead already, since
  `performClear` recreated the splitter instead — is deleted with it.
- `dshell-workspace` — `purgeSessionArtifacts` also drops
  `<session>.log.history.json`, the legacy file the PTY suffix list never
  covered.

What changes for the user: no `/clear` in the slash menu; `clear` (bash's own,
which the canvas honours) is unaffected; up-arrow history keeps working because
it never depended on the command.

Acceptance check:

- `pnpm typecheck` and `pnpm build` clean; the emitted `commands/lib/index.js`
  no longer contains the registration and `terminal-bridge/lib/index.js` no
  longer contains `clearSession`.
- In the running harness, the slash menu (composer, leading `/`) lists
  `new` plus dsh's stock commands and **no** `clear` — read from the page's
  `[role="listbox"]` after typing `/`, nothing submitted.
- The history route still answers for a resumed session, so the up-arrow path
  is unaffected.

Still open from this: rows left in `history.sqlite` by a session that was
already cold at delete time (no bridge record, so no `releaseSession`) belong to
the retention pass in "Not addressed here" item 2.

## Phase 10.7 — History retrieval goes to the index

Goal: the up-arrow gesture searches the whole history, under one clear rule, at
a cost that does not grow with how much history exists. Phase 10.5 built the
index; this phase is the wiring, because the index had **no caller**: the route
read `bridge.history()` — the live 200-row window — so nothing older than the
window was reachable, and the browser filtered what it was sent with
`commonPrefix(command, query) > 0`, i.e. **first character equal**. A draft of
`git` listed `grep -r git .`, and a command older than the newest 200 could not
be found at all. The client's `requestHistory` even took a `draft` parameter and
dropped it from the request body.

The three seams, and what each became:

| seam | was | is |
|---|---|---|
| wire | `{action:'history', sessionId}` | `{action:'history', sessionId, draft, limit}` |
| route | `bridge.history()` — the window | `bridge.matchHistory()` — the store, window as fallback |
| rule | first character equal (`commonPrefix > 0`) | strict prefix, case-insensitive, in the store and in the fallback |

`CommandHistory.match()` is the facade that keeps the store knowledge out of the
route: it asks `store.matchPrefix` whenever the store is open and filters the
in-memory window only when it is not, under the same strict rule. The window is
now a cache for the empty-draft path, not the ceiling on what is findable.

The query itself had to change, and this is the fourth measured fact from
Phase 10.5 — measured at 200k commands in one session:

| draft | matching rows | range seek + `ORDER BY seq DESC LIMIT` | newest-first scan, early exit |
|---|---|---|---|
| `g` | 20,000 | 9.09 ms | 0.11 ms |
| `git` | 10,000 | 4.72 ms | 0.23 ms |
| `git --flag 19` | 555 | 0.16 ms | 0.21 ms |
| `zzzz` | 0 | 0.005 ms | 0.68 ms |

The range seek is an index seek, but the index is ordered by `command_norm`
while "the newest matches" is ordered by `seq`, so the plan adds
`USE TEMP B-TREE FOR ORDER BY` and sorts every match — hence the linear growth,
and hence 9 ms of **blocking** work on the event loop (`node:sqlite` is
synchronous). Scanning newest-first through the primary key `(session_id, seq)`
makes `ORDER BY seq DESC LIMIT` free and lets the scan stop as soon as enough
matches are seen; it is bounded by `PREFIX_SCAN_BUDGET = 5000` rows and falls
back to the range seek, which is the cheap path precisely when the prefix is
sparse. `limit` matches inside the newest budget *are* the newest `limit`
matches, so the two paths cannot disagree.

No pagination, deliberately: the gesture wants the newest K matches, which is a
top-K query, and a page of a prefix would put the *older* matches first —
paging the gesture would make it wrong, not faster. A browsing UI (or the
agent-facing query of item 3) is where paging belongs. And still no trie: for a
strict prefix the B-tree is the same structure a trie would be, without a second
in-memory copy to rebuild (see the note in Phase 10.5).

Acceptance check:

- 24 behavioural checks against the built libs: every draft agrees with a
  brute-force computation over the raw rows (dense, sparse, deep, absent,
  case-folded, empty), strict prefix never returns `grep` for `git`, timeline
  order, `limit`, the fallback reaching rows older than the scan budget, the
  newest-first statement's plan on the primary key with no temp B-tree, the
  facade finding commands older than the 200-row window, and the JSON fallback
  window keeping the same strict rule.
- The fixture checks report, over 8k stored rows: dense prefix 171 µs, sparse
  fallback 507 µs, empty draft 41 µs.
- In the running harness, the route answers `draft: "npm l"` with only the
  `npm login …` rows (the old rule would also have listed
  `npm config set registry …`), `draft: "npm c"` with only the config row, and
  an unknown prefix with none.
- In the browser, the real gesture: `npm c` + ↑ left
  `npm config set registry https://registry.npmjs.org/` in the composer with a
  one-row list, and an empty draft + ↑ left `echo history-store-ok` (the newest
  command) with the full ten-row list.

## Phase 10.8 — History maintenance: budget, layout 2, deletion

Four follow-ups from Phase 10.7's measurements and review.

**The scan budget is derived, not fixed.** 10.7 shipped
`PREFIX_SCAN_BUDGET = 5000`, which the calibration showed is only right at one
size: a draft whose matches have density `d` makes the scan read `limit / d`
rows while the range seek reads and sorts `d * N`, so equality gives
`budget = sqrt(limit * N * b/a)`. With the measured `b/a ≈ 2.5` (sorting a
match costs about 2.5 row reads) that is `sqrt(limit * N * 2.5)`. `N` comes from
`max(seq)`, which the query already reads — and it over-counts after a deletion,
which only widens the budget, and a budget wider than the session is harmless
because the scan is bounded by the table. Measured (µs, limit 60, one session):

| N | density | matches | adaptive | range only | old fixed 5000 |
|---|---|---|---|---|---|
| 8k | 1/10 | 800 | 153 | 245 | 128 |
| 8k | 1/20 | 400 | 274 | 89 | 142 |
| 8k | 1/100 | 80 | 166 | 38 | 533 |
| 8k | 0 | 0 | 119 | 4 | 482 |
| 50k | 1/20 | 2 500 | 184 | 753 | 194 |
| 50k | 1/100 | 500 | 673 | 285 | 959 |
| 50k | 0 | 0 | 336 | 4 | 597 |
| 200k | 1/2 | 100 000 | 74 | 19 017 | 38 |
| 200k | 1/20 | 10 000 | 186 | 3 392 | 178 |
| 200k | 1/100 | 2 000 | 2 061 | 1 185 | 1 812 |
| 200k | 0 | 0 | 670 | 4 | 621 |

All 18 measured shapes (three sizes × six densities) return the right rows. The
honest reading: adaptive beats the old constant by up to ~4× in the *sparse*
band, which is the band a user reaches by typing more characters, and loses to
it by ≤1.3× in the mid-density band, where the probe is paid and then discarded
in favour of the range seek. Its worst case is 2.06 ms, the old constant's is
1.81 ms, and range-only's is 19 ms at the same size — so the ordering that
matters is intact, and the residual is the price of "probe, then decide". A
two-stage probe (estimate the density from a small probe, then either continue
scanning or take the range seek) would roughly halve that worst case; it is not
worth the extra statement at sub-millisecond typical costs.

**Layout 2 drops an index nothing read.** `commands_at(at)` was created for a
cross-session time query that was never built: no query in the engine touches
`at`. It cost disk and write amplification on every insert, so layout 2 removes
it. The engine now *migrates* a layout-1 database in place instead of rejecting
it — the `DROP INDEX` is the whole migration — which also establishes that
future layout changes need not be a hard failure.

**Deleting a session drops its history even with no shell record.**
`releaseSession` could only clear what it had a record for, so a session
deleted before its terminal was ever opened kept its rows forever, and the
route only called it in the loaded branch. Now the route calls `release` in both
branches, `releaseSession` additionally reaches the store by path through
`forgetSessionHistory` (which leaves an absent store uncreated rather than
creating one to delete nothing from it), and the purge stays synchronous.

**Teardown folds the log.** `close()` now runs `PRAGMA optimize` (so the
planner keeps the statistics it gathered) and `PRAGMA wal_checkpoint(TRUNCATE)`
(so no sidecar is left beside the log directory). Both best-effort.

Measured and **not** adopted: a covering index `(session_id, seq, command_norm)`
makes the scan's per-row prefix test index-only, which speeds the probe up
2.4–3× (194→80 µs at density 1/20, 756→250 at 1/100, 754→222 at 1/500, 200k
rows, forced-index comparison) and shortened the whole `matchPrefix` call to
525 µs from 2473 µs in the mid-density case. It costs +31% disk (24.4 → 31.9 MB
for 200k rows, ~37 B/row) on a store that is deliberately unbounded. Deferred:
the same win is available from the two-stage probe without the disk, and the
current absolute costs do not justify either yet.

Acceptance check:

- 15 migration and purge checks: on a **copy of the real v1 store** (10 rows,
  `commands_at` present), opening it stamps layout 2, drops only that index,
  leaves every row byte-identical, keeps the prefix index, and still answers
  `count` / `recent` / `matchPrefix`; a fresh database is created at layout 2
  without the index; an unknown layout is still refused with
  `version-mismatch`; `forgetSessionHistory` removes one named session's rows
  and leaves another's, and does not create a store that was never there.
- The live store migrated on boot (layout 2, 10 rows intact) and the history
  route still answers `npm l` with 5 rows and `npm c` with 1.
- The deletion wiring was exercised end to end against the live store without
  touching a real session: two rows were injected for a probe session, the
  probe was deleted through `/api/dshell/sessions`, and its rows went to zero
  while the real session's ten stayed; this is the cold case (no bridge record),
  which is exactly what used to leak.
- The 30 storage checks and the 24 retrieval checks still pass; the 8k-row
  sparse fallback dropped from 507 µs to 136 µs.



## Phase 10.9 — Per-command output, addressable by offset

Goal: an injected terminal block must never carry a long command's output whole,
and the model must be able to read the rest on demand — `(seq, offset, limit)`
into one command's output, across boots. This is the first change that makes the
store hold output rather than only the line.

**Why new storage was needed even though three artifacts are already persisted.**
None of them can answer that question:

| artifact | holds | why it cannot be sliced per command |
|---|---|---|
| dsh session log (`sessions/<shard>/<id>/session.v3.jsonl.zstd`) | the conversation's events | the terminal stream is not in it; a zstd JSONL per turn, not a byte range per command |
| PTY log (`dshell-pty/<id>.log`) | the raw byte stream | bytes are there, but raw ANSI, every command concatenated, prompts and echoes included, and **no seq anywhere** — locating command 57 means re-running the splitter over the whole file |
| block log (`<id>.log.blocks.json`) | sanitized text | granularity is a *block* (a stretch between turns), and it is capped (400 blocks / 512 KiB) |
| `commands` table (layout 2) | line, exit, time, indexed by `(session_id, seq)` | indexable, but deliberately without output |

`seq` exists only in the splitter's own semantics, so no raw log has it. The fix
is one more table in the same database — not a new engine, file or format:

```
command_output(session_id, seq, output, bytes, dropped)  PRIMARY KEY (session_id, seq)
```

`output` is the retained **tail** with `bytes` (what the command produced) and
`dropped` (what is missing from the front), so offset 0 is honestly the start of
*the retained text* and a reader is told when it is not the start of the output.
It sits beside the narrow `commands` table rather than in it: the prefix probe
reads those rows, and kilobytes of output on them would slow every search.

Two caps, deliberately different, which is what makes the tool safe to use:

| layer | cap | why that number |
|---|---|---|
| store | 64 KiB per command | equal to the splitter's own pending bound, so storing this much costs no extra memory; raising it is a memory decision |
| window/preview | 16 KiB per command in memory, 2 KiB in the injected block | 200 × 64 KiB in memory is the one thing the cache must not become |

Outputs are retained for the newest 1000 commands per session; eviction loses
the text, never the metadata. `clearSession` drops both tables, so deleting a
session still takes everything with it.

**The tool.** `dshell_terminal_output` takes `{cursor, seq, offset, limit}`
(default slice 2 KiB, never more than 8 KiB — the tool exists to keep reads
bounded, so it cannot be asked for a whole output), and answers with the slice
plus `[保留 N 字节, 原输出 M 字节; 本次 offset A -> B]` and a `next offset`.
The cursor pins the shell generation: after a respawn the same `seq` names a
different command, and the answer is `stale` rather than a wrong slice. With no
store the in-memory window's display text answers instead, so a fallback
deployment still reads the recent past.

**The injected block is now a window.** On each user-driven step the newest
three commands ride in with their output previews (2 KiB each, tail-first),
the session cursor, each command's `seq` (the tool's key — without it the model
could not ask for anything), a count of commands finished since the previous
step, and — only when something was cut — a pointer at the tool. A shell that
closes no command records at all (one without markers) falls back to a capped
slice of its raw output. The watermark survives for the count line only; the
block itself always shows the recent state, which is smaller than the old
first-turn block (20 command lines + an 8 KiB raw tail).

Acceptance check:

- 20 output checks against the built libs: whole outputs, byte-window slicing
  that snaps to UTF-8 boundaries (CJK), paging from the returned offset, an
  offset past the end, negative offsets, non-positive limits, missing rows,
  eviction past the retention window with metadata surviving, `clearSession`
  dropping both tables, and the layout 2 → 3 and 1 → 3 migrations (the 2 → 3
  case against a copy of the real store: 10 rows intact, pre-existing commands
  reporting no output rather than empty output).
- 13 splitter checks, including the two-tier truncation: a 20 KiB body keeps a
  full stored tail while the preview carries its marker, and an 80 KiB body
  stores only the last 64 KiB and reports the dropped front.
- In the running harness: the live store migrated to layout 3 on boot (10 rows,
  `command_output` created); a scratch session ran `seq 1 300` and `seq 1 800`,
  both persisted with their outputs (1092 B and 3092 B, `dropped` 0); the agent
  turn then quoted the injected block verbatim —
  `[dshell 主终端 · 最近 2 条] cursor: g2:5460:2`, both commands with `exit` and
  `seq=`, full output for the small one, `…(仅显示尾部)` for the other, and the
  tool hint — and its two tool calls returned, verbatim:
  `[保留 3092 字节, 原输出 3092 字节; 本次 offset 0 -> 512]` … `(next offset: 512)`
  and then `本次 offset 512 -> 1024` … `(next offset: 1024)`, with the cursors
  advancing `g2:5482:2` → `g2:5504:2`.
- Deleting the scratch session through the route removed its 2 commands **and**
  its 2 outputs while the real session's 10 rows stayed, so the output table
  rides the existing deletion contract.

## Phase 10.10 — SSH credentials and host trust

A standard-and-safety review of the whole `dshell-ssh` chain (runner, device
registry, router, remote filesystem, spawn routing, the HTTP route and the
device card), then the fixes that needed no decision. The verdict was that the
OpenSSH usage is correct and in places more careful than usual — askpass instead
of argv passwords, password devices pinned to `PreferredAuthentications=password`
+ `PubkeyAuthentication=no` + one prompt, two-level POSIX quoting with the
assignment-word subtlety handled, `-T`/`-t` chosen per path, remote writes staged
by `mktemp` on the destination filesystem and renamed into place, the sandbox
fence applied in trusted code to the device path — with two verified credential
defects and two permission/leak surfaces.

**Fixed:**

- **`IdentitiesOnly=yes` whenever a device has a stored key.** Without it the
  harness user's ssh agent is still consulted: `ssh -vv` shows the agent's
  identity being *offered before* the explicit `-i` one, so a host that also
  authorises a personal key authenticates as that identity, and a device whose
  key was rotated or revoked keeps looking like it works. Only the devices that
  actually carry a key get the option — a key device with no stored secret is
  documented as using the ambient agent, and that path is unchanged.
- **`ControlPath` is per device.** `%C` hashes only local host, remote host,
  port and remote user, so two device records reaching the same account shared
  one master connection and whichever authenticated first served the other;
  changing a password or key did not invalidate that master for
  `ControlPersist=120s`. The path is now a 16-hex digest of the destination
  *and* the device id, with the destination included so that editing a device's
  host cannot leave a master authenticated to the old one in place. Not `%C`:
  its 40 characters leave too little of the ~108 byte unix socket path for
  `ssh`'s own listener name once `$DSH_HOME` is deep, and an over-long path does
  not merely disable sharing — ssh fails the connection — so when the path would
  not fit, the control options are dropped and the connection is made without
  reuse.
- **Host trust stays the plugin's own.** `StrictHostKeyChecking=accept-new`
  with no `UserKnownHostsFile` was writing dshell's first-contact decisions into
  the user's personal `~/.ssh/known_hosts` — hash-aware `ssh-keygen -F` found
  the rig and the remote server there — and reading it back. The option now
  points at `$DSH_HOME/dshell/ssh/known_hosts`, beside the keys, so dshell's
  trust and the user's ssh client's trust are separate stores.
- **The trusted host key is shown.** `accept-new` records an unknown host's key
  without asking, so the one decision the user could verify was also the one
  they never saw: a successful Test reported only `已连接 user@host（system）· Nms`,
  and the `Permanently added …` line ssh prints went to a stderr that is only
  read on failure. `router.test` now reads this plugin's own `known_hosts` with
  `ssh-keygen -F` (which resolves hashed entries) before and after connecting and
  appends `主机密钥 SHA256:…（首次信任，请与服务器管理员核对）` or `（已信任）` — so
  first contact is announced by name, and the fingerprint is there to compare
  against an out-of-band value. It is read back from the local store on purpose:
  a fingerprint the device reports would travel over the very connection whose
  identity is in question. `host-key.ts` computes OpenSSH's `SHA256:` spelling
  from the key blob in JS, cross-checked against `ssh-keygen -l`.
- **Terminal transcripts are owner-only.** `$DSH_HOME/dshell-pty/` was `0775`
  with `0664` files while `history.sqlite` was already `0600`; a transcript holds
  everything the shell printed and (see the splitter) every line the user typed,
  so any other account on the machine could read it. The directory is now `0700`
  and every artifact `0600` (`<id>.log`, `.timeline.json`, `.blocks.json`,
  `.history.json`), written through `private-file.ts`, which also tightens a file
  an earlier build left loose — creation mode alone would only have fixed future
  sessions. The 102 existing files were tightened in place.

**Verified with the built code, not by reading it.** A script called the real
`sshArgv`/`interactiveShellArgv` from `lib/` and fed the result to `ssh -G`: key
devices report `identitiesonly yes` with the device key as the only
`identityfile` and `userknownhostsfile …/dshell/ssh/known_hosts`; a key device
with no stored secret still reports `identitiesonly no`; password devices keep
their pins; the two devices hash to different socket paths, each short enough to
leave room for ssh's listener name. A live handshake against the local rig showed
a fresh connection offering exactly one key — the device key — with no agent
identity offered, and a second connection riding the master with zero offers. A
`PtyBuffer` opened over a fixture that started `0775`/`0664` came back
`0700`/`0600`, as did a log created from scratch, its timeline sidecar and a
blocks json.

The host-key line was verified by driving the real `router.test` against the rig
with a stand-in subprocess service: against the real store it reports
`已信任` with the same fingerprint `ssh-keygen -lF` reports, and
`trustedHostKey` returns `undefined` for a device that is not trusted yet. Run
against an isolated `DSH_HOME` with an empty store, the same call reports
`首次信任，请与服务器管理员核对` and leaves the rig's key in *that* store while the
personal one is untouched. A third run under a `DSH_HOME` too deep for any
socket confirmed the fallback: the control options disappear and the connection
still succeeds.

**Still open (needs a decision, not a patch):** whether the newest-command window
should skip lines typed at a prompt that is not a shell prompt, since a secret
typed at a remote `sudo`/`psql`/passphrase prompt is currently recorded as a
"command" and injected; and that a live master means a connection *test* cannot
prove a just-rotated credential within `ControlPersist`.

## Phase 10.11 — The scheduled-removal state gets its own section, and a deleted session leaves the pipe graph

Phase 9.5 left the scheduled-removal state *inside* `已归档`: a pending row was
an archived row with a ` · 重启后清除` suffix, a `取消` action instead of `恢复`,
no delete button and no checkbox. That made one list hold two different
meanings, and the row-level special cases were the only place the distinction
was visible. Two things were also still wrong about deletion itself:

- **A deleted session stayed in the pipe graph as an edge-less node.** dsh
  cannot tear a loaded session down (`ctx.sessions` keeps it until the next
  start), so the raw session list keeps naming it, and the graph drew a node per
  listed session. Its pipes had already been dropped by
  `BufferService.detachSession`, which left a peer that looked merely idle.
  The endpoint pickers in the create-pipe form also still offered it.
- The sidebar gave no place to see "these are on their way out" as a state,
  as opposed to a per-row annotation.

Shipped:

- **A third group, `待删除`, after `已归档`.** Its rows are `archive.pending`;
  `已归档` now lists `archived` minus pending, so a row appears in exactly one
  group. The header carries the meaning (`待删除` + a quiet `重启后清除`) and the
  group is hidden while empty; each row's only action is `取消` (drop the
  scheduled purge and return the session to the active list — the same
  gesture unarchiving performs). Multi-select stays with `已归档`, where
  恢复/删除 actually apply, so `selectable` keeps one meaning.
  No protocol change: `pendingPurge` was already in the session response.
  Both the count and the visibility of `已归档` derive from the split list,
  not from `archive.archived`: a pending session is still in the durable tag
  set, so a raw count kept the header (and its multi-select controls) alive
  over zero rows.
- **`BufferState.departed`** — the ids a deletion has taken away, populated
  only by `detachSession` and never persisted, because after a restart their
  logs are purged during composition and dsh stops listing them, so there is
  nothing left to hide. The pipe panel filters them out of the graph nodes and
  the endpoint pickers. Archiving is deliberately *not* included: an archived
  session is put away, not gone, and may still be a legitimate end of a pipe.
- **`restoreSession`** undoes the hiding when a pending deletion is
  cancelled. `SessionTagStore.unarchive` already cancels the scheduled purge
  (the two are one gesture from the sidebar), which puts the session back in
  use — dsh never forgot it and its log is intact — so a permanently hidden
  graph node would be wrong for the rest of the process. The route's
  `unarchive` branch calls it after the tag write. Its pipes are not
  resurrected: those were cut when the deletion was requested, and re-linking
  is a new gesture.

The two pure derivations are the whole client change (the row split and the node
filter); the panel learns about a deletion on its next read, which is
immediate when it is opened and at most one 3 s poll otherwise.

Verified in the running harness on the rebuilt bundle, end to end, with two
scratch sessions and a real pipe: archiving a row then deleting it moved it to
`待删除` with `已归档` disappearing entirely (header and multi-select included),
the confirmation dialog closed instead of sticking, `/api/dshell/buffer`
listed the session in `departed` with the pipe gone, and the graph went from
three nodes and one edge to two nodes and no edge — the deleted session's node
absent, the surviving peer unmarked. `取消` then removed the `待删除` group,
returned the row to the active list, and brought its graph node back; the
restored session's shell answered `echo` with the right cwd, so cancelling a
deletion leaves a usable session rather than a tombstone. The in-memory half
was also checked directly against a seeded pipe: `detachSession` reports the id
in `snapshot().departed` and a freshly constructed service does not inherit it,
confirming the process-lifetime claim rather than asserting it.

An independent review pass over the change found four more edges, all closed
here. The confirmation dialog still promised a loaded session would be
"收进「已归档」" — it now says `待删除`. `多选` could be stranded: the mode's
only switches live on the `已归档` header, so a batch delete that moved every
selected session to `待删除` emptied the group and left the mode on with no way
out — an effect now drops the mode, the selection and the batch target when the
group empties. The session route's two tag reads are separate awaits, so a
concurrent `markPending` could report a pending id the archive half lacked, a
pair the row split cannot represent (the row would appear twice); the response
now repairs `pendingPurge ⊆ archived`. And the create-pipe form's endpoint
picks are re-checked against the live list before submitting, because a picker
value can outlive its option while the form is open — the same orphan edge the
node filter exists to prevent — with the submit button disabled rather than
silently failing.

The build is also warning-free again: the preset's deprecated
`external`/`noExternal` are now `deps.neverBundle`/`deps.alwaysBundle` (plus
`deps.onlyBundle: false` to silence the bundling hint), and the client entries
dropped their redundant `export default`, which was the sole source of
rolldown's `MIXED_EXPORTS` — the loader's `exports.default ?? exports` reaches
the same `{ name, inject, apply }` either way, and no dsh client entry exports a
default. Boot was re-verified with every client plugin loading.

## Phase 10.12 — Tab completion folds capitals

The composer's Tab matched a path prefix byte for byte, so `ls nexus-sh` found
nothing while `Nexus-shell` sat in the directory being listed — the shell's
filesystem is case-sensitive and the completion inherited that, even though the
reader's mistake is only a missed shift and the name is right in front of them.

Shipped:

- **The comparison folds ASCII capitals; nothing else changes.** Every path the
  route looks up stays exact and stays in the session's own world — the fold is
  on the reader's side of the comparison only, because a completion is a guess
  about what was meant, not a lookup. Candidates keep the spelling the
  filesystem stores, which is what makes the correction happen: the client
  replaces the token's span with the candidate, so `nexus-sh` + Tab becomes
  `Nexus-shell/`, and a unique candidate applies itself, so the key that opens
  the list is the key that fixes the line.
- **Ambiguity is listed, never guessed.** `nexus-` with `nexus-study` beside
  `Nexus-shell` opens the list with both, each spelled as stored — the fold
  widens the candidate set rather than picking a winner. A name that exists
  exactly is still used exactly: folding can only turn a miss into a match.
- **Only A–Z fold**, deliberately. The mistake being repaired is a Latin
  letter; a locale-aware fold would start equating names that are not the same
  name in other scripts (a Turkish dotless i, the Kelvin sign), and could
  change the string length the candidate offsets are measured in. Chinese
  names complete exactly as before.
- **A directory the reader spelled with the wrong capitals gets one recovery.**
  `ls neXus-shell/<Tab>` cannot list a directory that does not exist by that
  name, so the completion falls back to completing the segment the slash
  follows — `Nexus-shell/` — after the exact reading misses. Only an ABSENT
  path reaches it: a token that exists but is not a directory is not an older
  spelling of something else, and `ls foo/` must not silently become `ls foo.d/`
  because a file was given a slash. The answer still owns just that segment,
  which is what keeps the line correct: the next Tab lists the directory.

Boundaries, both deliberate: a spelling error is not repaired (`nexus-shrll/`
still reports `目录不存在` — the fold equates case, not letters), and only the
segment being completed is folded, so a wrong case *earlier* in the path
(`neXus-shell/inner/`) still reports the miss — correcting that would have to
rewrite text the candidate does not own, which the completion's span-only
protocol cannot express.

Verified in the browser against a fixture directory holding `nexus-study`,
`Nexus-shell`, `Solo-Dir` and `中文目录`: `nexus-` listed both spellings,
`nexus-sh` and `NEXUS-SH` both completed to `Nexus-shell/`, `nexus-st` to
`nexus-study/`, `SOLO-` to `Solo-Dir/`, `中` to `中文目录/`, `rea` to
`readme.md`, and `neXus-shell/` (relative and absolute) corrected through the
recovery, while `nexus-shrll/`, `zzz/` and `neXus-shell/inner/` still reported
`目录不存在`. `ls Nexus-shell/inner` completing normally shows the exact path is
untouched.



## Phase 10.13 — The command hint, taken a word at a time

A shell's line editor suggests because it owns the line; here the composer is the
line and the history is on the host, so re-typing a long command meant recalling
it by hand or walking the `↑` list back to it.

Shipped: the tail of a recent command is ghosted after the caret, and the **right
arrow takes it one word per press** — `docker` + → + → walks `docker run nginx a
word at a time, the last press ending the line. The source is the same
per-session record the up-arrow list reads (the bridge's command splitter), so
nothing new is stored, and the ask goes to the host because the host owns the
index over the WHOLE history — a window filtered in the browser is exactly the
ceiling that makes an old command unfindable.

Decisions the work forced:

- **The ghost is not inside the editor.** The composer is a Lexical
  contenteditable: an injected node would be reconciled away on the next update
  and, until it was, the editor would read its selection offsets out of a tree it
  does not own. The tail is instead a span in the composer's floating overlay,
  placed from the caret's own rect — so it sits wherever the next character would
  go, the wrap included.
- **The place is re-read, never cached.** The ghost is positioned from the caret's
  rect on every `selectionchange`, on a window resize, AND on the editor's own
  resize: a re-wrap is the one caret move the selection API does not report, and
  the window can stay the same size while the composer does not (the sidebar
  opened, the view split). Without the `ResizeObserver` the ghost kept the line
  the offset used to be on.
- **The match is an exact prefix, unlike Tab's.** Tab REWRITES the token under the
  caret, which is why it can fold capitals; the ghost can only append, so a
  case-insensitive match could suggest a command spelled differently from the
  draft and then append a tail continuing the wrong word.
- **What is not on screen is not taken.** The ghost hides whenever the caret
  leaves the end of the draft, and the arrow agrees with what the reader can see:
  a mid-line → moves the caret instead of accepting. (Found by testing the
  first cut, which accepted while the ghost was invisible — the same
  visible/state disagreement the completion list's apply-on-move rule exists to
  prevent.)
- **A hint belongs to the session that asked for it.** The store's entry carries
  its session id, and both the read and the take test it, so a switch retires the
  old line at once: a session whose draft coincidentally matches the previous
  one's command cannot ghost — or take — text from the session it came from.
  (Also found by review: the id was written down and never read.)
- **One query per typing pause, sequence-guarded.** The draft changes on every
  keystroke, so the ask is debounced and an answer to a keystroke already
  overtaken is dropped; an empty line asks nothing.
- The legend names the key while a ghost is DRAWN — the ghost publishes its own
  visibility, because "a hint is in hand" and "a hint is on screen" are different
  claims (the same reason the caret's position gates the take) — and reverts to
  the idle line otherwise: the gesture has no affordance of its own, and → is an
  ordinary caret move the rest of the time.
- A tail of nothing but spaces is no hint at all, so it neither draws nor claims
  the arrow.

Verified in the browser on a session that had run `echo alpha beta gamma delta`:
`echo` ghosted ` alpha beta gamma delta` (after a restart, so the persistence path
is part of the proof); each → appended one word plus its space, with the ghost
shrinking to match and vanishing on the last; a mid-line caret hid the ghost and
left the draft alone; Tab still opened the path list with the ghost showing, and
accepting closed it; `↑` still opened history; agent mode showed nothing; and a
screenshot confirmed the tail reads as dimmed continuation text on the same
baseline, immediately after the caret.

## Phase 10.14 — The shell assists get switches

Three gestures read the composer's line (Tab completion, the `↑` history list,
the ghost hint) and all three were unconditional. An assist that cannot be turned
off is in the way for the reader who wants the line to themselves — and each one
claims a key that means something else: Tab moves the focus out of a composer,
`↑` and `→` move the caret.

Shipped: a second group in dshell's settings card (`输入辅助`) with one switch per
gesture, each row naming what its gesture does so the card explains itself, and
the header summarising the state (`输入辅助：全部开启`, or the names of the ones
that are off). The switches live in the same `dshell` settings document as the
palette and in the same card, because a settings namespace is one document and
the Plugins section dispatches ONE card per namespace — a second card could never
be reached. That is also why the card is titled `终端与输入辅助` now rather than
`终端配色`.

Decisions the work forced:

- **The gate is read through a ref.** The interceptor that claims those keys is a
  DOM-level listener that has to answer synchronously: a value closed over at
  registration would go stale on the next flip, and re-registering the listeners
  per flip would re-enter the arbitration this feature exists to stay out of.
- **"Off" means the browser's behaviour, per key** — Tab walks the focus (verified
  landing on the composer's attach button), `↑` and `→` move the caret. No
  substitute binding: an assist that is off but still eats its key would be the
  worst of both.
- **A gesture switched off mid-flight takes its list with it**, and which switch
  owns the open list is the list's own `source` — Tab opened one and `↑` opened
  another, so clearing on the wrong switch would drop a list the reader may still
  be using.
- **An answer that arrives late is dropped.** Both key gestures continue in a
  promise, and a round trip outlives the keystroke that started it: the answer
  re-checks the session, the mode, the draft it was asked about, and its own
  switch before it writes anything. The switch is the case the Host cannot know
  about — a reply cannot be cancelled from the other side — which is why the
  gesture is re-checked where the answer lands instead of only where it is claimed.
  (Review finding: only the hint had this guard.)
- **The ghost itself reads the switch, not just the store.** The clear that
  follows a flip runs in the controls' effect, one paint after the render, so the
  ghost would otherwise flash for a frame after being turned off.
- **The legend names only what is on.** `直接输入 · Ctrl+C 中断` is what remains
  with all three off; promising a key the settings card has turned off is a worse
  answer than a shorter line — and the ghost's own entry appears only while it is
  DRAWN, since a caret parked mid-line hides it.
- The document is user data, so a value that is not a boolean reads as the default
  rather than as off: a hand-edited file or an older document must not silently
  disable the composer's assists.
- `theme-settings.ts`/`theme-card.ts` became `settings.ts`/`settings-card.ts`
  (and the schema `settings-schema.ts`): they now hold switches that are not about
  the theme, and a file named for the theme would have been a lie.

Verified in the browser end to end. The card opened with all three on. Turning
`智能提示` off removed the ghost and made `→` a plain caret move, with the write
landing in `$DSH_HOME/settings.yaml` as `commandHint: false`, and the switch still
off after the section was reopened. Turning all three off left the legend at
`直接输入 · Ctrl+C 中断`, with `echo` showing no ghost, `↑` opening nothing, and Tab
moving the focus to the attach button. Turning them back on restored the ghost,
`→` acceptance, the `↑` list, and 14 Tab candidates.

## Phase 10.15 — The chunked relay names its scratch in the world's own namespace

A move over 32 MiB between two device sessions died on `分块数量不符`. The
relay builds a scratch directory from the world's session directory and then
uses that ONE string in two places that do not accept the same spelling when the
world is a device: the commands it runs inside that world (`mkdir -p`/`split`/
`cat` over the shell seam) and `ctx.fs`, which translates a mount path into the
device's own. A device-bound session's directory is a local MOUNT directory
standing in for the device tree, so the shell built the scratch at
`~/.dsh/dshell/mnt/<device>/<remote dir>/.dshell-xfer-…` — a path the device
never had — while `ctx.fs` read and wrote the chunks at `<remote dir>/…` under
the device's root. Two directories, one transfer: the slices were never where
the reader looked.

Provenance: the failure had already happened in the wild before the fix and left
its signature on the test server — four transfers (2026-09-12) each left an
EMPTY directory under `~/.dsh/dshell/mnt/43-138-57-105/root/.dshell-xfer-<id>`
(created by the shell's `mkdir -p`) beside a directory holding the real chunks at
`/root/.dshell-xfer-<same id>` (written through `ctx.fs` after translation).

The scratch is now spelled as the world's own process path
(`processPath(resolve(<session dir>/.dshell-xfer-…))`), which is the convention
`writeBytesAs` already used for the file it writes and the file panel's transfer
engine uses for its roots. A local session's path is unchanged; a device-bound
one gets the device's path, so the shell and `ctx.fs` name one directory.

Verified end to end with the two registered devices (the local sshd rig as
`本地测试机` and `43.138.••.••`), one session on each, a pipe between them, and a
40 MiB file (>32 MiB, so the relay is the path taken):

- `download` rig → server: three chunks, the server's copy reported 41943040
  bytes and sha256 `e349a168…127e59` — the source's digest — read back from the
  device's own shell.
- `upload` server → rig: the rig's copy matched the server file's digest
  `d931ab32…33528` byte for byte.
- Both transfers cleaned their scratch on both sides (nothing left under either
  device's root), which is the other half of the same fix: cleanup runs through
  the same naming.

## Phase 10.16 — The pipe's buffer browser reads like the file list

The pipe detail page's 缓冲区 view was a minimal debug listing: plain rows, a
`d`/`-`/`?` glyph for the kind, a crumb row that wrapped, and a `⟳ 刷新` text
button. It showed the namespace, but not as a place to walk — and the list a
reader already walks for exactly this job is the right sidebar's file navigator.

The browser is now drawn the way that navigator is: a quiet header (back
chevron, refresh icon, a one-line crumb strip that scrolls instead of wrapping,
its current crumb bold and inert), then rows of the same measure — 13px names in
a 20px line box, 16px folder and file-type icons, `4px 8px` padding, the size
(or a mapping's provenance) right-aligned in dim tabular figures — with a
monospaced `..` row on top for going up, and the notes (loading, empty,
truncated, error) indented to the names' column. Mapped roots keep their
`← origin · 读 · ui-a → ui-b` detail as the right-hand column, and the real path
moved into the crumb strip's tooltip: it is provenance, not navigation. A row is
entered on a single click, and a double click lands the same way, as the file
list's own rows do. The browser stays read-only — every mutation is still a tool
call.

Two things the work turned up:

- **The file navigator's row hover had never painted.** Its `rowStyle` set
  `background: transparent` inline, and an inline declaration wins over the
  packaged `:hover` rule — so the rule matched, the radius applied, and the
  colour did not. Both lists now keep the resting background in the same
  stylesheet as the highlight; the hovered row's computed colour is
  `rgba(127,127,127,.09)` in each.
- **A dshell client package that draws dsh's icon set has to declare it.**
  `@deepseek-ai/dsh-client-ui-primitives` is in PLATFORM_MODULES and therefore
  never bundled, but the buffer package still needed the dependency entry — with
  the hoisted store alone, tsc cannot resolve `FileTypeIcon`/`classifyFileType`.

Verified in the browser against a real grant (a 60-minute read mapping of the
repo directory): the browser listed 19 entries, folders first, with sizes, the
`..` row and working crumbs; its row measure matched the file navigator's
exactly (13px name, `4px 8px`, gap 6px, 20px line box, 28px row), and both lists
answered the same hover colour.

## Phase 10.17 — dshell follows dsh's language setting

dsh ships a language switcher in its General settings (通用设置 → 语言, writing
the durable `locale.preference` and driving its own browser chrome through
`ctx.locale`). dshell ignored it: every dshell package hardcoded Chinese, so a
user who picked English got an English dsh shell wrapped around a Chinese
dshell. Reproduced before the work — `<html lang="en">`, dsh's own rows in
English, and the sidebar still reading `归档` / `已归档` / `多选`.

Every browser-face string now belongs to a per-package namespace
(`dshellMode` 161 keys, `dshellWorkspace` 62, `dshellBuffer` 58, `dshellFiles`
25, `dshellSsh` 25, `dshellTerminalBridge` 1), following the shape
`dshell-files` had already established: a `locales.ts` that merges the namespace
into `LocaleNamespaceMap` and ships `zh` as the key-set source of truth plus an
`en` whose completeness the compiler checks, dictionaries registered inside
`ctx.effect`, `locale: NS` on each slot registration to synthesize the `t` seat,
and `ctx.locale.bind(NS)` at the sites that are not slots. Lookups resolve at
call time, so switching the language re-renders the whole surface with no reload
— confirmed by watching the sidebar, the composer legend and the settings card
change under a pick.

Four things the retrofit turned up:

- **Module-scope label tables cannot be localized in place.** `STATE_LABEL`,
  `JOB_STATUS_LABEL`, `HELPER_ROWS`, `TOOL_LABEL`, `THEMES[].label`,
  `SESSION_ROW_LABEL` and `MODE_MENU_ROWS` are all built at import, before any
  `t` exists. Each became an identifier→key map resolved at render, or a factory
  taking `t`; the identifiers they key on (`queued`, `midnight`, `shell`) are
  untouched, which is what keeps the wire values and localStorage keys stable.
- **A slot registration that CALLS the component discards the injected seat.**
  `register({ … }, () => Card(props))` drops every prop the renderer composes,
  `t` included; passing the component itself with the extra face declared as
  `inject: () => ({ … })` is what lets the synthesized `t` arrive.
- **Translating a string the code matches on breaks behaviour silently.** The
  compact rail hid the sidebar's section headings by matching their rendered
  text (`['会话 (', '已归档']`), so an English UI stopped marking them — and
  `待删除` had never been in the list at all. It now marks the group headers
  through `data-dshell-row="archive-header"` / `"pending-header"` and finds the
  main header structurally, which is language-independent and covers all three
  sections. The one other text matcher, dshell-ssh's settings-nav lookup, already
  listed both languages.
- **Host text is out of scope, and stays that way.** dsh localizes its browser
  chrome only; dshell's route errors, SSH test results, tool results, pipe
  notices and system-prompt sections carry no locale, so host-produced strings a
  client renders verbatim keep their own language. Localizing them needs a
  message-key protocol across the wire rather than another dictionary — recorded
  in `dshell-architecture.md` § 10 as the boundary.

Verified in the browser in both languages on every surface: sidebar (including
the collapsed rail), composer chip and legend, block timeline, status card,
settings cards (terminal palette names included), the pipe panel, the SSH device
card, and the new-session dialog — plus a clean `pnpm typecheck` and full
`pnpm build`.

## Phase 10.18 — the host half follows the language too

Phase 10.17 localized the browser faces, which left the other half: text the
HOST authors and the reader still sees. A route refusal, an SSH device error, the
Test result line, a spawn-failure reason in the terminal's connection panel, the
`/new` result, and the pipe notices a delegated request carries were all still
Chinese after switching to English — and they could not simply read the setting,
because dsh's locale service is browser-side and the host never sees the language
on screen.

The direction is now stated by dshell itself. `dshell-terminal-bridge` provides
`ctx.dshellHostCopy` and registers `POST /api/dshell/locale`; every browser face
reports the locale it resolved on boot and on every change. `bind(dicts)` resolves
the language at call time — reported locale, then the durable
`locale.preference`, then `zh` — and each package keeps its own host dictionaries
in `src/host-locales.ts` beside the browser ones (`zh` the key-set source of
truth, `en` complete, the same compile-time discipline). 68 host keys across
`ssh` (13), `buffer` (45), `terminal-bridge` (6), `commands` (2) and `workspace`
(2).

Three things the work turned up:

- **The provider's home is decided by the activation graph.** It went into
  `dshell-mode` first — the package that owns the presentation surfaces — and the
  profile refused to boot: mode waits for the bridge's PTY service, and the
  bridge had been given an `inject` on the copy service mode provided, so both
  sat pending on each other (`dsh: 4 entries did not activate`, with dsh's own
  `fs` chain stalled behind them, since a pending row never provides its
  service). Moving the provider to `dshell-terminal-bridge` — the far end of a
  dependency edge that already existed — removes the cycle: every writer of host
  copy waits for the bridge, which is what it was already doing. Cordis has no
  optional `inject`, so the direction has to be acyclic, not merely lazy.
- **A consumer cannot use the typed accessor.** The `Context` augmentation lives
  with the provider and a consumer's tsc program does not include that package's
  source, so consumers read the service structurally
  (`ctx.get('dshellHostCopy') as HostCopy`), the same way this repo already reads
  `dshellBufferCore`.
- **`/new` had been broken on `main`, and localizing its result is what exposed
  it.** The command registered its handler but never declared `sessionController`
  in `inject`, so every invocation died with `cannot get property
  "sessionController" without inject` — after creating nothing, and reporting a
  failure the user could not act on. Found by running the command to see the
  localized line; fixed by declaring the inject (the same commit, since the
  localized string is only observable once the command works).

The boundary is unchanged where it matters: **tool results and prompt sections
are not localized** — they are the agent's interface, and a per-language variant
would make the model's data depend on the UI language.

Verified against a live harness: route refusals in both languages
(`未知操作` → `Unknown action`), the SSH Test result in both (`已连接 wpp@wpp（Linux
7.0.0-31-generic） · 336ms` → `Connected wpp@wpp (Linux 7.0.0-31-generic) ·
402ms`, host-key line included), and the framework-carried `/new` result
(`New session created: session-a410b363-…`) — with the language switched back to
Chinese afterwards.

## Phase 10.19 — a mapped directory's subpaths resolve again

A device session that had been granted the artifact directory could not fetch a
single file from it. It addressed the grant the way the tool describes
(`/dist-artifacts/SHA256SUMS-artifacts`) and every `read` / `download` / `upload`
was refused as out of scope, while `ls` on the same root worked.

The split that turns a buffer path into "which grant" plus "where inside it" kept
the separator it had just cut on: `rest` came out as `/SHA256SUMS-artifacts`, and
the containment test refuses an absolute path by design, so the refusal named a
path the caller had not written. `ls` survived because a lone mapping name
resolves to `.`. The shape read as permissions, which is why the model spent a
dozen turns rewriting the path instead of reporting it.

The rule now lives in one place, `splitBufferPath` in
`packages/dshell/buffer/src/paths.ts`, with the area-relative invariant written
down as its contract (architecture § 11) — the previous shape was a chain of
`replace` calls that read as if they stripped separators and did not.

Verified by running the real service over the live grant: the reported call
resolves to `/home/wpp/nexus/Nexus-Study/dist-artifacts/SHA256SUMS-artifacts` and
reads the checksum list, as does a nested `read /lab/sub/deep.txt` over a lab
grant; `ls` on the mapped root is unchanged. The only case that still fails is a
filename the model had invented — a genuine `ENOENT`, not a scope refusal.

## Phase 10.20 — an interjection stays in the turn it steered

Sending a message while the agent was working produced `agent/inbox/spliced`
moving the prompt from the next-turn queue into the running turn's `next-step`
list, and then the durable `user/message` at the next step boundary. The fold
treated every durable `user/message` as the start of a task, so the interjection
opened a **second card** inside one turn — and that card carried no turn number.
`assembleTimeline` places turn-less blocks by timestamp against the shell regions
rather than by turn, and the next `turn/start` adopts any turn-less open block,
so the card was also liable to be relabelled as the *next* turn. 轨迹 kept the
message inside its turn, so the two views of one session disagreed in both order
and shape.

The fold now reconstructs steering the way dsh's own client does (ui-chat's
`SteeringHistory`): a `next-step` splice that is not cancelled hands its removed
ids to the running turn, and the `user/message` naming one of them joins that
turn's open block, marked 插话 / Interjection, at the point it arrived. The card
also cuts its rows into one segment per human message, so a request sent mid-turn
is drawn after the work it interrupted rather than hoisted next to the request
that opened the card; a card with one request renders exactly as before.

Verified against the session that reported it: the card count dropped from four
to three, the interjection row sits inside the turn-2 card between the work that
preceded it and the answer it produced, and 轨迹's row order for the same turn is
工具 → 上下文 → 用户 → 助手. The one remaining difference between the surfaces is
deliberate and older: the injected terminal-context notice is a context row in
轨迹 and is not drawn in 会话, because plugin-sourced messages are model input
rather than the reader's words.

## Phase 10.21 — Tab completes commands, from the session's own world

`dock<Tab>` did nothing, and it was deliberate: the interceptor's own comment
said "a lone first token could be a command name, which this does not do yet" and
returned early, so a bare command word never even reached the host. Arguments did
complete (as paths) and showed the candidate list; the first word had no source
at all.

That word now completes from the commands the session's **world** offers: the
directories on that world's `PATH`, plus the shell's interactive builtins (which
exist because no directory holds them). A local session's shell is a child of the
harness with `--noprofile --norc`, so its `PATH` is read straight from the
process; a device session's `PATH` belongs to the device, so that world is asked
once with a read-only `printf %s "$PATH"` through the same shell seam the file
transfer writes through. Everything after the first word still completes as a
path, and a first word spelled like one (`./build.sh`) still does.

Four things the work had to get right, all measured:

- **The list is per session and cached, holding the in-flight promise.** A device
  world charges a probe plus one round trip per directory; listing the directories
  CONCURRENTLY is what makes that a Tab press instead of a hang (1534 ms cold on
  the device session, against the ~7–14 s a sequential walk would take; 107 ms
  cold locally, 4–5 ms warm for both).
- **A path completion warms it in the background.** The reader completes a path
  before they complete a command, so the walk is usually already done.
- **The client no longer decides which source answers** — it asks, and only its
  SILENCE rule is source-aware: a non-path argument with no match stays quiet
  (`echo hi<Tab>`), a command with no match gets the card.
- **Empty answers became reason codes** (`DshellCompletionNote`), so
  `目录不存在` / `不是目录` / `无匹配` — host-authored Chinese shown verbatim in an
  English UI until now — are written by the browser in the reader's language.

The two worlds really are different: this machine answers `dock` with
`docker`, `docker-credential-ecr-login`, `docker-proxy`, `dockerd…`, and the
device session with `docker`, `docker-compose`, `docker-proxy`, `dockerd…` —
one list has `docker-compose`, the other has `docker-credential-ecr-login`.

Verified in the browser with real key events on both sessions: `dock<Tab>` lists
the six candidates with a `$` glyph and a 命令 / command hint, a unique prefix
fills itself in with the trailing space a shell writes (`docker-p<Tab>` →
`docker-proxy `), and `zzzznotacommand<Tab>` answers 本会话的世界里没有以这个前缀
开头的命令.

## Phase 10.22 — Tab reads the line before it answers

10.21 made the first word complete, but the rule it used was "the first word is
the command", and the client kept a second copy of the rule ("a slash means a
path") to decide when to stay quiet. Two copies of one rule is a bug with a
delay on it, and the first word is not where commands live anyway: `sudo dock`,
`pwd; host`, `echo $(dock` and `xargs dock` all name a command in the second,
third or fourth position, and every one of them completed as a PATH until now.

So the position became a property of the LINE, read once, by both halves, from
`packages/dshell/std/src/shell-line.ts`: tokenize up to the caret (quotes
respected, unterminated quotes kept whole), walk the tokens before it, and report
`command | argument | flag | redir` plus the span a completion replaces. Every
entry in the walk is a fact about bash's grammar, and three of them are the ones
that were wrong before:

- **Wrapper words and list keywords do not become the command.** `sudo`, `env`,
  `time`, `xargs`, `if`, `then`, `do` hand the command position to the next word —
  so `sudo dock<Tab>` now lists `docker…`, and it is instant, because the names
  come from the cache 10.21 built rather than from a process.
- **A descriptor duplication is not a redirection.** `2>&1` names no file, so the
  word after it is still an ordinary argument; `>` names one, so `ls > <Tab>` and
  even `ls ><Tab>` list the directory — which is what bash does there.
- **A dash word is a flag only after the command is named**, and a lone `-` is the
  stdin convention rather than a flag prefix.

`cd` and its relatives now take directories only. There is deliberately no mirror
rule for "files only": a path is completed a segment at a time, so
`> logs/app.log<Tab>` has to pass through `logs/`, and the honest rule is "any
path" for both a redirection and an argument. A flag is answered with NOTHING
until the shell oracle can be asked — the directory's files would be the wrong
KIND of answer for `-la`, and silence is not a lie.

The wire carries the position (`DshellCompletion.position`), which is what the
client's silence rule reads instead of re-deriving it: `echo hi<Tab>` stays quiet
because `hi` is a word and not a failed path, `dockz<Tab>` gets 本会话的世界里没有
以这个前缀开头的命令, `ls none/<Tab>` gets 目录不存在, and a flag gets nothing at
all.

The repo also gained its first test rig for this: root `vitest`, a config that
aliases the standard layer to its SOURCE so specs need no build, and
`std/tests/shell-line.spec.ts`, which drives the scanner with lines that were
really typed — `sudo rm -rf ./*`, `pwd; hostname; id -un`, `sudo apt list | grep
mini`, `test -f x && dock`, `make 2>&1 | tail -5`, `ls > out`, and the init line
the terminal bridge feeds. 21 assertions, and the two that failed first were real
bugs in the walk (a command outliving its own command position, and `FOO='a b'`
stopping being an assignment because its VALUE was quoted).

Verified against both worlds with `fetch` and then with real key events:
`sudo dock<Tab>` and `pwd; host<Tab>` list commands (the device answers
`docker-compose`, this machine `docker-credential-ecr-login`), `cd <Tab>` lists 28
entries of kind `directory` and nothing else, `ls > <Tab>` lists 37 files and
directories, `cd nexus<Tab>` fills in `nexus/`, and the two `<Tab>` presses that
cycle a list still move the highlight and write the candidate into the draft.

**Next phase:** flag and subcommand candidates (`docker r<Tab>` →
`rename restart rm rmi run`), which need the world's own bash-completion asked in
a separate process — Phase 10.23 below.

## Phase 10.23 — the session's own shell answers the rest

10.22 taught Tab where the caret is, which fixed the KIND of answer for every
position except one: a flag. `docker rm --force` cannot come from a directory —
no file is named `--force` — and it cannot come from a `PATH` walk either. The
word exists only in bash-completion's completion function for `docker`, so that
is who gets asked: the session's own shell, in a process of its own
(`bash -c <probe> dshell-probe <line> <caret>`), in the session's world — the
device's own bash for a device session.

The answer covers what the file system cannot: `docker r<Tab>` →
rename/restart/rm/rmi/run, `git ch<Tab>` → checkout/cherry-pick/cherry,
`systemctl sta<Tab>` → start/status, `sudo apt list --<Tab>` → the long options
(`sudo` works because bash-completion's own `_comp_cmd_sudo` shifts the position,
which is exactly why asking the first word with a spec is the right rule).

Four decisions the work turned on:

- **The line is data, never syntax.** It rides the command line as an argument,
  quoted once, and the probe script is written without a single quote character —
  an invariant the new spec asserts (`26` tests in
  `files/tests/shell-completion.spec.ts` and `std/tests/shell-line.spec.ts`
  together), because a script whose safety depends on every future edit
  re-escaping correctly is one edit from an injection.
- **Two phases, so a slow world never blocks a keystroke.** The host answers from
  what it knows and marks it `pending`; the browser draws that immediately and
  asks again with `refine`. The late answer is applied only while the store still
  holds the very state it was asked about — Escape, a keystroke, a cycled
  candidate or another Tab all drop it (verified in the browser: `git ch<Tab>`
  then Escape or Backspace leaves an empty list behind).
- **A refine can only add.** `NOSPEC`, an empty list, a world that will not
  answer: the fast answer stands, so a path listing the reader is looking at is
  never taken away by a shell that had nothing to say.
- **A cache keyed by WORLD and line context.** Measured: the second Tab on the
  same context is 13 ms against 436 ms cold locally, 1.8 s cold on the device —
  and the world is part of the key because a device's bash-completion is not this
  machine's.

The switch in the settings card is `子命令与选项` (Subcommands and options), and
its label is the promise: off, Tab still completes command names and paths for a
device session too, and never starts a process for it. Verified with real keys
with the switch off: `git ch<Tab>` lists nothing, `dock<Tab>` still lists the six
commands, `cd nexus<Tab>` still lands on `nexus/`.

One latent bug fell out of this: the PATH probe for a device session had been
reading `ctx.shell` as a PROPERTY, which this route cannot (`cannot get property
"shell" without inject`) — the throw was caught and the fallback directory list
quietly took the device's place, which is why the device's own PATH had never
actually been read. Both probes now go through one `runInWorld` helper that reads
the service structurally, the way dshell-ssh's own router does.

**Still open:** anything only an `alias`, a shell FUNCTION, or a `PATH` a profile
changed would add (neither source knows those), and a candidate's own "no space
after me" intent (`complete -o nospace`), which the client approximates with a
per-kind suffix rule.

## Phase 10.24 — a shell region is as tall as its screen

The report: after several restarts or reconnects, the SSH session's terminal
grows "a big block of no characters" under its last line.

The cause was in the block view's measurement, and the bytes had been telling the
story for a while. Each respawn (a harness restart, an ssh reconnect) makes the
bridge reprint its startup line and run `clear`; the host already truncates that
echo out of the log AFTER the send settles — but the copies written before that
fix existed are in the persisted log, and the seed re-appends them on every
respawn (measured: 7 copies, 183 newlines, 34 KB for the session in question).
`regionMetrics` counted a row per newline, so a region whose screen holds 11 rows
was measured at 180 and rendered 2880 px tall — 95% of it empty, growing by about
one banner per reconnect until it hit the 220-row cap.

The fix follows the convention the ring buffer already uses (§ 4.3): `ESC[2J`
means the display was reset, so the walk starts over there — the rows measured
before it are not height. `ESC[3J` (the scrollback alone) deliberately does not
do this, and nothing is removed from the text: the pre-erase bytes stay in the
region's own scrollback, where the reader can still scroll to them.

Measured on the reported session: that region went from **180 rows / 2880 px** to
**11 rows / 176 px**, with its ink in all eleven. The local session — no respawn
banner in its log — is unchanged, and a region past `SPAN_MAX_ROWS` still scrolls
inside itself.

`packages/dshell/mode/tests/region-rows.spec.ts` pins it down with slices of that
same log: a respawn banner before a clear measures as its post-clear rows, a clear
that opens a region measures one row, `ESC[3J` alone keeps its rows, and the
widths erased by a wipe stop widening the grid.

## Phase 10.25 — a device Tab answers from memory

The report: "SSH 模式下 Tab 反应慢" — Tab in a device session takes noticeably
longer than the same Tab on this machine.

The first question was whether it was the network, and the measurements say no.
Against the device this project tests with:

| what | measured |
| --- | --- |
| one `ssh` command over the shared control master | 23 ms |
| the oracle probe (a `bash` sourcing bash-completion) | 125 ms |
| one call through dsh's subprocess seam, from the route | **0.39 s** |
| `resolve` (2 such calls) | 0.78 s |
| `list` / a path completion (3 such calls) | 1.17 s |
| a flag or bare-word completion (3 calls, then the probe) | 1.6 s |
| the same requests against a LOCAL session | 5–7 ms |

A device call is 0.39 s because of how the harness runs a local command at all:
`systemd-run --user --scope … node --import tsx …/subprocess-local/src/bin.ts --
ssh …`. The transient systemd scope, the Node process and tsx transpiling dsh's
own runner cost ~0.39 s, so the wire is 6% of it. That price is dsh's and is not
ours to change; what dshell controls is the NUMBER of calls a keystroke makes, and
a Tab was making three or four.

Three changes, one direction — the reader's keystroke stops being where the work
happens:

- **The fast pass no longer reads when the shell is going to answer.** A flag and
  a bare word are the shell's questions; the directory listing is only the
  fallback for a shell that has nothing, so it moved into the refine pass, which
  reaches it only after the shell has actually declined. A cold `docker r<Tab>`
  went from 1.6 s (three calls, then the probe) to ~0.5 s (the probe).
- **Readings are cached for a few seconds** (`files/src/readings.ts`), keyed by
  the world and the directory, with a single-flight so two askers share one read.
  Tab, Tab, Tab in one directory is one read; the life is short on purpose,
  because a listing is the answer a reader compares against their own screen.
- **The browser warms before the key lands.** On an edit, debounced 250 ms and
  keyed by everything before the word being typed (so a word costs one warm, not
  one per character), the client sends `warm` — the same question `complete` would
  ask, with the answer thrown away — and the host fetches BOTH halves: the shell
  probe and the directory its fallback would read. Both caches are single-flight,
  so a Tab arriving while a warm is still on the wire joins it rather than buying
  a second probe.

Verified on the same device: a cold path Tab is still ~1.2 s (the honest price of
a first look), and the Tab a reader actually feels — type, pause, Tab — is
**2–6 ms**. In the browser, with real keys in a scratch device session: the warm
went out in 41 ms, the Tab's own request took 6 ms, and the completion applied
(`/va` → `/var/`). The local session's timings are unchanged (6 ms), and a warm
there is a no-op nobody waits for.

**The follow-up the first cut did not cover: `cd <Tab>`.** Reported next, and
rightly: a keystroke warm fires 250 ms after the last key, so a reader who types
`cd ` and presses Tab inside that window still waited for the read (measured:
warm 34 ms, the Tab behind it 1.07 s). Two more pieces:

- **The reading is taken when a command SETTLES**, not only when a key is
  pressed. The client watches the shell-integration marker the host's splitter
  already reads (`ESC ] 133 ; D`), and a settled command is the moment the world
  changed while the reader reads its output; the directory the shell now stands
  in is read then, plus the command list. A blank line — what the composer holds
  after a send — now means "warm the session's own directory", because that is
  what `cd <Tab>` and `ls <Tab>` both read, and the replay a fresh attach sends
  carries the marker too, so a session nobody has typed in is warmed as well.
- **A reading that is merely old answers at once**, with its refresh started
  behind the answer (fresh for 3 s, served for up to 60 s, refused past that).
  The reader gets their list immediately after any pause, and the Tab after it
  sees the new listing.

Measured on the device afterwards: `cd <Tab>` = 2.9 ms (was 1.07 s), and a Tab
12 s after the last read answers in 35 ms with the re-read landing behind it, then
2.4 ms. In the browser, in a scratch device session, a settled command was
observed to send the warm itself (an empty-line request, answered in 76 ms) —
which is the whole trigger, verified where it fires rather than at the route.

**And the first Tab of a directory, which still stuttered.** Reported after that:
"第一次 tab 还是会卡手". Correct — nothing had pre-answered the reader who `cd`s
somewhere new and completes there, which is the most ordinary flow there is. Two
more pre-warms, aimed at exactly that:

- **A `cd` that RESOLVES warms the directory it landed in.** The composer already
  routes every `cd` line through the route's `resolve` to learn where the shell
  went; the route now reads that directory's listing behind the answer. This is
  the only trigger that can cover the case, because the keystroke comes before
  this side knows the directory exists.
- **Taking a directory warms what is inside it.** All three ways a candidate is
  applied (auto-applied, cycled, clicked) run through one function, so a landed
  directory is read at once — the Tab-Tab walk into a tree, which was otherwise
  the slow one.

Measured after: a Tab inside a directory a `cd` just entered is 34 ms, then
2.5 ms; the contrast case — a directory nobody resolved, read or completed in —
is still 1.15 s cold. In the browser, a real `cd /tmp` in a scratch device session
sent `resolve` (770 ms) with `/tmp`'s warm behind it; that session and the earlier
scratch sessions were deleted afterwards and the user's session restored.

**Still open:** a first look at a directory still costs three calls because the
route asks the seam for `resolve`, `stat` and `listDir` separately; folding those
into one device command would cut a cold Tab to ~0.4 s, and it belongs in
dshell-ssh's provider rather than in this route. The listing cache's freshness is
a 3 s TTL rather than an invalidation on the shell's next command.

## Phase 10.26 — dshell's own data directory, picked in settings

The question was dsh's: "当前不时不支持自选数据目录？给整个 dsh" — does the harness
let a reader say where its data lives? dsh resolves its home per call
(`$DSH_HOME`, else `~/.dsh`) and offers no flag, no setting, no UI, so the answer
was no. The follow-up scoped it: "在设置中也没添加一个选择按钮配置存储地址？保证不会影响其余
dsh" — a picker in dshell's settings, and the rest of dsh untouched.

That scoping is the whole feature, and it is why the choice is not `DSH_HOME`:
moving the harness home moves sessions, settings and storage with it, and the
reader's actual problem was a big transcript directory on a full disk. dshell
keeps exactly two trees of its own — `dshell/` and `dshell-pty/` — so the setting
names the harness home those two resolve under, and a deployment keeps its
sessions where they were.

What was built:

- **A card of its own** in the plugin settings section (数据目录), with a
  「选择…」 button and 恢复默认, stored in a namespace of its own (`dshell-data`,
  field `dir`). The first cut put it in the terminal card as a `dshell.dataDir`
  row, and that was wrong in a way the reviewer named precisely: dsh's plugin
  section dispatches one card per registered settings namespace, so a second
  namespace is a second card — and "where does this thing write my transcripts"
  is not a question about the composer. The terminal namespace keeps the palette
  and the shell switches (both `live`); the storage namespace is registered
  `applies: 'restart'`, which is true of it and false of the others. The field
  moved before release, so no document migration was needed.
- **A host-side directory browser** (`POST /api/dshell/dirs`,
  `terminal-bridge/src/dirs-route.ts`): the browser cannot open a native folder
  dialog for a host path, and in a remote `dsh web` the browser is not even on the
  harness's machine, so the host lists its own directories and the card draws
  breadcrumb + up + home + a path field. Directories only; a symlink to one counts
  as one; a path it cannot read is reported as `noDirectory` / `notDirectory` /
  `noAccess`, and a directory that cannot be written is refused in words. The same
  route CREATES a directory (`action: 'mkdir'`): one path segment below the
  directory being shown, refused rather than repaired (empty, `.`, `..`, any
  separator, anything resolving outside the parent), answering with the new
  directory's own listing so the picker lands inside it, and reporting a taken
  name as `exists` beside the parent's listing.
- **A settlement at start** (`mode/src/data-root.ts`): the choice takes effect at
  the NEXT start, because a running harness cannot move the files it is holding
  open. At that start the trees that travel are moved (`dshell/ssh` minus sockets
  and the regenerated askpass helper, `dshell/buffer`, `dshell/tags.json`,
  `dshell-pty`), the ones that must not (`dshell/mnt/**` — session working
  directories recorded as absolute paths; `dshell/ssh/ctl/**`) stay, collisions at
  the destination are reported and never overwritten, and a record in the default
  root lets 恢复默认 bring everything home again.
- **A published seat** (`std/src/data-root.ts`): the root is a SETTING, so it is
  knowable only after the settings service is up — and a plugin that resolves a
  path in its own apply keeps that value for the life of the process. `dshell-ssh`
  and `dshell-workspace` declare the seat in their `inject` lists, so their applies
  begin after the decision; everything that resolves a path later (routes, shell
  spawns, file listings) needs no ordering at all.

Verified live, on this machine, with the user's own data: picked
`/home/wpp/.dshell-move-test` through the picker, restarted → the registry, keys,
buffer state, tags and all 72 transcripts moved (checksums unchanged for
`devices.json` and `state.json`), `dshell/mnt` and `ctl` stayed, the log said so,
and the moved root's devices were visible in the UI. Then 恢复默认, restarted →
everything came home, the devices were visible again, and the test directory, the
record and the settings line were removed afterwards. `pnpm test` (80 specs),
`pnpm typecheck` and `pnpm build` are clean.

**The bug this phase actually cost, worth recording:** the first cut published the
root as a `DSHELL_HOME` environment variable set at composition. The restart then
produced an EMPTY device list — the file intact under the old root, `dshell-ssh`
having built its registry a few milliseconds before the variable was set, and its
`targetForSession` cache being synchronous on purpose (so the value could not
simply be re-read later). Two rounds of "wait for settings, then settle" were not
enough either: a sibling's apply is not ordered after another sibling's by row
order. Declaring the dependency is what made it deterministic. The lesson is
recorded in `std/data-root.ts` and architecture § 15: a cross-package fact that
must exist before an apply needs a service edge, not a coincidence.

**Not covered:** the picker creates one segment at a time (no `mkdir -p`), a
directory it creates is not remembered as "created by dshell" and so is never
cleaned up; migrating a root that is
an NFS mount or has a symlinked `dshell/` inside it is untested; the settings
document's `dataDir` and the record file can disagree if the document is edited by
hand while the harness runs, in which case the next start settles the document's
value and rewrites the record.

## Phase 10.27 — entering a device session warms its own directory

Asked for directly: "当前 ssh 预热能不能在进入的时候就预热一次" — warm once when the
session is entered, rather than only on a keystroke or a settled command.

Part of it already existed (the composer warms at mount) and it was measured
working — but only when the composer's mirror already knew the directory. That
mirror was filled by exactly one thing: a `cd` typed through the composer. So the
pre-warm read the session's RECORDED tree while the reader's Tab asked about the
tree the SHELL was standing in, which is a different directory in three ordinary
situations: a device session whose shell starts in its login directory rather
than the session's tree, any session entered after the shell had already moved,
and any page loaded after a `cd`.

Two pieces, both small:

- **The client now reads the shell's own report of where it stands.** dsh's shell
  integration prints OSC 3008 (`…;cwd=<path>`) before every prompt, and the bytes
  already reach this side: the same chunk listener that watches for the settled
  command marker now parses it (`mode/src/client/shell-report.ts`, 5 specs over
  real log fragments) and adopts the directory before deciding that warm. The
  path is in the SHELL's namespace — a device's own path — which is what the
  world's translation wants: a path inside a mount directory is mapped, anything
  else passes through unchanged.
- **Entering arms a second warm, fired by that first report.** The mount-time warm
  can only guess (the session's recorded tree, possibly before the device
  connection exists); the one the report triggers runs when both facts hold. So
  the entry warm lands on a live world, at the directory the reader will Tab in.

Verified on the device: after a harness restart and a page load, entered the
session, waited for the prompt, typed `cd ` and pressed Tab INSIDE the keystroke
warm's 250 ms window — isolating the entry warm as the only thing that could have
answered. The `complete` request carried `cwd: "/root"` (the device's own report,
where before it carried no cwd at all) and answered in **4 ms** with the device's
real entries in the list.

**Not covered:** a Tab that arrives while the entry warm's read is still in flight
joins that read rather than answering from nothing (a device's first read is three
round trips, ~1 s); that is the honest price of the world not having answered yet,
and the alternative — a fast wrong answer — is worse. The report's `cwd` is read
as the rest of the line up to the report's terminator, relying on dsh's
integration writing it last (its own bytes, so ours to rely on).

## Phase 10.28 — dshell's own icon on the desktop build

Asked for directly: "有没有为桌面端程序设置程序图标？" — a question first, answered with
the artifact rather than the config, and then "主要体现智能交互的 shell 特点就好" for
what the mark should say.

**There was no icon anywhere.** Three places can carry one, and all three were
empty: upstream's electron-builder config has no `icon` field (`directories` sets
only `output`, `linux` only `category` and the AppImage target), upstream's
`main.ts` builds its `BrowserWindow` without `icon:`, and neither repository holds
an icon asset (`apps/desktop` has no `build/`, no png/ico/icns; this repo had no
`assets/`). Confirmed against the shipped rc.2 AppImage rather than inferred: its
`hicolor` icons at 16, 32, 48, 64, 128 and 256 are byte-for-byte identical
(sha256) to `app-builder-lib`'s `templates/icons/electron-linux/*.png` — the
**default Electron atom**, reached through the desktop entry's
`Icon=deepseek-harness`. So the packaged app has been wearing Electron's logo in
the launcher, the dock and the taskbar since the first build.

The mark is dshell's own, drawn for this: the prompt the shell itself uses (a
chevron and a block cursor) with a spark beside it for the half that answers.
Three sources, because the smallest sizes are redrawn rather than scaled —
`icon.svg` with the spark for 48 px and up, `icon-small.svg` without it for 32,
`icon-16.svg` with a pulled-in chevron and a bar for the cursor so 16 px still
reads as `>_` instead of one white blob.

Where it went, keeping `dsh/` untouched:

- `assets/icons/linux/{16,32,48,64,128,256,512}x{same}.png`, rasterized with
  Inkscape from the SVGs next to them (the exact command is in `dshell-setup.md`).
- `scripts/linux-desktop.mjs` — the directory, the size list, and a pure
  `withLinuxDesktop(config)` that adds it (Phase 10.29 widened this from
  `withLinuxIcon` when the `.deb` target arrived). The application lives in its
  own module because importing upstream's config means resolving a desktop
  target, which throws for linux-x64 outside the packaging hook; a module of our
  own lets the delta be tested rather than described.
- `scripts/electron-builder.linux.config.mjs` — `linux: { …upstream.linux, icon }`.

**The trap this needed a test for.** electron-builder reads a directory's
`NxN.png` file names as the sizes themselves and never re-measures them
(`collectIconsFromDir` in `app-builder-lib`); each name becomes a
`hicolor/NxN/apps/` entry (`${icon.size}x${icon.size}`) and the largest becomes
the `.desktop` entry's icon. A PNG saved at the wrong size therefore ships a
blurred icon and reports nothing at all. `scripts/tests/linux-desktop.spec.ts`
checks every name against the file's own IHDR
header, checks the directory holds exactly the expected sizes, and checks the
override adds the icon without disturbing the rest of upstream's config. Proven
to bite: copying the 128 px pixels over `256x256.png` fails with
`expected { width: 128, height: 128 } to deeply equal { width: 256, height: 256 }`.

Verified by rebuilding the AppImage (`pnpm package:linux --from=builder`, exit 0,
no "default Electron icon is used" warning in the log): all seven `hicolor` sizes
inside are byte-identical to the assets, `.DirIcon` and the AppImage's root
`deepseek-harness.png` now point at `hicolor/512x512/…` instead of 256, and
`hicolor/256x256/apps/deepseek-harness.png` hashes `ed8d814d…` where the Electron
default it replaced hashed `21e8e6c2…`.

**Not covered:** mac and win icons (this repo packages linux-x64 only, and the
mac section of upstream's config is untouched); the window icon of a dev run,
which is upstream's `BrowserWindow` and not ours to set; and `StartupWMClass`,
which stays `DeepSeek Harness` — electron-builder warns that setting
`desktopName` with `linux.syncDesktopName` would associate running windows with
the entry more firmly, but that is an upstream package-name decision. `dsh web`'s
browser-tab favicon is upstream's own and unchanged.

## Phase 10.29 — a package you can install, not just run

Asked for directly: "打包linux安装包并帮我装好" — build an installer and put it on
the machine.

Two additions to `scripts/linux-desktop.mjs`, and one rename: what began as
`linux-icons.mjs` now describes the whole Linux desktop delta, so it is
`linux-desktop.mjs` and its `withLinuxIcon` is `withLinuxDesktop`.

- **`deb` joins `AppImage` in `linux.target`.** Upstream builds mac and win only,
  and its own Linux target is the portable image; the `.deb` is what makes the app
  installable (`/opt`, `/usr/bin`, a launcher entry, icons).
- **The two things fpm refuses to build without.** `maintainer`, supplied through
  `deb.maintainer` (the checkout's own git identity — this build never leaves the
  disk), and a project URL, which cost a build cycle to get right: electron-builder
  has **no `homepage` field in its config schema**, so `homepage:` at the top level
  fails validation with `configuration has an unknown property 'homepage'`. fpm
  reads the URL out of the *package metadata* (`appInfo.computePackageUrl()`), so
  it has to go in through `extraMetadata.homepage`, which `packager` merges into
  the metadata before `AppInfo` reads it.

Verified end to end, on Ubuntu 26.04 (`pnpm package:linux --from=builder`, exit 0):

- `deepseek-harness-0.1.5-rc.2-linux-amd64.deb`, 194 MB, 672 MB installed, nine
  dependencies that all resolve — `libgtk-3-0` and `libatspi2.0-0` are the pre-t64
  names and apt satisfies them through the t64 packages' `Provides`.
- `sudo apt install ./…deb` installs clean; `dpkg -l` shows `deepseek-harness
  0.1.5~rc.2 amd64`; `/usr/bin/deepseek-harness` is an `update-alternatives` link;
  `desktop-file-validate` accepts the launcher entry; all seven hicolor icons are
  hash-identical to `assets/icons/linux/`.
- Upstream's own `postinst` is what makes it start on a modern Ubuntu: it installs
  `/etc/apparmor.d/deepseek-harness` (listed by `aa-status`, needed because
  `kernel.apparmor_restrict_unprivileged_userns=1` here) and leaves
  `chrome-sandbox` at 0755 — which is why the `.deb` needs no `--no-sandbox` in its
  `Exec`, unlike the AppImage's upstream entry.
- The app then launched: main process holding Wayland window handles, renderer
  alive, and an empty log apart from the updater's 404.

**Not covered:** mac and win installers (this repo packages linux-x64 only); the
package's `Description:` synopsis line comes out blank, cosmetic and inherited
from upstream's metadata; and both the package name (`deepseek-harness`) and the
launcher entry (`DeepSeek Harness`) are upstream's product identity, not dshell's.

## Phase 10.30 — dshell inside the installed desktop app

The install above boots **dsh's own UI**: the app carries upstream's seeded
package set, and dshell is not in it. That is the difference between installing
dsh's desktop shell and installing dshell, so it needed its own answer — and the
desktop app is much stricter about plugins than the web harness.

What the app enforces (`apps/desktop/src/project-manager.ts`, in the asar):

- It generates its own pnpm profile at `~/.dsh/profiles/desktop`, from the seed in
  its `resources/`, and reads the plugin list from `dsh.profile.bundles` — which
  must **begin** with the two built-ins (`@deepseek-ai/dsh-base`,
  `@deepseek-ai/dsh-web-app`); everything after them is a plugin.
- Every bundle must resolve **inside the profile**. The web profile's way of
  installing dshell — `link:` dependencies pointing at this checkout — is refused
  at boot: `dsh desktop: profile bundle "@nexus-aethra/dshell-bundle" resolved
  outside the desktop profile`. So the packages have to arrive from a registry.

Route that works, using tools this repo already has (documented step by step in
`dshell-setup.md`): `pnpm pack` every dshell package, serve them with
`scripts/local-registry.mjs`, add them to the profile's `dependencies` at `0.1.0`,
append the bundle to `dsh.profile.bundles`, and install with the app's **own**
bundled node and pnpm (the app pins registry, store dir and virtual-store settings
for its profile, and a different pnpm would resolve differently).

One more discovery on the way: the desktop seed is a curated subset of upstream,
and five packages dshell names are not in it — `@deepseek-ai/dsh-tool-terminal`
(named by the bundle patch's `dshell-tool-terminal` row), `dsh-client-store`,
`dsh-client-ui-slots`, `dsh-client-ui-primitives`, `dsh-client-ui-dockkit`
(diffed dshell's 42 upstream references against the profile's 242 installed
packages). They ship packed by our own build under
`.desktop-build/…/packed/dsh/`, so they go into the same local registry; without
`dsh-tool-terminal` the desktop app refuses to boot with `failed to import loader
entry dshell-tool-terminal`.

Verified: after that install the app starts with no plugin-tree error, and
`~/.dsh/settings.yaml` gains a `dshell:` section (`theme: midnight`,
`commandHint`, `historyList`, `tabCompletion`, `completionShellOracle`) written at
startup — dsh persists settings only for registered namespaces, so dshell's host
half is applied inside the desktop app, not merely present in `node_modules`. The
only remaining line in its log is the updater's 404 for a Linux channel upstream
does not publish.

**Not covered:** none of this is in the installer yet — a fresh machine needs the
pack/serve/install steps by hand, and the honest next step is to seed the five
upstream packages plus the dshell tarballs into the app's `resources/seed` and
pre-write the profile's plugin list at build time, so `apt install` alone brings up
dshell. The client half is confirmed by resolution and by the app's clean boot, not
by a screenshot; and the app's plugin window pins `registry.npmjs.org`, so a plugin
transaction started from its UI would fetch the published 0.1.0 rather than this
checkout.

## Phase 10.29 — a package you can install, not just run

Asked for directly: "打包linux安装包并帮我装好" — build an installer and put it on
the machine.

Two additions to `scripts/linux-desktop.mjs`, and one rename: what began as
`linux-icons.mjs` now describes the whole Linux desktop delta, so it is
`linux-desktop.mjs` and its `withLinuxIcon` is `withLinuxDesktop`.

- **`deb` joins `AppImage` in `linux.target`.** Upstream builds mac and win only,
  and its own Linux target is the portable image; the `.deb` is what makes the app
  installable (`/opt`, `/usr/bin`, a launcher entry, icons).
- **The two things fpm refuses to build without.** `maintainer`, supplied through
  `deb.maintainer` (the checkout's own git identity — this build never leaves the
  disk), and a project URL, which cost a build cycle to get right: electron-builder
  has **no `homepage` field in its config schema**, so `homepage:` at the top level
  fails validation with `configuration has an unknown property 'homepage'`. fpm
  reads the URL out of the *package metadata* (`appInfo.computePackageUrl()`), so
  it has to go in through `extraMetadata.homepage`, which `packager` merges into
  the metadata before `AppInfo` reads it.

Verified end to end, on Ubuntu 26.04 (`pnpm package:linux --from=builder`, exit 0):

- `deepseek-harness-0.1.5-rc.2-linux-amd64.deb`, 194 MB, 672 MB installed, nine
  dependencies that all resolve — `libgtk-3-0` and `libatspi2.0-0` are the pre-t64
  names and apt satisfies them through the t64 packages' `Provides`.
- `sudo apt install ./…deb` installs clean; `dpkg -l` shows `deepseek-harness
  0.1.5~rc.2 amd64`; `/usr/bin/deepseek-harness` is an `update-alternatives` link;
  `desktop-file-validate` accepts the launcher entry; all seven hicolor icons are
  hash-identical to `assets/icons/linux/`.
- Upstream's own `postinst` is what makes it start on a modern Ubuntu: it installs
  `/etc/apparmor.d/deepseek-harness` (listed by `aa-status`, needed because
  `kernel.apparmor_restrict_unprivileged_userns=1` here) and leaves
  `chrome-sandbox` at 0755 — which is why the `.deb` needs no `--no-sandbox` in its
  `Exec`, unlike the AppImage's upstream entry.
- The app then launched: main process holding Wayland window handles, renderer
  alive, and an empty log apart from the updater's 404.

**Not covered:** mac and win installers (this repo packages linux-x64 only); the
package's `Description:` synopsis line comes out blank, cosmetic and inherited
from upstream's metadata; and both the package name (`deepseek-harness`) and the
launcher entry (`DeepSeek Harness`) are upstream's product identity, not dshell's.

## Phase 10.30 — dshell inside the installed desktop app

The install above boots **dsh's own UI**: the app carries upstream's seeded
package set, and dshell is not in it. That is the difference between installing
dsh's desktop shell and installing dshell, so it needed its own answer — and the
desktop app is much stricter about plugins than the web harness.

What the app enforces (`apps/desktop/src/project-manager.ts`, in the asar):

- It generates its own pnpm profile at `~/.dsh/profiles/desktop`, from the seed in
  its `resources/`, and reads the plugin list from `dsh.profile.bundles` — which
  must **begin** with the two built-ins (`@deepseek-ai/dsh-base`,
  `@deepseek-ai/dsh-web-app`); everything after them is a plugin.
- Every bundle must resolve **inside the profile**. The web profile's way of
  installing dshell — `link:` dependencies pointing at this checkout — is refused
  at boot: `dsh desktop: profile bundle "@nexus-aethra/dshell-bundle" resolved
  outside the desktop profile`. So the packages have to arrive from a registry.

Route that works, using tools this repo already has (documented step by step in
`dshell-setup.md`): `pnpm pack` every dshell package, serve them with
`scripts/local-registry.mjs`, add them to the profile's `dependencies` at `0.1.0`,
append the bundle to `dsh.profile.bundles`, and install with the app's **own**
bundled node and pnpm (the app pins registry, store dir and virtual-store settings
for its profile, and a different pnpm would resolve differently).

One more discovery on the way: the desktop seed is a curated subset of upstream,
and five packages dshell names are not in it — `@deepseek-ai/dsh-tool-terminal`
(named by the bundle patch's `dshell-tool-terminal` row), `dsh-client-store`,
`dsh-client-ui-slots`, `dsh-client-ui-primitives`, `dsh-client-ui-dockkit`
(diffed dshell's 42 upstream references against the profile's 242 installed
packages). They ship packed by our own build under
`.desktop-build/…/packed/dsh/`, so they go into the same local registry; without
`dsh-tool-terminal` the desktop app refuses to boot with `failed to import loader
entry dshell-tool-terminal`.

Verified: after that install the app starts with no plugin-tree error, and
`~/.dsh/settings.yaml` gains a `dshell:` section (`theme: midnight`,
`commandHint`, `historyList`, `tabCompletion`, `completionShellOracle`) written at
startup — dsh persists settings only for registered namespaces, so dshell's host
half is applied inside the desktop app, not merely present in `node_modules`. The
only remaining line in its log is the updater's 404 for a Linux channel upstream
does not publish.

**Not covered:** none of this is in the installer yet — a fresh machine needs the
pack/serve/install steps by hand, and the honest next step is to seed the five
upstream packages plus the dshell tarballs into the app's `resources/seed` and
pre-write the profile's plugin list at build time, so `apt install` alone brings up
dshell. The client half is confirmed by resolution and by the app's clean boot, not
by a screenshot; and the app's plugin window pins `registry.npmjs.org`, so a plugin
transaction started from its UI would fetch the published 0.1.0 rather than this
checkout.

## Phase 10.31 — a palette that knows which surface it is on

Reported from the desktop app: "当前在浅色模式下并不正常". dshell's four palettes
were dark-only — `text: #e8e8ec` on a palette whose `bg` is deliberately
`transparent`, so on dsh's light surface (white) the block view's shell output was
there and unreadable. The sidebar and the agent's prose were fine, because those
read dsh's own `--dsw-*` tokens; it was the terminal's own palette that had only
ever been drawn on black.

The fix splits dshell's colours by what they answer:

- **`palettes.ts`** (new, DOM-free) holds each palette as two skins — `light` and
  `dark` — instead of one flat set. `getTheme(id, mode)` resolves the pair, so
  every existing consumer keeps reading `theme.text` and friends and simply gets
  the right answer for the surface.
- **`theme.ts`** gains a second store for the mode, read from
  `<body data-ds-dark-theme>` — the attribute dsh's inline boot script writes and
  its ThemePresenter toggles — and watched with a MutationObserver, since nothing
  emits an event for it. `useDshellTheme()` subscribes to both stores, so
  switching dsh's theme repaints dshell with no reload. The mode is never
  persisted: it is dsh's setting, not dshell's.
- The settings card's swatch resolves through `getTheme(theme.id)` so the dot
  previews the skin the pick will actually produce, and its note says the
  palette follows dsh's light/dark setting (zh + en).
- `ps1User`/`ps1Path` were declared on every palette and read by nothing in the
  repository; they are gone rather than duplicated per skin.
- **The ANSI vocabulary belongs to the surface, not to the palette.** xterm's
  defaults are the Tango set — `#eeeeec` for `white`, `#8ae234` for bright green,
  `#729fcf` for bright blue — and every one of them is an ink for a dark ground.
  Correcting the foreground alone therefore left `ls` painting filenames
  near-white on white: the same bug, one layer down. Each skin now carries its own
  sixteen slots and `xtermTheme()` hands them to the renderer. The dark set is
  Tango verbatim — written out rather than inherited, so no dshell release
  repaints the output a dshell-less dsh would show — while the light set keeps
  Tango's hues and holds them dark enough that every slot clears 4.5:1 on the
  page.
- The semantic inks are shared by mode rather than rebuilt per palette:
  `danger`, `dangerFaint`, `warn`, and the faint fill a hover or a current row
  is drawn with (`faintFill`). A red is a red whichever scheme is picked, so a
  palette's identity stays in its greys, borders and accent.
- `getTheme` resolves through a cache, so one (palette, mode) pair is one object
  for the life of the page. The block view rebuilds a shell region's terminal
  when its theme changes, so a fresh object per call tore down and reopened every
  visible terminal on every render.
- The literals dshell-owned surfaces still carried went to one of those two
  systems: the 数据目录 picker's panel, borders and buttons read dsh's tokens now
  (`--dsw-alias-bg-layer-2`, `--dsw-alias-border-l4`,
  `--dsw-alias-button-primary-fill`) with its caution and failure lines from the
  palette; the data card's buttons likewise; and the `#f87171` reds in the status
  card, the connection notices and the bookmark rail became `theme.danger`.

Light skins are authored per palette rather than derived: solarized light uses
Solarized's own base3 ground with base00/01 inks, dracula's pink is darkened for a
white page, and midnight and forest keep their accents over neutral inks.

**The guard is contrast, measured, not eyeballed.** `tests/palettes.spec.ts`
(45 specs) computes WCAG relative luminance and asserts, for every palette and
both modes, body text ≥ 4.5 against the exact surface dsh paints (`#ffffff` light,
`#151517` dark — `--dsw-alias-bg-base`'s own values), accent-coloured text ≥ 4.5,
the accent indicator ≥ 3, `muted` ≥ 3.5 (it carries hints, and two of the four
DARK skins measure 3.9–4.1 today, which this fix must not restyle), and text ≥ 4.5
on the palette's own `menuBg`, which paints itself. It also asserts the palette ids
equal the settings schema's, so a selectable id cannot resolve to nothing. Proven
to bite: putting the old `#e8e8ec` back as midnight's light ink fails three
assertions.

The ANSI half is measured the same way, because it is the half that survives a
careless fix: every slot of a light skin must clear 4.5:1 on the white page, each
dark skin's set must equal xterm's own table verbatim, and no light skin may leave
a slot at its dark value — a slot left alone passes a per-palette comparison while
still being unreadable.

Verified in a browser on the dev harness (which shares the harness home, so it was
in light mode too): before, the session's shell block was near-invisible; after,
`root@VM-0-6-ubuntu:~# Shared connection …` and the command line read as normal
dark text on white. The mode switch was verified live too — toggling
`data-ds-dark-theme` moved all 182 palette-styled elements from the light values
to the dark ones and back with no reload. The desktop app got the same fix through
its own profile (re-packed, reinstalled, restarted; dsh caches plugin bundles
until restart, so a rebuild alone changes nothing).

The ANSI half was measured the same way, in the same session, by reading the ink
of every span the terminals had drawn: 29 spans, three distinct inks, and the
worst of them 6.48:1 against the white page — `#1b1c22` for ordinary text
(16.99:1), `#2a5d9e` for the `ls` directories (6.65:1) and `#c00000` for the
`docker ps` digest (6.48:1). The same session's `ls` is the screenshot above: it
is the case the report was about. The switch was driven through dsh's own 外观
control rather than by hand-writing the attribute, and the live xterm options
followed it — `#1b1c22`/`#5c6470`/`#2a5d9e`/`#457d05` in light,
`#e8e8ec`/`#d3d7cf`/`#729fcf`/`#8ae234` in dark, the last four being Tango's, so
dark output is pixel-identical to before. The palette swatches were checked in both
modes as well (light accents in light mode, dark ones in dark), and the 数据目录
picker was opened in light mode: white panel, near-black primary button.

**Not covered:** the four palettes' dark skins are unchanged, including the two
`muted` values below 4.5; the dark ANSI set stays Tango's, including the slots
that are invisible against a near-black ground (`black`, `brightBlack`) — a
program that asks for the ground's own tone gets exactly that; and
`session-rows.ts` still exports the ANSI-to-CSS maps (`SESSION_ROW_COLOR`,
`GUTTER_COLOR`) left over from the canvas renderer the block view replaced. They
are unreferenced today, but they are a second and now stale copy of the same
vocabulary, which is the kind of thing a reader follows by mistake.

## Phase 10.32 — the 0.1.1 release

`0.1.0` was published 2026-09-15T18:32Z. Six PRs landed after it (#22–#27) and
none of them reached npm: the data-directory feature, the settings refactor, the
directory-warm-up fix, the icon, the `.deb` target — and the light-mode palette,
which is the one that made the gap visible. Between them they touched `std`,
`mode`, `ssh`, `buffer`, `terminal-bridge` and `workspace`, so a consumer
installing from the registry got a dshell that predates all of it. That mattered
in one concrete place: the desktop app's plugin window installs from
`registry.npmjs.org` (pinned in its `project-manager`), so its view of dshell was
six PRs stale.

All eleven packages moved to **`0.1.1`** and were published in dependency order
(`std` → `conversation` → `storage` → `ssh` → `buffer` → `terminal-bridge` →
`files` → `commands` → `mode` → `workspace` → `bundle`) with the bypass-2FA
granular token, after `pnpm install` → `build` → `typecheck` → `test` (147 specs)
came back green. The bundle's `workspace:^` edges rewrote to `^0.1.1`, and the
docs that quote a version (`dshell-packages.md`'s pack recipe, `dshell-setup.md`'s
desktop-profile steps) now quote this one.

**The publish is verified by the bytes, not by the CLI's word.** The
`dshell-mode` tarball fetched back from the registry carries the light skin
(`#1b1c22`), the light ANSI inks (`#5c6470`, `#2a5d9e`), the semantic red
(`#b42318`), the mode watcher (`data-ds-dark-theme`) and the data-directory route
(`DSHELL_DIRS_PATH`) — i.e. today's source, not yesterday's.

**The read side lagged again, and this time per package.** For several minutes
after the publishes returned `+ @nexus-aethra/dshell-<name>@0.1.1`, the packuments
for seven of the eleven still listed only `0.1.0`, and their `0.1.1` tarballs
answered `{"error":"Not found"}` — while `terminal-bridge`, `mode`, `workspace`
and `bundle` were already downloadable, and cache-busting made no difference. The
tell that this is replication and not a failed publish is the `dist` block the
registry writes on acceptance: each of the seven already carried its `shasum`,
`integrity`, `fileCount`, `unpackedSize` and two signatures, exactly as the
working four did. Same shape as the first publish's trap, slower: judge a publish
by `dist` metadata and the tarball, not by a single read a minute later.

**Still open:** the desktop profile pins the eleven packages at exact `0.1.0`, so
a fresh install from npm still resolves yesterday's code until that pin moves to
`0.1.1`; the installed app currently carries this week's code through an in-place
refresh of `dshell-mode`'s tarball into the profile. The token used here was
pasted into a chat transcript when it was created and should be rotated.

## Phase 10.33 — moving onto dsh 0.1.6 (roadmaps first)

Upstream published `dsh-v0.1.6-alpha.1` (`0a15e36e`, 2026-09-15) — the first tag
since the `0.1.5-rc.2` this repo pins 211 times. It is an alpha on the channel
path 0.1.5 walked (alpha.1 → alpha.2 → rc.1 → rc.2), it adds eighteen packages
(ssh + `fs-ssh`, a terminal controller with a client half, browser-use and
computer-use provider registries, a PTC runtime, MCP resources, image offload,
auto review, an archive settings page), and it deletes two (`e2b`,
`code-runtime-worker-thread`).

The tag is fetched into `dsh/` and **not** checked out: the repo still builds
against `0.1.5-rc.2`. Before any code moves, the migration gets a plan —
[`dshell-upgrade-0.1.6.md`](./dshell-upgrade-0.1.6.md) carries an adaptation
roadmap (A1 two hosts in one manifest set, A2 the host move, A3 behavioral
adaptation, A4 the ssh and client-terminal migrations, A5 desktop and release,
A6 the deferred capabilities) and a testing roadmap (T1 assumptions as
assertions, T2 compile-time host contract, T3 route integration, T4 the
acceptance checklist scripted, T5 the zero-coverage packages).

Two findings from the measurement phase set the shape of that plan, and both are
worth more than the plan itself:

- **The desktop profile gained a manifest validator it never had**
  (`apps/desktop/src/profile-packages.ts`, absent at rc.2). It refuses a
  first-party package declared in `dependencies` — which `mode` and `ssh` do for
  `@deepseek-ai/schemastery` — and it range-checks every peer against the
  runtime's version, where `^0.1.5-rc.2` does *not* satisfy `0.1.6-alpha.1`
  (node-semver and prereleases). The fix is therefore a manifest *restructure*
  plus a two-host range, not a version-string replace: that is A1, and it lands
  while the host is still rc.2 so `main` never stops being publishable.
- **The type surface barely moved.** Checking every named symbol dshell imports
  from 25 first-party packages against the published `0.1.6-alpha.1` types found
  zero regressions; the client contract did reorganize
  (`contract/input` → `contract/draft-editor`, `context-provenance` →
  `context-producer`), but dshell references none of it. The work is in behavior
  and packaging, which is why the testing half of the document exists.

**A1 landed** (2026-09-17, host still at rc.2): 211 pins across nine manifests
widened to `0.1.5-rc.2 || 0.1.6-alpha.1`, and `@deepseek-ai/schemastery` moved
out of `dependencies` into a peer in `mode` and `ssh`. The gate was
install/typecheck/build green, 9 spec files and 147 tests passing, a `pnpm pack`
of `dshell-mode` showing the union (schemastery a peer, absent from
`dependencies`), `package:linux --from=builder` still producing the `.deb`, and
the web harness booting on rc.2 with all seven dshell client faces advertised.
That schemastery is runtime-owned stopped being an inference here: it is one of
the 241 entries in the desktop build's own `desktop-packages.json`. The
per-check evidence is in the upgrade document's A1 section.

## Phase 10.34 — T1: the assumptions become assertions

The upgrade's real exposure was never the code — it was the things the repo
believed about dsh and checked nowhere: 211 pins, 46 `link:` overrides, a bundle
patch naming eight stock row ids, a client module table, and an install recipe
whose package list could fall behind the workspace silently. Phase 10.33 listed
that exposure; this phase closes it, before the host moves, so the move itself
has a net.

Three spec files, 25 cases, and every one of them was shown to bite by breaking
what it watches:

- **`bundle/tests/host-rows.spec.ts`** reads the two `web`-profile bundle patches
  out of `dsh/` and asserts that the eight ids dshell disables still exist, that
  its ten inserts collide with nothing, and that the profile still composes those
  two bundles at all. dsh's patch files carry `!!js` tags, which the YAML default
  schema refuses, so the loader extends it rather than the spec special-casing
  them. Renaming a targeted id (`ui-jobs` → `ui-jobs-renamed`) fails the case
  with that id in the message — which is the point: on 0.1.6 a renamed row is a
  no-op dshell's layer cannot see, and startup is best-effort there, so nothing
  else would have said a word.
- **`scripts/tests/manifest-contract.spec.ts`** holds the workspace's agreement
  with the checkout: peers and devDependencies carry the same names and ranges,
  every declared name resolves through a root override whose target manifest
  answers to that name, every `dsh-*` range satisfies `dsh/package.json`'s
  version, no `@deepseek-ai/*` name is ever a dependency, `neverBundle` is a
  subset of dsh's `PLATFORM_MODULES`, and the install recipe names every package.
  Each of those four claims was broken in turn and went red.
- **`terminal-bridge/tests/commands.spec.ts`** is the old
  `scripts/check-commands.ts` moved into the suite — same 13 assertions over the
  command splitter and the two truncation caps, now with a runner that fails a
  build. The script is deleted; the phase that introduced it (Phase 10.5) keeps
  its text as the record of how it was verified then.

One finding came from the new checks rather than from review: `buffer`'s client
bundle requires `@deepseek-ai/dsh-client-ui-primitives` from the module table,
while its manifest declared that package in `devDependencies` only. Nothing had
noticed, because the install recipe places it by hand for every profile — the
manifest simply under-declared what the package needs from its host. Fixed in
the same commit.

One planned check changed shape, and the reason is worth keeping: the intent was
to assert that the five seed-omission names match where the docs list them. There
is no list to assert against — the desktop package set is generated from the
packed tarball closure — so the check became the rule the desktop validator
actually enforces (no first-party name in `dependencies`) plus the ownership
check above, which together cover what the seed list was standing in for.

Suite: 12 files, 172 cases, up from 9 and 147.

## Phase 10.35 — A2: move the host to 0.1.6-alpha.1

`dsh/` is checked out at `dsh-v0.1.6-alpha.1` (`0a15e36e`). The install step
must use the pnpm 11.7.0 that ships inside the checkout; on this workspace the
root `packageManager` is pnpm 9, and `npx pnpm@11.7.0` resolves that root value
and then refuses the lockfile with `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`. The
working form is:

```sh
git -C dsh checkout dsh-v0.1.6-alpha.1
node dsh/node_modules/.pnpm/pnpm@11.7.0/node_modules/pnpm/bin/pnpm.cjs install
```

Run from `dsh/` so the workspace file there is what controls resolution.

The one infrastructure break the move surfaced: `node-pty`'s pnpm store path
grew a `_patch_hash=` suffix in the 0.1.6 lockfile. The old override
`link:./dsh/node_modules/.pnpm/node-pty@1.2.0-beta.15/node_modules/node-pty`
pointed at a directory that no longer exists, and `packages/dshell/terminal-bridge/node_modules/node-pty`
was a dangling symlink. Both were re-pointed at the new store directory, and what
is on disk now is the patch-hash path in both places:

- the root override (`package.json`) is
  `link:./dsh/node_modules/.pnpm/node-pty@1.2.0-beta.15_patch_hash=b40ae545…/node_modules/node-pty`;
- `packages/dshell/terminal-bridge/node_modules/node-pty` is a symlink to that same
  directory, and the target resolves.

An earlier revision of this paragraph claimed the override had been pointed at
`link:./dsh/node_modules/node-pty`, "the stable top-level link pnpm 11 keeps".
That path does not exist in this checkout (`ls dsh/node_modules/node-pty` fails),
so the record was wrong, not the fix: there is exactly one `node-pty@*` directory
under `dsh/node_modules/.pnpm/`, the patch-hash one.

The three compile-time breaks listed in §1.2 did not bite dshell's code: the
guide-entry `id` requirement is in `ui-sidebar-right`, which dshell does not
touch; `SubprocessHandle.control` is present on our `SpawnHandle`; and the
async `ShellExecutor.start` / `SandboxProvider.confine` seams are not
implemented by our SSH layer.

**Wrong on the first item** — dshell *does* register a guide entry
(`packages/dshell/files/src/client/definition.ts`), and it did bite. Corrected in
Phase 10.38; the other two hold.

Acceptance: `pnpm typecheck`, `pnpm build`, `pnpm test` (12 files, 172 cases)
and the T1 specs (`host-rows.spec.ts`, `manifest-contract.spec.ts`) all pass
with `dsh/` at 0.1.6. The emitted client bundles carry a 0.1.6-only symbol
(`ctx.webTerminals` / `webTerminals`).

**Correction (Phase 10.38).** `pnpm build` was **not** green at this point, and
the "the three compile-time breaks did not bite" paragraph above is wrong about
one of them. Only `typecheck` and `test` were green. See Phase 10.38.

## Phase 10.36 — A3: behavioral best-effort startup and row-liveness

0.1.6 makes startup best-effort: optional rows that fail to activate only
produce a warning, and the harness keeps running. That removes the implicit
smoke test "it did not boot", so we need an explicit "our rows are live"
assertion.

Evidence collected on the 0.1.6 harness:

- The boot log contains **zero** row-activation warnings — no `did not
  activate`, no `inactive` entries, no `required startup failure`.
- `/api/dshell/sessions` answers with the dshell workspace shape
  (`{"archived":["session-c56e1b53-26a4-40d2-97ea-5f771f140e6c"],"pendingPurge":[]}`),
  which proves the `dshell-workspace` row is mounted and its route is
  processing requests.
- The boot payload names all seven dshell client faces (`buffer`,
  `conversation`, `files`, `mode`, `ssh`, `terminal-bridge`, `workspace`).
- The bundle-patch row ids were already locked by T1
  (`host-rows.spec.ts`), and they still hold on 0.1.6.

The remaining A3 items — `localDisplayPath`, the `FS_NOT_FOUND` traversal
case in the SSH file routing, the `agent/created` signature, and the message
projection obligation — are recorded in the upgrade doc as behavioral facts
to observe when the harness is running under a browser. They are not
structural changes, so they do not need a phase of their own until a phase
actually touches those seams.

## Phase 10.37 — A4.1 is falsified: `ctx.ssh` is one connection, not a device

A4.1 planned to let `ctx.ssh` + `SshFileSystem` carry remote fs, exec and sandbox
*for a bound device*, demoting the mount directory and the per-tool seams to a
compatibility path. Reading the 0.1.6 host before writing the code showed that
shape cannot exist there, so nothing was migrated and the SSH layer stays as it
is. This phase is the record of that, so the next person does not spend the
attempt again.

The falsifying facts, each read directly at `dsh-v0.1.6-alpha.1` (`0a15e36e`):

- `ctx.ssh` is **one** connection. `Config.host` is a scalar OpenSSH alias
  ("including its existing user, key and known-host configuration",
  `dsh/packages/ssh/ssh/src/index.ts:18`), the service is a single
  `SshConnection` named `ssh` (`:47`, `:73`), and `request(method, params,
  result, signal, wait)` takes no host (`:115`).
- Its consumers each claim a capability service **once per context**, so the ssh
  family swaps the whole process world rather than scoping to a session:
  `SshFileSystem` → `ctx.fs` (`dsh/packages/ssh/fs-ssh/src/index.ts:20-21`),
  `SshSubprocessRuntime` → `ctx.subprocess`
  (`dsh/packages/ssh/subprocess-ssh/src/index.ts:229-230`), `SshSandboxProvider`
  → `ctx.sandbox` (`dsh/packages/ssh/sandbox-ssh/src/index.ts:10-11`).
- Two providers of one capability in one context is an error, not a layering:
  "a host composes exactly one provider of `ctx.shell` … mounting both fails loud
  on a duplicate service registration"
  (`dsh/packages/shell/shell/src/index.ts:13-17`); the duplicate throws at
  `dsh/vendor/cordis/src/reflect.ts:290`.

Mounting upstream's rows alongside our `bash-local`/`fs-local` rows would
therefore fail rather than give one session a remote world — and if it were
accepted, every session would move to that single device, which is the opposite
of a per-session binding.

Per-session isolation exists as a primitive but is not wired to sessions:
`ctx.isolate(name, label?)` makes a child context with its own realm for one
service name (`dsh/vendor/cordis/src/context.ts:121-124`), and the only
production user is agent-presets, which mounts a preset composition **once per
preset id** (`dsh/packages/preset/agent-presets/src/index.ts:776`, `:449`) with
sessions binding to that standing mount (`:454`, `:491`, `:688`). Sessions on one
preset share the instance.

**Decision.** dshell's per-device transport is the design of record, not a
compatibility path. It drives the system `ssh` through `ctx.subprocess` and needs
no 0.1.6-only service, which is also what keeps the dual-host peer ranges honest.
No code changed: the only artifacts from the attempt were two dependency
additions (`@deepseek-ai/dsh-ssh`, `@deepseek-ai/dsh-fs-ssh` in
`packages/dshell/ssh/package.json` plus their root overrides), and they were
reverted with the lockfile.

**What is still worth taking, unscheduled.** Upstream's real asset here is the
helper *protocol* — `@deepseek-ai/dsh-ssh/protocol` (`SshRpcPeer`,
`RemoteOperationError`) and `@deepseek-ai/dsh-ssh/schemas` with the remote helper.
A per-device client speaking it would replace "spawn `ssh` per command against a
mount directory" with one multiplexed, hash-verified helper session per device,
and the device registry would stay ours because the connection count stays ours.
That is a project the size of the existing `ssh` layer, so it is listed here as a
candidate phase and not folded into the upgrade.

**A4.2 stands, narrowed.** `ctx.webTerminals` is a client service that genuinely
is keyed by session — `view(sessionId, …)`, `launchShells(sessionId, …)`,
`close(sessionId, …)`, `recover(sessionId)`
(`dsh/packages/api/terminal-controller/src/client/index.ts:68`, `:87`, `:106`,
`:124`) — but it models a **sidebar** terminal, while dshell's is the agent's own
PTY with a claim hook. Reuse is therefore the recovery/attach and
shell-discovery semantics, not tab ownership. `dshell-terminal-bridge` is about
5,800 lines (client 985 + 322, host PTY 586), so it is its own phase.

Acceptance for this phase: `pnpm typecheck` and `pnpm test` (12 files, 172 cases)
stay green with the dependency additions reverted, and the upgrade doc's A4
section states the constraint with the citations above.

## Phase 10.38 — the three client breaks A2's acceptance missed

Phase 10.35 recorded all four gates green. At its merge commit they were not:
`pnpm typecheck` and `pnpm test` were green, and `pnpm build` failed on three
client implementations that no longer satisfied their upstream interface. This
phase lands the fixes and the corrected record.

| Site | Break | Fix |
|---|---|---|
| `packages/dshell/workspace/src/client/index.ts` | `IWorkspaces` and `UiWorkspace` gained a required `unarchiveSession` (TS2420, both stand-ins) | both delegate to `SessionPanelClient.unarchive`, which already existed and whose route this package serves — `workspace/src/route.ts:98` handles `action: 'unarchive'` |
| `packages/dshell/files/src/client/definition.ts` | `SidebarRightGuideEntry` gained a required `id` (TS2741) | `id: 'files'`. §1.2 and Phase 10.35 both predicted this break "would not bite because the type lives in `ui-sidebar-right`"; that reasoning confused where the *type* lives with where a *value* is registered — dshell registers one guide entry |
| `packages/dshell/mode/src/client/index.ts` | `CommandClaim` gained a required `name` (TS2741) | `name: next`, the canonical mode name; upstream documents it as "the key of per-command composer copy such as `hint.*`" |

The other two §1.2 breaks genuinely did not bite (`SubprocessHandle.control` is
on our `SpawnHandle`; we implement neither async `start` nor `confine`).

**Why this escaped, and the gate consequence.** At the merge commit
`pnpm typecheck` was green while `pnpm build` was red on all three rows.
`typecheck` is `tsc -b` over `tsconfig.host.json` / `tsconfig.client.json`, which
trusts per-project `*.tsbuildinfo`; `build` is `tsc -p` per package, which does
not. `.tsbuildinfo` is gitignored (`.gitignore:20`), so its freshness belongs to
one working copy and not to the commit. The mechanism was not pinned down, and
this phase does not claim to: what is recorded is that the two gates disagreed
on a merge commit's content, and that only `build` was telling the truth.

Consequence for the T roadmap: "`pnpm typecheck` is green" must not be used as
the compile gate on its own. Either the gate becomes `pnpm build`, or the
check is `tsc -b … --force` (which discards the incremental state that made the
disagreement possible). This belongs with T2 (compile-time host-contract
assertions) and T4 (the scripted acceptance checklist), since both were premised
on the compile gate being trustworthy.

A second, related lesson: the upstream interface change surfaced only because the
implementation *declares* `implements IWorkspaces`. A dshell class that consumed
the service without declaring the interface would have compiled cleanly and
failed at runtime — which is exactly the failure mode 0.1.6's best-effort startup
(A3) no longer reports loudly.

Acceptance: `pnpm typecheck`, `pnpm build` (all 11 packages) and `pnpm test`
(12 files, 172 cases) all green at once, and the A2 and 10.35 sections carry the
corrections.

## Phase 10.39 — the device seam moves to RPC (design + spike)

Assembling remote commands as shell text is not a durable way to run a session on
a device. Every structured operation has to be *encoded* as a string and then
parsed back: `find -printf '%f\0'` with backslash-zero characters so the remote
shell does not turn them into real NULs, `LC_ALL=C` around `stat`/`find`, and a
nesting depth of quoting that exists only to smuggle a directory into an argv
element. Each of those is a correctness and an injection surface at the same
time. This phase replaces the encoding with a contract.

### The decision

**dshell writes its own helper; upstream's `SshRpcPeer` framing and op vocabulary
are the contract.** Not their helper.

Three reasons, each checkable:

1. **Their helper cannot be extended.** The dispatch ends in a hard
   `throw new Error('Unknown SSH helper operation: ${method}')`
   (`dsh/packages/ssh/ssh/src/helper.ts:239`), so "extend their RPC" cannot mean
   adding methods to it, and `dsh/` is read-only for us.
2. **Their helper is heavy to deploy.** `lib/helper.js` still imports
   `@deepseek-ai/cordis`, `dsh-fs`, `dsh-fs-sandbox`, `dsh-sandbox-local`,
   `dsh-sandbox-policy`, `dsh-session-projection`, `dsh-subprocess`,
   `dsh-subprocess-local` and `zod`; `dsh-subprocess-local` additionally needs
   node-pty's native prebuilt `spawn-helper` (`scripts/ensure-spawn-helper.mjs`).
   Their README says it plainly: "Install the built helper and its matching
   runtime dependencies on the remote host."
3. **Their connection refuses half our devices.** `SshConnection.start()` pins
   `BatchMode=yes` and `StrictHostKeyChecking=yes`
   (`dsh/packages/ssh/ssh/src/index.ts:263-265`) and manages no known_hosts. Our
   registry has `auth: "password"` devices, and password login is exactly what
   `BatchMode` disables.

### Spike results (2026-09-17, rig `127.0.0.1:2222`, remote node v24.21.0)

A helper of ours, importing their framing class, plus a client of ours:

```
hello in 144ms -> {"protocol":1,"platform":"linux","node":"…v24.21.0/bin/node","root":"/home/wpp"}
dshell.ping -> {"pong":"DSHELL","at":…}                    ← our own op, same connection
dshell.list -> {"entries":[{"name":"…","size":89,"dir":false},…]}   ← structured, not parsed text
unknown method -> Unknown SSH helper operation: dshell.nope         ← same boundary as theirs
```

- the handshake costs 144–186 ms **including** the ssh connection setup;
- `SshRpcPeer` works on both ends, so nothing binds us to their helper artifact;
- our own method names coexist with their vocabulary on one connection;
- the identical run against a `tsdown` bundle: **one file, 139,283 bytes**, whose
  only remaining imports are `node:crypto`, `node:events`,
  `node:fs/promises`, `node:path`. Everything else — `SshRpcPeer`, `zod` — is
  inlined. Deployment for the fs/exec op set is therefore "one file plus node".

### Target shape

- One long-lived `ssh -T -M` child per device. **We already multiplex**:
  `runner.ts:90-92` sets `ControlMaster=auto`,
  `ControlPath=<data root>/dshell/ssh/ctl/<tag>`, `ControlPersist=120s`. The
  transport does not change; what changes is that the connection carries a
  process instead of one exec per command.
- One helper process on the device, JSON-RPC over that child's stdio via
  `SshRpcPeer`.
- Op names mirror theirs where the semantics match, so a future swap stays cheap;
  our own needs go under `dshell.*`.
- No command string is assembled anywhere: arguments travel as JSON.

| Their op | dshell use |
|---|---|
| `fs.resolve`, `fs.stat`, `fs.lstat`, `fs.list`, `fs.next` | replaces the `find`/`stat` text parsing, including the NUL and `LC_ALL=C` workarounds |
| `fs.write`, `fs.edit`, `fs.stream` | replaces the host-side `cat`/redirect assembly for read/write/edit and the buffer relay |
| `process.prepare`/`start`/`done`/`wait`/`terminate` | replaces the assembled `bash -lc` line; argv travels as a list |
| `executable` | replaces the `rg` presence assumption in glob/grep |
| `terminal.environment` | shell discovery for the device |
| `sandbox` | deferred; we do not sandbox on the device today |

### Staging

- **S1 — transport, fs and exec.** Kills the assembly for `read`/`write`/`edit`/
  `list`/`glob`/`grep`/`bash`. This is where the encoding pain actually is, and
  it is the part the spike proved deployable as one file.
- **S2 — terminal.** Open decision, because a PTY cannot be allocated in pure JS:
  either keep today's `ssh -tt 'exec bash -l'` for the interactive terminal, or
  deploy a native allocation path per device. Not settled here.

### What we keep

The device registry and its UI, password *and* key auth, per-device
`known_hosts`, and `remoteRoot`/mount for the session's own directory — the
harness reads that directory locally for instruction files, project discovery and
sandbox roots, so the mount stays regardless of how commands travel.

### Security: what this does and does not buy

It does **not** make the device trusted, and the honest accounting matters because
the motivation for this phase is partly risk:

- **Gained:** the entire quoting/injection class disappears. Arguments are JSON,
  never a shell string, so there is no nested-quote depth to get wrong and no
  `NUL` smuggling. The local hop no longer has to be handed
  `danger-full-access` to fit a `cd … && …` through it, because there is no
  command to fit.
- **Taken on:** a persistent Node process on the device that can perform
  filesystem and process operations as the device user — a longer-lived surface
  than short-lived execs, and one whose integrity now depends on a deployed
  artifact. Upstream's own caveat applies verbatim: digest verification "does not
  make writable deployment files safe to execute or authenticate a malicious SSH
  host." We would verify our helper's hash the same way and for the same limited
  reason — detecting an unexpected installed artifact, not authenticating a host.

So the net effect is a smaller *error* surface with a different *trust* surface.
The device-trust work (host-key pinning, which is still open in 10.10) is
unaffected and still needed.

### Open questions, stated rather than assumed

- **PTY** (above) — the only piece outside the single-file story.
- **Protocol version.** Their `SSH_PROTOCOL_VERSION` and `helloSchema` are
  versioned. We should pin to a version we have read and keep our own handshake
  tolerant, rather than inheriting alpha churn on a wire format.
- **Helper upgrade.** How a device's installed helper is refreshed when dshell
  updates: hash-pinned, but who pushes it, and what happens to a live session.

### Verification

On the rig, the same three seams that are tested by hand today — `bash`, a
relative read/write, and `grep`/`glob` — must pass over the RPC path, plus one
red-light case: kill the helper mid-operation and require the client to report an
unconfirmed outcome rather than silently retry (their peer contract is explicit
that cancellation never replays an ambiguous mutation, and ours must match).

Acceptance for S1: those checks green on the rig with the RPC path on, and the
current exec path still available per device so any single device can be moved
back without a rebuild.

**Rollback:** per-device, and the existing exec path is not deleted until S1 is
green on the rig.

### Provisioning: probe, then deploy

Requiring the user to prepare the machine by hand is what makes upstream's ssh
family unusable for dshell's "add a device in a dialog" flow, so provisioning has
to be dshell's job. The probe rides the dialog's existing **Test** action
(`packages/dshell/ssh/src/router.ts:379`), which today answers reachability,
identity and the trusted fingerprint; it grows two more questions, and the install
action is offered from its answer.

**Probe, in order:** reachability and auth (as today); then whether `node` exists
and what version; then whether the helper artifact is present at its
content-addressed path and whether its hash equals the one this build produced.

**Verify by bytes, not by a version number.** The helper already self-reports:
`hello` answers with `hash: sha256(readFileSync(entryPath))`
(`dsh/packages/ssh/ssh/src/helper.ts:105`). Compare that against the hash of the
helper this dshell build ships. A version *string* would accept a
rebuilt-but-mislabelled artifact; a hash cannot.

**Transmit; never compile on the device.** The helper is a build output of
dshell's own build — the 139,283-byte single file measured above — so runtime work
is only "put bytes there". Compiling on the device would need a toolchain and
network access on someone else's server, would make the deployed artifact
non-reproducible (a different build is different bytes, so there is nothing to
pin), and would turn a user's machine into a package-fetch target.

**The bootstrap needs nothing but `ssh`.** One exec with the bytes on stdin
(base64), plus `mkdir -p` and `chmod`. On-device verification deliberately does
*not* need `sha256sum`: the helper hashes itself during `hello` and a mismatch
refuses the connection, so the bootstrap depends on no hashing tool on the device.

**Content-addressed path:** `~/.dshell/helper/helper-<sha256>.js`, a 0600 file in a
0700 directory, outside the session workspace — upstream's "keep Node, helper,
bootstrap and their dependencies outside the workspace and writable temporary
roots" applies to us for the same reason. The filename carries the expected hash,
so a new version never lands on top of a running one.

**No attach to a live helper — rejected deliberately.** Detecting an *active*
helper and reusing it sounds free, but it is a daemon model: it needs a rendezvous
(socket path plus authentication, because the helper holds unrestricted
filesystem and process powers) and a reap story for a process that outlives its
client, and it buys back roughly 150 ms — the measured handshake was 144–186 ms
*including* the ssh connection setup. Helper lifetime stays bound to the
connection, as upstream has it: `ControlPersist=no`, one authority per connection,
and a lease plus heartbeat (`ServerAliveInterval=10`, `CountMax=3`, `leaseMs`
30000) so a lost link starts remote cleanup instead of leaving an orphan with
those powers.

**Node is the one thing we cannot provision.** Installing a runtime on a user's
machine is out of scope, and doing it silently is dangerous. A device without Node
therefore keeps the assembled-command path — which changes that path's role from
"rollback" to **the no-Node compatibility tier**, a better reason to keep it alive
than a rollback that is expected to expire.

**Mismatch policy differs from upstream on purpose.** They refuse the connection.
dshell should redeploy with a log line, because in our model the device is ours to
manage and the artifact is one we authored; refusing would turn every helper
release into a manual visit to every device. Whether that becomes a per-device
choice is open.

**The development loop and provisioning are the same mechanism.** The helper's
source lives in our repo, `tsdown` bundles it at build time, and the bundle's hash
is the contract. So a helper change produces a new hash, which makes the device
redeploy on the next connect — "improve the helper" and "keep devices current" are
one loop rather than two. Keep one escape hatch: a local-path override, so the rig
can point at a freshly built helper without a deploy.

Acceptance for provisioning, on the rig: with `~/.dshell/helper` removed, Test
reports "no helper" and offers install; install then Test reports a hash match;
rebuild the helper and the next connect detects the mismatch and redeploys. The
"no node" path must report itself clearly and route to the compatibility tier
rather than attempting an install.

### Development plan (M0–M4)

Agreed 2026-09-17. Migration first, provisioning last, so every milestone before
M4 is developed against a helper deployed to the rig by hand.

| Milestone | Delivers | Ends when |
|---|---|---|
| **M0** | The spine: helper protocol, device helper, connection manager, build and dependency wiring. No behaviour change. | Handshake + echo round trip on the rig (done — see 10.40). |
| **M1** | `exec` through the `ctx.subprocess.spawn` seam: the router stops rewriting commands, and a bound session's spawns return a helper-backed handle. | On the rig: `bash` (relative workdir, exit code, stderr, an over-limit output that spills), `grep`/`glob`, and the red-light case (kill the helper mid-exec → reported as unconfirmed, never silently retried). |
| **M2** | `fs.*` ops: `resolve`/`stat`/`lstat`/`list`/`next`/`read`/`write`/`edit`/`remove`/`rename`/`mkdir`/`publish`, with typed errors. `remote-fs.ts` loses its shell text and its English-stderr classifiers. | On the rig: relative read/write; a permission and a not-found case arriving as typed errors; the `find -printf '%f\0'` path gone. |
| **M3** | Transfers and the buffer relay move onto `fs.*`, and the three duplicate `quote` helpers disappear with their last callers. | On the rig: a large file copied both ways, a cross-session buffer copy, and a checksum mismatch handled. |
| **M4** | Provisioning: the Test action probes for Node and the helper, an install action bootstraps it, and a digest mismatch redeploys. | The provisioning acceptance above. |

Out of scope for this round, recorded: the remote interactive terminal (it keeps
today's `ssh -tt` path, and the PTY question stays open), and the two single-use
`bash -c` probes in `files` (the PATH lookup and the completion oracle).

Three constraints shape every milestone:

1. **The connection must bypass the seam being wrapped.** A bound session's
   subprocesses are routed by wrapping `ctx.subprocess.spawn`, so the connection
   that serves them is spawned with `node:child_process` directly. Creating it
   through `ctx.subprocess` would recurse.
2. **The fallback is also the no-Node tier.** A device without a verified helper
   keeps the current assembled-command path — one code path serving both "not
   migrated yet" and "cannot run a helper at all".
3. **`pnpm typecheck`, `pnpm build` and `pnpm test` stay green at every
   milestone**, and the fallback stays reachable.

## Phase 10.40 — M0: the helper spine

The scaffold for everything above: dshell's own device helper, the connection
that owns it, the wire contract between them, and the build and dependency wiring
that turn the helper into one deployable file. No behaviour changes — nothing in
the existing seams consults any of it yet.

### What landed

- `ssh/src/helper/protocol.ts` — the operation set and its schemas. Names mirror
  dsh-ssh's where the semantics match; everything else is `dshell.*`. The
  revision is deliberately independent of `SSH_PROTOCOL_VERSION`: the framing is
  theirs, the operations are ours.
- `ssh/src/helper/run.ts` — the device-side behaviour, over explicit streams so
  it can be driven without spawning. Owns the handshake, the lease, and the
  deliberate refusal of unknown operations.
- `ssh/src/helper-entry.ts` — the launch shape: its own path (which the handshake
  hashes), the signals that mean the connection is over, no arguments accepted.
- `ssh/src/connection.ts` — one ssh child, one helper, one `SshRpcPeer`;
  handshake, digest check, lease heartbeat, disposal, and a pool keyed by device
  and target.
- `runner.ts` — `trustOptions` and `keepaliveOptions` extracted so
  `helperArgv` reuses the *same* trust and authentication options as the
  per-command invocations. A device whose host key was trusted on one path and
  not the other would be two different answers to "is this the machine I meant".
- `tsdown.dshell.preset.ts` — `dshellNodeBundle`, and the ssh package builds two
  artifacts now (`lib/client.js`, `lib/helper.js`), with `./helper` exported.

### Evidence

Rig `127.0.0.1:2222` (the throwaway device), host and device on Node v24.21.0,
helper deployed as `~/.dshell/helper/helper-<sha256>.js`:

```
artifact hash: 84d72c09ad105311571d6a74c84023fe6282c31603ad674a9eb665d4c3d0e33c
hello in 153ms -> {"protocol":1,"hash":"84d72c09…","platform":"linux",
                   "node":"…/v24.21.0/bin/node","nodeVersion":"v24.21.0","root":"/home/wpp"}
dshell.echo -> {"label":"dshell","upper":"DSHELL","pid":86034,"cwd":"/home/wpp"}
echo pid differs from the host pid: 86018
disposed cleanly
MISMATCH -> the device's dshell SSH helper differs from this build (device 84d72c09ad10…, expected ffffffffffff…)
ABSENT   -> the dshell SSH helper did not start on the device: … Cannot find module '/home/wpp/.dshell/helper/does-not-exist.js'
```

The echo's pid differing from the host's is the part that matters: the rig is the
same machine, so it is the only proof the work happened in a process the ssh
connection started rather than locally.

`lib/helper.js` is 262,079 bytes and imports only `node:crypto`, `node:events`,
`node:fs` and `node:url`.

### The traps, each of which cost real time

- **One zod, or nothing compiles.** `SshRpcPeer`'s signature is written in zod's
  types, so our schemas must be the *same zod* dsh-ssh resolves. `^4.4.3`
  resolved 4.6.5 while their tree had 4.4.3, and the result was
  `Type instantiation is excessively deep and possibly infinite` plus a
  structural-mismatch error naming nothing near the cause (a 40-line dump ending
  at `_zod.version.minor`). Pinned to the exact version, and
  `helper-artifact.spec.ts` now asserts the two versions are equal, so the next
  such drift is one red test instead of an afternoon.
- **`alwaysBundle` must match subpath imports.** Matching the bare package name
  leaves `@deepseek-ai/dsh-ssh/protocol` external, and the artifact *looked*
  fine — it built, it ran — while quietly requiring a `node_modules` the device
  does not have. Patterns are `^pkg(/|$)` now.
- **Self-containment is a build gate, not an assertion.**
  `deps.onlyImport: []` makes tsdown refuse to emit when anything
  package-shaped would remain an import; node's built-ins are always allowed.
  Red-light tested: emptying `alwaysBundle` fails the build naming both
  offenders. A post-hoc spec could only have described the problem.
- **The remote helper path must be absolute.** `helperArgv` quotes each word for
  the remote shell, and a quoted `~` never expands — so `~/.dshell/helper/…`
  is a path that cannot work, and the design's shorthand has to be read as
  `${HOME}`-expanded by whoever installs it.
- **`tsc -p` emits JS for files only the bundle needs.** `lib/helper-entry.js`
  and `lib/helper/run.js` appear beside the bundle and are unreachable once it
  exists, while `files: ["lib"]` would happily ship them;
  `scripts/drop-intermediates.mjs` removes exactly those two and the spec asserts
  they are gone (its neighbour, `lib/helper/protocol.js`, is a real host module
  and must stay).
- **A pre-handshake failure needs a different error path.** The peer rejects a
  pending request with "outcome is unknown", which wins the race against the
  child's exit and buries the cause. The handshake now waits for the child (which
  must be exiting, since the channel closed) so the ssh client's stderr is in
  hand, and a self-diagnosed failure outranks a transport one — without which
  tearing down after a digest mismatch would replace the mismatch with
  "did not start", hiding the actual problem.

### Not yet true

Nothing routes through the spine, so the helper is inert in a real session; M1
wires the first seam. The pool's disposal is not bound to anything yet (no
device deletion, no host unload), which M1 must do or a device change would leave
a helper behind. And the lease/heartbeat pair is exercised only by the rig run:
its interaction with a *hanging* device (as opposed to a closed one) is
unverified.

## Phase 10.41 — M1: exec through the subprocess seam

The first seam that acts on the spine. A device session's processes now leave
through `ctx.subprocess.spawn`, so the shell executor, the search tool and
anything else that spawns keep their own timeouts, caps, spills, streaming and
background handles — those live above this seam — and only the location changes.

### What landed

- `ssh/src/helper/protocol.ts` — the process operations (`prepare`, `snapshot`,
  `done`, `terminate`, `wait`) and their schemas.
- `ssh/src/helper/processes.ts` — the device's process table: bounded output
  windows, spill files, group termination, and reaping on close.
- `ssh/src/remote-process.ts` — `SubprocessHandle` over the wire, including the
  synchronous, offset-based readers the seam demands.
- `ssh/src/helper/target.ts` — the target probe (the device's home and a Node
  executable, in one round trip), memoized per device and dropped when a device
  changes.
- `ssh/src/router.ts` — **stops rewriting the command**, and leaves `workdir` as
  the session's own mount path. The translation to a device directory now happens
  once, in the subprocess seam, instead of here and there.
- `ssh/src/spawn-routing.ts` — the three-outcome seam, and the owner of the
  connection pool's lifetime (created here, disposed with the plugin, released
  when a device is saved, deleted or re-bound).

### Evidence

Rig `127.0.0.1:2222`, driven through the real connection with the exact specs the
two callers build:

```
1. exit 7 | stdout "/tmp/dshell-sshd\nhello" | stderr "oops" | ran in the device directory: true
2. total 108894 bytes | lossy true | kept the tail: true | spill /tmp/dshell-helper-…/….stdout
3. rg exit 0 | files 9 | no spill: true
4. missing program -> mapped: … missing (spawn … ENOENT)
5. fallback exit 0 | files 9
6. RED LIGHT -> done rejected: SSH helper disconnected; outcome is unknown
   output after the kill is empty, not invented: ""
   the connection stays failed, so nothing is retried silently
```

Observations 1–3 are `bash-local`'s spec (exit code, both streams, the working
directory) and the search tool's (a host-resolved rg path, collect without
spill, read after `done`). Observation 5 is the **fallback tier** measured rather
than asserted: the assembled line returns the same 9 files, so a device with no
helper behaves as it did before this milestone. Observation 6 is the red light —
killing the helper mid-execution must not be mistakable for a finished command,
and the empty output is the tell that nothing was invented to fill the gap.

### Decisions and traps

- **`danger-full-access` stays, for a better reason than it had.** The active row
  is `bash-sandbox`, and it confines by wrapping `argv` in a *host* runner
  program before spawning. Handing that wrapped argv to a device that does not
  have the runner would fail; the policy is also meaningless there. So the
  override remains, now as "the confinement does not belong on this machine"
  rather than "it would confine the ssh client".
- **RPC serves collect mode only, and the fallback is a capability tier, not just
  a migration tier.** `'pipe'`, `'inherit'` and a control channel take the
  assembled path, which serves them because the local ssh client has real pipes.
  That is a better answer than refusing them.
- **`ssh` is checked before the RPC branch.** It is a bare name, so it looks
  perfectly routable — and routing it would run an ssh client *on the device*
  with the host's argv, credentials and known_hosts paths.
- **The assembled line uses the device's name for the program.** The caller's
  unresolved rg path is absolute to the host and would not exist on the device;
  the old rg-only special case is now the general rule, which is also what keeps
  the no-helper tier behaving as it did.
- **A start can fail in the platform's own time.** Node reports a missing program
  on the child's `error` event, after `spawn` returned, so the helper cannot know
  synchronously: `prepare` reports no `pid` and the failure surfaces on `done`,
  where the `ENOENT` is. Translation had to cover both ends — an earlier revision
  only translated the prepare rejection, and the rg diagnostic silently never
  fired. Observation 4 is what caught it.
- **Live output is polled, and only once a reader has read.** The seam's readers
  are synchronous, so live output can only come from what has already arrived; a
  reader that reads after `done` (the foreground and search shapes) never polls
  at all. Granularity is the poll interval — a real difference from upstream's
  forwarded sockets, and the first thing to revisit if background shells need
  smooth streaming.
- **Children are started in their own process group and terminated as one.**
  `child.kill()` reaches only the process it names, so `bash -c 'thing & wait'`
  would leave `thing` running after the caller believed it stopped. A new group
  plus a negative-pid kill is the equivalent of what the ssh client's
  disconnection used to achieve.
- **The helper reaps its own children**, on close and on lease expiry, so a host
  that dies without saying goodbye leaves nothing running on the device.
- **An abort that lands before `prepare` returns still terminates.** The
  termination request follows the promise for the process id rather than the id
  itself; without that, a cancellation in that window left a process nobody could
  name any more.
- **`spillPath` is a device path.** Correct rather than confusing in a device
  session — every file operation there is remote too, so the same tools can read
  it — but not something the harness itself can open, and any message showing it
  should say which machine it names.

### Not yet true

- Acceptance was measured at the mechanism level, through the specs the callers
  build, not through a live browser session. End-to-end belongs to the T4
  checklist.
- Warm-on-bind is fire-and-forget, so on a freshly started host the first tool
  call may take the fallback path while the helper connects. One round trip, no
  failure.
- `remote-fs` still uses the assembled hop; moving it onto fs operations is M2.
- There is still no confinement *on* the device: the command runs under the
  device's own policy, which the seam says so explicitly.

## Phase 10.42 — M2: the filesystem seam moves to RPC

The device fs (`ctx.fs` for a bound session) ran one `ssh` invocation per
operation since A4, with two hard habits pinned into the design:

- `LC_ALL=C` everywhere, because `stat -c %F` prints a *localized* "regular
  file" string and `find -printf` only emits a NUL separator when its format
  itself is a NUL — which Node refuses to send across argv. `find` answers in
  English if asked to.
- a stderr classifier that turned English error text into `FsError` codes,
  because there was no other signal on the assembled lane.

Both disappear on the helper lane. The wire speaks for itself, and what the
helper *does* say about a failure is a code derived from an errno, not a
phrase.

### Wire contract — `packages/dshell/ssh/src/helper/protocol.ts`

Six new operations under the existing `HELPER_OPS` constant; nothing else
changes:

| op               | request                                  | reply                                  |
| ---------------- | ---------------------------------------- | -------------------------------------- |
| `fs.resolve`     | `{ path: absolute }`                     | `{ path: absolute }`                   |
| `fs.stat`        | `{ path: absolute }`                     | `{ kind, size, version } \| null`      |
| `fs.lstat`       | `{ path: absolute }`                     | `{ kind, size, version } \| null`      |
| `fs.list`        | `{ path: absolute }`                     | `{ entries: [{name, kind, size?, version?}] }` |
| `fs.readRange`   | `{ path, offset, length ≤ 8 MiB }`       | `{ data: base64 }` (short = EOF)       |
| `fs.write`       | `{ path, data: base64 ≤ 32 MiB }`        | `{ kind, size, version }`              |

A reply's `kind` is one of `file | directory | symlink | other`; `version` is
the same five-field token the local backend derives, opaque on the wire. A
failure carries the seam's `FsErrorCode` (`FS_NOT_FOUND`, `FS_NOT_DIRECTORY`,
`FS_NOT_REGULAR_FILE`, `FS_PERMISSION_DENIED`, `FS_TOO_LARGE`, `FS_IO_ERROR`)
in the existing `RemoteOperationError.code`, decided from the platform
errno. The helper's own framing and pending-request ceiling are unchanged.

### Device implementation — `packages/dshell/ssh/src/helper/fs.ts`

The piece that runs on the other machine. `DeviceFileSystem` exposes the
six primitives and is the answer to why every fs op used to be a `ssh
argv` line:

- `realpath` is per-component because `realpath -m` recurses on the longest
  existing prefix, which collapses `link/..` into the link's parent and
  gives the wrong answer when an intermediate component does not exist.
  Per-component realpath followed by a missing-tail append covers both
  `link/` and `link/absent/x.txt`.
- `versionOf` is the same five-field token (`dev:ino:size:mtimeNs:ctimeNs`)
  the local backend derives, nanosecond timestamps rather than milliseconds
  so a guard that could not tell a rewrite from the state it already read
  would still permit the overwrite it exists to refuse.
- a `mode` field travels back from the device for the write path's mode
  preservation, and is stripped before the reply crosses the seam — it is
  the write's business and nothing else's.
- `list` does not sort: order is the seam's decision (see below).

### Host seam — `packages/dshell/ssh/src/remote-fs*.ts`

The original `remote-fs.ts` was rewritten around one interface
(`RemoteFsTransport`) that two implementations both satisfy:

- `HelperFsTransport` — the device is reachable through the verified
  connection; every call is one request, fields named on both ends.
- `ShellFsTransport` — the no-Node tier; one `ssh` invocation per
  operation, parsed back as before.

`RemoteFileSystem` owns the policy half — guards, edit rules, line endings,
diff basis — and is unaware which transport is in use; which one it picks
is decided by `connection === undefined`, which `DshellFileSystem` reads
from the router's `helperConnection` accessor without awaiting. Awaiting
here would turn "no helper verified right now" into a stall on every read.

The list order is the seam's, not the device's: `DeviceFileSystem.list`
returns the kernel's order, `find -printf` returns whatever `find` chose,
and neither is sorted. `RemoteFileSystem.listDir` sorts once with English
collation — the order the local backend produces — so the same directory
reads the same way on either lane and from either machine. The known lane
difference: a symlink to a file is reported as `file` (followed probe)
on the helper lane, `other` (the entry itself) on the shell lane. The
verify-script asserts it; it is the last thing the shell lane exists to
preserve, and the M2 verify-script records it rather than papers over it.

### Verification

- `pnpm typecheck` and `pnpm build` are GREEN.
- `pnpm test`: 230 passed (was 176); new files:
  - `tests/device-fs.spec.ts` — 21 rules, one fs truth per test, against a
    real local filesystem. The permission mapping and the staging-file
    cleanup on failure are both proven by reverting in place and
    re-running.
  - `tests/remote-fs.spec.ts` — 20 rules over the policy layer, exercised
    through a fake transport. The guarded-write guards are proven by
    deleting the if-branches and re-running.
  - `tests/remote-fs-helper.spec.ts` — 13 rules over the helper lane's
    wire shape and error mapping. The "unknown code falls back to
    `FS_IO_ERROR`" rule is proven by replacing the fallback with the
    device's code verbatim.
- **Rig verification** — `/tmp/dshell-m2-verify.mjs` (49 checks, all pass)
  drives the real connection against the throwaway sshd at
  127.0.0.1:2222 and exercises:
  - relative-path resolution, read, write, and version-guarded write;
  - typed errors (`FS_NOT_FOUND`, `FS_NOT_DIRECTORY`, `FS_NOT_REGULAR_FILE`,
    `FS_PERMISSION_DENIED`) for absent files, non-directories, and a file
    with mode `0000` / a directory with no read bit;
  - mode preservation (an existing file's mode is carried over; a new
    file gets `0o600`);
  - a literal edit (including CRLF detection-and-restore);
  - a 9 MiB read that spans the 8 MiB frame ceiling, with a multi-byte
    character straddling the boundary;
  - a stream that is abandoned after one chunk, with the connection
    answering afterwards.
  The helper-lane runs with a `ctx.subprocess.spawn` that throws on every
  call, so any observation that passes is evidence no `ssh` invocation
  ran for it: the `find -printf` path is gone from the helper lane, the
  `stat -c`/`LC_ALL=C` path is gone, the `mktemp` publish script is gone,
  the `head -c`/`tail -c` reads are gone. The same operations then run
  against a real spawn shim to prove the shell lane still works.

### What the shell lane keeps

It is the no-Node tier. Every constant the assembled path needed stays
where it was — `STAT_FORMAT`, `FIND_FORMAT`, the `LC_ALL=C` prefix, the
`realpath -m` resolve, the `head -c`/`tail -c` reads, the `mktemp` +
`chmod --reference` + `mv` publish script, the two stderr classifiers.
The helper lane retiring them is what makes the helper lane *the* lane;
the shell lane remaining available is what makes no-Node still work.

### Deferred

- `files/src/transfer.ts` and `buffer/src/service.ts` still assemble — M3.
- Provisioning — the device-card probe, the install route, the
  `~/.dshell/helper/helper-<sha256>.js` install action — is M4.

### Acceptance

All three gates green; rig 49/49; helper-lane subprocess attempts = 0;
expected-fallback property recorded (`link-to-file` reads as `file` on the
helper lane, `other` on the shell lane).

## Phase 10.43 — the archive set becomes upstream's

dsh 0.1.6 ships an archive set, a settings page that lists it, and a
round trip around it. dshell had its own: a `tags.json` document, an
`/api/dshell/sessions` route with `archive`/`unarchive` actions, and a
collapsible `已归档` group in the sidebar. Two implementations of one
concept, and they disagreed the moment both were visible — archiving
through the sidebar left dsh's page printing `暂无已归档会话。`.

The migration is not a deletion; it is a change of ownership.

### What upstream owns now

`workspaceRegistry.archivedSessionIds` plus
`archiveSession`/`unarchiveSession`, reached through the stock
`workspace-controller` row, which this profile now ENABLES. Its client
half is the `workspaces` service the sidebar reads and the settings page
is written against. dshell keeps the STORE (`$DSH_HOME/dshell/tags.json`)
and nothing else.

The registry that backs it is the stand-in dshell already had. Only its
archive half is real; its workspace half stays the honest projection of a
shell without workspaces. Hosting upstream's real `WorkspaceRegistry`
instead would run its one-time `bootstrap()`, which groups stored session
headers by cwd and rebuilds the accounting design 4.7 removed — on a
fresh profile, where nothing has seeded the initialized marker. Upstream's
`archiveSession` does not require that accounting: it checks that the
session EXISTS, never that it belongs to a workspace.

Because the registry's `archivedSessionIds` is a synchronous getter and
`WorkspaceFeed` reads it while the controller activates, the tag document
is loaded during composition (`SessionTagStore.load()`), before the
registry is registered.

### Why the row used to take the client down

"Failed to load plugins" — and the cause was ours. `WorkspaceController`
does `super(ctx, 'workspaces')`, and dshell-workspace registered a
`workspaces` stand-in of its own. Two providers for one service key is a
cordis error, and it surfaces only as a fiber in state `failed`.

The probe that found it: a temporary hook in dshell's own client entry
(never in dsh's read-only `boot-client.ts`) that exposed the loader and
printed every non-active entry's `fiber._error`. The message was
`service "workspaces" has been registered at
<@nexus-aethra/dshell-workspace (later removed)/client>`.

The earlier suspicion — that the row's manifest inject
`['@deepseek-ai/dsh-api-gateway', '@deepseek-ai/dsh-client-connection']`
disagreed with its code inject `['remote', 'remote.workspace']` — was
wrong. That split is stock throughout; `terminal-controller` has it too.
The probe was removed once it had answered.

### What the sidebar keeps

The 归档 row action (the only writer), the 待删除 group with its cancel,
and the delete flow behind a confirmation — and nothing else. The `已归档`
group is gone: restoring is the settings page's job now, and a second list
of archived sessions is a second place for the same set to drift.

Removing it orphaned 删除, which had lived on the archived rows, so the
active row now carries both actions. The row markers moved with it: the
`已归档` multi-select is gone, `mutedRowStyle` replaces `archivedRowStyle`,
and the compact rail's label walker now anchors on `pending-header` plus an
`empty` marker instead of `archive-header`.

### Two owners, one hidden set

A row leaves the active list for either of two reasons, and the two facts
arrive from different owners: the archive set is the registry's live
snapshot, the scheduled-purge qualifier is dshell's own route. The sidebar
filters on their union.

That split has one visible consequence, and it is where the bug was: the
delete path marks a loaded session pending by writing the tag document
directly, so the registry's snapshot never changes and the client model
never notifies. Cancelling from `待删除` therefore re-reads the qualifier
itself (`cancelPending`), because the restore command cannot update it.
dsh's own `/api` responses carry no cache headers either, so an early read
is a stale read.

### Acceptance

- Archiving in the sidebar, then opening Settings → 已归档会话, lists the
  session (`未分组 · 3天`) — the page that always printed the empty state.
- 取消归档 there returns the session to the sidebar with no reload, and
  the store is empty afterwards.
- Deleting a loaded session moves it to `待删除` and steps the stage off
  it; cancelling there restores it in place.
- Boot is clean — no `did not activate` warning, no `Failed to load
  plugins`; `pnpm build`, `pnpm typecheck`, `pnpm test` (275) all green.
## Phase 10.44 — host capabilities belong to local sessions

dsh 0.1.6 ships browser use and computer use as two registries with
providers behind them, and the stock rows hand both to every session.
That is wrong here for one reason, and the reason is the session's own
shape: dshell's device sessions run their shell, files and cwd on a
remote machine through `ssh`, so a browser or a desktop that lives on
THIS machine is the wrong side of the boundary the session exists to
cross. "Browser tools" in a device session would silently be operating
the local machine.

The user's rule for this round was: local sessions get them, a remote
session tries and turns off if it does not work. That rule cannot be
implemented inside upstream's runtime, and the two capabilities cannot
even be gated the same way:

- The browser is mounted PER AGENT into the agent's own scope
  (`McpClient` in the provider's `agent/created` listener). A scope
  cannot mask its own registrations — `tools.restrict()` filters what a
  scope INHERITS, not what it owns — so a deny list cannot take the
  browser away again. Not mounting is the only way to say no.
- The desktop is the opposite: the native provider discovers its catalog
  once and registers it GLOBALLY, so every session sees it and
  `tools.restrict({ deny })` is exactly the mechanism for taking it away
  from one.

### The provider — `packages/dshell/host-tools`

A new host package fills `ctx.browserUse` with dshell's own provider
(the stock Playwright row is disabled, since the slot admits one). It
mounts the same pinned `@playwright/mcp` per live local agent and differs
from upstream's in three ways:

- **locality is part of the decision.** `runsOnThisMachine(agent, bound,
  isMount)` asks the SSH router by session id, then asks whether the
  session's cwd is under the mount base. The second question is not
  redundant: the new-session dialog creates the session with the mount as
  its cwd and records the device assignment one round trip LATER, so at
  `agent/created` a brand-new device session looks exactly like a local
  one. The router resolves the same race the same way for the visible
  terminal. Refusing early is also the safe direction — a mount is an
  empty local stand-in, so "local" would be a wrong answer that stays
  wrong.
- **the engine's output goes to dshell's data root**
  (`$DSH_HOME/dshell/browser`), not the session's working directory, which
  is where the stock provider leaves a `.playwright-mcp/` directory.
- **failure is contained.** dsh rejects agent creation when a serial
  `agent/created` listener rejects, and upstream's provider awaits MCP
  startup inside that listener — so a broken install there costs the
  SESSION, not the browser. Here the mount is wrapped: a browser that
  cannot start is logged and that session simply has no browser tools.

For a device session the package mounts nothing and instead denies the
currently registered `cua_driver_native__*` names for that agent, re-run
on `tools/change` for a catalog that finished discovering after the
session was created. Names already denied are remembered, because each
call appends a layer.

### Two hazards this phase actually hit

Both were found by running it, and both are the kind that a spec would
not have caught:

- **`ctx.tools` on a context that did not declare it THROWS.** The first
  build of the mask read `ctx.tools` from the plugin's own context, whose
  `inject` named only `browserUse`. The throw happened inside the
  `agent/created` listener, which is the one place a throw is fatal:
  every device session failed to open, and the client showed its
  "选择一个工作区开始" hero with the session gone from the sidebar. The
  cause is invisible from the browser — the gateway answers
  `{"code":"gateway/internal","message":"resume failed for session …:
  Error: cannot get property \"tools\" without inject"}` and the host log
  is silent — so it was found by wrapping `window.fetch` in the page and
  reading the RPC response back. `inject` now names `tools`, and the
  scope is minted with `createScope` rather than borrowed from
  `agent.ctx`, because a restriction may only be registered through a
  context that injects `tools`.
- **A repeated `agent/created` for one activation would mount twice.**
  Upstream's provider is idempotent per agent (`SessionResources` keys by
  agent); ours is not, so the mount records the agent before awaiting the
  handshake and clears it on the agent's disposal.

### Wiring

- Patch rows: `dshell-browser-use-registry` (`@deepseek-ai/dsh-browser-use`),
  `dshell-host-tools` (`@nexus-aethra/dshell-host-tools`),
  `dshell-computer-use-registry` (`@deepseek-ai/dsh-computer-use`), and
  `dshell-computer-use-cua-native`
  (`@deepseek-ai/dsh-experimental-computer-use-cua-driver-native`). The
  stock `browser-use-playwright-mcp` row stays off: one provider per slot.
- `scripts/install-into-dsh-profile.sh` installs dshell's package plus the
  three upstream ones the stock profile does not ship. Row names resolve
  from the PROFILE's own dependencies, so a missing install is a failed
  import at boot with nothing pointing at the script.
- Root overrides gain `dsh-browser-use`, `dsh-computer-use`, `dsh-mcp-client`
  and `dsh-scope` (`dsh-scope` is new to this package's peer set, which the
  manifest contract checks in both directions).

### Verification

`pnpm build`, `pnpm typecheck` and `pnpm test` are green (274 cases; the
new `host-tools.spec.ts` carries 8 — Chromium discovery, the server's
argv, and the four locality rules).

In the browser, against a live harness and the local sshd rig:

- a local session's agent opened `https://example.com` and answered
  "页面标题是：Example Domain";
- a fresh device session opens normally — no hero state, still ten rows in
  the sidebar — and stays open;
- **no browser is mounted for a device session**: opening two of them left
  the child-process count unchanged, and every `@playwright/mcp` child's
  cwd is a local session's directory, never a mount;
- **the desktop mask takes effect**, read from the model's own surface:
  asked to count its `cua_driver_native__*` tools, the device session's
  agent answers "0 个" while the local session's agent answers 88. The
  catalog itself was confirmed out of band by driving
  `@trycua/cua-driver` directly (59 tools, all `cua_driver_native__`);
- the harness log stays clean: no warn from either containment path.

## Phase 10.45 — the 0.1.2 release

Four PRs and one new package since `0.1.1`, so the whole family moved
again: **twelve** packages at `0.1.2`, published in dependency order.

The release is mostly what the two phases above it describe — the archive
set moving to upstream (10.43), the machine's own capabilities becoming a
per-session decision (10.44) — plus the helper status loop actually
persisting what it deployed (#46) and the dialogs following the theme they
open in (#49). `dshell-host-tools` is NEW in this release and the bundle
depends on it, which is why an install of the bundle now pulls twelve
names instead of eleven.

### What a consumer does differently

Nothing structural — one command, four packages:

```sh
dsh plugin --profile web add -w @nexus-aethra/dshell-bundle@0.1.2
# the rows the patch names that a stock profile does not ship
dsh plugin --profile web add -w @deepseek-ai/dsh-browser-use@0.1.6-alpha.1
dsh plugin --profile web add -w @deepseek-ai/dsh-computer-use@0.1.6-alpha.1
dsh plugin --profile web add -w @deepseek-ai/dsh-experimental-computer-use-cua-driver-native@0.1.6-alpha.1
```

Verified rather than assumed, against a profile created from the shipped
web template:

- with only the bundle installed, the host boots and reports
  `2 entries did not activate` — the two computer-use rows — and nothing
  else is affected. That is how the second command above was discovered
  rather than guessed;
- with all four installed, the boot is silent, and the published client
  bundles render the full UI in the fresh profile: ten sessions, per-row
  `归档` / `删除`, no `Failed to load plugins`.

### Publishing notes

- `pnpm publish` does not accept `--userconfig`; the token file goes in
  `NPM_CONFIG_USERCONFIG`, and both `--registry=https://registry.npmjs.org/`
  and `--access public` are explicit because the ambient registry is the
  read-only npmmirror mirror and the scope is not the default one.
- The read side lags the write side, per package and again for a name's
  FIRST publish: `dshell-host-tools`' dist-tags answered and its tarball
  downloaded minutes before its packument stopped 404ing, so `npm install`
  failed with `E404` while every other package was already installable.
  A publish is not re-run for this; the acceptance signal is `+ pkg@version`
  from the publish itself plus the `dist` block the registry writes.
- The bundle's `workspace:^` edges rewrite to `^0.1.2` on pack, and the
  published manifest was read back to confirm all eleven deps — including
  `dshell-host-tools` — came out that way.

### Deferred

- The desktop profile still pins exact `0.1.0`; moving it forward is a
  `.deb` rebuild, not an npm step (design 10.30's profile rules).
- The token in `~/.npmrc.publish` has been pasted through a transcript and
  should be rotated.

## Phase 10.46 — the transport is a library, not the host's ssh

Committed 2026-10-19 as `7728876` on `feat/dshell-device-metrics`.

The host `ssh` binary was the one dependency dshell could not supply, and it
failed in four ways at once: absent on a stock Windows install until the user
adds the OpenSSH Client optional feature; reading `~/.ssh/config` and
`~/.ssh/known_hosts`, which are the user's files and not dshell's to write;
costing a process spawn per command that the harness then wrapped in a systemd
scope of its own (Phase 10.13 measured that at 0.39 s a call); and an
spawn-ENOENT that only ever fired on Windows. Replacing it with an in-process
`ssh2` client removes all four, and it is what lets a device session's terminal
be a session rather than a wrapper around someone else's.

### The three doors

`ssh/src/transport/transport.ts` pools one client per device, keyed by the
device AND a fingerprint of the credentials it was opened with — a rotated key
must not keep serving from a connection authenticated with the old one, which
would look exactly like a device that still accepts it. Over that pool:

| door | shape | used by |
| --- | --- | --- |
| `exec` | one channel, bounded collect, closed when the command ends | test, helper deploy, `remote-fs-shell` |
| `open` | one channel kept alive, fed through dsh's `SubprocessHandle` seam | the legacy command lane for a bound session |
| `shell` | a pty channel | the device terminal |

`open` is the seam that matters. dsh hands a plugin a `SubprocessHandle`, and
`ssh/src/channel-process.ts` is one — a `PassThrough` for each of stdin, stdout
and stderr over a channel, with the same collect-and-spill contract dsh's own
runner implements. So the harness's caller sees the object it already knows,
while the bytes never leave this process. `runner.ts`, the askpass helper and
`ssh-client.ts` are gone, and with them the `ctl/` sockets the data-root
migration had to step around.

### Host keys are dshell's own

`ssh/src/transport/known-hosts.ts` keeps a `known_hosts` under dshell's data
root in OpenSSH's hashed format (`|1|<salt>|<hmac>`), read and written by this
package alone. First contact is trust-on-first-use and says so; a later
disagreement is refused with both fingerprints rather than silently accepted.
`probeHostKey` asks a host for its key without authenticating, which is what
the device card's key-change flow reads.

A compatibility reading worth recording: a `known_hosts` written by the
PREVIOUS build was read back correctly by the new one (the container's entry
predates this commit and the test still reported 已信任), so an upgrade does
not re-learn every host.

### What is deliberately not covered

Written into `dshell-architecture.md` § 19 and both READMEs rather than left to
be discovered:

- **hardware keys** (`sk-*` / FIDO / PKCS#11) — the signature has to happen in
  a device or a daemon that holds it, and `ssh2` has neither.
- **`~/.ssh/config`** — `ProxyJump`, `ProxyCommand`, `Include`, `Match` and
  per-host options are not read. A device behind a bastion needs the bastion
  itself registered as the device.
- **agent forwarding** and `ssh-add` — the agent is the host's; dshell
  authenticates only with the credential the vault holds.
- **security cadence follows `ssh2`** — the CVE surface of the SSH
  implementation is now a dependency's release schedule rather than the
  operating system's. Pinned at exactly `1.17.0`.

The remote command line is unchanged on purpose: `LC_ALL=C` still prefixes every
remote command, a command's text still travels verbatim, and the settle marker
still rides an injected `PROMPT_COMMAND` printing OSC `133;D`.

### Acceptance

Container `dshell-metrics-run` (dsh `v0.2.1-rc.2`) with the local build injected,
against the real device:

| what | reading |
| --- | --- |
| connection test | `已连接 root@VM-0-6-ubuntu · 1096ms`, host key `SHA256:ptAAuu4t…（已信任）` |
| helper deploy | `present`, digest matches, 319 ms |
| device terminal | remote prompt `root@VM-0-6-ubuntu:~#`, OSC `133;D;0` + `3008;…exit=success` |
| Ctrl+C | `sleep 30` → `exitCode: 130` |
| file list / write / read back / search | `/root` listed; 32-byte local→remote copy `done`; `cat` on the device returns the bytes; `grep -rl` finds it |
| no host `ssh` | exactly one TCP connection to `:22`, owned by the harness process itself |

Plus a pre-flight outside the container: pure-JS `ssh2` (no native binding, which
is what the container ends up with) dials the device, passes the host-key
verifier and runs a command with exit code 0.

The suite is 50 files / 561 tests, and it is green on ten consecutive runs —
the tenth matters, because one of them exposed a real flake in
`transport.spec.ts`'s `channelOf`, which waited a fixed number of event-loop
turns for a channel that dialing reaches through real file I/O. It now waits for
the run to have subscribed to the channel's outcome, against a wall-clock
deadline. A gate that passes once is not a gate.

### Not yet done

No release, no tag: the 0.1.14 line stops at `0.1.14-alpha.3` on npm's `alpha`
dist-tag while `latest` stays `0.1.13`. Merging to main, releasing and tagging
are all still owed a decision.

> **This journal has a gap.** Phases 10.46 onward are recorded here, but the
> work between 10.45 (the 0.1.2 release) and this one — the credential vault,
> the device form moving to vault groups, the device metrics readout, the 0.1.14
> alpha line — is not written up as phases. Read
> [`dshell-handoff-2026-10.md`](./dshell-handoff-2026-10.md) for the live state
> and `git log` for the sequence.
