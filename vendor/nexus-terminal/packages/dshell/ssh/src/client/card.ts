/**
 * The dshell-ssh page in the Plugins panel: the device list and the form that
 * adds one.
 *
 * The card shape is the one dsh's settings surfaces use (header disclosure,
 * collapsed first) and needs no save button for the list itself — every action
 * posts immediately — but the add/edit form is staged, because a half-typed
 * host must not be committed by a stray keystroke.
 */

import {
  createElement, useCallback, useEffect, useState, useSyncExternalStore,
  type CSSProperties, type ChangeEvent, type ReactElement,
} from 'react'
import type { PropsLocale, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { DshellSshKey } from './locales.js'
import type { DeviceAuth, DeviceHelperStatus, DeviceView, TrustedHostKey } from '../protocol.js'
import type { SshClientService } from './service.js'
import { VaultCard } from './vault-card.js'
// Type-only: pulls this namespace's key merge (`PropsLocale<'dshellSsh'>`).
import type {} from './locales.js'

const cardStyle: CSSProperties = {
  listStyle: 'none',
  border: '0.5px solid var(--dsw-alias-border-l4)',
  borderRadius: 16,
  background: 'var(--dsw-alias-bg-layer-3)',
  transition: 'border-color .16s, background .16s',
}
const openCardStyle: CSSProperties = {
  background: 'var(--dsw-alias-bg-layer-2)',
  borderColor: 'var(--dsw-alias-label-dimmed)',
}
const headerStyle: CSSProperties = {
  width: '100%', appearance: 'none', border: 0, background: 'none', font: 'inherit',
  color: 'inherit', textAlign: 'left', cursor: 'pointer', display: 'flex',
  alignItems: 'center', gap: 12, padding: '14px 16px', borderRadius: 12,
}
const headTextStyle: CSSProperties = { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }
const descStyle: CSSProperties = {
  fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-primary)', opacity: 0.7,
}
const bodyStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 10, padding: '0 16px 16px' }
const rowStyle: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8, fontSize: 13,
  // Wrapping is what makes the helper line below work: it carries
  // `flexBasis: 100%`, and in a nowrap line that basis competes with the row's
  // own children instead of starting a second line — the actions were squeezed
  // until their labels broke one character per line.
  flexWrap: 'wrap',
  padding: '8px 10px', borderRadius: 10, background: 'var(--dsw-alias-bg-module-platform)',
}
const rowTitleStyle: CSSProperties = {
  flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
}
/** The row's actions, kept on one line whatever the device name costs. */
const actionGroupStyle: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0,
}
const actionStyle: CSSProperties = {
  border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer',
  // An action keeps its own measure: the title already ellipsizes, so there is
  // nothing to gain by letting these shrink, and a shrunken one wraps its
  // label instead of truncating it.
  whiteSpace: 'nowrap', flexShrink: 0,
  fontSize: 12, opacity: 0.75, padding: '2px 6px', borderRadius: 6,
}
const helperStyle: CSSProperties = {
  // `minWidth: 0` lets the line shrink to the row, and `anywhere` breaks the
  // path/digest run: a helper path is one long unbreakable token, and without
  // both it painted straight past the card's edge.
  flexBasis: '100%', minWidth: 0, overflowWrap: 'anywhere',
  fontSize: 11, lineHeight: '16px', opacity: 0.65, padding: '2px 4px 0',
}
const formStyle: CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }
const fieldStyle: CSSProperties = {
  width: '100%', boxSizing: 'border-box', background: 'var(--dsw-alias-bg-module-platform)',
  border: '0.5px solid var(--dsw-alias-border-l4)', borderRadius: 8, color: 'inherit',
  padding: '7px 9px', fontSize: 13, outline: 'none',
}
const noteStyle: CSSProperties = { fontSize: 12, opacity: 0.65, gridColumn: '1 / -1' }
/** The test result: two lines (what answered, then the host key) worth keeping apart. */
const resultStyle: CSSProperties = {
  ...noteStyle, whiteSpace: 'pre-wrap', overflowWrap: 'break-word',
}
const errorStyle: CSSProperties = { fontSize: 12, color: '#f87171', gridColumn: '1 / -1' }
const primaryStyle: CSSProperties = {
  border: 'none', background: 'var(--dsw-alias-button-primary-fill, #4f6bed)',
  color: 'var(--dsw-alias-label-primary-foreground, #fff)',
  cursor: 'pointer', borderRadius: 8, padding: '7px 14px', fontSize: 13, gridColumn: '2 / -1', justifySelf: 'end',
}

