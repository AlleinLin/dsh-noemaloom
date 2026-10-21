# dshell Phase 0 — Setup notes

The minimum toolchain and workspace shape required to boot dsh with
the dshell bundle active. Read this once before touching the repo on
a fresh machine.

## Branch model

`main` holds the released line only, and is never committed to directly:
work reaches it by squash-merging a pull request once its acceptance
check passes.

Each development direction gets **its own branch** — named after the
direction it serves, not after the phase number — so a line of work can be
reviewed, paused or abandoned without dragging anything else with it. The
branch is **deleted once its pull request is squash-merged** (the
repository's "automatically delete head branches" is on), so the repository
holds `main` and whatever is currently in flight, and nothing else.

The branch list was longer in two ways, and neither survives. The initial
development phase ran on a long-lived `dev`, squash-merged into `main` as
the initial integration; `dev` was then deleted as well, so that phase is
recorded by `main`'s history rather than by a branch. And the branches of
the first sixteen pull requests were kept for a while: a squash leaves a
branch's tip outside `main`'s history, so each one sat there reading as
unmerged work. A branch is not what records what landed — `main` is. To ask
whether a branch's work is already in `main`, compare trees
(`git diff --stat origin/main <branch>` is empty when it is), never
ancestry.

## Required tools

| Tool | Version | Source |
|---|---|---|
| Node | **24.21.0** | nvm |
| pnpm | **9.15.0** | wrapper at `~/.local/bin/pnpm` |
| corepack | bundled with Node 24 | (none — provided) |

These versions are pinned because:

- **Node 24** matches dsh CI (`PRIMARY_NODE_VERSION: '24'` in
  `dsh/.github/workflows/build-preview-cloudflare.yml`); pnpm 11.7.0
  crashes on Node 22 with `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING`.
- **pnpm 9.15.0** is the last release whose default workspace hoist
  matches what `dsh/packages/client/tsdown.client.ts` expects. pnpm 10
  leaves workspace packages un-hoisted and breaks `workspaceManifest`
  inside the bundled build.

## Environment

`~/.bashrc` already exports Node 24 bin and `~/.local/bin` (where the
pnpm wrapper lives). It also sets `npm_config_registry` to the
npmmirror mirror; `~/.npmrc` and `~/.config/pnpm/rc` carry the same
for any tool that does not honor env vars.

If you fork or refresh the machine, recreate the bootstrap in this
order:

```sh
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
. "$HOME/.nvm/nvm.sh"
nvm install 24

# Pin pnpm by direct wrapper (bypass corepack auto-dispatch):
corepack prepare pnpm@9.15.0 --activate
# The wrapper resolves corepack's own cache under $HOME, so it works on any
# machine — the path is derived, never typed in.
cat > "$HOME/.local/bin/pnpm" <<'WRAP'
#!/usr/bin/env node
const { homedir } = require('node:os')
const { join } = require('node:path')
require(join(homedir(), '.cache', 'node', 'corepack', 'pnpm', '9.15.0', 'bin', 'pnpm.cjs'))
WRAP
chmod +x "$HOME/.local/bin/pnpm"

# npm mirror
cat > ~/.npmrc <<'EOF'
registry=https://registry.npmmirror.com/
fetch-retries=5
fetch-retry-mtimeout=60000
EOF
mkdir -p ~/.config/pnpm
cat > ~/.config/pnpm/rc <<'EOF'
registry=https://registry.npmmirror.com/
strict-peer-dependencies=false
auto-install-peers=true
EOF
```

## Workspace shape

The Nexus-Shell repository lives next to the dsh checkout:

```
~/.bashrc                 # node + pnpm bootstrap (created by setup, outside the repo)
Nexus-Shell/
├── dsh/                   # local reference checkout, never tracked
├── docs/                  # design contract and roadmap
├── packages/dshell/
│   ├── bundle/            # dsh bundle: profile patch layer
│   ├── conversation/      # target `terminal`: host stub + browser ViewBuilder
│   ├── terminal-bridge/   # ws upgrade + PtyBuffer (Phase 2+)
│   ├── mode/              # composer toggle (Phase 5+)
│   └── commands/          # /new + model tools (Phase 6/8)
├── scripts/
│   ├── install-into-dsh-profile.sh
│   └── bootstrap-profile-client.sh
├── tsdown.dshell.preset.ts
└── (root) package.json + pnpm-workspace.yaml + tsconfig.*.json
```

`dsh/` is git-ignored in `.gitignore` so the upstream reference is
never accidentally pushed.

## Build order

```
1. dsh/         pnpm install --no-frozen-lockfile   (one-time, pnpm 10 lockfile write is fine)
                pnpm run build:lib
                pnpm run build:web
2. Nexus-Shell/ pnpm install
                pnpm --filter "@nexus-aethra/dshell-*" run build
3. (one-time)   ./scripts/install-into-dsh-profile.sh
4. (one-time)   ./scripts/bootstrap-profile-client.sh
5. (each session) cd dsh && pnpm dsh web
```

After step 4, the dsh web profile picks up dshell automatically — no
`--patch` flag needed — and both the host stack and the client bundle
roster are materialized.

## Why three pnpm operations for the dshell side

- `pnpm install` populates `Nexus-Shell/node_modules` with the dsh
  sibling packages via `link:` paths in each dshell `package.json`.
- `pnpm --filter ... run build` runs `tsc` to emit `lib/index.js` and
  `lib/client/index.js` for every dshell package. dsh resolves those
  files at boot, not the source TypeScript.
- `./scripts/install-into-dsh-profile.sh` runs `pnpm dsh plugin add`
  five times against `$DSH_HOME/profiles/web`, which materializes the
  dshell packages (plus their transitive deps) inside the profile's
  own `node_modules`. Only `dshell-bundle` becomes a `dsh.bundle`
  layer; the other four are plain runtime deps of the bundle.

Re-running the script is safe: pnpm no-ops when packages are already
installed.

## Client bundles: the `__ModuleLoader__` closure contract

dsh's browser side does not load plugins as ES modules. Every client
bundle must be a CJS closure handed to the module table:

```js
window.__ModuleLoader__.load({ id: '<pkg-name>', factory: (require) => {
  var module = { exports: {} }; var exports = module.exports;
  /* ... compiled plugin face ... */
  return module.exports; } });
```

A raw ESM bundle (`export const apply = ...`) throws a syntax error
inside the combo loader, which **kills the whole module table** — the
page then fails with `loaded without registering "<pkg>" via
__ModuleLoader__.load` for *every* dsh package, not just the malformed
one. Symptom: `Failed to load plugins` on boot.

dsh builds its own bundles with `dsh/packages/client/tsdown.client.ts`,
but that preset cannot run outside the dsh repository (its
`workspaceManifest` globs `dsh/packages/*/*` only). The repo-root
`tsdown.dshell.preset.ts` reproduces the artifact contract locally:

- `format: 'cjs'`, `platform: 'browser'`, and `entryFileNames:
  'client.js'` — dsh's bundle server (`dsh-client-modules`) serves
  exactly `lib/client.js` per package under `/plugins/`.
- `banner` / `intro` / `footer` must sit **inside `outputOptions`**,
  matching dsh's own preset. A top-level `banner` is honored but a
  top-level `intro` is silently dropped, and the `intro` is what
  defines the `exports` the CJS interop writes to — losing it yields
  `exports is not defined` at load time.
- The banner stamps the package id into the `__ModuleLoader__.load`
  handoff; it must match the `name` in the package manifest exactly.

Every client-face package wraps the preset in its own
`tsdown.config.ts` and runs it via `tsdown --config-loader tsx`; `tsx`
is a root devDependency because tsdown cannot resolve its own config
loader from a foreign workspace.

A client entry exports **`name`, `inject` and `apply` only** — no
`export default`, matching dsh's own client entries (0 of 46 carry
one). The loader normalizes with `exports.default ?? exports`, so both
shapes reach it as an object with the same three members, but mixing
them makes the emitted `module.exports` ambiguous and rolldown reports
`MIXED_EXPORTS` for that entry; the clean shape is the named-only one,
and the build is expected to be warning-free.

