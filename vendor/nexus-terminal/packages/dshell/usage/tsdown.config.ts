// Client bundle for dshell-usage: the same __ModuleLoader__ closure contract as
// the other dshell client faces (see tsdown.dshell.preset.ts). The host half is
// plain tsc output; the charts are hand-rolled SVG in the client face, so there
// is no charting dependency to inline.
import { dshellClientBundle } from '../../../tsdown.dshell.preset.ts'

export default dshellClientBundle('@nexus-aethra/dshell-usage')