/** The credential chips, wrapping: the vault is a library, not a short list. */
const chipRowStyle: CSSProperties = {
  display: 'flex', flexWrap: 'wrap', gap: 6, gridColumn: '1 / -1',
}
/** One credential in the picker: the name, its kind, and the pick made visible. */
const credentialChipStyle = (selected: boolean): CSSProperties => ({
  border: `0.5px solid ${selected ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l4)'}`,
  background: selected ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
  color: 'inherit', cursor: 'pointer', borderRadius: 8, padding: '4px 10px',
  fontSize: 12, whiteSpace: 'nowrap',
})

/** The trust row under a device: label, fingerprint, and the two actions. */
const trustStyle: CSSProperties = {
  flexBasis: '100%', minWidth: 0, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8,
  fontSize: 12, opacity: 0.85,
}
const trustLabelStyle: CSSProperties = { opacity: 0.6 }
const trustValueStyle: CSSProperties = {
  fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  maxWidth: 260,
}
const trustBadgeStyle: CSSProperties = {
  border: '0.5px solid var(--dsw-alias-border-l4)', borderRadius: 999, padding: '1px 7px', opacity: 0.7,
}
const confirmStyle: CSSProperties = {
  flexBasis: '100%', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8,
  border: '1px solid #f87171', borderRadius: 8, padding: '8px 10px', opacity: 1,
}
const dangerActionStyle: CSSProperties = {
  border: '1px solid #f87171', background: 'transparent', color: '#f87171', cursor: 'pointer',
  borderRadius: 8, padding: '3px 10px', fontSize: 12, whiteSpace: 'nowrap', flexShrink: 0,
}

/** Disclosure chevron, drawn to match the sibling cards without importing dsh icons. */
function Chevron({ open }: { open: boolean }): ReactElement {
  return createElement('svg', {
    width: 14, height: 14, viewBox: '0 0 16 16', 'aria-hidden': true,
    style: {
      flex: '0 0 auto', opacity: 0.7, transition: 'transform .16s ease',
      transform: open ? 'rotate(180deg)' : 'none',
    } as CSSProperties,
  }, createElement('path', {
    d: 'M4 6.5 L8 10.5 L12 6.5', fill: 'none', stroke: 'currentColor',
    strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round',
  }))
}

/**
 * The blank form's state.
 *
 * The device itself holds no secret: `credentialId` points into the vault, and
 * the login method follows whichever credential is picked. A device with no
 * credential at all has NO identity to offer — the transport never reaches for
 * an ambient one — so it can only fail to log in.
 */
const BLANK = {
  id: undefined as string | undefined,
  name: '', host: '', port: '22', user: '', remoteRoot: '',
  auth: 'key' as DeviceAuth,
  credentialId: '' as string,
}

/** Field label above the credential picker. */
const labelStyle: CSSProperties = { fontSize: 12, opacity: 0.7, gridColumn: '1 / -1' }

/**
 * The card's composed props: the device service this package injects into the
 * slot, plus the framework-synthesized `t` seat for the declared namespace.
 */
export type DshellSshCardProps = { ssh: SshClientService } & PropsLocale<'dshellSsh'>

/** The card's props as the Plugins panel hands them over, including its view. */
export type DshellSshConfigProps = DshellSshCardProps & {
  /** `summary` is the one-liner the panel falls back to; `page` is the card. */
  readonly view?: 'summary' | 'page' | undefined
}

/**
 * The `dshell-ssh` row's configuration page.
 *
 * The panel renders one entry per row it was handed a page for, and asks it
 * twice: once as the row's one-liner (`summary`, used when the package itself
 * carries no description) and once as the page itself. There is no form to
 * stage here — the device registry writes through its own route — so the page
 * is simply the card, which draws its own chrome.
 *
 * @param props - the device service, the locale seat, and which view to draw.
 * @returns the summary line, or the card.
 */
export function DshellSshConfigPage({ view, ...card }: DshellSshConfigProps): ReactElement {
  if (view === 'summary') return createElement('span', null, card.t('row.summary'))
  // Two cards, stacked, each with its own chrome: the device registry and the
  // credential library it draws from. They are one page because a device row
  // that names a credential is unreadable without knowing what is in it.
  return createElement('ul', {
    style: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 10 },
  },
    createElement(DshellSshCard, card),
    createElement(VaultCard, card),
  )
}

