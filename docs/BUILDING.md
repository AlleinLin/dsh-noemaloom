# Build, install and remove

## Requirements

- Node.js 24 LTS recommended; exact supported versions are in `package.json`.
- DeepSeek Harness Desktop **0.2.1-rc.2** for runtime installation.
- Windows and PowerShell for the supplied Desktop installer.
- Python 3.10+ for the optional Python memory bridges; check each vendored component's
  `pyproject.toml` or `package.json` and install the dependencies for the feature you enable.
- Optional external memory services and models require their own configuration.

```powershell
npm ci --ignore-scripts
npm run check
npm run pack:delivery
```

The tracked `.npmrc` enables `legacy-peer-deps` because some pinned upstream UI
packages declare React 18 peer ranges while the integration uses the host's shared
React 19 identity. The lockfile retains the existing dependency graph. This resolves
installation only; runtime compatibility still requires the relevant Desktop checks.

The build creates the original client adapters and native capability entries before
bundling the host and client. Type checking and tests then run against this build.
Desktop GUI, external-model requests and optional Python/service behavior are not
covered by a successful JavaScript CI job.

## Packaging

The packaging script runs `npm pack`, audits the actual archive and generates:

- A content-addressed `local-dsh-nexus-<version>-<sha256>.tgz`.
- `install-manifest.json`, `install-desktop.ps1` and `SHA256SUMS.txt`.
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
It uses the Desktop profile under `DSH_HOME`, or the user's `.dsh` when unset.
Reopen Desktop and verify the enabled plugin, configuration and desired runtime features.
The internal package name remains `@local/dsh-nexus`; some entries still use the Nexus label.

## Remove

Exit Desktop before running:

```powershell
& 'C:\Program Files\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd' plugin --profile desktop remove '@local/dsh-nexus'
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
