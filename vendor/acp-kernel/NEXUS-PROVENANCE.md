# Nexus ACP source identity

Published billion-context 0.1.213 pins `133f3525c628c4b959bb79ece82af6df82e131a3`, `kernel/` 0.0.186, MIT.
The complete 251-file kernel Git tree is compared to the prior 244-file tree. Source/tests and regression fixtures are retained; no global fetch hook or upstream installer is activated.

The local indexed-runtime.ts/indexed-types.ts extension, transactional storage, covered-message lookup and bounded archive queries remain local adaptations. The rebase keeps upstream toolPairExtremes together with indexed coveredMessageIds. wire/bili-message.ts resolves the local types instead of a second kernel package. Three CRLF-only merge conflicts were normalized; unit-projection.ts was explicitly reconciled.

Every kernel test is discovered by the coordinated Node runner. The repository-wide Git compare was truncated at 300 files; the kernel comparison uses both complete Git trees and is not presented as a complete repository review. Exact validation is in docs/release-r54-verification.json.
