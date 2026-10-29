# Cognition source identity

Repository: https://github.com/FuRongJun-1999/dsh-memory

Published package: `@furongjun1999/dsh-memory 0.9.16`

Release commit: `72fd465db69bb7edcfed54b1a9e03c88b7e27ea2`

Archive integrity:
`sha512-eCHFgxEdnsgPe6aeNdIKkfuODRFV9Hje3pzKbeLG4cfRlKzGBr13YIEzEiTfVYCaQpsQzIxuyFu26HnquHg4OQ==`

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

`VALIDATION-FIXTURES.json` records exact public release fixtures required by
the unchanged Python regressions: specification documents, Rust source, UI
source, build script, integrity manifest and payload. These fixtures do not
register or execute a Rust engine or the upstream installer. UI tests write
only to temporary directories. The isolated source copy receives a synthetic
Git HEAD before testing so the upstream oracle and its negative control run
without access to the working repository or user Git hooks.
