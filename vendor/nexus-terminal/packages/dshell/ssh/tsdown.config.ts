// Client bundle for dshell-ssh: same __ModuleLoader__ closure contract as the
// other dshell client faces (see tsdown.dshell.preset.ts).
//
// The second entry is the device-side helper: one self-contained ESM file the
// connection ships to a device and runs there. It is built from source rather
// than from tsc's output because it has no JSX and no browser API to mirror,
// and it must inline everything it imports — the node preset enforces that.
import { dshellClientBundle, dshellNodeBundle } from '../../../tsdown.dshell.preset.ts'

export default [
  dshellClientBundle('@nexus-aethra/dshell-ssh'),
  dshellNodeBundle('src/helper-entry.ts', 'helper'),
]