The `dshell-bundle` patch also disables dsh's `client-hmr` row. HMR is
dev-only but ships in the client roster, and a missing HMR bundle is a
hard load failure outside the dsh dev workflow.

## Common pitfalls

- **`Cannot find package '@nexus-aethra/dshell-...' imported from /home/wpp/.dsh/profiles/web/`** — the dshell packages have
  not been installed into the profile. Run
  `./scripts/install-into-dsh-profile.sh`.
- **`Cannot find module '...lib/index.js'`** — the dshell package was
  built but its sibling copy in the profile's `node_modules` is
  stale. Run `pnpm --filter ... run build` again, then
  `./scripts/install-into-dsh-profile.sh`.
- **`Cannot get property "uiConversation" without inject`** — the
  `ConversationViewDefinition` registration belongs in the browser
  face (`src/client/index.ts`), not the host face. `uiConversation` is
  a browser-only service. See
  `packages/dshell/conversation/src/client/index.ts` for the working
  shape.
- **`service "sandbox" has been registered`** — never re-add
  `dsh-sandbox-local` or `dsh-subprocess-local` in the dshell bundle
  patch; dsh's web profile already mounts them. The dshell patch only
  inserts new ids.
- **`tsdown: no packages/*/*/package.json declares the name ...`** —
  dsh's `tsdown.client.ts` globs `dsh/packages/*/*` only. Do not
  reuse it from dshell packages — use the local
  `tsdown.dshell.preset.ts` instead.
