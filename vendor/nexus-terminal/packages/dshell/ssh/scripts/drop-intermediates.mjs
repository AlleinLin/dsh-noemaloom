/**
 * Remove the tsc-emitted JS that only the device bundle needed.
 *
 * `tsc -p` emits JS for every file it type-checks, so the device-side sources
 * land in `lib/` alongside the host's. Two of those are dead once tsdown has
 * bundled them into `lib/helper.js`:
 *
 *   lib/helper-entry.js  the bundle's own entry
 *   lib/helper/run.js    the helper's behaviour, reachable only from that entry
 *
 * `lib/helper/protocol.js` is deliberately NOT removed: the connection manager
 * imports it, so it is a real host module.
 *
 * Deleting rather than shipping them keeps `files: ["lib"]` meaning what it
 * says — everything in the tarball is something that runs. The alternative was
 * to narrow `files` with a negation pattern, which npm's `files` matching does
 * not apply consistently.
 */
import { rmSync } from 'node:fs'

for (const path of ['lib/helper-entry.js', 'lib/helper/run.js']) {
  rmSync(path, { force: true })
  // The source map goes with the file it describes: a map without its script
  // is dead weight in the tarball, and `sourceMappingURL` in a shipped file
  // would point at nothing.
  rmSync(`${path}.map`, { force: true })
}
