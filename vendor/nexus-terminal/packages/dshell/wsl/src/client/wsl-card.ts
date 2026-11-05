/**
 * The 管理台's WSL card: the distributions this machine could run shells in.
 *
 * A distribution is a BUILT-IN device — it appears with detection, carries no
 * credential, and cannot be edited or deleted — so it reads badly inside the
 * SSH registry card, whose rows are about credentials and whose actions are
 * refusals here. This card is the distro's own surface: what was detected,
 * whether it answers, and the one direction a reader can take (bind a
 * session from the creation page).
 *
 * The chrome is the registry card's, copied rather than re-invented (see
 * `card-styles.ts`): two cards on one page draw as siblings or not at all.
 * The device list and the test action are the SSH client service's, consumed
 * structurally by key — a composition without dshell-ssh has no device list
 * to show and this card simply stays empty.
 */

import { createElement, useState, type ReactElement } from 'react'
import { useSyncExternalStore } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import {
  actionStyle, bodyStyle, cardStyle, Chevron, descStyle, headTextStyle,
  headerStyle, helperStyle, openCardStyle, rowStyle, rowTitleStyle, titleStyle,
} from './card-styles.js'
import type {} from './locales.js'

/** What the card needs of the SSH client service, no more. */
interface SshDevicesFace {
  getSnapshot(): {
    devices: readonly { readonly id: string; readonly name: string; readonly auth: string; readonly builtin?: boolean }[]
  }
  subscribe(listener: () => void): () => void
  test(deviceId: string): Promise<string>
}

/** The snapshot an absent ssh face reads as: no devices, nothing to list. */
const NO_DEVICES: { readonly devices: readonly { readonly id: string; readonly name: string; readonly auth: string; readonly builtin?: boolean }[] } = { devices: [] }

/** Props the card receives: the translate seat and the structural ssh face. */
export interface DshellWslCardProps extends PropsLocale<'dshellWsl'> {
  readonly ssh: SshDevicesFace | undefined
}

/** The WSL distributions, as the 管理台's own card. */
export function DshellWslCard({ ssh, t }: DshellWslCardProps): ReactElement {
  const [open, setOpen] = useState(false)
  const snapshot = useSyncExternalStore(ssh?.subscribe ?? (() => () => {}), ssh?.getSnapshot ?? (() => NO_DEVICES))
  const distros = snapshot.devices.filter(device => device.builtin === true && device.auth === 'wsl')
  return createElement('div', {
    style: open ? { ...cardStyle, ...openCardStyle } : cardStyle,
  },
    createElement('button', {
      type: 'button', style: headerStyle, 'aria-expanded': open,
      onClick: () => { setOpen(value => !value) },
    },
      createElement('span', { style: headTextStyle },
        createElement('span', { style: titleStyle }, t('admin.card.wsl')),
        createElement('span', { style: descStyle },
          distros.length === 0
            ? t('wsl.empty')
            : t('wsl.summary', {
              count: distros.length,
              names: distros.map(d => d.name).join(t('card.nameSeparator')),
            })),
      ),
      createElement(Chevron, { open }),
    ),
    open
      ? createElement('div', { style: bodyStyle },
        ...distros.map(device => createElement('div', { key: device.id, style: rowStyle },
          createElement('span', { style: rowTitleStyle }, device.name),
          createElement('div', { style: { display: 'flex', gap: 8, flexShrink: 0 } },
            createElement('button', {
              type: 'button', style: actionStyle, title: t('device.testTooltip'),
              onClick: () => { void ssh?.test(device.id).catch(() => {}) },
            }, t('device.test')),
          ),
        )),
        createElement('div', { style: helperStyle }, t('wsl.hint')),
      )
      : null,
  )
}
