// Client bundle for dshell-wsl: the same __ModuleLoader__ closure contract as
// the other dshell client faces (see tsdown.dshell.preset.ts). The host half is
// plain tsc output; the card is hand-rolled styles in the client face, so there
// is no styling dependency to inline.
import { dshellClientBundle } from '../../../tsdown.dshell.preset.ts'

export default dshellClientBundle('@nexus-aethra/dshell-wsl')
