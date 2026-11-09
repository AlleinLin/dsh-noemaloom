# dshell Development Roadmap

This is the sequence dshell was built in, and the record of what each phase
decided. Every phase ends with an acceptance check: a reading, a measurement
or a runnable artifact that says the phase shipped. A phase without a reading
is a phase that did not ship.

## The suite as it stands

Twelve packages under `packages/dshell/`: `std`, `storage`, `bundle`,
`conversation`, `terminal-bridge`, `mode`, `commands`, `files`, `ssh`,
`buffer`, `usage`, `wsl`. All twelve say version `0.1.16`, which is also npm's
`latest`; the tag `dshell-v0.1.16` points at `b3d72f9`. The branch this
document was last written on (`feat/dshell-wsl-device`) is UNRELEASED — it sits ahead of
`origin/main` (`git rev-list --count origin/main..HEAD` is the number, and it moves with
every commit). What it carries is phases 10.49, 10.50 and 10.51, and each one's
"Not yet done" says what is owed.

## How to read it

- The **phase index** below carries one line per phase: what landed, and the
  one constraint worth remembering. Start there.
- The **detailed sections** cover Phase 10.31 onward — the recent rounds,
  where the decisions are still load-bearing and the acceptance readings are
  the evidence a reviewer asks for. Earlier phases are index-only on purpose:
  their detail is the git history's job now, and a phase that is still in
  force says so in its own line.
- **Phase numbers are stable.** Other documents cite them:
  [`dshell-packages.md`](./dshell-packages.md) names the phase that
  introduces each plugin, and [`dshell-design.md`](./dshell-design.md) cites
  the phases that settled a decision. A phase is never renumbered; a new phase
  is appended.

## The acceptance discipline

1. **A claim is not a reading.** "The panel sorts by CPU" is a claim; "the head
   sorted by `undefined` until the prop named `key` was renamed" is a
   reading.
2. **Prefer the byte over the word.** A published tarball's contents, a file's
   real mode, a registry's `dist` block, a measured contrast ratio — these
   are facts. "The build passed" is a fact about the build and about nothing
   else.
3. **Red-light the check.** A test that has never failed has never been
   tested. The phases below that say "shown to bite" or "proven by
   reverting" are the ones whose evidence can be trusted.
4. **Write down what is not true.** Every phase here ends with what was left
   open. A phase with no open item is a phase that was not looked at hard
   enough.

## Where the detail lives

| Document | What it holds |
|---|---|
| [`dshell-design.md`](./dshell-design.md) | the decisions the code must not contradict |
| [`dshell-architecture.md`](./dshell-architecture.md) | wire shapes, Cordis keys, package layout |
| [`dshell-packages.md`](./dshell-packages.md) | which plugin owns which feature |
| [`dshell-handoff-2026-10.md`](./dshell-handoff-2026-10.md) | the current handover: the live state, what is released, what is owed, and what is open |

## Phase index

| Phase | What landed | The constraint worth remembering |
|---|---|---|
| **0** — Repo scaffold | pnpm workspace beside `dsh/`, one placeholder package proving the build | `dsh/` is a read-only reference; everything dshell owns lives under `packages/dshell/` |
| **1** — Bundle and empty target | `dshell-bundle` patches the `web` profile; `dshell-conversation` registers a `terminal` view that renders nothing | a plugin that registers a slot proves the path, not the surface |
| **1.5** — Workspace removal | `dshell-workspace` stubs replace dsh's four stock workspace rows; the sidebar is one flat session list | the stock rows must be DISABLED, not shadowed — two providers of one service key is a cordis error |
| **1.6** — New-session dialog | name, start directory and agent preset are chosen at creation; the stock 新会话 button opens the same dialog | the preset roster comes from `ctx.remote.agentPresets.list()`; broken compositions are dropped, not shown |
| **2** — Main shell lifecycle | `dshell-terminal-bridge` owns one `main` PTY per agent; bytes land in a per-session log under `$DSH_HOME/dshell-pty/` | a fresh main shell seeds from the file's tail and never truncates it |
| **3** — WebSocket transport | `registerUpgrade` on `ctx.webServer`; the browser relays bytes to a console before anything renders | the `bind` frame carries the session id, and a bind with a wrong id is closed |
| **4** — Fused terminal surface | dshell borrows dsh's stock composer wholesale and contributes exactly two slots (the mode chip and the `chat` view) | shadowing `conversation.composer.bar` was abandoned — borrowing the composer keeps every stock feature |
| **4.x** — Shell-interaction mechanics | raw PTY push, a bridge-owned `clear`, focus follows mode, guarded socket handover | a polled diff of dsh's scrollback double-consumes the prompt line; raw push deletes the whole class of defect |
| **5** — ANSI canvas and the block view | the block view becomes the only conversation surface; shell regions are cut by task boundary | the block view occupies the stock `chat` cell — a sibling tab is reachable only through a stored view selection |
| **6** — Real commands | `/clear`, `/new`, `/compact` are real `ctx.commands` registrations | the in-terminal `clear` is the canvas's own; the slash command was retired in 10.6 |
| **7** — Terminal context management | an absolute cursor plus a command splitter; each step injects only what the model has not seen | the injection is host-side at the step, where the message source is durable |
| **8** — `dshell_get_main_terminal` | the agent learns the `main` PTY's id | one PTY has one foreground; superseded by 9.11 |
| **9** — Hardening | exit, browser disconnect and session disposal all close the shell cleanly | a browser reload must not kill the session's `main` shell |
| **9.5** — Session panel | archive (a dshell-owned durable tag) and purge over one `/api/dshell/sessions` route | a LOADED session cannot be deleted immediately — dsh discards the only teardown capability it has |
| **9.6** — SSH device sessions | a durable device registry, per-device secrets, a session-to-device binding and the mount directory | the device's tree is a LOCAL EMPTY mount directory; the harness reads that directory locally for everything |
| **9.7** — Connection failures | the connection is proved before the session exists; the host classifies the death; reconnection is bounded at three attempts | `bound` is read from the SESSION, not from the wire — a live shell being re-attached is not a death |
| **9.8** — Cross-session pipe | only the USER can create a link; `delegate` returns a ticket id and the requester's turn ends | a turn cannot be suspended and resumed, so the answer reopens the turn as a new message |
| **9.9** — Unbounded file navigator | the file pane walks to `/`, and on a device session it walks the DEVICE's tree | dsh's own `workspaceFiles` is fenced to the workspace root; dshell's own route is not |
| **9.10** — Two-pane file transfer | files are dragged between this machine and the device; a copy is a job with progress and cancel | this machine is the explicit ABSENCE of an initiator; a request that inherited a session would read the device behind the local pane's back |
| **9.11** — The agent's own terminal | two shells per session: the user's `main` and the agent's lazily spawned `agent` shell | the agent's shell forks the USER's directory, read from the user's own prompt line (best effort) |
| **10** — Packaging | every `dshell-*` package carries a `dsh.bundle` row, and a combined suite bundle lists them; the suite is TWELVE packages today | a clean dsh install with only the suite added must load dshell with no manual config |
| **10.1** — Desktop transport | the frame protocol also rides `ctx.connection.fetch` (an NDJSON GET and a POST send) | the subscriber is a CARRIER, not a socket: the ws and the Response body share one interface |
| **10.2** — Publishable packages | manifests rewritten for publication; `scripts/local-registry.mjs` serves packed tarballs | `files: ["lib"]` — the old list shipped only the two entry bundles and omitted every host module the entry imports |
| **10.3** — Linux packaging | `scripts/package-linux.mjs` widens the two closed target registries and runs upstream's stages in upstream's order | the hook must NOT travel in `NODE_OPTIONS`; pnpm 11 re-executes itself and fails at the first nesting |
| **10.4** — Following dsh to 0.1.5-rc.2 | the checkout moves to the rc.2 TAG; 190 pins move rc.1 to rc.2 | the target is the tag, not master — between them the desktop pipeline renames the seed paths and would invalidate the script |
| **10.5** — A storage engine for shell history | a std-tier contract, a `dshell-storage` SQLite engine, and the bridge's `CommandHistory` facade | `LIKE 'x%'` with a bound parameter NEVER uses the prefix index; the range form is the index seek |
| **10.6** — Retiring `/clear` | the `/clear` registration and the clear-only bridge paths are deleted | the slash command's only distinct effect was dropping persisted scrollback, which the terminal no longer needs |
| **10.7** — History retrieval goes to the index | the route asks the store, the rule is a strict prefix, and the query is a newest-first scan | under a strict prefix there is nothing to rank, so recency is the only meaningful order |
| **10.8** — History maintenance | the scan budget is DERIVED, layout 2 drops an index nothing read, and deletion reaches cold sessions | a covering index is 2.4 to 3 times faster but costs +31% disk on a deliberately unbounded store — deferred, not rejected |
| **10.9** — Per-command output | a `command_output` table; `dshell_terminal_output` slices by `(cursor, seq, offset, limit)` | the cursor pins the shell GENERATION — after a respawn the same `seq` names a different command |
| **10.10** — SSH credentials and host trust | `IdentitiesOnly=yes` for key devices, a per-device `ControlPath`, dshell's own `known_hosts`, owner-only transcripts | the control path must FIT: `%C` leaves too little of the socket path, and an over-long path fails the connection outright |
| **10.11** — Scheduled removal | a `待删除` group of its own; a deleted session leaves the pipe graph | two facts from two owners: the archive set is the registry's, the pending qualifier is dshell's |
| **10.12** — Tab completion folds capitals | ASCII A to Z fold on the READER's side; ambiguity is listed, never guessed | only the segment being completed is folded — the completion's span-only protocol cannot rewrite earlier text |
| **10.13** — The command hint | the tail of a recent command is ghosted after the caret, and the right arrow takes it one word per press | the ghost is a span in the composer's floating overlay, not a node inside the editor |
| **10.14** — The shell assists get switches | one switch per gesture (Tab, the history list, the hint), in the dshell settings document | "off" means the BROWSER's behaviour per key — there is no substitute binding |
| **10.15** — The chunked relay names its scratch | the scratch directory is spelled as the world's own process path | the shell and `ctx.fs` must name ONE directory, or the chunks land where the reader is not looking |
| **10.16** — The pipe's buffer browser | the pipe detail page draws its buffer the way the file navigator draws files | a dshell client package that draws dsh's icon set must DECLARE the dependency |
| **10.17** — dshell follows dsh's language | per-package locale namespaces, `zh` as the key-set source of truth, `en` checked by the compiler | a module-scope label table cannot be localized in place — it is built before any `t` exists |
| **10.18** — The host half follows the language | `ctx.dshellHostCopy` and `POST /api/dshell/locale`; every browser face reports the locale it resolved | the provider's home is decided by the ACTIVATION GRAPH: cordis has no optional inject, so the direction must be acyclic |
| **10.19** — A mapped directory's subpaths resolve | one `splitBufferPath`, with the area-relative invariant written down as its contract | `rest` must not keep the separator it just cut on — an absolute path is refused by design |
| **10.20** — An interjection stays in its turn | the fold reconstructs steering the way dsh's own client does, and the row is marked 插话 | a durable `user/message` is not necessarily the start of a task |
| **10.21** — Tab completes commands | the first word completes from the session's own world's `PATH` plus the shell's builtins | the client asks rather than deciding which source answers — only its silence rule is source-aware |
| **10.22** — Tab reads the line before it answers | one scanner (`std/src/shell-line.ts`) reports the position of the word under the caret | a descriptor duplication is not a redirection, and a dash word is a flag only after the command is named |
| **10.23** — The session's own shell answers the rest | flags and subcommands come from bash-completion, asked in the session's own world | the line is DATA: it rides the argv quoted once, and the probe script contains no quote character at all |
| **10.24** — A shell region is as tall as its screen | `ESC[2J` resets the region walk, so a respawn banner is not height | `ESC[3J` (scrollback alone) deliberately does not reset the walk |
| **10.25** — A device Tab answers from memory | readings are cached for seconds, the browser warms 250 ms before the key lands, and a settled command warms too | the keystroke stops being where the work happens — a device call is 0.39 s of harness overhead |
| **10.26** — dshell's own data directory | a picker for the harness home that owns `dshell/` and `dshell-pty/`, settled at the NEXT start | a cross-package fact that must exist before an apply needs a SERVICE EDGE, not a coincidence |
| **10.27** — Entering a device session warms its directory | the client reads the shell's own OSC 3008 `cwd` report and arms a second warm | the path is in the SHELL's namespace — a device's own path, not the mount's |
| **10.28** — dshell's own icon | three SVGs and seven PNGs; electron-builder takes the directory's file NAMES as the sizes | a PNG saved at the wrong size ships a blurred icon and reports nothing at all |
| **10.29** — A package you can install | `.deb` joins `AppImage`; `withLinuxDesktop` adds the maintainer and the project URL | electron-builder has NO `homepage` field — the URL has to go in through `extraMetadata.homepage` |
| **10.30** — dshell inside the installed desktop app | the desktop profile resolves dshell from a REGISTRY; `link:` dependencies are refused at boot | the desktop seed omits five upstream packages dshell names, and they ship packed by our own build |
| **10.31** — a palette that knows which surface it is on | each palette becomes a light and a dark skin, and the ANSI slots belong to the surface | the guard is measured contrast, not eyeballed — every slot of a light skin must clear 4.5:1 |
| **10.32** — the 0.1.1 release | eleven packages published in dependency order | judge a publish by the `dist` block and the tarball, not by a single read a minute later |
| **10.33** — moving onto dsh 0.1.6 | the upgrade gets a plan before any code moves; A1 widens 211 pins to a two-host range | the type surface barely moved — the work is in behavior and packaging |
| **10.34** — T1: the assumptions become assertions | three spec files pin what the repo believes about dsh | a renamed upstream row is a no-op dshell's layer cannot see, and startup is best-effort there |
| **10.35** — A2: move the host to 0.1.6-alpha.1 | `dsh/` checks out at the alpha.1 tag and the install uses its own pnpm | the workspace's pnpm 9 refuses the lockfile pnpm 11 wrote |
| **10.36** — A3: behavioral startup | the boot log is read for row-activation warnings, because 0.1.6 startup is best-effort | "it did not boot" is no longer a smoke test — the rows need an explicit liveness assertion |
| **10.37** — A4.1 is falsified | `ctx.ssh` is ONE connection, so dshell's per-device transport is the design of record | two providers of one capability in a context is an error, not a layering |
| **10.38** — the three client breaks | the guide-entry `id`, the `unarchiveSession` and the `CommandClaim.name` breaks are fixed | "`pnpm typecheck` is green" must not be the compile gate — `tsc -b` trusts a gitignored tsbuildinfo |
| **10.39** — the device seam moves to RPC | dshell writes its OWN helper and borrows upstream's `SshRpcPeer` framing | upstream's helper cannot be extended, is heavy to deploy, and refuses half our devices |
| **10.40** — M0: the helper spine | the protocol, the device helper, the connection and the one-file build | one zod, or nothing compiles — the schemas must be the SAME zod dsh-ssh resolves |
| **10.41** — M1: exec through the subprocess seam | a device session's processes leave through `ctx.subprocess.spawn` | the connection must bypass the seam being wrapped, or it recurses |
| **10.42** — M2: the filesystem seam moves to RPC | six `fs.*` ops with typed errors; the shell lane stays as the no-Node tier | the list order is the SEAM's, not the device's |
| **10.43** — the archive set becomes upstream's | dsh's archive set and settings page own archiving; dshell keeps the store | two providers of one service key is a cordis error, and it surfaces only as a failed fiber |
| **10.44** — host capabilities belong to local sessions | browser and desktop capabilities mount only for LOCAL sessions | a scope cannot mask its own registrations — not mounting is the only way to say no |
| **10.45** — the 0.1.2 release | twelve packages at `0.1.2`, published in dependency order | the desktop profile still pins exact `0.1.0` — moving it is a `.deb` rebuild, not an npm step |
| **10.46** — the transport is a library, not the host's ssh | an in-process `ssh2` client with three doors and dshell's own `known_hosts` | a rotated key must not keep serving from a connection authenticated with the old one |
| **10.47** — the device panel | processes, containers and ports in the right sidebar; released in 0.1.15 | the list is a tool: filter, sort by any column, and follow a port to its process |
| **10.48** — the host-version window | one range in `dsh-upstream.json`, written out by a script; released in 0.1.16 | npm resolves peers WITHOUT `includePrerelease` and dsh WITH it — both sides must accept the same set |
| **10.49** — the 管理台 | one settings section for the whole suite, with a child seat each package contributes into | every edge to dshell-ssh is a RUNTIME seat, never a build-time import |
| **10.50** — WSL2 as a built-in device | a WSL2 distribution is a derived device row with its own transport, behind a provider registry | the exec door carried both directions on one stream and dropped its stdout — fixed by giving the command a real duplex, and re-measured |
| **10.51** — port forwards | a TCP tunnel from the reader's machine to a device's port, in the panel and in the model's hands | the two directions are moved by hand, not by `pipe` — `pipe` ends the destination when the source ends |
| **10.52** — dsh 0.2.2-rc.1 support | the peer window widens to `<0.2.3-0`; the surface is read by a checkout-agnostic spec | the pin still says 0.2.1-rc.3, so the release gate guards 0.2.1's names — the reading is done, the pin move is not |

