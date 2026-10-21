# Native file editor and debugger

The editor is a `documentPreviews` renderer inside the existing file tab. The
native tab navigation, split panes and floating panes remain the owners of
layout. Monaco, its styles and five workers load from this plugin only when a
supported file opens. No CDN, marketplace or VS Code extension host is used.
The body font and palette follow the existing Claude theme; code uses monospace.
Better Sidebar's file router yields supported extensions to this renderer.
Its original editor remains available for other formats and previously open tabs.

## Editing and recovery

Use Save or Ctrl/Cmd+S, Find, Replace, and Compare in the file toolbar. Writes
use the existing `files.write` hash check and preserve file encoding/newlines.
If another process changes the file, saving reports a conflict and keeps the
draft. Compare shows the current disk file on the left. After reviewing and
merging the candidate, explicitly adopt the current disk snapshot, then Save.
Discarding a draft requires a confirmation and reloads the disk version.

Monaco models are shared by workspace and canonical file identity, including
across split tabs and sessions in that workspace. Each mounted editor is
disposed on unmount; a clean model cache retains at most16 models /16 MiB.
Plugin unload disposes mounted editors, flushes drafts, releases shared models,
terminates its workers and removes its injected stylesheet.
Drafts persist in the host workspace store, with bounded browser recovery as a
second copy. Reopening a native tab or restarting restores the draft. If the
disk hash changed, recovery keeps the candidate and reports the conflict.
Recovery conflicts require explicitly adopting the reviewed disk base before
saving. A browser candidate is retained when a delayed host draft differs;
server completion timestamps never silently discard local unsaved edits.
The native text-tab API has no asynchronous close veto; closing a tab therefore
retains its recoverable draft.

Editable drafts are limited to512 KiB each and32 files /8 MiB per workspace.
Larger complete text files up to8 MiB open read-only. The model registry admits
at most48 models /64 MiB including mounted views. Clean models are evicted
first; unsaved edits are never silently evicted. Browser recovery retains at
most32 entries /4 MiB and reports storage failures. Save or discard old drafts
when a limit is reached.

## First supported debugger set

| Language | Actual adapter | Default preparation |
| --- | --- | --- |
| TypeScript / Node | Microsoft js-debug DAP1.140.0 | Bundled TypeScript compiler emits local source maps; `.js` runs directly |
| Python | Microsoft debugpy1.8.22 | Select CPython3.10–3.14 x64; the matching pinned wheel loads without pip/global installation |
| Java | Microsoft Java Debug server0.53.2 + Eclipse JDTLS1.63.0 | JDTLS uses a separately cached JDK25; plain Java uses the selected `javac -g`, project configurations use JDT commands |
| C# | Samsung netcoredbg3.2.0-1092 | One adjacent `.csproj` is built in Debug with portable PDBs, or select an already built DLL |

