# Cognition source identity

Repository: https://github.com/FuRongJun-1999/dsh-memory

Published package: `@furongjun1999/dsh-memory 0.9.21`

Observed Git HEAD (not a package gitHead; package identity is npm integrity): `5cf81083a63b80d3383eee0fb3a5a05178f2113a`

Archive integrity:
`sha512-/Xl6bsSbHj6tcid6X6dTJvghan7KGz0rrw7WAkFN9KVMA31mstkQ/c+d2YoZOge4DH013pXZT0fisC2EN09Jag==`

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

The 2026-11-02 release also carries the exact upstream PR729 aliases forwarding fix
in mcp_server.py, op_table.py and writepipe.py. UPSTREAM-FIXES.json records
the published base and exact Git-file hashes. These three source files use
upstream Git LF; their npm base used CRLF. The normalized semantic delta is only
alias parameter discovery, both write outlets and confirmation replay metadata.
The Git-only session5 log resolver is not imported; trusted native identity remains
authoritative. The seven newly published operator documents are copied verbatim.

The public MD-directory specification and two log-index scripts listed in
`VALIDATION-FIXTURES.json` are additional fixtures for the unchanged P27 and
logref regressions. The logref runner uses only synthetic temporary logs.
These scripts are not imported by `nexus_bridge.py`, registered as host hooks,
or executed against user sessions. CI pins zstandard 0.25.0 to exercise the
logref body rather than counting its missing-dependency skip as coverage.