export function DshellSshCard(props: DshellSshCardProps): ReactElement {
  const { ssh, t } = props
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState(BLANK)
  const snapshot = useSyncExternalStore(ssh.subscribe, ssh.getSnapshot)
  // The group that is actually holding a device's credential, read from the
  // current state: a refusal is a moment, and the group stays locked after any
  // other call has answered.
  const lockedGroup = snapshot.devices
    .map(device => ssh.lockedGroupForDevice(device.id))
    .find(group => group !== undefined)
  const edit = (field: keyof typeof BLANK, value: string): void => {
    setForm(current => ({ ...current, [field]: value }))
  }
  const pickCredential = (id: string): void => {
    setForm(current => ({ ...current, credentialId: id }))
  }
  const submit = (): void => {
    // The login method is the credential's, not the form's: a key credential
    // authenticates by key, a password credential by password. With nothing
    // picked the device keeps its own method and its own secret, if any.
    const picked = snapshot.credentials.find(c => c.id === form.credentialId)
    void ssh.save({
      ...form.id === undefined ? {} : { id: form.id },
      name: form.name,
      host: form.host,
      port: Number(form.port) > 0 ? Number(form.port) : 22,
      user: form.user,
      remoteRoot: form.remoteRoot,
      auth: picked?.kind ?? form.auth,
      // Sent even when empty: clearing the reference is the one way back to a
      // device that authenticates without a stored credential.
      credentialId: form.credentialId,
    })
    setForm(BLANK)
  }
  const loadIntoForm = (device: DeviceView): void => {
    setForm({
      id: device.id,
      name: device.name,
      host: device.host,
      port: String(device.port),
      user: device.user,
      remoteRoot: device.remoteRoot,
      auth: device.auth,
      credentialId: device.credentialId ?? '',
    })
  }

  return createElement('li', {
    style: open ? { ...cardStyle, ...openCardStyle } : cardStyle,
    'data-dshell-card': 'ssh',
  },
    createElement('button', {
      type: 'button', style: headerStyle, 'aria-expanded': open,
      onClick: () => { setOpen(value => !value) },
    },
      createElement('span', { style: headTextStyle },
        createElement('span', {
          style: { fontSize: 14, lineHeight: '22px', color: 'var(--dsw-alias-label-primary)' },
        }, t('card.title')),
        createElement('span', { style: descStyle },
          snapshot.devices.length === 0
            ? t('card.empty')
            : t('card.summary', {
              count: snapshot.devices.length,
              names: snapshot.devices.map(d => d.name).join(t('card.nameSeparator')),
            })),
      ),
      createElement(Chevron, { open }),
    ),
    open
      ? createElement('div', { style: bodyStyle },
        ...snapshot.devices.map(device => createElement('div', { key: device.id, style: rowStyle },
          createElement('span', { style: rowTitleStyle },
            `${device.name} · ${device.user}@${device.host}:${String(device.port)}`
            + ` · ${t('device.login', {
              method: device.auth === 'password' ? t('auth.password') : t('auth.key'),
            })}${device.hasSecret ? '' : t('device.noSecret')}`),
          // The actions travel as one unit. Flex breaks lines before it
          // shrinks anything, so four loose buttons let a long device name
          // push the last one onto its own line; grouped and unshrinkable,
          // they always stay together and the title does the yielding.
          createElement('div', { style: actionGroupStyle },
            createElement('button', {
              type: 'button', style: actionStyle, title: t('device.testTooltip'),
              // The refusal is published on the snapshot, which this card
              // renders; catching it here keeps a deliberate refusal from also
              // looking like an unhandled failure in the console.
              onClick: () => { void ssh.test(device.id).catch(() => {}) },
            }, t('device.test')),
            createElement('button', {
              type: 'button', style: actionStyle, title: t('device.installTooltip'),
              onClick: () => { void ssh.install(device.id).catch(() => {}) },
            }, t('device.install')),
            createElement('button', {
              type: 'button', style: actionStyle, title: t('device.edit'),
              onClick: () => { loadIntoForm(device) },
            }, t('device.edit')),
            createElement('button', {
              type: 'button', style: actionStyle, title: t('device.remove'),
              onClick: () => { void ssh.remove(device.id) },
            }, t('device.remove')),
          ),
          device.helper !== undefined
            ? createElement('div', {
              style: helperStyle,
              // The tooltip carries the whole result — the on-device path and
              // both digests. It is diagnostic, so it belongs where a reader
              // goes looking for it rather than on the row.
              title: helperDetail(device.helper),
            }, helperLine(t, device.helper))
            : null,
          createElement(HostTrustLine, { device, ssh, t }),
        )),
        createElement('div', { style: formStyle },
          createElement('input', {
            style: fieldStyle, placeholder: t('form.namePlaceholder'),
            value: form.name,
            onChange: (event: ChangeEvent<HTMLInputElement>) => { edit('name', event.target.value) },
          }),
          createElement('input', {
            style: fieldStyle, placeholder: t('form.hostPlaceholder'),
            value: form.host,
            onChange: (event: ChangeEvent<HTMLInputElement>) => { edit('host', event.target.value) },
          }),
          createElement('input', {
            style: fieldStyle, placeholder: t('form.portPlaceholder'),
            value: form.port,
            onChange: (event: ChangeEvent<HTMLInputElement>) => { edit('port', event.target.value) },
          }),
          createElement('input', {
            style: fieldStyle, placeholder: t('form.userPlaceholder'),
            value: form.user,
            onChange: (event: ChangeEvent<HTMLInputElement>) => { edit('user', event.target.value) },
          }),
          createElement('input', {
            style: fieldStyle, placeholder: t('form.remoteRootPlaceholder'),
            value: form.remoteRoot,
            onChange: (event: ChangeEvent<HTMLInputElement>) => { edit('remoteRoot', event.target.value) },
          }),
          // The credential is the whole login story: the device stores a
          // reference, never a copy, and the method follows the credential's
          // kind. Credentials are made in the vault below — this form only
          // points at one.
          createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, gridColumn: '1 / -1' } },
            createElement('span', { style: labelStyle }, t('form.credentialLabel')),
            snapshot.credentials.length === 0
              ? createElement('span', { style: { fontSize: 12, opacity: 0.65 } }, t('form.vaultEmpty'))
              : createElement('div', { style: chipRowStyle },
                  ...snapshot.credentials.map(credential => createElement('button', {
                    key: credential.id,
                    type: 'button',
                    style: credentialChipStyle(credential.id === form.credentialId),
                    onClick: () => { pickCredential(credential.id) },
                  }, `${credential.name} · ${credential.kind === 'key' ? t('auth.key') : t('auth.password')}`)),
                  // The way back to a device with no credential at all: it has no
                  // identity to offer, so it can only fail to log in.
                  form.credentialId !== ''
                    ? createElement('button', {
                        type: 'button', style: actionStyle, onClick: () => { pickCredential('') },
                      }, t('form.clearCredential'))
                    : null,
                ),
          ),
          snapshot.error !== undefined ? createElement('div', { style: errorStyle }, snapshot.error) : null,
          // A locked group is the one refusal this page can act on: the vault
          // below holds the key. The button re-opens that group's unlock box,
          // because the reader may have scrolled past it — or dismissed the
          // panel — since the refusal arrived.
          // The group is read from the CURRENT state, not from the last
          // refusal: a refusal is a moment, and the group stays locked after
          // any other call has answered. A button that appears only while a
          // refusal is the newest thing on the wire disappears the moment the
          // reader touches the vault — which is where they are going.
          lockedGroup !== undefined
            ? createElement('button', {
              type: 'button', style: actionStyle,
              onClick: () => { ssh.requestUnlock(lockedGroup) },
            }, t('card.goUnlock', { name: lockedGroup.name }))
            : null,
          snapshot.testResult !== undefined ? createElement('div', { style: resultStyle }, snapshot.testResult) : null,
          createElement('button', {
            type: 'button',
            style: primaryStyle,
            disabled: form.host.trim() === '' || form.user.trim() === '',
            onClick: submit,
          }, form.id === undefined ? t('form.submitAdd') : t('form.submitSave')),
        ),
      )
      : null,
  )
}

