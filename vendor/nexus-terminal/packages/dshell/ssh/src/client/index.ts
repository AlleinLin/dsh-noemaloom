/**
 * dshell-ssh browser face: the device page in the Plugins panel and the
 * `dshellSsh` service the session picker reads.
 *
 * The surface is the `dshell-ssh` row's own configuration page: since
 * `0.1.7-rc.2` dsh carries plugin configuration on the Plugins panel, which
 * keys an entry by `<bundle package>#<row id>` and draws a configure control
 * on that row, so a reader configures the device registry beside the plugin it
 * belongs to.
 */

import { type Context } from '@deepseek-ai/cordis'
// Type-only: pulls the renderer-owned slots service (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the locale service (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the workspace SlotMap (`sidebar.workspaces.session.row.action`).
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
// Type-only: pulls the Plugins-panel SlotMap (`plugins.row.config`).
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { DSHELL_BUNDLE_NAME } from '@nexus-aethra/dshell-std'
import { DshellSshConfigPage } from './card.js'
import { en, zh } from './locales.js'
import { SshClientService } from './service.js'
import { DshellSessionDeviceButton } from './session-bind.js'

export const name = '@nexus-aethra/dshell-ssh/client'

export const inject = ['slots', 'locale'] as const

/** This package's copy namespace. */
const NS = 'dshellSsh'

export type { DeviceView, DeviceInput, DeviceBinding } from '../protocol.js'
export type { SshSnapshot, SshClientService } from './service.js'
export type { DshellSshKey } from './locales.js'

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dshell-ssh: dictionaries')
  const ssh = new SshClientService(ctx)
  void ssh.load()
  // The page itself is the registered component: its `t` seat comes from the
  // declared namespace, and the device service travels as the inject face, so
  // both reach it as composed props. The panel keys the entry by the row it
  // configures, which is why the bundle's name is stated rather than inferred.
  ctx.slots.inject('plugins.row.config', () => ctx.slots.register(
    {
      name: 'plugins.row.config',
      key: `${DSHELL_BUNDLE_NAME}#dshell-ssh`,
      locale: NS,
      inject: () => ({ ssh }),
    },
    DshellSshConfigPage,
  ))
  // The per-session device binding rides the stock session row's hover strip:
  // dshell's own session list, which carried the old picker, is gone with the
  // stock workspace UI restored.
  ctx.slots.inject('sidebar.workspaces.session.row.action', () => ctx.slots.register(
    {
      name: 'sidebar.workspaces.session.row.action',
      id: 'dshell-device',
      order: 50,
      locale: NS,
      inject: () => ({ ssh }),
    },
    DshellSessionDeviceButton,
  ))
}