---
## Phase 10.31 — a palette that knows which surface it is on

Reported from the desktop app: "当前在浅色模式下并不正常". dshell's four palettes
were dark-only — `text: #e8e8ec` on a palette whose `bg` is deliberately
`transparent`, so on dsh's light surface (white) the block view's shell output
was there and unreadable. The sidebar and the agent's prose were fine, because
those read dsh's own `--dsw-*` tokens; it was the terminal's own palette that
had only ever been drawn on black.

The fix splits dshell's colours by what they answer:

- **`palettes.ts`** (new, DOM-free) holds each palette as two skins — `light`
  and `dark` — instead of one flat set. `getTheme(id, mode)` resolves the pair,
  so every existing consumer keeps reading `theme.text` and friends and simply
  gets the right answer for the surface.
- **`theme.ts`** gains a second store for the mode, read from
  `<body data-ds-dark-theme>` — the attribute dsh's inline boot script writes
  and its ThemePresenter toggles — and watched with a MutationObserver, since
  nothing emits an event for it. The mode is never persisted: it is dsh's
  setting, not dshell's.
- **The ANSI vocabulary belongs to the surface, not to the palette.** xterm's
  defaults are the Tango set, and every one of them is an ink for a dark
  ground. Correcting the foreground alone therefore left `ls` painting
  filenames near-white on white: the same bug, one layer down. Each skin now
  carries its own sixteen slots and `xtermTheme()` hands them to the renderer.
  The dark set is Tango verbatim — written out rather than inherited, so no
  dshell release repaints the output a dshell-less dsh would show — while the
  light set keeps Tango's hues and holds them dark enough that every slot
  clears 4.5:1 on the page.
- The semantic inks are shared by mode rather than rebuilt per palette:
  `danger`, `dangerFaint`, `warn`, and the faint fill a hover or a current
  row is drawn with. A red is a red whichever scheme is picked, so a palette's
  identity stays in its greys, borders and accent.
- `getTheme` resolves through a cache, so one (palette, mode) pair is one object
  for the life of the page. The block view rebuilds a shell region's terminal
  when its theme changes, so a fresh object per call tore down and reopened
  every visible terminal on every render.
- The literals dshell-owned surfaces still carried went to one of those two
  systems: the 数据目录 picker's panel, borders and buttons read dsh's tokens
  now; and the `#f87171` reds in the status card, the connection notices and
  the bookmark rail became `theme.danger`.

**The guard is contrast, measured, not eyeballed.** `tests/palettes.spec.ts`
(45 specs) computes WCAG relative luminance and asserts, for every palette and
both modes, body text >= 4.5 against the exact surface dsh paints (`#ffffff`
light, `#151517` dark), accent-coloured text >= 4.5, the accent indicator >= 3,
`muted` >= 3.5, and text >= 4.5 on the palette's own `menuBg`. It also
asserts the palette ids equal the settings schema's, so a selectable id cannot
resolve to nothing. Proven to bite: putting the old `#e8e8ec` back as
midnight's light ink fails three assertions. The ANSI half is measured the
same way: every slot of a light skin must clear 4.5:1 on the white page, each
dark skin's set must equal xterm's own table verbatim, and no light skin may
leave a slot at its dark value — a slot left alone passes a per-palette
comparison while still being unreadable.

**Acceptance readings.** In a browser on the dev harness: before, the session's
shell block was near-invisible; after, `root@VM-0-6-ubuntu:~# Shared
connection …` and the command line read as normal dark text on white. Toggling
`data-ds-dark-theme` moved all 182 palette-styled elements from the light
values to the dark ones and back with no reload. The ANSI half was read from
the ink of every span the terminals had drawn: 29 spans, three distinct inks,
the worst of them 6.48:1 against the white page (`#1b1c22` for ordinary text
at 16.99:1, `#2a5d9e` for the `ls` directories at 6.65:1, `#c00000` for the
`docker ps` digest at 6.48:1).

**Not covered.** The four palettes' dark skins are unchanged, including the two
`muted` values below 4.5; the dark ANSI set stays Tango's, including the slots
that are invisible against a near-black ground — a program that asks for the
ground's own tone gets exactly that; and `session-rows.ts` still exports the
ANSI-to-CSS maps (`SESSION_ROW_COLOR`, `GUTTER_COLOR`) left over from the
canvas renderer the block view replaced.

## Phase 10.32 — the 0.1.1 release

