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
// Type-only: pulls the ctx.configForms service merge, which is how this
// plugin's own entry config reaches the browser.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { DSHELL_BUNDLE_NAME, SSH_SETTINGS_NAMESPACE } from '@nexus-aethra/dshell-std'
import { DshellAdminPage } from './admin.js'
import { DshellSshConfigPage } from './card.js'
import { watchDshellNavIcon } from './nav-icon.js'
import type { SshSettings } from '../ssh-settings.js'
import { en, zh } from './locales.js'
import { SshClientService } from './service.js'
import { DshellSessionDeviceButton } from './session-bind.js'

export const name = '@nexus-aethra/dshell-ssh/client'

export const inject = ['slots', 'locale', 'configForms'] as const

/** This package's copy namespace. */
const NS = 'dshellSsh'

export type { DeviceView, DeviceInput, DeviceBinding } from '../protocol.js'
export type { SshSnapshot, SshClientService } from './service.js'
export type { DshellSshKey } from './locales.js'

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dshell-ssh: dictionaries')
  const t = ctx.locale.bind(NS)
  // This plugin's own entry config, reached through the settings domain's
  // shared form service. The namespace is the entry id the bundle patch
  // declares (see ssh-settings.ts), which is what both halves key on.
  const hiddenForm = ctx.configForms.get<SshSettings>(SSH_SETTINGS_NAMESPACE)
  const ssh = new SshClientService(ctx, hiddenForm)
  void ssh.load()
  // The hidden set is a browser-side preference, so it is followed rather
  // than fetched: the card's toggle writes it and the pickers re-render on
  // the same store, and a second browser's write arrives the same way.
  ctx.effect(() => ssh.watchHiddenDevices(), 'dshell-ssh: hidden device mirror')
  // The 管理台: one settings section whose body is a card list contributed by
  // whichever dshell packages are composed in (the children declaration is
  // what authorizes the page's renderSlot). This package owns the frame and
  // contributes the device surface; dshell-mode contributes the terminal and
  // data-root cards into the same seat.
  ctx.slots.inject('settings.section', () => ctx.slots.register(
    {
      name: 'settings.section',
      id: 'dshell',
      order: 45,
      label: () => t('admin.nav'),
      locale: NS,
      children: { 'dshell.admin.card': { kind: 'list', scope: 'root' } },
      inject: () => ({ ssh }),
    },
    DshellAdminPage,
  ))
  // The row's own icon, because this seat carries none: dsh draws a generic
  // gear for any section id it does not ship (see nav-icon.ts).
  ctx.effect(() => watchDshellNavIcon(() => t('admin.nav')), 'dshell-ssh: navigation icon')
  // The device card, into the seat the 管理台 renders: the same surface the
  // Plugins row's configure control opens, so a reader manages devices either
  // beside the plugin or in the console — one component, two doors.
  ctx.slots.inject('dshell.admin.card', () => ctx.slots.register(
    {
      name: 'dshell.admin.card',
      id: 'devices',
      order: 10,
      label: () => t('admin.card.devices'),
      locale: NS,
      inject: () => ({ ssh }),
    },
    DshellSshConfigPage,
  ))
  // A device kind with its own transport and no credential brings its own
  // card, registered into this same seat from its own package: such a kind is
  // a provider's surface, not this registry's.
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
