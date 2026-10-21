# Nexus reuse record

Repository: https://github.com/ranxianglei/billion-context

Pinned source commit: `7790bea9178884e70a32bdf7629fd65314b0773e`

Upstream path: `kernel/`; package version: `acp-kernel 0.0.147`; license: MIT.

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
are retained and rebased from the previous Nexus checkout onto 0.0.147. They
are an indexed archive extension, not files published by upstream. Rebase
retains upstream orphan cleanup, stable reference migration, view/truncation
latches and all-or-nothing compression, together with fail-closed archive
lookups and bounded delta persistence.
