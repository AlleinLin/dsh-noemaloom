# Cognition source identity

Repository: https://github.com/FuRongJun-1999/dsh-memory

Published package: `@furongjun1999/dsh-memory 0.9.13`

Release commit: `2710114be671d655056f1c503f973262c8855453`

Archive integrity:
`sha512-hKeVrlvlZWwegzyAuEGOTeD1uHtSH9Zmm8nI4t+agCOCOKvH34W/tib9y2hNaLFFT88ns41tg/GB+gF1BTJrnA==`

The complete upstream `md_cg/` tree, `utf8_boot.py`, policy, character
blocks, package manifest and MIT license are retained. The original npm
ignore file is preserved locally. `nexus_bridge.py` is the separate local
adapter: the host supplies actor, session, allowed layers and write authority,
and each operation uses its own workspace or session storage root.

The host does not execute the upstream installer or register a second set
of global hooks. The coordinated cognition check compiles every Python
source and executes every regression module added or changed in this release,
plus previously omitted upstream conformance and review-layer regressions.
The exact modules and individual exit codes are recorded in its report.

`VALIDATION-FIXTURES.json` records three exact public Git files required by
the unchanged upstream regressions: two specification documents and the Rust
engine source used to compare declared defaults. This does not register or
execute a Rust engine. The check runs from an isolated copy because some
upstream tests create package-relative sample stores.
