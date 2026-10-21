// Client bundle for dshell-buffer: same __ModuleLoader__ closure contract as
// the other dshell client faces (see tsdown.dshell.preset.ts).
//
// @xyflow/react is inlined: it renders the pipe graph, it is not a platform
// module dsh serves, and the closure loader's require would fail on it.
import { dshellClientBundle } from '../../../tsdown.dshell.preset.ts'

export default dshellClientBundle('@nexus-aethra/dshell-buffer', 'lib/client/index.js', ['@xyflow/react'])
