# Nexus reuse record

Repository: https://github.com/ranxianglei/billion-context

Pinned release source commit: `39a0ada58f396ec6e5ee29fdbaa01c01b74f14d9`

Upstream path: `kernel/`; package version: `acp-kernel 0.0.169`; license: MIT.
This is the kernel in the published `billion-context 0.1.209` release.

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
are retained and rebased from the previous Nexus checkout onto 0.0.169. They
are an indexed archive extension, not files published by upstream. Rebase
retains upstream orphan cleanup, stable reference migration, view/truncation
latches and all-or-nothing compression, together with fail-closed archive
lookups and bounded delta persistence.

The 2026-10-24 rebase also retains upstream failed-compress folding,
bounded receipt protection, middle-system preservation and orphan guards.
All newly published kernel regression tests are retained and discovered by
the normal coordinated test runner. A successful text merge alone is not a
validation result.

The 2026-10-26 three-way rebase retains the local indexed membership path and
adds upstream exact ledger interval coverage, stable stamped citations and
one-time restamping. Unstamped native views continue to use ID membership;
no storage schema or existing session history is rewritten by this upgrade.

The 2026-10-29 rebase preserves local indexed clone ownership while carrying upstream
refLedgerAligned through sync and fold clones. It retains exact covered ranges and the
new upstream schema/coverage regressions without rewriting persisted user sessions.
