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
  headerStyle, helperStyle, noteStyle, openCardStyle, rowStyle, rowTitleStyle, titleStyle,
} from './card-styles.js'
import type {} from './locales.js'

/** What the card needs of the SSH client service, no more. */
interface SshDevicesFace {
  getSnapshot(): {
    devices: readonly { readonly id: string; readonly name: string; readonly auth: string; readonly builtin?: boolean }[]
    hiddenDevices: readonly string[]
  }
  subscribe(listener: () => void): () => void
  test(deviceId: string): Promise<string>
  setDeviceHidden(deviceId: string, hidden: boolean): Promise<boolean>
}

/** The snapshot an absent ssh face reads as: no devices, nothing to list. */
const NO_DEVICES: {
  readonly devices: readonly { readonly id: string; readonly name: string; readonly auth: string; readonly builtin?: boolean }[]
  readonly hiddenDevices: readonly string[]
} = { devices: [], hiddenDevices: [] }

/** Props the card receives: the translate seat and the structural ssh face. */
export interface DshellWslCardProps extends PropsLocale<'dshellWsl'> {
  readonly ssh: SshDevicesFace | undefined
}

/** The WSL distributions, as the 管理台's own card. */
export function DshellWslCard({ ssh, t }: DshellWslCardProps): ReactElement {
  const [open, setOpen] = useState(false)
  // Why a toggle did not take, when it did not. The write is optimistic, so a
  // refusal arrives AFTER the row has already flipped; without this the reader
  // watches the switch bounce back with nothing said about why.
  const [refused, setRefused] = useState<string | undefined>(undefined)
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
        ...distros.map(device => {
          const hidden = snapshot.hiddenDevices.includes(device.id)
          return createElement('div', { key: device.id, style: rowStyle },
            createElement('span', { style: rowTitleStyle }, device.name),
            createElement('div', { style: { display: 'flex', gap: 8, flexShrink: 0 } },
              // The visibility toggle: the one action a built-in row has that
              // a stored device does not. It says what it does to the PICKERS,
              // because that is all it does — the distro still answers, and a
              // session already bound to it keeps running there.
              createElement('button', {
                type: 'button',
                style: hidden ? { ...actionStyle, opacity: 1 } : actionStyle,
                title: hidden ? t('device.showTooltip') : t('device.hideTooltip'),
                onClick: () => {
                  setRefused(undefined)
                  // Both refusals arrive the same way: a write that was never
                  // attempted (no settings domain, unwritable document) answers
                  // false, and one that was attempted and rejected either
                  // answers false or throws. Either way the service has already
                  // rolled its optimistic value back, so the row returns to
                  // where it was -- and this says why.
                  void (async () => {
                    try {
                      const stored = await ssh?.setDeviceHidden(device.id, !hidden)
                      if (stored !== true) setRefused(t('device.visibilityRefused'))
                    } catch {
                      setRefused(t('device.visibilityRefused'))
                    }
                  })()
                },
              }, hidden ? t('device.show') : t('device.hide')),
              createElement('button', {
                type: 'button', style: actionStyle, title: t('device.testTooltip'),
                onClick: () => { void ssh?.test(device.id).catch(() => {}) },
              }, t('device.test')),
            ),
            hidden
              // Why the row is dimmed, in one line, so a reader who hid it
              // last week is not left guessing what the state means.
              ? createElement('div', { style: noteStyle }, t('device.hiddenNote'))
              : null,
          )
        }),
        createElement('div', { style: helperStyle }, t('wsl.hint')),
        // What hiding does and does not do, stated once on the card rather
        // than on every row.
        createElement('div', { style: noteStyle }, t('wsl.visibilityNote')),
        refused === undefined ? null : createElement('div', { style: { ...noteStyle, color: 'var(--dsw-alias-status-danger, #d97706)' } }, refused),
      )
      : null,
  )
}
