import { copyFileSync } from 'node:fs'
import { dshellClientBundle } from '../../../tsdown.dshell.preset.ts'

copyFileSync(new URL('./src/client/running-whale@2x.png', import.meta.url), new URL('./lib/client/running-whale@2x.png', import.meta.url))

// @xterm/xterm ships the canvas renderer; the combo loader's require only
// knows the dsh platform modules, so it must be inlined into client.js.
export default {
  ...dshellClientBundle('@nexus-aethra/dshell-mode', 'lib/client/index.js', ['@xterm/xterm']),
  loader: { '.png': 'base64' as const },
}
