/**
 * Where dshell-ssh keeps its own files under the harness home.
 *
 * Kept apart from `index.ts` so the modules that need a path (the device
 * registry, the mount mapping, the router) can share one resolution rule
 * without importing the plugin entry — which would be a cycle, since the entry
 * imports them.
 */

import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { DSHELL_HOME_ENV } from '@nexus-aethra/dshell-std'

/**
 * The harness home these paths live under.
 *
 * Three sources, in the order a reader would expect: dshell's own data root
 * (which the host half exports under `DSHELL_HOME` before anything here asks),
 * then the harness's home, then `~/.dsh`. The first is not an alias for the
 * second: moving dsh's home takes sessions and settings with it, and a reader
 * who only wants dshell's files on another disk has to be able to say so.
 *
 * dshell's half of the precedence is read and blank-checked in
 * {@link dshellDataRoot}; everything after it — the harness's own variable, the
 * home fallback, tilde expansion, normalization — is the harness's
 * `resolveDshHome`. `workspace/src/purge.ts` imports this function rather than
 * re-deriving the root, so the resolution rule has one owner;
 * `tests/harness-home.spec.ts` pins the precedence it implements.
 */
export function harnessHome(): string {
  return resolveDshHome(dshellDataRoot())
}

/**
 * dshell's own data root from the environment the mode package exports, blank
 * treated as unset.
 *
 * The blank check cannot be left to `resolveDshHome`: its unset guard covers
 * only the harness's own `$DSH_HOME` lookup, and an explicit empty string is
 * trusted as a `configured` override, which would resolve the root to the
 * process's working directory and make every path built under it relative.
 * This package's own registry and the workspace package's purge both build
 * paths under the result, so the guard is theirs to share.
 *
 * It cannot live in the standard layer instead: that layer is bundled into the
 * client and carries no `node` types by design, and `process.env` needs both.
 */
export function dshellDataRoot(): string | undefined {
  const configured = process.env[DSHELL_HOME_ENV]
  return configured !== undefined && configured.trim().length > 0 ? configured : undefined
}

/** Device directory: registry, secrets, bindings and this plugin's known_hosts. */
export function sshDeviceRoot(): string {
  return join(harnessHome(), 'dshell', 'ssh')
}

/**
 * The host keys this plugin has trusted, one file for all devices.
 *
 * Deliberately not the harness user's `~/.ssh/known_hosts`: a device's host key
 * is this plugin's own record, and mixing the two would make dshell's
 * first-contact decisions that user's ssh client's as well.
 */
export function sshKnownHostsPath(): string {
  return join(sshDeviceRoot(), 'known_hosts')
}

/**
 * Root of the local mount directories that stand in for remote trees.
 *
 * A device-bound session's working directory has to exist on THIS machine —
 * the harness creates it when the session is created and reads it later for
 * instructions and project discovery — so a remote path cannot be the cwd.
 * Instead each device tree is mirrored by an empty local directory here, and
 * every execution seam translates between the two.
 */
export function mountBase(): string {
  return join(harnessHome(), 'dshell', 'mnt')
}
