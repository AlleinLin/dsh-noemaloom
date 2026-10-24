# Nexus reuse record

Repository: https://github.com/ranxianglei/billion-context

Pinned release source commit: `f161c51894bad4b9e0da15e29353abf5710689c9`

Upstream path: `kernel/`; package version: `acp-kernel 0.0.161`; license: MIT.
This is the kernel in the published `billion-context 0.1.206` release.

The complete kernel `src/`, upstream `tests/` and fixtures are retained. The
wire/bili-message.ts self-package type import is changed to ../types.js so the
vendored source resolves without a second installed kernel package. Runtime
adapter code lives in `src/adapters/upstream/billion/` and `src/domain/context/`.
The upstream standalone persist adapter is retained as source but is not used
by Nexus; Nexus uses the single shared transactional store. Global hooks and
upstream installer code are not executed.

Upstream test mapping: every `kernel/tests/*.test.ts` maps to the identically
named `vendor/acp-kernel/tests/*.test.ts`. Integration tests live in
`tests/context/`. Tests are written during implementation and run in the
project's coordinated validation stage. This record does not claim a test pass.

Nexus-local indexed-runtime.ts/indexed-types.ts and their integration points
are retained and rebased from the previous Nexus checkout onto 0.0.161. They
are an indexed archive extension, not files published by upstream. Rebase
retains upstream orphan cleanup, stable reference migration, view/truncation
latches and all-or-nothing compression, together with fail-closed archive
lookups and bounded delta persistence.

The 2026-10-24 rebase also retains upstream failed-compress folding,
bounded receipt protection, middle-system preservation and orphan guards.
All newly published kernel regression tests are retained and discovered by
the normal coordinated test runner. A successful text merge alone is not a
validation result.