/**
 * What this plugin trusts for one device, and the way to change that.
 *
 * Its whole point is to be readable BEFORE anything goes wrong. A reader who
 * needs to compare a fingerprint is, by definition, in the middle of something
 * having gone wrong — so a fingerprint that is only shown when a connection
 * fails is a fingerprint nobody has written down.
 *
 * The revoke is two steps because it is irreversible in the one direction that
 * matters: once the record is gone, the next connection trusts whatever answers,
 * with no second look. The confirmation therefore states the consequence rather
 * than asking "are you sure".
 */
function HostTrustLine(props: {
  device: DeviceView
  ssh: SshClientService
  t: TranslateNS<'dshellSsh'>
}): ReactElement {
  const { device, ssh, t } = props
  const [keys, setKeys] = useState<readonly TrustedHostKey[] | undefined>(undefined)
  const [confirming, setConfirming] = useState(false)
  const load = useCallback((): void => {
    void ssh.hostKeys(device.id).then(setKeys)
  }, [device.id, ssh])
  // Asked for on mount rather than on the button: this line is the record of
  // what is trusted, and a row that showed nothing until it was clicked would
  // not be a record.
  useEffect(() => { load() }, [load])
  // A different device is a different trust decision; the panel must not survive it.
  useEffect(() => { setConfirming(false) }, [device.id])

  return createElement('div', { style: trustStyle },
    createElement('span', { style: trustLabelStyle }, t('device.trustLabel')),
    keys === undefined || keys.length === 0
      ? createElement('span', { style: trustValueStyle }, t('device.trustNone'))
      : createElement('span', { style: trustValueStyle, title: keys.map(k => k.fingerprint).join('\n') },
        // One entry is the normal case; several key types on one host would
        // otherwise wrap the row, and the full set stays in the tooltip.
        `${keys[0]?.keyType ?? ''} ${shortFingerprint(keys[0]?.fingerprint)}`),
    // The passphrase badge follows the CREDENTIAL when there is one: a device
    // that logs in through the vault keeps its passphrase in the credential, not
    // beside its own key — and the two views of the same fact must not disagree.
    (device.hasPassphrase === true
      || (device.credentialId !== undefined
        && ssh.getSnapshot().credentials.find(row => row.id === device.credentialId)?.hasPassphrase === true))
      ? createElement('span', { style: trustBadgeStyle }, t('device.passphrase')) : null,
    createElement('button', {
      type: 'button',
      style: actionStyle,
      disabled: keys === undefined || keys.length === 0,
      onClick: load,
    }, t('device.trustRefresh')),
    createElement('button', {
      type: 'button',
      style: actionStyle,
      disabled: keys === undefined || keys.length === 0,
      onClick: () => { setConfirming(true) },
    }, t('device.trustRevoke')),
    confirming
      ? createElement('span', { style: confirmStyle },
        createElement('span', { style: { flex: '1 1 180px', minWidth: 0 } }, t('device.trustRevokeConfirm')),
        createElement('button', {
          type: 'button',
          style: dangerActionStyle,
          onClick: () => {
            setConfirming(false)
            // Revoke, then re-read: the reply is the state the card renders, so
            // it must be the state the file is in after the change, not a guess.
            void ssh.revokeHostKey(device.id).then(setKeys)
          },
        }, t('device.trustRevokeNow')),
        createElement('button', {
          type: 'button',
          style: actionStyle,
          onClick: () => { setConfirming(false) },
        }, t('device.trustRevokeCancel')),
      )
      : null,
  )
}