`0.1.0` was published 2026-09-15T18:32Z. Six PRs landed after it (#22–#27) and
none of them reached npm: the data-directory feature, the settings refactor,
the directory-warm-up fix, the icon, the `.deb` target — and the light-mode
palette, which is the one that made the gap visible. Between them they touched
`std`, `mode`, `ssh`, `buffer`, `terminal-bridge` and `workspace`, so a
consumer installing from the registry got a dshell that predates all of it.
That mattered in one concrete place: the desktop app's plugin window installs
from `registry.npmjs.org`, so its view of dshell was six PRs stale.

All eleven packages moved to **`0.1.1`** and were published in dependency order
(`std` → `conversation` → `storage` → `ssh` → `buffer` →
`terminal-bridge` → `files` → `commands` → `mode` → `workspace` →
`bundle`) with the bypass-2FA granular token, after `pnpm install` →
`build` → `typecheck` → `test` (147 specs) came back green. The bundle's
`workspace:^` edges rewrote to `^0.1.1`.

**The publish is verified by the bytes, not by the CLI's word.** The
`dshell-mode` tarball fetched back from the registry carries the light skin
(`#1b1c22`), the light ANSI inks (`#5c6470`, `#2a5d9e`), the semantic red
(`#b42318`), the mode watcher (`data-ds-dark-theme`) and the data-directory
route (`DSHELL_DIRS_PATH`) — i.e. today's source, not yesterday's.

**The read side lagged again, and this time per package.** For several minutes
after the publishes returned `+ @nexus-aethra/dshell-<name>@0.1.1`, the
packuments for seven of the eleven still listed only `0.1.0`, and their
`0.1.1` tarballs answered `{"error":"Not found"}`. The tell that this is
replication and not a failed publish is the `dist` block the registry writes on
acceptance: each of the seven already carried its `shasum`, `integrity`,
`fileCount`, `unpackedSize` and two signatures, exactly as the working four
did. Judge a publish by `dist` metadata and the tarball, not by a single read
a minute later.

**Still open.** The desktop profile pins the eleven packages at exact
`0.1.0`, so a fresh install from npm still resolves yesterday's code until
that pin moves to `0.1.1`; the installed app currently carries this week's
code through an in-place refresh of `dshell-mode`'s tarball into the profile.
The token used here was pasted into a chat transcript when it was created and
should be rotated.

## Phase 10.33 — moving onto dsh 0.1.6 (roadmaps first)

Upstream published `dsh-v0.1.6-alpha.1` (`0a15e36e`, 2026-09-15) — the first
tag since the `0.1.5-rc.2` this repo pins 211 times. It adds eighteen packages
(ssh + `fs-ssh`, a terminal controller with a client half, browser-use and
computer-use provider registries, a PTC runtime, MCP resources, image offload,
auto review, an archive settings page) and deletes two.

The tag is fetched into `dsh/` and **not** checked out: the repo still builds
against `0.1.5-rc.2`. Before any code moves, the migration gets a plan. It was written in a
separate one-migration document, now removed; what it held is this: an
adaptation roadmap (A1 two hosts in one manifest set, A2 the host move, A3
behavioral adaptation, A4 the ssh and client-terminal migrations, A5 desktop and
release, A6 the deferred capabilities) and a testing roadmap (T1 assumptions as
assertions, T2 compile-time host contract, T3 route integration, T4 the
acceptance checklist scripted, T5 the zero-coverage packages). A1 and A2 land
below as phases 10.33 and 10.35, and T1 as 10.34.

Two findings from the measurement phase set the shape of that plan, and both are
worth more than the plan itself:

- **The desktop profile gained a manifest validator it never had**
  (`apps/desktop/src/profile-packages.ts`, absent at rc.2). It refuses a
  first-party package declared in `dependencies` — which `mode` and `ssh` do
  for `@deepseek-ai/schemastery` — and it range-checks every peer against the
  runtime's version, where `^0.1.5-rc.2` does *not* satisfy
  `0.1.6-alpha.1` (node-semver and prereleases). The fix is therefore a
  manifest *restructure* plus a two-host range, not a version-string replace:
  that is A1, and it lands while the host is still rc.2 so `main` never stops
  being publishable.
- **The type surface barely moved.** Checking every named symbol dshell imports
  from 25 first-party packages against the published `0.1.6-alpha.1` types
  found zero regressions. The work is in behavior and packaging, which is why
  the testing half of the document exists.

**A1 landed** (2026-09-17, host still at rc.2): 211 pins across nine manifests
widened to `0.1.5-rc.2 || 0.1.6-alpha.1`, and `@deepseek-ai/schemastery` moved
out of `dependencies` into a peer in `mode` and `ssh`. The gate was
install/typecheck/build green, 9 spec files and 147 tests passing, a `pnpm pack`
of `dshell-mode` showing the union, `package:linux --from=builder` still
producing the `.deb`, and the web harness booting on rc.2 with all seven
dshell client faces advertised.

## Phase 10.34 — T1: the assumptions become assertions

The upgrade's real exposure was never the code — it was the things the repo
believed about dsh and checked nowhere: 211 pins, 46 `link:` overrides, a bundle
patch naming eight stock row ids, a client module table, and an install recipe
whose package list could fall behind the workspace silently. Three spec files,
25 cases, and every one of them was shown to bite by breaking what it watches:

- **`bundle/tests/host-rows.spec.ts`** reads the two `web`-profile bundle
  patches out of `dsh/` and asserts that the eight ids dshell disables still
  exist, that its ten inserts collide with nothing, and that the profile still
  composes those two bundles at all. Renaming a targeted id (`ui-jobs` →
  `ui-jobs-renamed`) fails the case with that id in the message — on 0.1.6 a
  renamed row is a no-op dshell's layer cannot see, and startup is
  best-effort there, so nothing else would have said a word.
- **`scripts/tests/manifest-contract.spec.ts`** holds the workspace's agreement
  with the checkout: peers and devDependencies carry the same names and ranges,
  every declared name resolves through a root override whose target manifest
  answers to that name, every `dsh-*` range satisfies `dsh/package.json`'s
  version, no `@deepseek-ai/*` name is ever a dependency, `neverBundle` is a
  subset of dsh's `PLATFORM_MODULES`, and the install recipe names every
  package.
- **`terminal-bridge/tests/commands.spec.ts`** is the old
  `scripts/check-commands.ts` moved into the suite — same 13 assertions over the
  command splitter and the two truncation caps, now with a runner that fails a
  build.

One finding came from the new checks rather than from review: `buffer`'s client
bundle requires `@deepseek-ai/dsh-client-ui-primitives` from the module table,
while its manifest declared that package in `devDependencies` only. Nothing had
noticed, because the install recipe places it by hand for every profile.

Suite: 12 files, 172 cases, up from 9 and 147.

## Phase 10.35 — A2: move the host to 0.1.6-alpha.1

`dsh/` is checked out at `dsh-v0.1.6-alpha.1` (`0a15e36e`). The install step
must use the pnpm 11.7.0 that ships inside the checkout; on this workspace the
root `packageManager` is pnpm 9, and `npx pnpm@11.7.0` resolves that root
value and then refuses the lockfile with
`ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`. The working form is:

```sh
git -C dsh checkout dsh-v0.1.6-alpha.1
node dsh/node_modules/.pnpm/pnpm@11.7.0/node_modules/pnpm/bin/pnpm.cjs install
```

Run from `dsh/` so the workspace file there is what controls resolution.

The one infrastructure break the move surfaced: `node-pty`'s pnpm store path
grew a `_patch_hash=` suffix in the 0.1.6 lockfile. The old override pointed at
a directory that no longer exists, and
`packages/dshell/terminal-bridge/node_modules/node-pty` was a dangling symlink.
Both were re-pointed at the new store directory, and what is on disk now is the
patch-hash path in both places.

**Correction (Phase 10.38).** `pnpm build` was **not** green at this point, and
the "the three compile-time breaks did not bite" paragraph is wrong about one of
them. Only `typecheck` and `test` were green. See Phase 10.38.

## Phase 10.36 — A3: behavioral best-effort startup and row-liveness

0.1.6 makes startup best-effort: optional rows that fail to activate only
produce a warning, and the harness keeps running. That removes the implicit
smoke test "it did not boot", so we need an explicit "our rows are live"
assertion.

Evidence collected on the 0.1.6 harness:

- The boot log contains **zero** row-activation warnings — no `did not
  activate`, no `inactive` entries, no `required startup failure`.
- `/api/dshell/sessions` answers with the dshell workspace shape
  (`{"archived":[...],"pendingPurge":[]}`), which proves the
  `dshell-workspace` row is mounted and its route is processing requests.
- The boot payload names all seven dshell client faces (`buffer`,
  `conversation`, `files`, `mode`, `ssh`, `terminal-bridge`,
  `workspace`).
- The bundle-patch row ids were already locked by T1, and they still hold on
  0.1.6.

The remaining A3 items — `localDisplayPath`, the `FS_NOT_FOUND` traversal case
in the SSH file routing, the `agent/created` signature, and the message
projection obligation — are recorded in the upgrade doc as behavioral facts to
observe when the harness is running under a browser.

## Phase 10.37 — A4.1 is falsified: `ctx.ssh` is one connection, not a device

A4.1 planned to let `ctx.ssh` + `SshFileSystem` carry remote fs, exec and
sandbox *for a bound device*, demoting the mount directory and the per-tool
seams to a compatibility path. Reading the 0.1.6 host before writing the code
showed that shape cannot exist there, so nothing was migrated and the SSH layer
stays as it is. This phase is the record of that, so the next person does not
spend the attempt again.

The falsifying facts, each read directly at `dsh-v0.1.6-alpha.1`:

- `ctx.ssh` is **one** connection. `Config.host` is a scalar OpenSSH alias,
  the service is a single `SshConnection` named `ssh`, and
  `request(method, params, result, signal, wait)` takes no host.
- Its consumers each claim a capability service **once per context**, so the ssh
  family swaps the whole process world rather than scoping to a session:
  `SshFileSystem` → `ctx.fs`, `SshSubprocessRuntime` → `ctx.subprocess`,
  `SshSandboxProvider` → `ctx.sandbox`.
- Two providers of one capability in one context is an error, not a layering:
  "a host composes exactly one provider of `ctx.shell`". The duplicate throws
  at cordis's service registration.

**Decision.** dshell's per-device transport is the design of record, not a
compatibility path. It drives the system `ssh` through `ctx.subprocess` and
needs no 0.1.6-only service, which is also what keeps the dual-host peer ranges
honest. No code changed: the only artifacts from the attempt were two dependency
additions, and they were reverted with the lockfile.

**What is still worth taking, unscheduled.** Upstream's real asset here is the
helper *protocol* — `@deepseek-ai/dsh-ssh/protocol` (`SshRpcPeer`,
`RemoteOperationError`) and `@deepseek-ai/dsh-ssh/schemas` with the remote
helper. A per-device client speaking it would replace "spawn `ssh` per command
against a mount directory" with one multiplexed, hash-verified helper session
per device.

**A4.2 stands, narrowed.** `ctx.webTerminals` is a client service that is
genuinely keyed by session, but it models a **sidebar** terminal, while
dshell's is the agent's own PTY with a claim hook. Reuse is the recovery/attach
and shell-discovery semantics, not tab ownership.

## Phase 10.38 — the three client breaks A2's acceptance missed

Phase 10.35 recorded all four gates green. At its merge commit they were not:
`pnpm typecheck` and `pnpm test` were green, and `pnpm build` failed on
three client implementations that no longer satisfied their upstream interface.

| Site | Break | Fix |
|---|---|---|
| `packages/dshell/workspace/src/client/index.ts` | `IWorkspaces` and `UiWorkspace` gained a required `unarchiveSession` (TS2420, both stand-ins) | both delegate to `SessionPanelClient.unarchive`, which already existed and whose route this package serves |
| `packages/dshell/files/src/client/definition.ts` | `SidebarRightGuideEntry` gained a required `id` (TS2741) | `id: 'files'`. 10.35 predicted this break "would not bite because the type lives in `ui-sidebar-right`"; that confused where the *type* lives with where a *value* is registered — dshell registers one guide entry |
| `packages/dshell/mode/src/client/index.ts` | `CommandClaim` gained a required `name` (TS2741) | `name: next`, the canonical mode name |

**Why this escaped, and the gate consequence.** At the merge commit
`pnpm typecheck` was green while `pnpm build` was red on all three rows.
`typecheck` is `tsc -b` over the two tsconfigs, which trusts per-project
`*.tsbuildinfo`; `build` is `tsc -p` per package, which does not.
`.tsbuildinfo` is gitignored, so its freshness belongs to one working copy and
not to the commit. What is recorded is that the two gates disagreed on a merge
commit's content, and that only `build` was telling the truth.

Consequence for the T roadmap: "`pnpm typecheck` is green" must not be used as
the compile gate on its own. Either the gate becomes `pnpm build`, or the check
is `tsc -b … --force`.

A second, related lesson: the upstream interface change surfaced only because
the implementation *declares* `implements IWorkspaces`. A dshell class that
consumed the service without declaring the interface would have compiled cleanly
and failed at runtime.

**Acceptance:** `pnpm typecheck`, `pnpm build` (all 11 packages) and
`pnpm test` (12 files, 172 cases) all green at once.

## Phase 10.39 — the device seam moves to RPC (design + spike)

Assembling remote commands as shell text is not a durable way to run a session on
a device. Every structured operation has to be *encoded* as a string and then
parsed back: `find -printf '%f\0'` with backslash-zero characters so the
remote shell does not turn them into real NULs, `LC_ALL=C` around
`stat`/`find`, and a nesting depth of quoting that exists only to smuggle a
directory into an argv element. Each of those is a correctness and an injection
surface at the same time.

### The decision

**dshell writes its own helper; upstream's `SshRpcPeer` framing and op
vocabulary are the contract.** Not their helper. Three reasons, each checkable:

1. **Their helper cannot be extended.** The dispatch ends in a hard
   `throw new Error('Unknown SSH helper operation: …')`, so "extend their RPC"
   cannot mean adding methods to it, and `dsh/` is read-only for us.
2. **Their helper is heavy to deploy.** `lib/helper.js` still imports cordis,
   `dsh-fs`, `dsh-fs-sandbox`, `dsh-sandbox-local`, `dsh-sandbox-policy`,
   `dsh-session-projection`, `dsh-subprocess`, `dsh-subprocess-local` and
   `zod`; `dsh-subprocess-local` additionally needs node-pty's native prebuilt
   `spawn-helper`. Their README says it plainly: "Install the built helper and
   its matching runtime dependencies on the remote host."
3. **Their connection refuses half our devices.** `SshConnection.start()` pins
   `BatchMode=yes` and `StrictHostKeyChecking=yes` and manages no
   `known_hosts`. Our registry has `auth: "password"` devices, and password
   login is exactly what `BatchMode` disables.

### Spike results (2026-09-17, rig `127.0.0.1:2222`, remote node v24.21.0)

A helper of ours, importing their framing class, plus a client of ours:

```
hello in 144ms -> {"protocol":1,"platform":"linux","node":"…v24.21.0/bin/node","root":"/home/reader"}
dshell.ping -> {"pong":"DSHELL","at":…}                    ← our own op, same connection
dshell.list -> {"entries":[{"name":"…","size":89,"dir":false},…]}   ← structured, not parsed text
unknown method -> Unknown SSH helper operation: dshell.nope
```

- the handshake costs 144–186 ms **including** the ssh connection setup;
- `SshRpcPeer` works on both ends, so nothing binds us to their helper artifact;
- our own method names coexist with their vocabulary on one connection;
- the identical run against a `tsdown` bundle: **one file, 139,283 bytes**,
  whose only remaining imports are `node:crypto`, `node:events`,
  `node:fs/promises`, `node:path`. Deployment for the fs/exec op set is
  therefore "one file plus node".

### Target shape

- One long-lived `ssh -T -M` child per device. **We already multiplex**:
  `runner.ts` sets `ControlMaster=auto`, a per-device `ControlPath` and
  `ControlPersist=120s`. The transport does not change; what changes is that
  the connection carries a process instead of one exec per command.
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

### Security: what this does and does not buy

It does **not** make the device trusted, and the honest accounting matters because
the motivation for this phase is partly risk:

- **Gained:** the entire quoting/injection class disappears. Arguments are JSON,
  never a shell string, so there is no nested-quote depth to get wrong and no
  `NUL` smuggling.
- **Taken on:** a persistent Node process on the device that can perform
  filesystem and process operations as the device user — a longer-lived surface
  than short-lived execs, and one whose integrity now depends on a deployed
  artifact.

So the net effect is a smaller *error* surface with a different *trust* surface.

### Provisioning: probe, then deploy

Requiring the user to prepare the machine by hand is what makes upstream's ssh
family unusable for dshell's "add a device in a dialog" flow, so provisioning has
to be dshell's job. The probe rides the dialog's existing **Test** action, which
today answers reachability, identity and the trusted fingerprint; it grows two
more questions, and the install action is offered from its answer.

**Verify by bytes, not by a version number.** The helper already self-reports:
`hello` answers with `hash: sha256(readFileSync(entryPath))`. Compare that
against the hash of the helper this dshell build ships. A version *string* would
accept a rebuilt-but-mislabelled artifact; a hash cannot.

**Transmit; never compile on the device.** The helper is a build output of
dshell's own build — the 139,283-byte single file measured above — so runtime
work is only "put bytes there". Compiling on the device would need a toolchain
and network access on someone else's server, would make the deployed artifact
non-reproducible, and would turn a user's machine into a package-fetch target.

**The bootstrap needs nothing but `ssh`.** One exec with the bytes on stdin
(base64), plus `mkdir -p` and `chmod`. On-device verification deliberately does
*not* need `sha256sum`: the helper hashes itself during `hello` and a mismatch
refuses the connection.

**Content-addressed path:** `~/.dshell/helper/helper-<sha256>.js`, a 0600 file
in a 0700 directory, outside the session workspace.

**No attach to a live helper — rejected deliberately.** Detecting an *active*
helper and reusing it sounds free, but it is a daemon model: it needs a
rendezvous (socket path plus authentication, because the helper holds
unrestricted filesystem and process powers) and a reap story for a process that
outlives its client, and it buys back roughly 150 ms. Helper lifetime stays
bound to the connection.

**Node is the one thing we cannot provision.** A device without Node therefore
keeps the assembled-command path — which changes that path's role from
"rollback" to **the no-Node compatibility tier**, a better reason to keep it
alive than a rollback that is expected to expire.

### Development plan (M0–M4)

Agreed 2026-09-17. Migration first, provisioning last, so every milestone before
M4 is developed against a helper deployed to the rig by hand.

| Milestone | Delivers | Ends when |
|---|---|---|
| **M0** | The spine: helper protocol, device helper, connection manager, build and dependency wiring. No behaviour change. | Handshake + echo round trip on the rig (done — see 10.40). |
| **M1** | `exec` through the `ctx.subprocess.spawn` seam: the router stops rewriting commands, and a bound session's spawns return a helper-backed handle. | On the rig: `bash` (relative workdir, exit code, stderr, an over-limit output that spills), `grep`/`glob`, and the red-light case (kill the helper mid-exec → reported as unconfirmed, never silently retried). |
| **M2** | `fs.*` ops: `resolve`/`stat`/`lstat`/`list`/`next`/`read`/`write`/`edit`/`remove`/`rename`/`mkdir`/`publish`, with typed errors. | On the rig: relative read/write; a permission and a not-found case arriving as typed errors; the `find -printf '%f\0'` path gone. |
| **M3** | Transfers and the buffer relay move onto `fs.*`, and the three duplicate `quote` helpers disappear with their last callers. | On the rig: a large file copied both ways, a cross-session buffer copy, and a checksum mismatch handled. |
| **M4** | Provisioning: the Test action probes for Node and the helper, an install action bootstraps it, and a digest mismatch redeploys. | The provisioning acceptance above. |

Three constraints shape every milestone:

1. **The connection must bypass the seam being wrapped.** A bound session's
   subprocesses are routed by wrapping `ctx.subprocess.spawn`, so the connection
   that serves them is spawned with `node:child_process` directly. Creating it
   through `ctx.subprocess` would recurse.
2. **The fallback is also the no-Node tier.** A device without a verified helper
   keeps the current assembled-command path.
3. **`pnpm typecheck`, `pnpm build` and `pnpm test` stay green at every
   milestone**, and the fallback stays reachable.

## Phase 10.40 — M0: the helper spine

The scaffold for everything above: dshell's own device helper, the connection
that owns it, the wire contract between them, and the build and dependency
wiring that turn the helper into one deployable file. No behaviour changes.

### What landed

- `ssh/src/helper/protocol.ts` — the operation set and its schemas. Names mirror
  dsh-ssh's where the semantics match; everything else is `dshell.*`. The
  revision is deliberately independent of `SSH_PROTOCOL_VERSION`: the framing is
  theirs, the operations are ours.
- `ssh/src/helper/run.ts` — the device-side behaviour, over explicit streams so
  it can be driven without spawning. Owns the handshake, the lease, and the
  deliberate refusal of unknown operations.
- `ssh/src/helper-entry.ts` — the launch shape: its own path (which the
  handshake hashes), the signals that mean the connection is over, no arguments
  accepted.
- `ssh/src/connection.ts` — one ssh child, one helper, one `SshRpcPeer`;
  handshake, digest check, lease heartbeat, disposal, and a pool keyed by device
  and target.
- `runner.ts` — `trustOptions` and `keepaliveOptions` extracted so
  `helperArgv` reuses the *same* trust and authentication options as the
  per-command invocations. A device whose host key was trusted on one path and
  not the other would be two different answers to "is this the machine I meant".
- `tsdown.dshell.preset.ts` — `dshellNodeBundle`, and the ssh package builds
  two artifacts now (`lib/client.js`, `lib/helper.js`), with `./helper`
  exported.

### Evidence

Rig `127.0.0.1:2222` (the throwaway device), host and device on Node v24.21.0,
helper deployed as `~/.dshell/helper/helper-<sha256>.js`:

```
artifact hash: 84d72c09ad105311571d6a74c84023fe6282c31603ad674a9eb665d4c3d0e33c
hello in 153ms -> {"protocol":1,"hash":"84d72c09…","platform":"linux",
                   "node":"…/v24.21.0/bin/node","nodeVersion":"v24.21.0","root":"/home/reader"}
dshell.echo -> {"label":"dshell","upper":"DSHELL","pid":86034,"cwd":"/home/reader"}
echo pid differs from the host pid: 86018
disposed cleanly
MISMATCH -> the device's dshell SSH helper differs from this build (device 84d72c09ad10…, expected ffffffffffff…)
ABSENT   -> the dshell SSH helper did not start on the device: … Cannot find module '/home/reader/.dshell/helper/does-not-exist.js'
```

The echo's pid differing from the host's is the part that matters: the rig is
the same machine, so it is the only proof the work happened in a process the ssh
connection started rather than locally. `lib/helper.js` is 262,079 bytes and
imports only `node:crypto`, `node:events`, `node:fs` and `node:url`.

### The traps, each of which cost real time

- **One zod, or nothing compiles.** `SshRpcPeer`'s signature is written in
  zod's types, so our schemas must be the *same zod* dsh-ssh resolves. `^4.4.3`
  resolved 4.6.5 while their tree had 4.4.3, and the result was
  `Type instantiation is excessively deep` plus a structural-mismatch error
  naming nothing near the cause. Pinned to the exact version, and
  `helper-artifact.spec.ts` now asserts the two versions are equal.
- **`alwaysBundle` must match subpath imports.** Matching the bare package name
  leaves `@deepseek-ai/dsh-ssh/protocol` external, and the artifact *looked*
  fine — it built, it ran — while quietly requiring a `node_modules` the device
  does not have. Patterns are `^pkg(/|$)` now.
- **Self-containment is a build gate, not an assertion.** `deps.onlyImport: []`
  makes tsdown refuse to emit when anything package-shaped would remain an
  import. Red-light tested: emptying `alwaysBundle` fails the build naming both
  offenders. A post-hoc spec could only have described the problem.
- **The remote helper path must be absolute.** `helperArgv` quotes each word for
  the remote shell, and a quoted `~` never expands.
- **`tsc -p` emits JS for files only the bundle needs.** `lib/helper-entry.js`
  and `lib/helper/run.js` appear beside the bundle and are unreachable once it
  exists, while `files: ["lib"]` would happily ship them;
  `scripts/drop-intermediates.mjs` removes exactly those two and the spec
  asserts they are gone.
- **A pre-handshake failure needs a different error path.** The peer rejects a
  pending request with "outcome is unknown", which wins the race against the
  child's exit and buries the cause. The handshake now waits for the child, so
  the ssh client's stderr is in hand, and a self-diagnosed failure outranks a
  transport one.

### Not yet true

Nothing routes through the spine, so the helper is inert in a real session; M1
wires the first seam. The pool's disposal is not bound to anything yet (no device
deletion, no host unload). And the lease/heartbeat pair is exercised only by
the rig run: its interaction with a *hanging* device is unverified.

