/**
 * The per-session device binding, in the native session row.
 *
 * dshell's own session list used to carry the device picker; with the stock
 * workspace UI restored, the binding moves to the one per-session extension
 * point dsh offers on a row — `sidebar.workspaces.session.row.action`, the
 * hover strip beside the stock archive and pin buttons. The button names the
 * device the session runs on (or 本机), and its dropdown rebinds or unbinds
 * through the same route the old dialog used.
 */

import { createElement, useState, useSyncExternalStore, type CSSProperties, type ReactElement } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SshClientService } from './service.js'

/** What the row-action registration injects. */
export interface SessionDeviceSeat {
  readonly ssh: SshClientService
}

type Props = SessionDeviceSeat & PropsRuntime<'sidebar.workspaces.session.row.action'> & PropsLocale<'dshellSsh'>

const buttonStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  maxWidth: 96,
  padding: '1px 6px',
  borderRadius: 4,
  border: '1px solid var(--dsw-border, transparent)',
  background: 'transparent',
  color: 'inherit',
  fontSize: 11,
  lineHeight: '16px',
  cursor: 'pointer',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const panelStyle: CSSProperties = {
  position: 'absolute',
  top: '100%',
  right: 0,
  zIndex: 40,
  minWidth: 132,
  padding: 4,
  borderRadius: 8,
  border: '1px solid var(--dsw-border, transparent)',
  background: 'var(--dsw-menu-bg, Canvas)',
  boxShadow: '0 8px 24px rgb(0 0 0 / 0.18)',
}

const rowStyle: CSSProperties = {
  display: 'block',
  width: '100%',
  padding: '4px 8px',
  borderRadius: 4,
  border: 'none',
  background: 'transparent',
  color: 'inherit',
  fontSize: 12,
  lineHeight: '18px',
  textAlign: 'left',
  cursor: 'pointer',
}

/**
 * The group one device draws its credential from, when that group is locked.
 *
 * A session whose device's credential cannot be opened has no shell to start,
 * and this row is where the reader is looking when they find that out.
 */
function lockedGroupOfDevice(ssh: SshClientService, deviceId: string): { readonly id: string; readonly name: string } | undefined {
  const snapshot = ssh.getSnapshot()
  const credentialId = snapshot.devices.find(row => row.id === deviceId)?.credentialId
  if (credentialId === undefined) return undefined
  const groupId = snapshot.credentials.find(row => row.id === credentialId)?.group
  const group = groupId === undefined ? undefined : snapshot.groups.find(row => row.id === groupId)
  return group?.sealed === true && group.locked ? { id: group.id, name: group.name } : undefined
}

/** One hover-strip button: the session's device, with a rebind dropdown. */
export function DshellSessionDeviceButton({ ssh, sessionId, t }: Props): ReactElement {
  const [open, setOpen] = useState(false)
  const snapshot = useSyncExternalStore(ssh.subscribe, ssh.getSnapshot)
  const key = String(sessionId)
  const binding = snapshot.bindings.find(row => row.sessionId === key)
  const device = binding === undefined
    ? undefined
    : snapshot.devices.find(row => row.id === binding.deviceId)
  const locked = device === undefined ? undefined : lockedGroupOfDevice(ssh, device.id)
  const choose = (deviceId: string | null): void => {
    setOpen(false)
    void ssh.bind(key, deviceId).catch(() => {
      // Binding a device whose credential is locked is the one refusal this row
      // can act on: the bind published the group it is about, so take the
      // reader to that group's unlock box instead of closing the dropdown on
      // silence.
      const wanted = ssh.getSnapshot().lockedGroup
      if (wanted === undefined) return
      ssh.requestUnlock(wanted)
      ssh.revealInSettings()
    })
  }
  const unlock = (group: { readonly id: string; readonly name: string }): void => {
    setOpen(false)
    // The panel opens this group's box on its own — the request is what it
    // reads. Opening the settings dialog is this row's half of the job.
    ssh.requestUnlock(group)
    ssh.revealInSettings()
  }
  return createElement('div', { style: { position: 'relative', display: 'inline-flex' } },
    createElement('button', {
      type: 'button',
      style: locked === undefined
        ? buttonStyle
        : { ...buttonStyle, borderColor: '#d97706', color: '#d97706' },
      title: locked === undefined ? t('bind.title') : t('bind.lockedTitle', { name: locked.name }),
      onClick: () => setOpen(was => !was),
    }, device?.name ?? t('bind.local')),
    open
      ? createElement('div', { style: panelStyle, role: 'menu' },
          locked !== undefined
            ? createElement('button', {
              type: 'button',
              role: 'menuitem',
              style: { ...rowStyle, color: '#d97706' },
              onClick: () => { unlock(locked) },
            }, t('bind.unlockGroup', { name: locked.name }))
            : null,
          createElement('button', {
            type: 'button',
            role: 'menuitem',
            style: rowStyle,
            onClick: () => { choose(null) },
          }, t('bind.local')),
          ...snapshot.devices.map(row => {
            const rowLocked = lockedGroupOfDevice(ssh, row.id)
            return createElement('button', {
              type: 'button',
              role: 'menuitem',
              key: row.id,
              style: rowStyle,
              title: rowLocked === undefined ? undefined : t('bind.lockedTitle', { name: rowLocked.name }),
              onClick: () => { choose(row.id) },
            }, rowLocked === undefined ? row.name : `${row.name} · ${t('bind.locked')}`)
          }),
        )
      : null,
  )
}