- **`loaded without registering "<pkg>" via __ModuleLoader__.load`
  for many packages at once** — one bundle in the combo failed to
  execute. For dshell bundles the usual cause is raw ESM output; see
  the closure-contract section above. Rebuild with
  `pnpm --filter "@nexus-aethra/dshell-*" run build:client`, then
  reinstall and restart.
- **`exports is not defined`** — the tsdown preset's
  `banner`/`footer`/`intro` were hoisted out of `outputOptions`. Only
  the nested form survives; see above.

## Verifying Phase 0

After the build and install steps:

```sh
curl -sS -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3080/
# Expected: 401 (dsh's cookie auth gate, the post-install default)
```

If you see `000`, the server is not up. If you see `200`, you bypassed
the gate — make sure you are not following a redirect from a
tokenized URL.

### What Phase 0 actually proves

The 401 response confirms **three** things and **only** those:

1. dsh's host-side boot succeeded with the `web` profile stack.
2. The `dshell-bundle` patch layer landed in `dsh.profile.bundles`
   (see `$DSH_HOME/profiles/web/package.json`) and the dshell Cordis
   plugins activated without throwing.
3. dsh's cookie-auth gate (`ctx.connection.authorizeIndex`) is
   reachable.

The 401 alone does **not** prove the browser UI renders. dsh's web
profile populates its `client/` roster from `apps/web/package.json`'s
dev deps plus the `dsh.client` rows in
`bundle/web-app/cordis.patch.yml`, and the corresponding
`lib/client.js` files must exist under
`$HOME/.dsh/profiles/web/node_modules/@deepseek-ai/...`. On a fresh
profile **none of those client bundles are materialised** — dsh
assumes the profile lives inside the dsh monorepo and reaches every
package via workspace `link:` paths, but dshell runs the profile as an
independent workspace. Two provisioning steps close the gap:

1. `./scripts/install-into-dsh-profile.sh` — registers the four dshell
   plugins plus the bundle layer (see *Why three pnpm operations*).
2. `./scripts/bootstrap-profile-client.sh` — mirrors dsh's monorepo
   dependency closure into the profile by adding every
   `@deepseek-ai/dsh-*` runtime dep of `dsh-web-app` as a `link:` spec
   pointing at the sibling `dsh/` checkout (~82 packages), which also
   exposes the built `dsh-web-frontend` dist. Re-running is safe.

Browser-side acceptance after both steps: the page renders the full
dsh UI with no `Failed to load plugins` banner, and the boot payload
(`window.__DSH_BOOT__.entries`) advertises all client entries including
the three dshell bundles (`dshell-conversation`,
`dshell-terminal-bridge`, `dshell-mode`). Verified in-browser
on 2026-09-09.

## The data directory

dshell's own files live under a harness home — `$DSH_HOME`, else `~/.dsh` — in
two trees: `dshell/` (device registry and keys, buffer state, session tags, the
mount points device sessions stand in) and `dshell-pty/` (transcripts, their
timelines, the history database). Nothing else of dsh's is in them, which is why
they can be moved on their own.

Settings → 插件 has a 数据目录 card of its own (the terminal card next to it stays
about the composer): 「选择…」 opens a picker that browses THIS machine's
directories (the harness's, not a device's), with a 新建目录 field for a directory
that does not exist yet, and 恢复默认 puts the choice back to the harness home.
Three properties worth knowing before using it:

- **It takes effect at the next start**, because a running harness cannot move
  files it is writing, and the next start MOVES the trees above rather than
  copying them. One thing deliberately stays behind: `dshell/mnt/**` (each
  directory is a session's working directory, which dsh recorded as an absolute
  path). Nothing at the destination is overwritten; a collision is reported on
  stderr and left alone on both sides.
- **Clearing the field brings the files back.** The default root keeps a record
  of where its data went (`dshell/.dshell-data-root`), so 恢复默认 relocates them
  home at the next start instead of leaving the reader with an empty registry.