## Phase 10.41 — M1: exec through the subprocess seam

The first seam that acts on the spine. A device session's processes now leave
through `ctx.subprocess.spawn`, so the shell executor, the search tool and
anything else that spawns keep their own timeouts, caps, spills, streaming and
background handles — those live above this seam — and only the location changes.

### What landed

- `ssh/src/helper/protocol.ts` — the process operations (`prepare`,
  `snapshot`, `done`, `terminate`, `wait`) and their schemas.
- `ssh/src/helper/processes.ts` — the device's process table: bounded output
  windows, spill files, group termination, and reaping on close.
- `ssh/src/remote-process.ts` — `SubprocessHandle` over the wire, including
  the synchronous, offset-based readers the seam demands.
- `ssh/src/helper/target.ts` — the target probe (the device's home and a Node
  executable, in one round trip), memoized per device and dropped when a device
  changes.
- `ssh/src/router.ts` — **stops rewriting the command**, and leaves `workdir`
  as the session's own mount path.
- `ssh/src/spawn-routing.ts` — the three-outcome seam, and the owner of the
  connection pool's lifetime (created here, disposed with the plugin, released
  when a device is saved, deleted or re-bound).

### Evidence

Rig `127.0.0.1:2222`, driven through the real connection with the exact specs
the two callers build:

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

Observation 5 is the **fallback tier** measured rather than asserted: the
assembled line returns the same 9 files, so a device with no helper behaves as it
did before this milestone. Observation 6 is the red light — killing the helper
mid-execution must not be mistakable for a finished command, and the empty
output is the tell that nothing was invented to fill the gap.

### Decisions and traps

- **`danger-full-access` stays, for a better reason than it had.** The active
  row is `bash-sandbox`, and it confines by wrapping `argv` in a *host* runner
  program before spawning. Handing that wrapped argv to a device that does not
  have the runner would fail; the policy is also meaningless there.
- **RPC serves collect mode only, and the fallback is a capability tier, not just
  a migration tier.** `'pipe'`, `'inherit'` and a control channel take the
  assembled path, which serves them because the local ssh client has real pipes.
- **`ssh` is checked before the RPC branch.** It is a bare name, so it looks
  perfectly routable — and routing it would run an ssh client *on the device*
  with the host's argv, credentials and known_hosts paths.
- **The assembled line uses the device's name for the program.** The caller's
  unresolved rg path is absolute to the host and would not exist on the device.
- **A start can fail in the platform's own time.** Node reports a missing program
  on the child's `error` event, after `spawn` returned, so the helper cannot
  know synchronously: `prepare` reports no `pid` and the failure surfaces on
  `done`, where the `ENOENT` is.
- **Live output is polled, and only once a reader has read.** The seam's readers
  are synchronous, so live output can only come from what has already arrived.
- **Children are started in their own process group and terminated as one.**
  `child.kill()` reaches only the process it names, so `bash -c 'thing & wait'`
  would leave `thing` running after the caller believed it stopped.
- **The helper reaps its own children**, on close and on lease expiry, so a host
  that dies without saying goodbye leaves nothing running on the device.
- **An abort that lands before `prepare` returns still terminates.** The
  termination request follows the promise for the process id rather than the id
  itself.
- **`spillPath` is a device path.** Correct rather than confusing in a device
  session, but not something the harness itself can open.

### Not yet true

- Acceptance was measured at the mechanism level, through the specs the callers
  build, not through a live browser session. End-to-end belongs to the T4
  checklist.
- Warm-on-bind is fire-and-forget, so on a freshly started host the first tool
  call may take the fallback path while the helper connects.
- `remote-fs` still uses the assembled hop; moving it onto fs operations is M2.
- There is still no confinement *on* the device: the command runs under the
  device's own policy, which the seam says so explicitly.

## Phase 10.42 — M2: the filesystem seam moves to RPC

The device fs (`ctx.fs` for a bound session) ran one `ssh` invocation per
operation since A4, with two hard habits pinned into the design: `LC_ALL=C`
everywhere (because `stat -c %F` prints a *localized* string and
`find -printf` only emits a NUL separator when its format itself is a NUL),
and a stderr classifier that turned English error text into `FsError` codes.
Both disappear on the helper lane: the wire speaks for itself, and what the
helper says about a failure is a code derived from an errno, not a phrase.

### Wire contract — `packages/dshell/ssh/src/helper/protocol.ts`

Six new operations under the existing `HELPER_OPS` constant; nothing else
changes:

| op | request | reply |
|---|---|---|
| `fs.resolve` | `{ path: absolute }` | `{ path: absolute }` |
| `fs.stat` | `{ path: absolute }` | `{ kind, size, version } \| null` |
| `fs.lstat` | `{ path: absolute }` | `{ kind, size, version } \| null` |
| `fs.list` | `{ path: absolute }` | `{ entries: [{name, kind, size?, version?}] }` |
| `fs.readRange` | `{ path, offset, length <= 8 MiB }` | `{ data: base64 }` (short = EOF) |
| `fs.write` | `{ path, data: base64 <= 32 MiB }` | `{ kind, size, version }` |

A reply's `kind` is one of `file | directory | symlink | other`; `version` is
the same five-field token the local backend derives, opaque on the wire. A
failure carries the seam's `FsErrorCode` (`FS_NOT_FOUND`,
`FS_NOT_DIRECTORY`, `FS_NOT_REGULAR_FILE`, `FS_PERMISSION_DENIED`,
`FS_TOO_LARGE`, `FS_IO_ERROR`) in the existing `RemoteOperationError.code`,
decided from the platform errno.

