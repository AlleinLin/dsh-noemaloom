/**
 * Harness-home resolution — the root the device registry, the mounts and the
 * history purge are all built under.
 *
 * dshell had two private copies of it: `ssh/src/paths.ts` and
 * `workspace/src/purge.ts`. They drifted on the fallback — one used
 * `homedir()`, the other `process.env.HOME ?? '/'` — and neither handled a
 * blank `$DSHELL_HOME`: `??` does not catch an empty string, so the root
 * resolved to `''` and every path built under it became relative to the
 * process's working directory. The purge has now been pointed at this package's
 * {@link harnessHome}, so the rule has one owner and these cases are the ones
 * it must keep answering correctly.
 *
 * Delegating everything to `resolveDshHome(process.env[DSHELL_HOME_ENV])` would
 * not have fixed the blank case either, and case 3 below is the reason nobody
 * shipped it: upstream's unset guard covers only the harness's own `$DSH_HOME`
 * lookup, never the `configured` argument. An explicit `''` is trusted as an
 * override and resolves to the process's cwd. The guard therefore stays in
 * front of the call, and is asserted on its own.
 */

import { homedir, tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DSHELL_HOME_ENV } from '@nexus-aethra/dshell-std'
import { dshellDataRoot, harnessHome } from '../src/paths.js'

const ambientDshellHome = process.env[DSHELL_HOME_ENV]
const ambientDshHome = process.env.DSH_HOME

/**
 * A root, named the way THIS machine names directories.
 *
 * The roots are directories on the host, so they are resolved with the host's
 * rules: a fixture written in POSIX would come back Windows-spelled, and the
 * assertion would be about the spelling rather than about the precedence.
 */
function root(name: string): string {
  return join(tmpdir(), name)
}

afterEach(() => {
  if (ambientDshellHome === undefined) delete process.env[DSHELL_HOME_ENV]
  else process.env[DSHELL_HOME_ENV] = ambientDshellHome
  if (ambientDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = ambientDshHome
})

/** One harness start's worth of the two variables. */
function settle(dshellRoot: string | undefined, harnessRoot: string | undefined): void {
  if (dshellRoot === undefined) delete process.env[DSHELL_HOME_ENV]
  else process.env[DSHELL_HOME_ENV] = dshellRoot
  if (harnessRoot === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = harnessRoot
}

describe('the dshell data root guard', () => {
  it('passes a real root through', () => {
    settle(root('dshell-root-a'), undefined)
    expect(dshellDataRoot()).toBe(root('dshell-root-a'))
  })

  it('treats a blank or whitespace root as unset', () => {
    settle('', root('dsh-root-b'))
    expect(dshellDataRoot()).toBeUndefined()
    settle('   ', root('dsh-root-b'))
    expect(dshellDataRoot()).toBeUndefined()
  })

  it('is undefined when the variable is not exported at all', () => {
    settle(undefined, undefined)
    expect(dshellDataRoot()).toBeUndefined()
  })
})

describe('harness home resolution', () => {
  it('gives the dshell data root the top of the precedence', () => {
    settle(root('dshell-root-c'), root('dsh-root-c'))
    expect(harnessHome()).toBe(root('dshell-root-c'))
  })

  it('falls through to the harness home when the data root is blank', () => {
    settle('', root('dsh-root-d'))
    expect(harnessHome()).toBe(root('dsh-root-d'))
  })

  it('falls back to the harness home when dshell names no root', () => {
    settle(undefined, root('dsh-root-e'))
    expect(harnessHome()).toBe(root('dsh-root-e'))
  })

  it('falls back to the home harness directory when both are unset', () => {
    settle(undefined, undefined)
    expect(harnessHome()).toBe(resolve(join(homedir(), '.dsh')))
  })

  it('expands a tilde in either variable', () => {
    settle('~/dshell-tilde', undefined)
    expect(harnessHome()).toBe(resolve(join(homedir(), 'dshell-tilde')))
    settle(undefined, '~/dsh-tilde')
    expect(harnessHome()).toBe(resolve(join(homedir(), 'dsh-tilde')))
  })

  it('always answers with a normalized absolute root', () => {
    for (const [dshellRoot, harnessRoot] of [
      [`${join(tmpdir(), 'dshell-root-f')}${sep}`, join(tmpdir(), '..', 'tmp', 'dsh-root-f')],
      [join(tmpdir(), 'dshell-root-g'), undefined],
      [undefined, join(tmpdir(), 'dsh-root-h')],
      [undefined, undefined],
    ] as [string | undefined, string | undefined][]) {
      settle(dshellRoot, harnessRoot)
      expect(resolve(harnessHome()), `root: ${JSON.stringify(harnessHome())}`).toBe(harnessHome())
    }
  })
})
