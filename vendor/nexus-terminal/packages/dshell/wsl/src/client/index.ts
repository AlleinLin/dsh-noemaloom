/**
 * dshell-wsl browser face: the 管理台's WSL card.
 *
 * The seat this card renders into is dshell-ssh's `dshell.admin.card` — the
 * admin console authorizes its children declaratively (its `settings.section`
 * carries the children declaration), and dshell-mode already contributes a
 * sibling entry the same way. The device list itself is the SSH client
 * service's, consumed structurally by the `'dshellSsh'` key: a composition
 * that omits dshell-ssh has no device list, and this card renders empty
 * rather than failing to load.
 */

import { type Context } from '@deepseek-ai/cordis'
// Type-only: pulls the renderer-owned slots service (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the locale service (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from './admin-seat.js'
import { DshellWslCard } from './wsl-card.js'
import { en, zh } from './locales.js'

export const name = '@nexus-aethra/dshell-wsl/client'

export const inject = ['slots', 'locale'] as const

/** This package's copy namespace. */
const NS = 'dshellWsl'

export type { DshellWslKey } from './locales.js'

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dshell-wsl: dictionaries')
  const t = ctx.locale.bind(NS)
  // The card's device face is the SSH client service, resolved by key and
  // typed structurally (the sibling pattern dshell-mode's block view uses).
  const sshHost = ctx as unknown as {
    inject(keys: readonly string[], callback: (scope: {
      dshellSsh: {
        getSnapshot(): {
          devices: readonly { readonly id: string; readonly name: string; readonly auth: string; readonly builtin?: boolean }[]
        }
        subscribe(listener: () => void): () => void
        test(deviceId: string): Promise<string>
      }
    }) => void): unknown
  }
  let face: Parameters<Parameters<typeof sshHost.inject>[1]>[0]['dshellSsh'] | undefined
  sshHost.inject(['dshellSsh'], (scope) => { face = scope.dshellSsh })
  // The 管理台's WSL card, into the seat the admin console renders.
  ctx.slots.inject('dshell.admin.card', () => ctx.slots.register(
    {
      name: 'dshell.admin.card',
      id: 'wsl',
      order: 15,
      label: () => t('admin.card.wsl'),
      locale: NS,
      inject: () => ({ ssh: face }),
    },
    DshellWslCard,
  ))
}
