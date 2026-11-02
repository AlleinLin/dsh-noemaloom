import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * Specs for dshell's PURE logic — the parts that answer a question rather than
 * talk to a service: the shell line's tokenizer and position rule table
 * (`std`), and the parsers and caches the host halves keep next to them.
 *
 * Two deliberate limits, both about keeping the suite independent of the
 * harness: the environment is plain Node (no DOM, no jsdom), and specs import
 * SOURCE — the workspaces link each package's built `lib/`, so without the
 * alias below a spec would silently test a stale artifact instead of the code
 * it is next to. Anything needing a session, a PTY, or a browser is verified
 * against a live harness instead (see docs/dshell-roadmap.md).
 *
 * `scripts/tests` is in scope for the same reason: the packaging helpers there
 * are ordinary functions, the icon set is a fact about files rather than about
 * the harness, and `manifest-contract.spec.ts` holds the workspace's agreement
 * with the host checkout — the pins, the overrides they resolve through, the
 * client module table, and the install recipe's package list.
 */
export default defineConfig({
  resolve: {
    alias: {
      react: fileURLToPath(new URL('./packages/dshell/mode/node_modules/react', import.meta.url)),
      '@nexus-aethra/dshell-std': fileURLToPath(new URL('./packages/dshell/std/src/index.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['packages/*/*/tests/**/*.spec.ts', 'scripts/tests/**/*.spec.ts'],
    // The surface specs walk the whole upstream checkout -- 358 packages of source --
    // and parse four catalogs out of it. That is a filesystem walk of a size the
    // default five-second budget does not cover, and a CI runner is slower than a
    // developer machine. The upstream project raises the same budget for its own
    // equivalent checks (`DSH_COVERAGE_TEST_TIMEOUT_MS`), for the same reason.
    testTimeout: 120_000,
  },
})