The first artifact catalog targets Windows x64. The four toolchains themselves
remain explicit local prerequisites (`node`, `python`, `javac`/`java`, `dotnet`);
conditional SDK controls accept executable paths. Desktop's Electron executable
is never assumed to be Node. Java target compilation and execution use the
project toolchain; the cached JDK25 only hosts JDTLS (the pinned Eclipse bundles
require Java25, and Java Debug requires the JDK's JDI module).

Rust has a trusted native adapter-factory seam in `AdapterOptions.rust`; no Rust
adapter is shipped or claimed as accepted. `lldb`/`codelldb` configurations direct
users to local VS Code in the default composition.

Open Debug in the native file toolbar, choose a configuration, save edits, and
start. Click the gutter to persist source breakpoints. A hollow marker is
pending; a filled marker reflects adapter verification. Continue, Pause, Step
Over, Step In, Step Out and Stop send real DAP requests. The panel exposes
expandable/paged variables, watch evaluation, threads, stack frames and bounded
target output. Selecting a source frame navigates through the native resource
tab API. Sources outside the authorized workspace or adapter-only
`sourceReference` sources require local VS Code.

## launch.json

The host reads JSONC `.vscode/launch.json` and supports `node`, `node2`,
`pwa-node`, `python`, `debugpy`, `java` and `coreclr` configurations.
Without configurations, it creates a language default for the selected source.
Configuration labels cross the RPC boundary; launch environment values stay on
the host. Supported variables include workspaceFolder, workspaceFolderBasename,
file, fileDirname, fileBasename, fileBasenameNoExtension, relativeFile,
relativeFileDirname, pathSeparator and `${env:NAME}`. Environment substitution
is used only in the launch request and is never exposed as an inherited
environment snapshot.

Use argument arrays. External terminals, process pickers, non-loopback attach,
`${command:…}`, `${input:…}`, `preLaunchTask`, `postDebugTask`, compound launches
and extension-specific resolution need the **Open in VS Code** toolbar action.
Local attach requires an explicit loopback port; Stop disconnects without
terminating an externally attached target. `internalConsole` and
`integratedTerminal` launch inputs are rendered with the native output panel.
Programs requiring interactive terminal input should use local VS Code.

For Java projects choose `mainClass` / `projectName` and optionally `classPaths`
in launch.json. For C# multiple-project directories select `project` or a built
`program` DLL. TypeScript debug emit honors tsconfig, with source maps forced
on and emitted files confined to debugger storage. Projects requiring bundler
tasks or preserved JSX should use a prepared program or local VS Code. Managed
TypeScript output keeps the project's package metadata and links only to
workspace-local `node_modules` for Node dependency resolution. Dependencies
outside that workspace require a prepared program or local VS Code.

## Process ownership, cache and disposal

Debug execution is owner-only authenticated UI work. Model tools cannot start,
evaluate, stop or read the debugger. Configurations and breakpoints belong to a
workspace; running transports, variable references and process handles belong
to the originating session. Resuming invalidates stopped-state references.
Debug failure is local to the debugger and never cancels the agent/task.

All production preparation, adapter and reverse-terminal processes enter the
official subprocess provider, permission authority and sandbox policy. The
provider launches argument arrays with shell disabled and hidden Windows
processes. Cleanup terminates only these managed process ranges and awaits
quiescence. Plugin disposal and session disposal stop their owned debugger.
Requests, protocol history, events, output and variable pages have fixed limits.
Adapter stderr is drained without returning secret diagnostics; explicit launch
secrets are redacted from surfaced output and watch values.

The first launch downloads only the needed fixed-version archives from
`assets/debug-adapters.json`. Each archive's SHA-256 is checked before extraction;
unsafe archive paths/links and expansion beyond budgets are rejected. The
content-addressed cache is under the profile's `data/nexus/debug-cache/adapters`.
An installation receipt hashes every installed file; changed bytes or extra
files produce a repair error. Stop all debug sessions before removing that
specific cache directory to force a verified reinstall. SDK/debug build data is
under `debug-cache/runs`, independently of agent working state. Each owned run
directory is removed only after its managed processes have stopped successfully.

Full local Monaco/dependency licenses are installed under `notices/editor/`.
Original adapter and SDK licenses remain in their verified cache installations;
the adapter archives are not bundled in the delivery package.

## Acceptance after source freeze

Unit regressions cover byte framing, request budgets, actual stopped-event
ordering, delayed adapter cleanup, owner/session/workspace isolation, launch
variables, secret-free configuration labels, draft CAS/recovery, model eviction
and cache integrity.

Run `npm run acceptance:debug -- --id <fresh-id>` after the normal build and
checks. `--seed <directory>` reuses the exact pinned archives already downloaded;
hash verification remains mandatory. The runner uses the same production
runtime/adapters and real compiler/interpreter processes against committed
fixtures. It requires a verified source breakpoint, stopped event, original
source stack, real local `value=21`, a changed location after single-step,
target output `answer=42`, termination and cleanup for all four languages.
The TypeScript case uses an ESM package and a real local bare import; cleanup
also requires the managed run directory to be empty.
Results and source identity receipts are written under `evidence/`. Its
standalone process broker is acceptance-only; Desktop acceptance must also
exercise the official subprocess provider and Electron host environment.

Desktop checks additionally cover native split/remount editing, dirty close and
restart recovery, external CAS conflict, find/replace, diff merge/save, light
and dark theme, worker requests remaining local, gutter verification, expandable
variables, stack navigation, pause/step controls, stop during preparation and
plugin/session cleanup. No behavior is considered accepted merely because a
unit mock, manifest or build exists.