### Device implementation — `packages/dshell/ssh/src/helper/fs.ts`

- `realpath` is per-component because `realpath -m` recurses on the longest
  existing prefix, which collapses `link/..` into the link's parent and gives
  the wrong answer when an intermediate component does not exist.
- `versionOf` is the same five-field token (`dev:ino:size:mtimeNs:ctimeNs`)
  the local backend derives, nanosecond timestamps rather than milliseconds so a
  guard that could not tell a rewrite from the state it already read would still
  permit the overwrite it exists to refuse.
- a `mode` field travels back from the device for the write path's mode
  preservation, and is stripped before the reply crosses the seam.
- `list` does not sort: order is the seam's decision.

### Host seam — `packages/dshell/ssh/src/remote-fs*.ts`

The original `remote-fs.ts` was rewritten around one interface
(`RemoteFsTransport`) that two implementations both satisfy:
`HelperFsTransport` (the device is reachable through the verified connection)
and `ShellFsTransport` (the no-Node tier; one `ssh` invocation per operation,
parsed back as before). `RemoteFileSystem` owns the policy half — guards, edit
rules, line endings, diff basis — and is unaware which transport is in use;
which one it picks is decided by `connection === undefined`, which
`DshellFileSystem` reads from the router's `helperConnection` accessor without
awaiting. Awaiting here would turn "no helper verified right now" into a stall
on every read.

The list order is the seam's, not the device's: `RemoteFileSystem.listDir`
sorts once with English collation — the order the local backend produces — so
the same directory reads the same way on either lane and from either machine.
The known lane difference: a symlink to a file is reported as `file` (followed
probe) on the helper lane, `other` (the entry itself) on the shell lane.

### Verification

- `pnpm typecheck` and `pnpm build` are GREEN.
- `pnpm test`: 230 passed (was 176); new files: `tests/device-fs.spec.ts` (21
  rules), `tests/remote-fs.spec.ts` (20 rules over the policy layer) and
  `tests/remote-fs-helper.spec.ts` (13 rules over the helper lane's wire shape
  and error mapping). The guarded-write guards are proven by deleting the
  if-branches and re-running.
- **Rig verification** — `/tmp/dshell-m2-verify.mjs` (49 checks, all pass)
  drives the real connection against the throwaway sshd at 127.0.0.1:2222:
  relative-path resolution, read, write and version-guarded write; typed errors
  for absent files, non-directories, and a file with mode `0000`; mode
  preservation; a literal edit including CRLF detection-and-restore; a 9 MiB
  read that spans the 8 MiB frame ceiling with a multi-byte character
  straddling the boundary; a stream abandoned after one chunk. The helper-lane
  runs with a `ctx.subprocess.spawn` that throws on every call, so any
  observation that passes is evidence no `ssh` invocation ran for it.

### What the shell lane keeps

It is the no-Node tier. Every constant the assembled path needed stays where it
was — `STAT_FORMAT`, `FIND_FORMAT`, the `LC_ALL=C` prefix, the
`realpath -m` resolve, the `head -c`/`tail -c` reads, the `mktemp` +
`chmod --reference` + `mv` publish script, the two stderr classifiers. The
helper lane retiring them is what makes the helper lane *the* lane; the shell
lane remaining available is what makes no-Node still work.

### Deferred

- `files/src/transfer.ts` and `buffer/src/service.ts` still assemble — M3.
- Provisioning — the device-card probe, the install route, the
  `~/.dshell/helper/helper-<sha256>.js` install action — is M4.

### Acceptance

All three gates green; rig 49/49; helper-lane subprocess attempts = 0;
expected-fallback property recorded (`link-to-file` reads as `file` on the
helper lane, `other` on the shell lane).

## Phase 10.43 — the archive set becomes upstream's

dsh 0.1.6 ships an archive set, a settings page that lists it, and a round trip
around it. dshell had its own: a `tags.json` document, an
`/api/dshell/sessions` route with `archive`/`unarchive` actions, and a
collapsible `已归档` group in the sidebar. Two implementations of one concept,
and they disagreed the moment both were visible — archiving through the sidebar
left dsh's page printing `暂无已归档会话。`.

The migration is not a deletion; it is a change of ownership.

### What upstream owns now

`workspaceRegistry.archivedSessionIds` plus `archiveSession`/`unarchiveSession`,
reached through the stock `workspace-controller` row, which this profile now
ENABLES. dshell keeps the STORE (`$DSH_HOME/dshell/tags.json`) and nothing
else. The registry that backs it is the stand-in dshell already had: only its
archive half is real; its workspace half stays the honest projection of a shell
without workspaces. Because `archivedSessionIds` is a synchronous getter and
`WorkspaceFeed` reads it while the controller activates, the tag document is
loaded during composition, before the registry is registered.

### Why the row used to take the client down

"Failed to load plugins" — and the cause was ours. `WorkspaceController` does
`super(ctx, 'workspaces')`, and dshell-workspace registered a `workspaces`
stand-in of its own. Two providers for one service key is a cordis error, and it
surfaces only as a fiber in state `failed`.

The probe that found it: a temporary hook in dshell's own client entry (never in
dsh's read-only `boot-client.ts`) that exposed the loader and printed every
non-active entry's `fiber._error`. The message was `service "workspaces" has
been registered at <@nexus-aethra/dshell-workspace (later removed)/client>`.
The earlier suspicion — that the row's manifest inject disagreed with its code
inject — was wrong. That split is stock throughout. The probe was removed once it
had answered.

### What the sidebar keeps

The 归档 row action (the only writer), the 待删除 group with its cancel, and the
delete flow behind a confirmation — and nothing else. The `已归档` group is
gone: restoring is the settings page's job now, and a second list of archived
sessions is a second place for the same set to drift. Removing it orphaned 删除,
which had lived on the archived rows, so the active row now carries both
actions.

### Two owners, one hidden set

A row leaves the active list for either of two reasons, and the two facts arrive
from different owners: the archive set is the registry's live snapshot, the
scheduled-purge qualifier is dshell's own route. The sidebar filters on their
union. That split has one visible consequence, and it is where the bug was: the
delete path marks a loaded session pending by writing the tag document directly,
so the registry's snapshot never changes and the client model never notifies.

### Acceptance

- Archiving in the sidebar, then opening Settings → 已归档会话, lists the
  session (`未分组 · 3天`) — the page that always printed the empty state.
- 取消归档 there returns the session to the sidebar with no reload, and the store
  is empty afterwards.
- Deleting a loaded session moves it to `待删除` and steps the stage off it;
  cancelling there restores it in place.
- Boot is clean — no `did not activate` warning, no `Failed to load plugins`;
  `pnpm build`, `pnpm typecheck`, `pnpm test` (275) all green.

## Phase 10.44 — host capabilities belong to local sessions

dsh 0.1.6 ships browser use and computer use as two registries with providers
behind them, and the stock rows hand both to every session. That is wrong here
for one reason: dshell's device sessions run their shell, files and cwd on a
remote machine through `ssh`, so a browser or a desktop that lives on THIS
machine is the wrong side of the boundary the session exists to cross.

The user's rule for this round was: local sessions get them, a remote session
tries and turns off if it does not work. That rule cannot be implemented inside
upstream's runtime, and the two capabilities cannot even be gated the same way:

- The browser is mounted PER AGENT into the agent's own scope. A scope cannot
  mask its own registrations — `tools.restrict()` filters what a scope
  INHERITS, not what it owns — so a deny list cannot take the browser away
  again. Not mounting is the only way to say no.
- The desktop is the opposite: the native provider discovers its catalog once and
  registers it GLOBALLY, so every session sees it and `tools.restrict({ deny })`
  is exactly the mechanism for taking it away from one.

### The provider — `packages/dshell/host-tools`

A new host package fills `ctx.browserUse` with dshell's own provider (the stock
Playwright row is disabled, since the slot admits one). It mounts the same pinned
`@playwright/mcp` per live local agent and differs from upstream's in three
ways:

- **locality is part of the decision.** `runsOnThisMachine(agent, bound,
  isMount)` asks the SSH router by session id, then asks whether the session's
  cwd is under the mount base. The second question is not redundant: the
  new-session dialog creates the session with the mount as its cwd and records
  the device assignment one round trip LATER, so at `agent/created` a brand-new
  device session looks exactly like a local one. Refusing early is also the safe
  direction — a mount is an empty local stand-in, so "local" would be a wrong
  answer that stays wrong.
- **the engine's output goes to dshell's data root** (`$DSH_HOME/dshell/browser`),
  not the session's working directory, which is where the stock provider leaves
  a `.playwright-mcp/` directory.
- **failure is contained.** dsh rejects agent creation when a serial
  `agent/created` listener rejects, and upstream's provider awaits MCP startup
  inside that listener — so a broken install there costs the SESSION, not the
  browser. Here the mount is wrapped: a browser that cannot start is logged and
  that session simply has no browser tools.

For a device session the package mounts nothing and instead denies the currently
registered `cua_driver_native__*` names for that agent, re-run on
`tools/change` for a catalog that finished discovering after the session was
created. Names already denied are remembered, because each call appends a layer.

### Two hazards this phase actually hit

Both were found by running it, and both are the kind that a spec would not have
caught:

- **`ctx.tools` on a context that did not declare it THROWS.** The first build
  of the mask read `ctx.tools` from the plugin's own context, whose `inject`
  named only `browserUse`. The throw happened inside the `agent/created`
  listener, which is the one place a throw is fatal: every device session
  failed to open, and the client showed its "选择一个工作区开始" hero with the
  session gone from the sidebar. The cause is invisible from the browser — the
  gateway answers `{"code":"gateway/internal","message":"resume failed for
  session …: Error: cannot get property \"tools\" without inject"}` and the
  host log is silent — so it was found by wrapping `window.fetch` in the page
  and reading the RPC response back. `inject` now names `tools`, and the scope
  is minted with `createScope` rather than borrowed from `agent.ctx`.
- **A repeated `agent/created` for one activation would mount twice.**
  Upstream's provider is idempotent per agent; ours is not, so the mount records
  the agent before awaiting the handshake and clears it on the agent's disposal.

### Wiring

- Patch rows: `dshell-browser-use-registry`, `dshell-host-tools`,
  `dshell-computer-use-registry`, and
  `dshell-computer-use-cua-native`. The stock `browser-use-playwright-mcp`
  row stays off: one provider per slot.
- `scripts/install-into-dsh-profile.sh` installs dshell's package plus the
  three upstream ones the stock profile does not ship. Row names resolve from the
  PROFILE's own dependencies, so a missing install is a failed import at boot
  with nothing pointing at the script.

### Verification

`pnpm build`, `pnpm typecheck` and `pnpm test` are green (274 cases; the new
`host-tools.spec.ts` carries 8 — Chromium discovery, the server's argv, and the
four locality rules).

In the browser, against a live harness and the local sshd rig:

- a local session's agent opened `https://example.com` and answered
  "页面标题是：Example Domain";
- a fresh device session opens normally — no hero state, still ten rows in the
  sidebar — and stays open;
- **no browser is mounted for a device session**: opening two of them left the
  child-process count unchanged, and every `@playwright/mcp` child's cwd is a
  local session's directory, never a mount;
- **the desktop mask takes effect**, read from the model's own surface: asked to
  count its `cua_driver_native__*` tools, the device session's agent answers
  "0 个" while the local session's agent answers 88;
- the harness log stays clean: no warn from either containment path.

## Phase 10.45 — the 0.1.2 release

