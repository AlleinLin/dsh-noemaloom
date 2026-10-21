<div align="center">

<img src="docs/images/mark.webp" width="96" alt="Noemaloom orbital loom emblem">

# Noemaloom

**Weave memory, context and collaboration into a continuous workspace.**

A memory, context and multi-model orchestration workbench for DeepSeek Harness Desktop.

[![CI](https://github.com/AlleinLin/dsh-noemaloom/actions/workflows/ci.yml/badge.svg)](https://github.com/AlleinLin/dsh-noemaloom/actions/workflows/ci.yml)
[![DSH](https://img.shields.io/badge/DSH-0.2.1--rc.2-b9a4ff?style=flat-square&labelColor=110e25)](https://github.com/deepseek-ai/deepseek-harness)
[![Node](https://img.shields.io/badge/Node.js-24_LTS-b9a4ff?style=flat-square&labelColor=110e25)](https://nodejs.org/)
[![Status](https://img.shields.io/badge/Status-Experimental-e9bda5?style=flat-square&labelColor=110e25)](docs/BUILDING.md)
[![License](https://img.shields.io/badge/License-Component--specific-e9bda5?style=flat-square&labelColor=110e25)](LICENSE)

[Getting started](#getting-started) · [Architecture](docs/ARCHITECTURE.md) · [Contributing](CONTRIBUTING.md) · [简体中文](README.md)

<img src="docs/images/hero.webp" width="100%" alt="An orbital loom weaving memory beads and luminous lavender threads">

</div>

## A place for connected work

An Agent's work spans files, conversations, models and tasks. Noemaloom brings
memory, context compression, orchestration, graphs and workbench surfaces into
one DSH plugin, sharing scope, permissions and lifecycle handling.

The name combines **noema**, the content of thought, with **loom**, the instrument
that weaves separate threads into a continuous fabric.

> Experimental integration. Builds, automated tests, real Desktop behavior,
> external services and long-running model interactions require different forms
> of validation. A successful build is not complete runtime acceptance.

## Capabilities

<img src="docs/images/capabilities.webp" width="100%" alt="Concept illustration of memory, context weaving and connected tasks">

| Area | Source capabilities |
| :--- | :--- |
| Memory and files | File memory, project scope, search and provider adapters |
| Context | Compression, archival and reversible recovery |
| Tasks and models | Workflows, subagents, model discovery and task insights |
| Workbench | Graphs, native UI adapters, terminal and workspace surfaces |
| Engineering | Project rules, methods, resources and extensions |
| Recovery | Request recovery, connections, cancellation and lifecycle management |

Availability depends on the host and configuration. Python memory components need
their own Python dependencies; remote providers need their own service setup.

## Getting started

Target host: **DeepSeek Harness Desktop 0.2.1-rc.2**.
Node.js 24 LTS is recommended. The supplied Desktop installer uses Windows PowerShell.

```powershell
npm ci --ignore-scripts
npm run check
npm run pack:delivery
```

Packaging audits the actual npm archive and writes a content-addressed tarball,
installation manifest, installer and SHA-256 checksums to `build/`.
Save your work and fully exit Desktop before installing:

```powershell
.\build\install-desktop.ps1 -HarnessDirectory 'C:\Program Files\DeepSeek Harness' -CheckOnly
.\build\install-desktop.ps1 -HarnessDirectory 'C:\Program Files\DeepSeek Harness'
```

Reopen Desktop, confirm the plugin is enabled, then configure the desired models,
memory services and workspaces. See [build and installation](docs/BUILDING.md).

> The repository is named `dsh-noemaloom`. Runtime identifiers remain
> `@local/dsh-nexus` and `nexus-*` to preserve preset and adapter compatibility.
> Some host surfaces therefore still show the Nexus name.

## How the pieces connect

<img src="docs/images/workflow.webp" width="100%" alt="Memory beads passing through a loom, a graph and a connected woven fabric">

Host adapters connect DSH sessions, tools and client surfaces to the domain modules.
Scope and permission checks govern execution. Upstream native implementations
retain separate adapters, source identity and license notices.

Explore [architecture](docs/ARCHITECTURE.md),
[context recovery](docs/native-compaction-recovery.md) and [source provenance](sources.lock.json).

| Command | Purpose |
| :--- | :--- |
| `npm run build` | Build host, client, native capabilities and runtime surfaces |
| `npm run typecheck` | Check TypeScript |
| `npm test` | Run tests and write current evidence |
| `npm run verify:artifacts` | Check runtime exports and client isolation |
| `npm run check` | Run the full local verification sequence |
| `npm run pack:delivery` | Build an audited installation delivery |

Generated evidence, dependencies and build output are excluded from Git.

## License and acknowledgements

Original integration code is [MIT-licensed](LICENSE-ORIGINAL).
Third-party source, adapted portions, templates, prompts and assets retain their
component licenses. The complete distribution is not blanket MIT:
read [LICENSE](LICENSE), [NOTICE](NOTICE) and [third-party notices](THIRD-PARTY-NOTICES.md).

This project uses **[acp-kernel](https://github.com/ranxianglei/acp-kernel)** and
**[billion-context](https://github.com/ranxianglei/billion-context)** and preserves
their product attribution terms. Thanks to the DSH community and all upstream authors.
This is an independent community plugin, unaffiliated with DeepSeek.

<sub>Artwork is AI-generated brand concept imagery, not actual UI screenshots or
acceptance evidence. See [generation provenance](docs/images/generation.json).</sub>
