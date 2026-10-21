/**
 * Where dshell-buffer keeps its own files under the harness home, and how a
 * buffer path is cut apart.
 *
 * Kept apart from `index.ts` so the store and the service can share one
 * resolution rule without importing the plugin entry — which would be a cycle,
 * since the entry imports them.
 */

import { homedir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import { DSHELL_HOME_ENV } from '@nexus-aethra/dshell-std'

/**
 * The harness home these paths live under.
 *
 * dshell's own data root wins over the harness's, then `~/.dsh` — the same
 * three-source rule `dshell-ssh` uses (see `DSHELL_HOME_ENV`), because a
 * deployment that moved one dataset and not the other would leave a reader's
 * buffer state behind on the old disk.
 */
export function harnessHome(): string {
  return process.env[DSHELL_HOME_ENV] ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** Buffer state root: one document holding links, tickets and grants. */
export function bufferRoot(): string {
  return join(harnessHome(), 'dshell', 'buffer')
}

/**
 * Whether `child` lies at or beneath `parent`, compared lexically.
 *
 * Deliberately the same rule the sandbox and the SSH mount mapping use: both
 * sides of every comparison here are already canonical (`ctx.fs.resolve`
 * returns a realpath-shaped `targetKey` on both the local and the device
 * backend), so a lexical prefix test is sound and costs nothing. It is a
 * policy check over a model-controlled path, not a kernel boundary — a symlink
 * created after the check is out of scope for every fence in this codebase.
 *
 * @param parent - absolute directory the containment is measured from.
 * @param child - absolute path to test.
 * @returns whether `child` is inside `parent`.
 */
export function isUnder(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

/** A buffer path cut into the two things every file action needs. */
export interface BufferAddress {
  /** The path's first segment: the mapping name the granter declared with `as`. */
  readonly name: string
  /**
   * What follows it, area-relative: never absolute and never leading with a
   * separator, `''` for the mapped area itself. That is exactly the shape
   * `joinRelative` accepts, so the two halves of a resolution only fit together
   * while this invariant holds — an absolute `rest` is refused as a path escape
   * attempt, which reads to the caller as a permissions problem.
   */
  readonly rest: string
}

/**
 * Split a buffer path — `/mappedName/sub/file` — into the mapping name and the
 * path inside that mapped area.
 *
 * The one place this rule lives. Addressing is per SESSION: a name is looked up
 * across every live grant the caller holds, so the service only ever maps a
 * name to a grant and hands the `rest` to the containment test.
 *
 * @param bufferPath - a path rooted at `/`, as the tool received it.
 * @returns the address, or undefined when the path names no area at all
 *   (`''`, `/`, `//`).
 */
export function splitBufferPath(bufferPath: string): BufferAddress | undefined {
  const clean = bufferPath.replace(/^\/+/u, '')
  const name = clean.split('/')[0] ?? ''
  if (name.length === 0) return undefined
  return { name, rest: clean.slice(name.length).replace(/^\/+/u, '') }
}