Four PRs and one new package since `0.1.1`, so the whole family moved again:
**twelve** packages at `0.1.2`, published in dependency order. The release is
mostly what the two phases above it describe — the archive set moving to upstream
(10.43), the machine's own capabilities becoming a per-session decision (10.44) —
plus the helper status loop actually persisting what it deployed (#46) and the
dialogs following the theme they open in (#49). `dshell-host-tools` is NEW in
this release and the bundle depends on it, which is why an install of the bundle
now pulls twelve names instead of eleven.

### What a consumer does differently

Nothing structural — one command, four packages:

```sh
dsh plugin --profile web add -w @nexus-aethra/dshell-bundle@0.1.2
# the rows the patch names that a stock profile does not ship
dsh plugin --profile web add -w @deepseek-ai/dsh-browser-use@0.1.6-alpha.1
dsh plugin --profile web add -w @deepseek-ai/dsh-computer-use@0.1.6-alpha.1
dsh plugin --profile web add -w @deepseek-ai/dsh-experimental-computer-use-cua-driver-native@0.1.6-alpha.1
```

Verified rather than assumed, against a profile created from the shipped web
template:

- with only the bundle installed, the host boots and reports `2 entries did not
  activate` — the two computer-use rows — and nothing else is affected. That is
  how the second command above was discovered rather than guessed;
- with all four installed, the boot is silent, and the published client bundles
  render the full UI in the fresh profile: ten sessions, per-row `归档` /
  `删除`, no `Failed to load plugins`.

### Publishing notes

- `pnpm publish` does not accept `--userconfig`; the token file goes in
  `NPM_CONFIG_USERCONFIG`, and both `--registry=https://registry.npmjs.org/`
  and `--access public` are explicit because the ambient registry is the
  read-only npmmirror mirror and the scope is not the default one.
- The read side lags the write side, per package and again for a name's FIRST
  publish: `dshell-host-tools`' dist-tags answered and its tarball downloaded
  minutes before its packument stopped 404ing, so `npm install` failed with
  `E404` while every other package was already installable. A publish is not
  re-run for this; the acceptance signal is `+ pkg@version` from the publish
  itself plus the `dist` block the registry writes.
- The bundle's `workspace:^` edges rewrite to `^0.1.2` on pack, and the
  published manifest was read back to confirm all eleven deps — including
  `dshell-host-tools` — came out that way.

### Deferred

- The desktop profile still pins exact `0.1.0`; moving it forward is a `.deb`
  rebuild, not an npm step (design 10.30's profile rules).
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
|---|---|---|
| `exec` | one channel, bounded collect, closed when the command ends | test, helper deploy, `remote-fs-shell` |
| `open` | one channel kept alive, fed through dsh's `SubprocessHandle` seam | the legacy command lane for a bound session |
| `shell` | a pty channel | the device terminal |

`open` is the seam that matters. dsh hands a plugin a `SubprocessHandle`, and
`ssh/src/channel-process.ts` is one — a `PassThrough` for each of stdin,
stdout and stderr over a channel, with the same collect-and-spill contract dsh's
own runner implements. So the harness's caller sees the object it already knows,
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
PREVIOUS build was read back correctly by the new one, so an upgrade does not
re-learn every host.

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

Container `dshell-metrics-run` (dsh `v0.2.1-rc.2`) with the local build
injected, against the real device:

| what | reading |
|---|---|
| connection test | `已连接 root@VM-0-6-ubuntu · 1096ms`, host key `SHA256:ptAAuu4t…（已信任）` |
| helper deploy | `present`, digest matches, 319 ms |
| device terminal | remote prompt `root@VM-0-6-ubuntu:~#`, OSC `133;D;0` + `3008;…exit=success` |
| Ctrl+C | `sleep 30` → `exitCode: 130` |
| file list / write / read back / search | `/root` listed; 32-byte local→remote copy `done`; `cat` on the device returns the bytes; `grep -rl` finds it |
| no host `ssh` | exactly one TCP connection to `:22`, owned by the harness process itself |

Plus a pre-flight outside the container: pure-JS `ssh2` (no native binding, which
is what the container ends up with) dials the device, passes the host-key
verifier and runs a command with exit code 0.

The suite is 50 files / 561 tests, and it is green on ten consecutive runs — the
tenth matters, because one of them exposed a real flake in
`transport.spec.ts`'s `channelOf`, which waited a fixed number of event-loop
turns for a channel that dialing reaches through real file I/O. It now waits for
the run to have subscribed to the channel's outcome, against a wall-clock
deadline. A gate that passes once is not a gate.

### Not yet done

No release, no tag: the 0.1.14 line stops at `0.1.14-alpha.3` on npm's `alpha`
dist-tag while `latest` stays `0.1.13`. Merging to main, releasing and tagging
are all still owed a decision.

**Settled later.** The alpha line ran on to `0.1.14-alpha.13` and `0.1.14`
itself was published and tagged (`dshell-v0.1.14`, `3ecd82f`, 2026-10-20); the
release line continued with `0.1.15` (phase 10.47) and `0.1.16` (phase 10.48).

---

## Phase 10.47 — the device panel: processes, containers and ports

**Commit `72e5c33` (2026-10-24), released in 0.1.15 (tag `dshell-v0.1.15`,
commit `3fc6eac`).**

The right pane answered "what does this device hold" and never "what is running
on it". A dshell session bound to an SSH device had no way to see the machine's
processes, its containers, or the sockets it listens on — the reader had to open
a terminal and run `ps` by hand.

A device is a machine somebody else owns, and the first three questions about
it are always the same: what is eating the CPU, what is the container doing, and
who is holding this port. The file pane answered the fourth question (what
files are there) and nothing answered the first three.

### What landed

- **`packages/dshell/mode/src/device-detail.ts`** — one probe, one round trip.
  The device is asked with a single `bash -c` through the shell seam, so the
  SESSION decides the machine: the host's own routing decides whether that means
  this machine or the session's SSH device, and nothing in this package knows
  that ssh exists. The whole run lives inside the initiator boundary (`execute`
  included), or the spawn would see no session and answer with a local shell.
- **The lists are tools, not a readout**: filter by what the reader knows, order
  by any column (a second column breaks the first one's ties), open a row for
  what the list cannot fit, and let a port lead to the process holding it.
- **`packages/dshell/mode/src/client/device-*.ts`** — the panel: four pages
  (概览 / 进程 / 容器 / 监听端口), dsh's own primitives and tokens, and a tab kind
  of its own so it takes nothing from dsh's shipped panes. Its guide entry is the
  card on the start page, because a type that contributes none is a type nobody
  finds.

The panel also fixed two bugs it found in itself: the column heads sorted by
nothing (a prop named `key` is a reserved React prop, so React ate it before
the component was called, and every head sorted by `undefined`), and the
repository's own notes carried a device's public address into a directory that
would have been published.

### Decisions worth keeping

- **The lists are 200 processes long, not 40**: the reader narrows them, and
  the panel is where the narrowing happens.
- **`ss -p` says who holds a socket, and `ps` gives the owner, the state and
  the age of a process** — not just its name, because two instances of the same
  command differ only in their arguments.
- **Each list says out loud what it could not read**, judged by the tool's exit
  status rather than by its presence on the PATH: a runtime whose daemon is not
  running is not a runtime with nothing to show.
- **The heads and the rows are ONE grid**, so a reader who aims at "CPU" sorts
  by CPU.

### Acceptance readings

- Verified on the real device: **176 processes, 3 containers, 32 sockets**, and
  in a dshbox container running this working tree, with the clicks driven
  rather than left to a human.
- 688 tests pass, three consecutive runs.
- The published `0.1.15` installs on a `0.2.1-rc.3` dsh; the published
  `0.1.14` does not, which is what that release was for.

### Not yet done

The release happened (`0.1.15`, tag `dshell-v0.1.15`), so nothing is owed
here. The follow-up that did land separately is the port forward — the ports
page answers "what is listening", and the reader still had no way to *reach* it
(see Phase 10.51).

## Phase 10.48 — the host-version window

**Commit `b3d72f9` (2026-10-31), released in 0.1.16 (tag `dshell-v0.1.16`,
same commit).**

A dshell release used to name the exact dsh versions it supported, so every dsh
patch or release candidate required a dshell release that moved a string in
every manifest that declares one. Nothing was broken; the pin was. That coupling
is what made users wait after upgrading dsh.

The supported window is now

```
0.1.5-rc.2 || 0.1.6-alpha.2 || 0.1.7-rc.2 || 0.2.0-rc.1 || 0.2.0-rc.2 || >=0.2.1-rc.2 <0.2.2-0
```

stored once in `dsh-upstream.json` alongside the tag the checkout is built
against (`dsh-v0.2.1-rc.3`). Every 0.2.1 prerelease and 0.2.1 final installs
without a dshell release; 0.2.2 and later still require a surface review, which
is what a new minor line is for.

### Decisions worth keeping

- **The range cannot be a plain window, and the first attempt here proved it by
  shipping and failing to install.** npm resolves peer ranges WITHOUT
  `includePrerelease`, while dsh's gate resolves them WITH it, so a plain
  `>=0.1.5-rc.2 <0.2.2-0` matched nothing under npm's rules and the published
  `0.1.16-alpha.1` could not be installed at all. Both sides have to accept the
  same set, which is why the older prereleases are named explicitly.
- **One source, written out by a script.** `scripts/sync-host-range.mjs` writes
  the range into every manifest and `--check` reports drift, so a hand edit
  fails a gate instead of publishing a range no other package agrees with.
  Measured before the change: **213 `@deepseek-ai/dsh-*` declaration sites
  holding exactly one distinct value** — nine of the eleven packages of that
  round (`std` and `storage` declare none). Today the suite is twelve
  packages and 219 such sites across the ten manifests that carry them.
- **The upstream API surface dshell consumes by name is now a gate.**
  `scripts/upstream-surface.ts` and its two specs mean an upstream rename is a
  test failure rather than a runtime surprise.
- **CI runs the same actions the dsh checkout runs**, and the failures that
  first appeared on a clean runner are worth keeping, because each one is a
  class of problem a local checkout hides: two pnpm versions meet here and
  cannot be pinned to one (this repository is pnpm 9, the dsh checkout is pnpm
  11, and pnpm 10 moved overrides out of `package.json` into
  `pnpm-workspace.yaml`, so pnpm 9 reads dsh's override list as empty and the
  frozen install fails with `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`); the root
  lockfile no longer matched its manifests; an override named a path inside the
  package store in the pnpm 9 spelling; building dsh's *declarations* is not
  building dsh (`tsc` writes the declarations a package's types entry points
  at, `tsdown` writes the runnable JavaScript its main and exports point at);
  dsh is two builds, a Host face and a Client face, and this repository needs
  both; the surface specs walk 358 packages of upstream source, which the
  default five-second budget does not cover; and three specs were written
  against a Windows machine without saying so.

### Acceptance readings

**707 passed / 44 skipped**, the range check and the upstream check clean, and
the whole CI sequence verified on a tree whose 358 `lib` directories had been
deleted first — the state a fresh clone is in.

### Not yet done

The release happened (`0.1.16`, tag `dshell-v0.1.16`), so nothing is owed
here. What is still open is the far end of the window: `0.2.2` and later need a
surface review before they can join the range, and the range is written by hand
in `dsh-upstream.json` for each new minor line.

## Phase 10.49 — the 管理台, one settings page for the whole suite

**Commit `8b986cb` (2026-11-01). UNRELEASED.**

The suite's configuration lived in three places — the device registry beside the
dshell-ssh plugin row, the terminal and data-root cards beside the dshell-mode
row, and (now) the WSL built-ins that appear in the registry without a row of
their own. A reader asking "where do I manage dshell" had to know which plugin
owned which answer.

The 管理台 is one settings section (id `dshell`) whose body is a
card list: a child seat (`dshell.admin.card`) the page renders, into which
each package contributes its own cards. The seat's declaration is duplicated in
both clients — the owning page in dshell-ssh, the twin dshell-mode type-checks
its registration against — because the alternative is a build-time edge between
the two, and every edge to dshell-ssh is a runtime seat.

### What landed

- **dshell-ssh**: the section, the frame, and the device card (the same
  component the Plugins row opens — devices, credentials, vault, host keys,
  connection test, helper install; WSL built-in rows included).
- **dshell-mode**: the terminal and data-root cards (the row-config page
  itself, whose cards are self-contained module stores).
- Port-forward and every other surface stay where they are; the page is an
  umbrella, not a relocation.

The page itself is deliberately thin — a heading, one line of direction, and the
card list. The cards come from whichever packages are composed in, each
registered into the seat by its own plugin. That is the reason the seat exists
at all: the alternative is one package importing another's components.

### Decisions worth keeping

- **A settings namespace is one document, and the Plugins section dispatches ONE
  card per namespace.** That is why the terminal card could not be a second
  card, and why the data directory got its own namespace and card (Phase 10.26)
  rather than another row.
- **The seat's declaration is duplicated rather than imported.** Interface
  merging accepts identical members; if the copies ever drift, the compiler
  names the file that moved.
- **A card is a card.** The WSL card (Phase 10.50) was its own reading of
  "a card" — hand-rolled fallback colours, a different radius, its own chevron
  — next to the registry card's dsh-token chrome on the same page. The shared
  chrome moved to `card-styles.ts` and both cards draw from it: same shell,
  same header typography, same row and action measures, same disclosure
  chevron (commit `95ded8b`).

### Acceptance readings

- The section id, the child seat and the card registrations are in the tree, and
  the two clients' twin declarations of the seat type-check against each other.
- The 管理台 was read in the browser while it was built, and three follow-ups
  came out of that reading — the navigation row's name, its icon, and the WSL
  card's own page. Each is a commit in its own right (`bca50b9`, `95ded8b`,
  and the WSL card in phase 10.50).
- The gate on this branch: 75 vitest files passed + 1 skipped, **754 tests passed,
  44 skipped**; `tsc -b tsconfig.host.json` exit 0; `tsc -b tsconfig.client.json`
  exit 0.

### Not yet done

**This phase is unreleased.** Merging to `main`, the `0.1.17` version bump,
the publish and the tag are all still owed. The packages still say `0.1.16`,
which is the npm `latest`; the tag `dshell-v0.1.16` points at `b3d72f9`.

## Phase 10.50 — WSL2 as a built-in device, and the device-provider registry

**Commits `d64bc9b`, `a7a5d2a`, `f299b94`, `bca50b9`, `95ded8b`,
`8e7a5a3`, `fc42e01` (2026-11-01 → 2026-11-02). UNRELEASED.**

Windows hosts could not open a local terminal at all: the local plan refuses on
win32, and the only terminals were SSH devices. A WSL2 distribution is a POSIX
shell on this machine, and it slots into the device model whole: the same
binding, mount translation, spawn plan and probes, with a transport that spawns
`wsl.exe` instead of dialing ssh2.

### What landed

- **`packages/dshell/wsl/src/transport.ts`** — the three doors. `exec` and
  `open` are plain child processes; the `shell` door is a ConPTY pty
  (node-pty, imported lazily — only a pty owes the native module). The
  management output's UTF-16LE decoding and the localized `--list` parsing are
  theirs, pinned by specs.
- **`packages/dshell/wsl/src/provider.ts`** — `WslDeviceProvider`. `rows()`
  is one built-in row per WSL2 distribution (id `wsl:<distro>`, name
  unadorned, host `wsl`, port 0, an empty user, remoteRoot `~`, auth `wsl`,
  `builtin: true`, `hasSecret: false`); `connection()` derives a
  `DeviceConnection` (`kind: 'wsl'`, no secret); `owns()` answers by prefix;
  `doors()` returns the WSL transport; `refusal()` is the provider's own
  wording; `probeTargets()` is every live distro.
- **Detection**: `wsl.exe --list --verbose`, cached 30 s, Windows only, 8 s
  timeout, WSL1 filtered out. A machine without WSL answers an empty list and
  the built-in rows simply never appear.
- **`packages/dshell/wsl/src/client/`** — the 管理台's WSL card, its own
  styles, its locales, and its registration into slot `dshell.admin.card`
  (id `wsl`, order 15, namespace `dshellWsl`).
- **Registered in the bundle**: the `dshell-wsl` row in
  `packages/dshell/bundle/cordis.patch.yml` and `wsl` in
  `scripts/install-into-dsh-profile.sh`. Omitting the row removes WSL support
  without touching any other package.

### The registry refactor (commit `fc42e01`, 2026-11-02)

The WSL support lived as branches through dshell-ssh — a transport file, WSL
arms in the device store, a probe loop in the router, hardcoded refusals in the
forward seams, a card and locale keys in the client — and every one of them made
the SSH package carry vocabulary it does not own. A device kind with its own
transport and no credential is not SSH's to know about.

**dshell-ssh now owns a DEVICE-PROVIDER REGISTRY** instead
(`packages/dshell/ssh/src/registry.ts`, published as
`DSHELL_DEVICE_REGISTRY` — the service key lives in
`packages/dshell/std/src/contracts.ts:868`). A provider contributes built-in
rows, answers `connection()` for its ids, refuses save/remove through
`owns()`, serves its doors to the transport dispatcher, declines forwards in
its own words, and names the devices whose home the load should probe.

The contracts (`DeviceOutcome`, `DeviceCommand`, `DeviceExecResult`,
`DeviceExecOptions`, `DeviceShell`, `DeviceDoors`,
`DshellDeviceProvider`, `DshellDeviceRegistry`) live in dshell-ssh rather than
in std, because they speak in node streams and std must stay
browser-compilable. A provider imports them as TYPES from
`@nexus-aethra/dshell-ssh`, so the runtime dependency runs one way:
**ssh never imports wsl**.

Where the pieces sit:

| what | where |
|---|---|
| the service key | `std/src/contracts.ts:868` — `DSHELL_DEVICE_REGISTRY` |
| the contracts and the registry | `ssh/src/registry.ts` |
| the dispatch | `ssh/src/transport/transport.ts:625` — `transportFor(device)` → `deviceRegistry?.doorsFor(device) ?? deviceTransport()` |
| the registration and the wiring | `ssh/src/index.ts:96-97` — `ctx.provide(DSHELL_DEVICE_REGISTRY, router.registry)` and `useDeviceRegistry(router.registry)` |
| the store consults the registry first | `ssh/src/devices.ts:205` — a provider's connection wins over a stored row |
| save/remove is refused for built-in ids | `ssh/src/devices.ts:246` — locale key `error.builtin` in `ssh/src/host-locales.ts` |
| the load probes provider targets | `ssh/src/router.ts:1062` — `probeProviderRoots()` |
| the SSH card filters built-ins out | `ssh/src/client/card.ts:142` — WSL rows are listed by the 管理台 card instead |

### Decisions worth keeping

- **A built-in row is derived, not stored.** A distro that vanishes takes its
  rows with it and reads as an unknown device through the ordinary unservable
  path. Its actions (edit, delete, helper) are refusals, so the SSH registry
  card filters `builtin` rows out rather than showing rows it cannot serve.
- **Port forwards to a WSL distribution are refused in the provider's own
  words**: `WSL 与本机共享回环，端口本来就通，无需转发`. WSL2 shares this
  machine's loopback, so a tunnel would bind a second socket to bytes the first
  already carries.
- **The WSL row reads as its own login method** (`auth: 'wsl'`). The device
  card rendered a WSL built-in with the password-auth phrasing
  ("密码登录（未存凭据）") until it learned what `wsl` means — and the
  no-secret suffix would read as a fault on a device that holds no credential by
  design (commit `f299b94`).
- **The mount path stays inside Windows' grammar.** The mount directory is
  derived from the device id, and a WSL device's id carries a colon — illegal
  in a Windows directory name. The bind's mkdir failed with EINVAL before a
  shell ever ran, and the creation page showed the mount path in red. Reserved
  characters fold to a dash, and the mapping is built from this one call in
  both directions (commit `a7a5d2a`).
- **A provider's device has no helper handshake to volunteer its home.** The
  load probes whoever says they need it (`probeTargets()`), and the answers
  fill the same cache a bind fills, so the files seam never sees the literal
  `~`.
- **The row's name is the distro's own name, unadorned.** dsh's session-row
  device badge caps at 96 px, and any prefix we add ("WSL · ") is what clips it
  mid-glyph.

### The three defects the ConPTY run found (commit `8e7a5a3`)

- **A WSL exec's pipes threw EPIPE when the child died mid-stream**, and the
  unhandled throw took the whole dsh host down — every WSL surface read as
  broken because the page was talking to a corpse. Every child-pipe touch is
  guarded now, and each pipe carries an error handler, the same swallow the SSH
  transport applies to its channel.
- **A ConPTY pty answers a resize by homing and repainting its whole (mostly
  empty) grid**, and the region walk counted those rows — the blank wall above
  the prompt. A home move now wipes the measurement like an erase does, and the
  region renders its INK SPAN: blank rows between ink stay (spacing the shell
  chose), the dead frame around them is cut from the text and the grid alike.
- **A WSL device has no helper handshake to volunteer its home, so its root
  stayed the literal `~`** and the files seam answered `<home>/~`. The bind
  asks the device once for its home, WSL roots are probed at load for bindings
  that outlived a restart, and the files route expands a typed `~`.

Also: the resize sync no longer re-sends an unchanged grid (each redundant
resize spent a full ConPTY repaint).

### The exec door was broken here, and the reading that proved it

**Measured on this machine (Windows + WSL2 Ubuntu-24.04, 2026-11-04) BEFORE the
fix — this is a reading, not an inference:**

```
doors.exec(device, 'echo HELLO')    -> { exitCode: 0, stdout: '', stderr: '' }   <- WRONG
doors.open(device, 'echo VIAOPEN') -> stdout 'VIAOPEN\n'                          <- correct
```

**The cause was one duplex carrying both directions.**
`packages/dshell/wsl/src/transport.ts` built a single `PassThrough` and wired
BOTH ends of it to the child: the child's stdout was written INTO that stream
(`process.stdout.on('data', …)`) and the stream's own writes went to the
child's stdin. So the `stream.end()` that the no-stdin contract performs to
close the write side also ended the READ side, and the child's stdout was
dropped before the collector saw it.

**What it cost, in the product:**

- **`router.test`'s own probe line** (the hostname|user|uname one) answered
  empty over a WSL device, so the 管理台's WSL card's 测试 button read as an
  empty answer.
- **`router.ensureDeviceRoot`'s probe** ($HOME / node) answered empty too, so
  the root a WSL device reports was never learned. The fix in commit `8e7a5a3`
  — which added `ensureDeviceRoot` and the load-time provider probe — never
  actually took effect for WSL.

### The fix, and the readings after it

`ProcessCommand` now builds a real `Duplex`: its **writable** side is the
child's stdin and its **readable** side is the child's stdout, and the two
never touch — ending the writable side (what the no-stdin contract does) no
longer ends the readable one. This is the shape the SSH transport already
used: `packages/dshell/ssh/src/channel-process.ts` keeps three separate
`PassThrough`s — stdin, stdout, stderr — and pipes the directions
independently. The WSL transport now mirrors it, which is the whole of the
"split the runtime layer" this branch owed.

Three smaller gaps in the same door went with it:

- **`DeviceExecOptions.env` reaches the distro.** `wsl.exe` does NOT forward
  the Windows environment: it hands the distro a fixed set (PATH, HOME, …) and
  drops the rest, so setting the variable on the child process alone satisfies
  nothing — `printenv FOO` answered empty while `$HOME` answered fine, which is
  how the gap was found. `WSLENV` is the bridge WSL itself provides (a name
  listed there is copied into the distro), so the caller's keys are appended to
  it, and the host's own list is preserved. Measured after:
  `printenv DSHELL_PROBE` → `passed`.
- **`openStdin` is honoured** — `exec` ends the write side only when the
  caller did not ask to keep it open.
- **`open` honours `stdin`** — the payload is written and the write side then
  closed, which is the whole of the stdin contract. `open` used to ignore it,
  so a caller that went through `open` rather than `exec` lost its batch payload
  entirely: the spawn path (`ssh/src/spawn-routing.ts`, which passes
  `stdin` for a subprocess with a batch payload) and the binary file read
  (`ssh/src/remote-fs-shell.ts`) both go through `open`. The stdin logic now
  lives in `open` and `exec` inherits it, which is the SSH transport's shape.

The door's spawn is injectable (`WslSpawn`, defaulting to the real `wsl.exe`),
so the contract is proven by a fake child rather than by a machine that has
WSL on it. Eleven specs in `packages/dshell/wsl/tests/wsl.spec.ts` cover it:
collecting stdout and the exit code, output printed AFTER stdin closes (the
regression), stdin and stdout in flight at the same time, `openStdin`, `env`,
stderr kept separate from stdout, a nonzero exit code, a child that dies without
a word, a batch payload carried through the `open` door, and the `WSLENV`
bridge. **Eight of the eleven fail against the pre-fix code and all eleven pass against
the fixed one** — the three that pass on both are the ones asserting an empty answer
and the ones the broken shape happened to serve by accident.

Re-measured on the same machine after the fix:

```
doors.exec(device, 'echo HELLO')      -> { exitCode: 0, stdout: 'HELLO\n', stderr: '' }
doors.exec(device, 'echo A; echo B')  -> stdout 'A\nB\n'
doors.exec(device, 'printf xyz')      -> stdout 'xyz'
doors.exec(device, 'echo OUT; echo ERR 1>&2') -> stdout 'OUT\n', stderr 'ERR\n'
router.test's probe                   -> LAPTOP-65SFEHRB|gpumem|Linux 5.15.167 (microsoft-standard-WSL2)
router.ensureDeviceRoot's probe       -> /home/gpumem
```

**What worked over WSL all along, measured the same way:**

- **the SHELL door** (the ConPTY pty): a marker typed into the pty comes back,
  the prompt renders, and the session exits cleanly;
- **the device panel's probe** (it runs through the shell seam, not the exec
  door): real process, container and port rows came back.

### A WSL device is a WINDOWS-HOST story

The reason a WSL distribution had to be reachable at all is that the local
shell plan refuses on win32: `LOCAL_SHELL_SUPPORTED` in
`packages/dshell/terminal-bridge/src/pty.ts:426` is
`process.platform !== 'win32'`, and the refusal's own wording says it —
"dshell 的集成终端需要一个 POSIX shell；这台机器是 Windows，本地起不了。绑一台设备就能用。"

A WSL distribution is a POSIX shell ON this machine, so it slots into the
device model whole and answers the refusal the local plan cannot.

### Acceptance readings

- **On this machine (2026-11-04)**, `wsl.exe --list --verbose` reports
  **Ubuntu-24.04 (default)** and a **dshbox container distribution**, both
  WSL2. The provider's `rows()`, `connection()`, `doors()`, `refusal()`
  and `probeTargets()` all answer correctly against that list.
- **In the fast-test box container** (at commit `a7a5d2a`, before the
  registry refactor): the mount directory is created under its sanitized name, a
  session bound to the distro spawns `bash -l` through ConPTY (the process lives
  in the distro), and the command's output and settle markers land in the block
  log and render in the browser's own block view. That commit also reported the
  connection test answering from inside the distro — a reading the 2026-11-04
  measurement above did not reproduce at the time, because the exec door was
  still broken then. It does now: the same probe answers
  `LAPTOP-65SFEHRB|gpumem|Linux 5.15.167 (microsoft-standard-WSL2)` on this
  machine after the fix.
- **The phase-0 spike** proved the settle marker survives ConPTY with its exit
  code and BEL, resize reaches the inner shell, and the session exits cleanly.
  The bridge's own settle injection is transport-agnostic, so the command
  splitter, the block log and the completion warm trigger all work over this
  path unchanged.
- **The gate on this branch**: 77 vitest files passed + 1 skipped, **786 tests
  passed, 44 skipped**; `tsc -b tsconfig.host.json` exit 0;
  `tsc -b tsconfig.client.json` exit 0.
  (The three `repo-hygiene` failures that appear before the deletion of
  `docs/dshell-upgrade-0.1.6.md` is committed are an index artefact: the spec
  reads every tracked file and that one is gone from disk but still in git's
  index. Committing the deletion clears them — verified.)

### Not yet done

**This phase is unreleased.** Merging to `main`, the `0.1.17` version bump,
the publish and the tag are all still owed. The packages still say `0.1.16`,
which is the npm `latest`; the tag `dshell-v0.1.16` points at `b3d72f9`.

**The exec lane is fixed and re-measured** — see "The exec door was broken
here, and the reading that proved it" above. What is still owed is a real-machine
acceptance pass over every seam that now depends on it: the files panel's
`resolve`/`stat`/`list`, the mount derivation, and the 管理台's WSL card.

Two smaller items are open inside the phase itself:

- **The local Node on this machine is v22.14.0 while the root `package.json`
  declares `engines.node >= 24.11.0`.** The gates above were run on that
  Node, so the version the project asks for is not the version the suite was
  verified on.
- **Windows-only**: the WSL rows are derived from `wsl.exe`, so a machine
  without WSL answers an empty list and the feature is simply absent. The
  provider was not exercised on a non-Windows host in this round.

## Phase 10.51 — port forwards, and a session switch that is not a reconnect

**Commits `8d4615f`, `1064c45`, `5fdfeac`, `0286b1b`, `d1de46f`
(port forwards, 2026-10-31), `a38d27c` and `a3e86b1` (the session switch,
2026-10-31 → 2026-11-01). UNRELEASED.**

The device panel's ports page answers "what is listening". It did not answer
"how do I reach it from here" — and the protocol said so from the start: the
socket list is *what a port-forward would have to bind*.

This adds port forwards: a socket on the reader's machine, and every connection
accepted on it carried over the device's own SSH connection to a port there. It
is a TCP tunnel, not an HTTP proxy, so what travels through it is whatever the
port speaks — a web page, an API, a database wire protocol, a websocket.

### The three halves

- **The tunnel** (`ssh/src/forward/forwarder.ts`). It rides the POOLED
  connection the transport already holds, so a forward costs no extra SSH
  session. The cost of that choice is the thing this has to handle: a channel
  dies with its connection, and the transport re-dials a dead one on its own
  without knowing which forwards were meant to outlive it.
- **The route** (`ssh/src/forward/route.ts`). It names a SESSION, never a
  device — the session decides the machine, the same rule every other
  session-scoped route here follows. It lives in the shared contract layer, so
  the route that answers it and the browser face that reads it cannot drift
  from the forwarder in between.
- **The panel** (`mode/src/client/device-forward.ts`). Every port row carries a
  forward button, and a port that already has one names the local port it landed
  on — the address the reader opens in a browser.

**And the model gets a tool.** `port_forward` is registered in the scope of a
session that runs on a device, and only there: a forward is a tunnel to a
device, and a session on this machine has no device to tunnel to. It follows
the BINDING rather than the agent's birth, so a session bound after its agent
was created still gets it, and it goes away when the session is unbound.

### The two bugs the tunnel needed that a relay does not

Both were found by a tunnel that carried the request and dropped the answer,
and neither is visible in a type check:

- **The two directions are moved by hand rather than by `pipe`.** `pipe` ends
  the destination when the source ends, so a caller that finished writing would
  take the answer with it.
- **The listener is created with `allowHalfOpen`.** Node's default server
  answers a half-close by closing the whole socket — and a half-close is
  exactly what an HTTP client does after it has sent its request.

### The session switch (commits `a38d27c`, `a3e86b1`)

Switching session and coming back re-opens the PTY carrier, so the wire is
briefly `connecting` while the handshake runs. That is a rebind, not a retry,
but the two shared a presentation: `attempt` survived the switch and the
notice rendered "reconnecting (1/3)" over a terminal that was working. Three
changes separate them.

- **The retry budget now resets when a bind opens the carrier**, not only when
  live output arrives. The budget is spent by failures, and the reader choosing
  a session is not one.
- **A replay refills the budget when no death preceded it.** The host sends its
  `closed` frame before the snapshot, so a replay after one describes a shell
  that is still dead and must leave the scheduled retry alone; a replay with
  nothing in front of it is the carrier returning to a shell that never stopped.
- **Readiness crosses a switch as a MEMORY, not as a reset** (`a3e86b1`).
  Switching session and coming back reset `ready` to false, and a device
  session's presentation for "connecting and never answered" is the first-dial
  screen — so every switch to a session whose shell was alive flashed the dial
  panel over a terminal that was about to work. The client now remembers, per
  session and for the page's life, that its shell reached a prompt; the host's
  own ready frame remains the only authority, and the memory covers nothing but
  the window in front of it.

Two host-side changes, both about not destroying work on a false positive: the
`session/disposed` handler now asks `ctx.sessions.get(id)` whether the
session is live again before killing its PTY, and every shell death logs its
reason, because "the terminal died" has several causes that need different fixes.

### Scope

- **Forward direction**: local to device only. The reverse needs
  `forwardIn`, which asks the device's sshd for
  `AllowTcpForwarding remote` — a compatibility cost this does not pay.
- **Lifetime**: a forward belongs to a session and is not persisted. A session
  that ends takes its forwards with it; after a restart the reader asks for the
  ones they want again.
- **Local address**: loopback only.

### Acceptance readings

| Gate | Result |
|---|---|
| `vitest run` | **729 passed / 44 skipped** |
| `tsc -b` | exit 0 |
| new tests | 19 forwarder, 5 route, 7 tool, 3 seat |

The two half-close cases are the ones worth reading: both were found by a tunnel
that carried the request and dropped the answer, and neither is visible in a
type check. The forward was also driven against a real ssh2 server
(`1064c45`) and recorded against the real device (`d1de46f`).

The session-switch fix was verified in the fast-test box container against the
real device: a DOM observer recorded **zero connection-panel mounts across six
session switches** between live device terminals, with each terminal's own
content painted as soon as the switch landed; the panel family still appears
for a session that never reached a prompt (unsupported local, exhausted
retries).

### Not yet done

**This phase is unreleased.** Merging to `main`, the `0.1.17` version bump,
the publish and the tag are all still owed.

The same round also carries the CI fix (`e9b241d`): `actions/checkout@v4` and
`actions/setup-node@v4` still target Node 20, which the runners no longer run
them on — GitHub forces them onto Node 24 and says so in an annotation on every
run. The dsh checkout this repository builds against uses `checkout@v7.0.1` and
`setup-node@v7.0.0`, so this repository now uses those too, and the checkout
stops persisting credentials (no gate here pushes, fetches from this
repository, or reads its history).

---

## The gap this document used to admit

An earlier edition of this file ended with a note admitting a journal gap: the
work between Phase 10.45 (the 0.1.2 release) and Phase 10.46 was never written
up as phases. That gap is now closed, and this section says what filled it.

The unwritten stretch was, in order:

| what | when | where it is now |
|---|---|---|
| the token-usage page (a per-model index and the charts over it) | 2026-09-20 | never had a phase of its own; the package was removed in 0.1.17-alpha.3 — a terminal library has no business owning usage |
| the 0.1.6 alignment and the 0.1.5 release | 2026-09-20 | Phase 10.33's tail; tag `dshell-v0.1.5` |
| the 0.1.7 / 0.1.8 / 0.1.9 / 0.1.10 / 0.1.11 / 0.1.12 / 0.1.13 release line | 2026-09-28 → 2026-09-30 | release-only rounds: each is a `chore(dshell): 0.1.x` commit and a tag, with no feature of its own |
| the device's own shell, the device's credentials in memory, POSIX device paths, the Windows-safe PTY log | 2026-10-20 | Phase 10.46 (`49982c7`) — the in-process `ssh2` transport landed with them, and the credential vault's groups came with it |
| the device metrics readout (the chip) | 2026-10-20 | Phase 10.47's panel is its successor; the chip's own poller is `mode/src/client/device-metrics.ts` |
| the device form moving to vault groups | 2026-10-20 | Phase 10.46's vault card (`ssh/src/client/vault-card.ts`) |
| the 0.1.14 alpha line and the 0.1.14 release | 2026-10-20 | Phase 10.46's "Not yet done" — the line that was owed a decision was released as `0.1.14`, tag `dshell-v0.1.14` (`3ecd82f`) |

Two things in that stretch are worth carrying forward, because they were
recorded in the handover document rather than in a phase:

- **The credential vault's plain state is a BADGE, not an absence.** A group
  with no token stores its credentials UNENCRYPTED, and a row under a heading
  reading "vault" looks protected whether it is or not. The panel says 明文存储
  rather than 未设置密码, and the form that creates a group asks for the token
  first and treats leaving it empty as a deliberate choice.
- **A credential never reaches the browser.** The host opens the credential in
  memory and hands the bytes to the transport; a credential row can say its
  name, its kind and which devices use it, and never what it holds.

The handover document
([`dshell-handoff-2026-10.md`](./dshell-handoff-2026-10.md)) is the CURRENT handover: the live
state, what is released, what is owed, and what is open. It is rewritten at each
handover rather than maintained, so it is the field to read for the present — and
it goes stale the moment the branch is committed or released.

## Phase 10.52 — dsh 0.2.2-rc.1 joins the window

dsh shipped `0.2.2-rc.1` on its `next` tag, and dshell's peer window stopped at
`<0.2.2-0` — so a reader on the new dsh could not install the suite at all. The
rejection is explicit rather than silent, which is the good case:

```
dsh: installation rejected: Plugin @nexus-aethra/dshell-bundle@0.1.16 is incompatible
with dsh 0.2.2-rc.1: requirements { ... ">=0.2.1-rc.2 <0.2.2-0" }. ... To accept this
risk explicitly, grant the exact-version exemption ... with `dsh plugin allow-version`
```

The window is one string in `dsh-upstream.json` (`support.range`) that
`scripts/sync-host-range.mjs` writes into every manifest, so widening it is a
one-line change plus the sync — 219 declaration sites move together or a profile
activates some rows and silently disables the rest. The new upper bound is
`<0.2.3-0`. Checked before it was written — with `includePrerelease: true`, which
is the semantics both gates that matter use: dsh's own check
(`dsh/packages/boot/app-boot/src/plugin-compatibility.ts`) and this repo's
`scripts/tests/manifest-contract.spec.ts`. Under that reading `0.2.2-rc.1`,
`0.2.2-alpha.3` and `0.2.2` all satisfy the range while `0.2.3-rc.1`, `0.2.3` and
`0.3.0` do not. It is a strict superset of the old range: nothing the old window
admitted was dropped.

### What was verified, and where

A dshbox container built from the `dsh-v0.2.2-rc.1` template, host runtime so
`wsl.exe` is reachable, with all twelve dshell packages symlinked to this checkout
— so the container runs the code on this branch, not a published tarball.

| What | Reading |
|---|---|
| install | all twelve packages install |
| GUI | loads; console reports 0 errors |
| provider | `wsl:Ubuntu-24.04` + the dshbox distro, `builtin: true` |
| device list API | 200, both WSL rows |
| bind | 200; mount lands in `mnt\wsl-Ubuntu-24.04\~` |
| WSL terminal | `echo DSHELL_022_OK_42` answers `42`, with Ubuntu 24.04 LTS's banner and system info |
| `router.test` | `已连接 gpumem@LAPTOP-65SFEHRB（Linux 5.15.167 (microsoft-standard-WSL2)） · 334ms` |
| host-key trust | the `主机密钥 SHA256:…` line does NOT appear — the capability bits hold |
| helper deploy | refused, in the provider's own words |

Gates on this branch: 77 vitest files passed + 1 skipped, 786 tests passed / 44
skipped; both `tsc -b` builds exit 0; `sync-host-range.mjs --check` reports every
manifest carrying the same window.

### What is still owed

**The pin still says 0.2.1-rc.3, so the release gate still guards 0.2.1's surface.**
That is deliberate — the pin is what `fetch-upstream.mjs` materializes — but it
means `upstream-surface.spec.ts` asserts against 0.2.1's names, not 0.2.2's. The
window widening is therefore necessary but not sufficient on its own.

The other half is a reading, and it now exists:
`scripts/tests/upstream-surface-any.spec.ts` asks the same question of any checkout
named by `DSH_SURFACE_ROOT`. Measured against a 0.2.2-rc.1 mirror: 156 services,
109 slots, 62 events, and `missingSurface` empty — every name dshell reaches for is
still there. The pinned 0.2.1-rc.3 checkout measures 146/103/62, so 0.2.2 added ten
services and six slots and dropped none that dshell uses. Moving the pin and
re-running the release gate is what remains.

**`0.2.2-rc.1` is a release candidate.** It is verified here on one Windows + WSL2
machine in one container. A `0.2.2` final is inside the window by construction and
has NOT been verified; `0.2.3` and beyond are outside it and want their own pass.