/** The tail of a `SHA256:…` fingerprint, which is where its entropy is. */
function shortFingerprint(fingerprint: string | undefined): string {
  if (fingerprint === undefined) return ''
  return fingerprint.length <= 20 ? fingerprint : `…${fingerprint.slice(-19)}`
}

/** Pick the right key per state, since template-literal keys are not typed. */function helperLabel(
  t: (key: DshellSshKey) => string,
  state: 'absent' | 'present' | 'mismatch',
): string {
  return t(`device.helperState.${state}` as DshellSshKey)
}

/**
 * The helper line the row shows.
 *
 * A successful deployment shows only its label: `已部署到 <path>` restates the
 * label and then spends the line on a path, which is what a reader needs only
 * when something is wrong. Every other state shows its reason, because that is
 * the part that tells the reader what to do next.
 * @param t - this card's bound copy.
 * @param status - the recorded deployment status.
 * @returns the one-line summary.
 */
function helperLine(
  t: (key: DshellSshKey) => string,
  status: DeviceHelperStatus,
): string {
  const label = helperLabel(t, status.state)
  return status.state === 'present' ? label : `${label} · ${status.message}`
}

/**
 * The diagnostic behind one helper status, for the line's tooltip: the result
 * verbatim plus the on-device path and both digests, whichever the check
 * recorded. Composed from the fields rather than reusing `message`, so the
 * visible line can stay short without dropping anything a reader might need.
 * @param status - the recorded deployment status.
 * @returns one block of text, one fact per line.
 */
function helperDetail(status: DeviceHelperStatus): string {
  return [
    status.message,
    ...status.path === undefined ? [] : [status.path],
    ...status.expected === undefined ? [] : [`expected ${status.expected}`],
    ...status.onDevice === undefined ? [] : [`on device ${status.onDevice}`],
  ].join('\n')
}
