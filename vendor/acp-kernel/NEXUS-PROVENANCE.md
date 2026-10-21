# Nexus reuse record

Repository: https://github.com/ranxianglei/billion-context

Pinned source commit: `6deb4547e57af6203bcedd3739fdc63b75443aec`

Upstream path: `kernel/`; package version: `acp-kernel 0.0.136`; license: MIT.

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
