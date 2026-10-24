# Build, install and remove

## Requirements

- Node.js **24.22.1** LTS recommended (pinned in `.nvmrc`); patched 22.x and
  26.x releases listed in `package.json` are also supported.
- DeepSeek Harness Desktop **0.2.1-rc.3** for runtime installation.
- Windows and PowerShell for the supplied Desktop installer.
- Python 3.10+ for the optional Python memory bridges; check each vendored component's
  `pyproject.toml` or `package.json` and install the dependencies for the feature you enable.
- Optional external memory services and models require their own configuration.

```powershell
npm ci --ignore-scripts
npm run audit:security
npm run check
node tools/acceptance/cognition-upstream.mjs --output evidence/cognition
npm run pack:delivery
```

The tracked `.npmrc` enables `legacy-peer-deps` because some pinned upstream UI
packages declare React 18 peer ranges while the integration uses the host's shared
React 19 identity. The lockfile retains the existing dependency graph. This resolves
installation only; runtime compatibility still requires the relevant Desktop checks.

`engine-strict` rejects Node.js versions older than the October 21, 2026 security
releases. CI and delivery packaging reject all known npm audit findings, including
low-severity advisories. Upgrade the affected package or add a compatible, pinned
override and regenerate the lockfile; do not bypass the check with `--force`.
The Desktop application's embedded Node.js/Electron runtime must be updated by
the host distributor; a plugin dependency update does not replace that runtime.

The build creates the original client adapters and native capability entries before
bundling the host and client. Type checking and tests then run against this build.
Desktop GUI, external-model requests and optional Python/service behavior are not
covered by a successful JavaScript CI job.

The separate cognition check compiles every vendored Python source and executes
all 31 regression modules selected from the 0.9.13 changes and retained source
completion. Each module runs in a separate Python process with isolated memory
roots and an isolated copy of the complete public source. Its report records individual exit codes and optional upstream baseline
skips. Windows desktop control is checked separately with
`node tools/acceptance/computer-use-windows.mjs --fixture-input --output evidence/computer-use`;
that check writes to and captures only its own temporary WinForms window.

## Packaging

The packaging script runs `npm pack`, audits the actual archive and generates:

- A content-addressed `dsh-noemaloom-<version>-<sha256>.tgz`.
- `install-manifest.json`, `install-desktop.ps1`, `install-example.ps1` and `SHA256SUMS.txt`.
- `package-audit.json`, which must pass for packaging to succeed.

All output is written to `build/` and excluded from Git. Build source maps and
upstream runtime assets can be large; distribute runtime packages through GitHub Releases.

## Install

Keep the whole generated `build/` directory together. Save your work and fully exit
Desktop before installing.

```powershell
.\build\install-desktop.ps1 -HarnessDirectory 'C:\Program Files\DeepSeek Harness' -CheckOnly
.\build\install-desktop.ps1 -HarnessDirectory 'C:\Program Files\DeepSeek Harness'
.\build\install-desktop.ps1 -HarnessDirectory 'C:\Program Files\DeepSeek Harness' -VerifyOnly
```

The installer verifies the package digest, host version and installed key-file hashes.
When Desktop is older than the package's required host version, normal installation
first downloads that exact official Windows installer, verifies its pinned size,
SHA-512 and DeepSeek Authenticode publisher, and upgrades the existing installation
directory silently. It then verifies the new bundled CLI version before installing
the plugin. Newer or unrecognized versions are rejected; the script never downgrades.
`-CheckOnly` reports the proposed upgrade without downloading or changing anything.
`-VerifyOnly` never upgrades. Desktop must remain fully exited throughout installation.
Download failures retry three times with backoff; verified installers are cached under
`%LOCALAPPDATA%\dsh-noemaloom\host-installers`. An offline installer can be supplied
with `-HostInstallerPath 'C:\Downloads\deepseek-harness-0.2.1-rc.3-win-x64.exe'`;
the same size, digest and signature checks still apply. The script does not uninstall
Desktop or delete user profiles. An official installer error or version mismatch
stops the operation before plugin installation.

The official release identity is maintained in `scripts/desktop-host-release.json`
and embedded in the generated manifest. Update it with every host target change;
packaging rejects a mismatched version. The delivery example forwards all installer
options, including readonly modes and the offline path.

It uses the Desktop profile under `DSH_HOME`, or the user's `.dsh` when unset.
Reopen Desktop and verify the enabled plugin, configuration and desired runtime features.
The package and plugin registration name is `dsh-noemaloom`. If the former
`@local/dsh-nexus` dependency is present, the installer verifies the replacement
before removing the old registration with the same bundled CLI. Failed legacy
removal withdraws a newly added replacement while the old registration remains.
Existing `data/nexus` storage, settings keys and the `nexus` entry ID are retained.
See [registration and migration](PLUGIN-REGISTRATION.md) for custom module references.

## Remove

Exit Desktop before running:

```powershell
& 'C:\Program Files\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd' plugin --profile desktop remove 'dsh-noemaloom'
```

Restart Desktop and check any custom preset references. Uninstalling the package
does not request deletion of user-created memory, workspaces or sessions.

## Evidence and provenance

`npm test` generates current run records in `evidence/`; they are ignored by Git.
`npm run acceptance:report` evaluates the retained acceptance definitions against
available current evidence. Missing observations remain unverified.

`sources.lock.json` preserves the original source ledger. The old preparation script,
which depended on separate private research directories, is omitted. Upstream source
and license texts are retained; new upstream imports should record exact provenance.

Codinput keeps its pinned source and CommonJS host; its client is rebuilt with
hash-checked compatibility fixes and the audited root dependency lockfile.
The build checks `vendor/codinput/SOURCE.json` before generating the bridge.
See [the integration notes](codinput-upstream.md) for its original surfaces and
Desktop validation targets.
# Native editor assets and debugger acceptance

The normal build also writes `lib/editor/manifest.json` and separately bundled,
local ESM Monaco/worker assets. The main client includes only its native renderer
registration and lazy loader. The build retains exact dependency licenses in
`notices/editor/`; artifact and actual-package audits verify every whitelisted
editor asset hash. Monaco is a build dependency and is not installed into the
Desktop runtime; its compiled assets already include the patched sanitizer.
Debugger binaries remain an on-demand, SHA-256-pinned cache.
See [NATIVE-EDITOR.md](NATIVE-EDITOR.md) for toolchain prerequisites, supported
launch.json features, recovery limits and the real four-language acceptance
command. Run that acceptance only after the complete source batch is frozen.

