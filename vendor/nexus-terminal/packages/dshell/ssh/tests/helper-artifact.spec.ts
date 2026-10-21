/**
 * The device helper artifact: that it is one self-contained file, that the
 * connection manager and the file on disk agree on its identity, and that the
 * one dependency the two ends share is actually shared.
 *
 * Four facts, each of which has already failed once in this work:
 *
 * 1. **Self-containment.** The build enforces it (`onlyImport: []` makes tsdown
 *    fail when anything package-shaped would remain an import, and that gate was
 *    red-light tested: emptying `alwaysBundle` fails the build naming both
 *    offenders). This spec asserts the *artifact* anyway, because the failure it
 *    guards would not appear until a device without a `node_modules` ran it.
 * 2. **Identity agreement.** The digest `localHelperArtifact()` reports is what a
 *    device's helper must echo back in its handshake. The resolver walks to the
 *    package root rather than using a sibling URL, because the host runs either
 *    compiled (`lib/connection.js`) or from source under tsx/vitest
 *    (`src/connection.ts`) and those differ by a directory level — a
 *    sibling-relative path silently points at nothing in one of them, which
 *    would make every device look stale.
 * 3. **One zod.** Both ends are wired through `SshRpcPeer`, whose signature is
 *    written in terms of zod's types. A second copy at a different version does
 *    not degrade gracefully — it fails to compile with "Type instantiation is
 *    excessively deep", naming nothing near the cause. This pins the pair.
 * 4. **No dead intermediates.** `tsc -p` emits JS for every file it checks, so
 *    `lib/helper-entry.js` and `lib/helper/run.js` appear next to the bundle.
 *    They are unreachable once bundled, and `files: ["lib"]` would ship them.
 *
 * Requires `pnpm build` to have run: the artifact is a build output, and this
 * spec refuses to pass vacuously when it is absent.
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { localHelperArtifact } from '../src/connection.js'

// `resolve` strips the trailing slash `new URL('..')` leaves behind; the paths
// below are compared against ones built with `join`, which does not.
const PACKAGE_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const REPO_ROOT = resolve(fileURLToPath(new URL('../../../../', import.meta.url)))
const ARTIFACT = join(PACKAGE_ROOT, 'lib', 'helper.js')

/**
 * Every module specifier the bundle would resolve at runtime.
 *
 * Only text that can *be* an import statement is read, because the bundle keeps
 * its comments: a doc comment containing the words `from "not there"` is prose
 * about a missing file, not a module this artifact would ask for. The bundler
 * hoists every import onto a line of its own, so anchoring to the start of a
 * line separates the two without parsing anything.
 */
function importSpecifiers(source: string): string[] {
  const statements = [...source.matchAll(/^[ \t]*import\b[^\n]*/gm)].map((match) => match[0])
  const specifiers = statements.flatMap(statement => [
    ...statement.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g),
    ...statement.matchAll(/\bimport\s+['"]([^'"]+)['"]/g),
  ])
  return specifiers.map((match) => match[1] as string)
}

/** The version a package resolves to inside one directory's `node_modules`. */
function zodVersion(packageDirectory: string): string {
  const manifest = JSON.parse(readFileSync(join(packageDirectory, 'node_modules', 'zod', 'package.json'), 'utf8')) as { version: string }
  return manifest.version
}

describe('the device helper artifact', () => {
  it('ships as one file that imports nothing but node built-ins', () => {
    expect(
      existsSync(ARTIFACT),
      `${ARTIFACT} is missing; run "pnpm build" before "pnpm test"`,
    ).toBe(true)
    const specifiers = importSpecifiers(readFileSync(ARTIFACT, 'utf8'))
    // A non-empty list proves the extraction works; an assertion over an empty
    // array would pass no matter what the bundle contained.
    expect(specifiers.length).toBeGreaterThan(0)
    expect(specifiers.filter((specifier) => !specifier.startsWith('node:'))).toEqual([])
  })

  it('reports the identity the file actually has', () => {
    const artifact = localHelperArtifact()
    const bytes = readFileSync(ARTIFACT)
    expect(artifact.path).toBe(ARTIFACT)
    expect(artifact.hash).toBe(createHash('sha256').update(bytes).digest('hex'))
  })

  it('shares exactly one zod version with dsh-ssh', () => {
    // The pair, not a number: whichever version dsh-ssh resolves is the one our
    // schemas must be written in, so bumping either side alone is the failure.
    expect(zodVersion(PACKAGE_ROOT)).toBe(zodVersion(`${REPO_ROOT}/dsh/packages/ssh/ssh`))
  })

  it('leaves no tsc intermediate for the tarball to ship', () => {
    for (const dead of ['lib/helper-entry.js', 'lib/helper/run.js']) {
      expect(existsSync(join(PACKAGE_ROOT, dead)), `${dead} should be removed by scripts/drop-intermediates.mjs`).toBe(false)
    }
    // Its neighbour is a real host module and must survive the cleanup.
    expect(existsSync(join(PACKAGE_ROOT, 'lib', 'helper', 'protocol.js'))).toBe(true)
  })
})