- **The picker can create the directory**, one path segment at a time, inside
  whatever it is showing. That is the only place dshell writes outside its own
  trees, and it refuses anything that is not a plain name (no `/`, no `.`/`..`).

For scripted deployments, `DSHELL_HOME` overrides the directory from outside and
takes precedence over the setting. It deliberately never migrates anything: a
`DSHELL_HOME=/tmp/scratch dsh web` used as a sandbox must not relocate real data.

`docs/dshell-architecture.md` § 15 has the full rules, including why the choice is
published to the other plugins as a service rather than an environment variable.

## The application icon

Upstream ships no icon — no `icon` field in its electron-builder config, no asset
under `apps/desktop` — so every build before this one wore the default Electron
atom in the launcher, the dock and the taskbar. `scripts/linux-desktop.mjs` points
the Linux target at `assets/icons/linux/`, and `scripts/electron-builder.linux.config.mjs`
applies it. The mark is dshell's own: a prompt (chevron and block cursor) with a
spark beside it.

The assets are committed, so a build needs nothing installed to use them. To
change the mark, edit the SVG sources in `assets/icons/` and re-rasterize — this
is the exact command, run from the repo root, with Inkscape 1.x:

```bash
inkscape --export-type=png --export-filename=assets/icons/linux/16x16.png  -w 16  assets/icons/icon-16.svg
inkscape --export-type=png --export-filename=assets/icons/linux/32x32.png  -w 32  assets/icons/icon-small.svg
for n in 48 64 128 256 512; do
  inkscape --export-type=png --export-filename=assets/icons/linux/${n}x${n}.png -w $n assets/icons/icon.svg
done
```

Three sources, not one, because the mark is redrawn rather than scaled for the
smallest sizes: `icon.svg` carries the spark and serves 48 px and up,
`icon-small.svg` drops it for 32 px, and `icon-16.svg` pulls the chevron in and
stretches the cursor into a bar so the two glyphs still read as `>_` in a 16 px
launcher row. electron-builder takes the file NAMES as the sizes — it never
re-measures a directory's icons — so a PNG saved at the wrong size ships a
blurred icon and says nothing; `pnpm test` checks every name against its pixels.

## Installing the desktop app

`pnpm package:linux` produces two artifacts in
`dsh/apps/desktop/.desktop-build/targets/linux-x64/artifacts/`: the AppImage,
which runs without installing anything, and a `.deb`, which installs. The `.deb`
is the one to use if the app should appear in the launcher and on `PATH`:

```bash
pnpm package:linux                                   # build both
sudo apt install ./.desktop-build/…/artifacts/deepseek-harness-0.1.5-rc.2-linux-amd64.deb
deepseek-harness                                     # or launch it from the app grid
```

Install with `apt`, not `dpkg -i`: the package depends on the GTK/NSS/X11
libraries Electron needs, and only apt resolves them (on Ubuntu 24.04 and later
the `t64` names satisfy those dependencies through `Provides`). What lands:

| path | what |
|---|---|
| `/opt/DeepSeek Harness/` | the app, its bundled Node runtime and the seeded packages (~670 MB) |
| `/usr/bin/deepseek-harness` | an `update-alternatives` link to the binary above |
| `/usr/share/applications/deepseek-harness.desktop` | the launcher entry, `Icon=deepseek-harness` |
| `/usr/share/icons/hicolor/{16…512}x{…}/apps/deepseek-harness.png` | the mark, from `assets/icons/linux/` |
| `/etc/apparmor.d/deepseek-harness` | upstream's profile, needed on Ubuntu 24+ where unprivileged user namespaces are restricted |

The package's `postinst` is upstream's, and it is what makes the app start at all
on a modern Ubuntu: it loads that AppArmor profile and picks the sandbox mode
(`chrome-sandbox` stays 0755 when user namespaces work). That is also why the
`.deb` needs no `--no-sandbox` in its `Exec` line, while the AppImage's upstream
entry carries one.

`fpm` refuses to build a `.deb` without a maintainer and a project URL, and
neither upstream's `package.json` nor ours carries either — see
`scripts/linux-desktop.mjs` for where both come from. Two names are upstream's
and not dshell's: the package installs as `deepseek-harness` under
`/opt/DeepSeek Harness`, and the launcher entry reads `DeepSeek Harness`. To
uninstall: `sudo apt remove deepseek-harness`.

