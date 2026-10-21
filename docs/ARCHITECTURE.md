# Architecture

| Path | Responsibility |
| --- | --- |
| `src/host/` | Host lifecycle, sessions, tool admission and DSH adapters |
| `src/domain/` | Memory, context, workflows, graph, recovery and storage |
| `src/client/` | React workbench, UI adapters, localization and styles |
| `src/adapters/` | Models, search, VCS and upstream interoperability |
| `src/ports/` | Shared contracts between domain and integration layers |
| `src/workers/` | Isolated execution, parsing and storage workers |
| `src/upstream/` | Selected adapted upstream implementations |
| `vendor/` | Retained third-party source and explicit platform adapters |
| `assets/` | Required runtime templates, presets, catalogs and notices |
| `notices/`, `sources.lock.json` | License texts and source provenance |
| `tests/`, `tools/acceptance/` | Regressions and acceptance tooling |

`build-originals`, `build-native-capabilities` and `build-canvases` prepare upstream
runtime surfaces; `build.mjs` then bundles the host and client. The generated
`src/client/*.generated.js` files and `lib/` output are not tracked.

Root TypeScript modules are project source. JavaScript and Python inside `vendor/`
may be upstream source or required runtime data, so they are not removed by extension.
Vendored licenses, required package metadata and reviewed source hashes are preserved.
Prompt templates and vendored instruction examples are product data, not instructions
to a maintainer operating on this repository.
