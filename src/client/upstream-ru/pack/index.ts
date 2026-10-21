/**
 * Aggregator for the ru dictionaries: one module per source package under
 * src/client/ru/. Files are named after the source package (stable even if a
 * package renames its locale namespace); the mapping below owns the namespace
 * ids the locale registry sees. scripts/i18n-audit.mjs loads this module to
 * verify per-namespace coverage against every package's zh keys.
 * @module @linxin666/dsh-i18n/client/ru
 */
import { ru as gitGraph } from './git-graph.js'
import { ru as liangshen } from './liangshen.js'
import { ru as market } from './market.js'
import { ru as pet } from './pet.js'
import { ru as pluginManager } from './plugin-manager.js'
import { ru as presetCenter } from './preset-center.js'
import { ru as remoteBridge } from './remote-bridge.js'
import { ru as remoteWebUi } from './remote-web-ui.js'
import { ru as sessionId } from './session-id.js'
import { ru as sessionArchive } from './session-archive.js'
import { ru as skillExplorer } from './skill-explorer.js'
import { ru as ssh } from './ssh.js'
import { ru as taskBoard } from './task-board.js'
import { ru as taskBoardGithub } from './task-board-github.js'
import { ru as update } from './update.js'
import { ru as usage } from './usage.js'
import { ru as webSettings } from './web-settings.js'

/** ru dictionaries keyed by the locale namespace each source package registers. */
export const ruDictionaries: Record<string, Record<string, string>> = {
  'git-graph': gitGraph,
  'liangshen': liangshen,
  'dsh-web-ui-market': market,
  'pet': pet,
  'settings.pluginManager': pluginManager,
  'dsh-web-ui-preset-center': presetCenter,
  'remote': remoteWebUi,
  'remote-bridge': remoteBridge,
  'session-id': sessionId,
  'dsh-web-ui-session-archive': sessionArchive,
  'dsh-skill-explorer': skillExplorer,
  'dsh-ssh': ssh,
  'task-board': taskBoard,
  'task-board-github': taskBoardGithub,
  'update': update,
  'dsh-web-ui-usage': usage,
  'web-ui-plugins': webSettings,
}