The app that installs is upstream's desktop shell carrying upstream's seeded
package set — dshell is not among them, so a fresh install boots dsh's own UI.
dshell goes in afterwards, and the desktop app is stricter about how than the web
harness is.

### Putting dshell inside the installed app

The app generates its own pnpm profile at `~/.dsh/profiles/desktop` from the seed
in its `resources/`, and loads whatever `dsh.profile.bundles` names *after*
upstream's two built-ins (`@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-web-app`) —
that tail is the app's plugin list. Two rules the app enforces before it will
boot:

- every bundle must be the **first** entries in that list, and anything after
  them must be a valid package name;
- every bundle must resolve **inside the profile**. `link:` dependencies pointing
  at this checkout — how `~/.dsh/profiles/web` installs dshell — are rejected
  with `plugin bundle "@nexus-aethra/dshell-bundle" resolved outside the desktop
  profile`. The packages have to be installed into the profile from a registry.

`scripts/local-registry.mjs` exists for exactly this (it was built to prove the
packed manifests are installable), so:

```bash
# 1. pack dshell and serve it locally
for d in packages/dshell/*/; do (cd "$d" && pnpm pack --pack-destination /tmp/dshell-packs); done
node scripts/local-registry.mjs --port 4873 --dir /tmp/dshell-packs &

# 2. no upstream package needs copying into the registry any more. Checked
#    against the 0.2.0-rc.2 desktop runtime
#    (`resources/app/dsh/node_modules/@deepseek-ai/`, 278 `dsh-*` packages): it
#    ships every package the dshell client bundle imports at runtime —
#    `dsh-client-store`, `dsh-client-ui-slots`, `dsh-client-ui-primitives`,
#    `dsh-terminal`, `dsh-client-ui-input-trigger`, `dsh-client-ui-plugin-manager`.
#    The one name it does NOT ship, `dsh-client-ui-dockkit`, is imported
#    type-only (`import type { TabId }`) by dshell-files, so it is erased from
#    the built client and stays a dev/peer entry only.

# 2b. `@deepseek-ai/dsh-ssh` needs no step of its own since dshell 0.1.7: the
#     desktop seed neither builds nor ships it (it is absent from the release's
#     own `desktop-packages.json`, and still absent from the 0.2.0-rc.2
#     runtime), and dshell-ssh imports `SshRpcPeer` and
#     `RemoteOperationError` from it at runtime, so that row now declares it as a
#     DEPENDENCY and an install brings it. Before 0.1.7 it was a peer only, which
#     is why enabling the bundle failed with `dshell-ssh: failed to import` — and
#     because the patch hands `ctx.fs` to that row, `fs` never appeared and the
#     session controller, the workspace files and the deliverables tabs sat at
#     "pending (waiting for service: fs)".

# 3. in ~/.dsh/profiles/desktop/package.json: add
#    "@nexus-aethra/dshell-bundle" at the release you packed to "dependencies"
#    (it brings the other ten) and append it to dsh.profile.bundles. Then
#    install with the app's OWN runtime, from that directory — 0.2.0 moved the
#    bundled node under primary-runtime:
"/opt/DeepSeek Harness/resources/runtime/primary-runtime/dependencies/node/bin/node" \
  "/opt/DeepSeek Harness/resources/runtime/pnpm/bin/pnpm.mjs" \
  --config.registry=http://127.0.0.1:4873/ --config.enable-global-virtual-store=false \
  install --no-frozen-lockfile
```

Restart the app afterwards. The registry is needed only while installing — the
packages are copied into the profile, not linked to it.

Two consequences worth knowing. Any transaction the app's own plugin window
performs installs from `registry.npmjs.org` (pinned in its `project-manager`),
where these packages exist only at their published versions — not this
checkout — so a plugin installed or removed from the UI may replace the local
build with the published one. And the app checks upstream's update feed on every
start (`download.deepseek.com/…/linux-x64/`), which carries no Linux channel: it
logs a 404 and stays quiet unless you ask for an update check from the menu.

## Where to go next

- Read [`dshell-design.md`](./dshell-design.md) and
  [`dshell-architecture.md`](./dshell-architecture.md) before
  touching Phase 1+ code.
- Phase 0.5 (client provisioning, closure-format bundles, in-browser
  verification) is complete — its artifacts are the two
  `scripts/*.sh` files and `tsdown.dshell.preset.ts`. Continue with
  Phase 1+ in [`dshell-roadmap.md`](./dshell-roadmap.md).
- The `terminal` target's browser ViewBuilder keeps its empty snapshot
  shape until Phase 4 adds the xterm.js canvas.