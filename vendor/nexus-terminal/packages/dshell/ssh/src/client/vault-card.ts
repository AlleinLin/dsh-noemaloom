/**
 * The vault panel: groups, their tokens, and the credentials inside them.
 *
 * Everything here exists to keep one confusion from happening. A group with no
 * token stores its credentials UNENCRYPTED, and a row that sits under a heading
 * reading "vault" looks protected whether it is or not. So the plain state is a
 * badge on the group rather than an absence, the form that creates one asks for
 * the token first and treats leaving it empty as a deliberate choice, and the
 * wording says "明文存储" rather than "未设置密码".
 *
 * The panel also carries no secret. A credential row can say its name, its kind
 * and which devices use it; it can never show what it holds, because the host
 * opens the credential in memory and hands the bytes to the transport — never to
 * the browser.
 */

import {
  createElement, useEffect, useState, useSyncExternalStore,
  type ChangeEvent, type CSSProperties, type ReactElement,
} from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { CredentialKind, CredentialView, SshKeyFile, VaultGroupView } from '../protocol.js'
import type { SshClientService } from './service.js'
import type {} from './locales.js'

/** The bound translator of this package's namespace. */
type SshTranslate = TranslateNS<'dshellSsh'>

/** Props of the panel. */
export interface VaultCardProps {
  readonly ssh: SshClientService
  readonly t: SshTranslate
}

const cardStyle: CSSProperties = {
  listStyle: 'none', border: '0.5px solid var(--dsw-alias-border-l4)', borderRadius: 16,
  background: 'var(--dsw-alias-bg-layer-3)', overflow: 'hidden',
}
const openCardStyle: CSSProperties = { display: 'flex', flexDirection: 'column' }
const headerStyle: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left',
  border: 'none', background: 'transparent', cursor: 'pointer', padding: '14px 16px', color: 'inherit',
}
const bodyStyle: CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 8, padding: '0 16px 16px',
}
const fieldStyle: CSSProperties = {
  background: 'var(--dsw-alias-bg-layer-2)', color: 'inherit',
  border: '0.5px solid var(--dsw-alias-border-l4)', borderRadius: 8, padding: '6px 10px', fontSize: 13,
}
const actionStyle: CSSProperties = {
  border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer',
  fontSize: 12, opacity: 0.75, padding: '2px 6px', borderRadius: 6, whiteSpace: 'nowrap', flexShrink: 0,
}
const primaryStyle: CSSProperties = {
  // The fill and its foreground are a pair from the design system: on the dark
  // theme the fill is near-white, so a literal `#fff` label would vanish on it.
  border: 'none', background: 'var(--dsw-alias-button-primary-fill, #4f6bed)',
  color: 'var(--dsw-alias-label-primary-foreground, #fff)',
  cursor: 'pointer', borderRadius: 8, padding: '6px 14px', fontSize: 13,
  whiteSpace: 'nowrap', flexShrink: 0,
}
const noteStyle: CSSProperties = { fontSize: 12, opacity: 0.65 }
const warnStyle: CSSProperties = { fontSize: 12, color: '#d97706' }
const errorStyle: CSSProperties = { fontSize: 12, color: '#f87171' }
const groupStyle: CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 10px',
  border: '0.5px solid var(--dsw-alias-border-l4)', borderRadius: 12,
}
const rowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }
const keyChipStyle: CSSProperties = {
  border: '0.5px solid var(--dsw-alias-border-l4)', background: 'transparent', color: 'inherit',
  cursor: 'pointer', borderRadius: 8, padding: '2px 8px', fontSize: 11, fontFamily: 'monospace',
  maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
}
const badgeStyle = (tone: 'ok' | 'warn' | 'muted'): CSSProperties => ({
  border: `0.5px solid ${tone === 'warn' ? '#d97706' : 'var(--dsw-alias-border-l4)'}`,
  borderRadius: 999, padding: '1px 7px', fontSize: 11,
  color: tone === 'warn' ? '#d97706' : 'inherit', opacity: tone === 'muted' ? 0.6 : 1,
})

/** Disclosure chevron, drawn to match the sibling cards. */
function Chevron({ open }: { open: boolean }): ReactElement {
  return createElement('svg', {
    width: 14, height: 14, viewBox: '0 0 16 16', 'aria-hidden': true,
    style: { flex: '0 0 auto', opacity: 0.7, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .15s' },
  },
    createElement('path', {
      d: 'M4 6.5 L8 10.5 L12 6.5', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4,
      strokeLinecap: 'round', strokeLinejoin: 'round',
    }),
  )
}

/** The vault panel. */
export function VaultCard(props: VaultCardProps): ReactElement {
  const { ssh, t } = props
  const [open, setOpen] = useState(false)
  const snapshot = useSyncExternalStore(ssh.subscribe, ssh.getSnapshot)
  const sealed = snapshot.groups.filter(group => group.sealed).length
  // Somewhere else just found out the hard way that a group is locked — a
  // device test, most likely. Open the panel, open THAT group's unlock box and
  // put it on screen: the reader is taken to the door rather than told about
  // it. The request lives as long as the refusal, so pressing it again after
  // scrolling away works.
  const wanted = snapshot.lockedGroup
  useEffect(() => {
    if (wanted === undefined) return
    setOpen(true)
    // The body mounts on this render; give it a frame before measuring.
    const frame = requestAnimationFrame(() => {
      document.querySelector(`[data-dshell-vault-group="${wanted.id}"]`)
        ?.scrollIntoView({ block: 'center' })
    })
    return () => { cancelAnimationFrame(frame) }
  }, [wanted])
  return createElement('li', {
    style: open ? { ...cardStyle, ...openCardStyle } : cardStyle,
    'data-dshell-card': 'vault',
  },
    createElement('button', {
      type: 'button', style: headerStyle, 'aria-expanded': open,
      onClick: () => {
        setOpen(value => !value)
        // Read the lock state on opening rather than caching it: it is the one
        // fact about the vault that changes without this panel doing anything,
        // because another tab or a host restart can lock a group.
        if (!open) void ssh.load()
      },
    },
      createElement('span', { style: { flex: '1 1 auto', minWidth: 0 } },
        createElement('span', {
          style: { display: 'block', fontSize: 14, lineHeight: '22px', color: 'var(--dsw-alias-label-primary)' },
        }, t('vault.title')),
        createElement('span', { style: { display: 'block', fontSize: 13, opacity: 0.7 } },
          snapshot.groups.length === 0
            ? t('vault.empty')
            : t('vault.summary', { groups: snapshot.groups.length, sealed, plain: snapshot.groups.length - sealed })),
      ),
      createElement(Chevron, { open }),
    ),
    open
      ? createElement('div', { style: bodyStyle },
        ...snapshot.groups.map(group => createElement(GroupBlock, {
          key: group.id, group, ssh, t,
          unlockRequest: snapshot.lockedGroup?.id === group.id,
        })),
        createElement(NewGroupForm, { ssh, t }),
        snapshot.error !== undefined ? createElement('div', { style: errorStyle }, snapshot.error) : null,
        createElement('div', { style: noteStyle }, t('vault.note')),
      )
      : null,
  )
}

/** One group, its badge, its actions, and the credentials inside it. */
function GroupBlock(props: {
  group: VaultGroupView
  ssh: SshClientService
  t: SshTranslate
  /** True while something outside this block has asked for its unlock box. */
  unlockRequest?: boolean
}): ReactElement {
  const { group, ssh, t } = props
  const snapshot = useSyncExternalStore(ssh.subscribe, ssh.getSnapshot)
  const [token, setToken] = useState('')
  const [unlocking, setUnlocking] = useState(false)
  const [tokenError, setTokenError] = useState<string | undefined>(undefined)
  // Opened from outside — the device card's 去解锁, or a test that landed on a
  // locked credential. A local toggle still wins: this only ever opens.
  useEffect(() => {
    if (props.unlockRequest === true) setUnlocking(true)
  }, [props.unlockRequest])
  const inside = snapshot.credentials.filter(credential => credential.group === group.id)
  const usedBy = (credential: CredentialView): string => snapshot.devices
    .filter(device => device.credentialId === credential.id)
    .map(device => device.name)
    .join(t('card.nameSeparator'))
  // A sealed group with a token but no key in memory asks for that token. A
  // sealed group with NO token — the default group of a fresh vault — asks to
  // be claimed instead: an unlock box there could never open, because there is
  // nothing for a guess to be checked against. A plain group is offered a
  // token to seal it, which is the same claim.
  const claimable = !group.sealed || !group.hasToken

  return createElement('div', { style: groupStyle, 'data-dshell-vault-group': group.id },
    createElement('div', { style: rowStyle },
      createElement('span', { style: { fontWeight: 600, fontSize: 13 } }, group.name),
      // The plain state is a badge, not an absence of one.
      group.sealed
        ? createElement('span', {
          style: badgeStyle(!group.hasToken ? 'warn' : group.locked ? 'muted' : 'ok'),
        },
          !group.hasToken ? t('vault.unclaimed') : group.locked ? t('vault.locked') : t('vault.unlocked'))
        : createElement('span', { style: badgeStyle('warn') }, t('vault.plain')),
      createElement('span', { style: { ...noteStyle, flex: '1 1 auto' } },
        t('vault.credentialCount', { count: inside.length })),
      group.sealed && group.locked
        ? createElement('button', {
          type: 'button', style: actionStyle, onClick: () => { setUnlocking(value => !value) },
        }, claimable ? t('vault.setToken') : t('vault.unlock'))
        : null,
      group.sealed && !group.locked
        ? createElement('button', {
          type: 'button', style: actionStyle, onClick: () => { void ssh.lock(group.id) },
        }, t('vault.lock'))
        : null,
      claimable && !(group.sealed && group.locked)
        ? createElement('button', {
          type: 'button', style: actionStyle, onClick: () => { setUnlocking(value => !value) },
        }, t('vault.setToken'))
        : null,
      createElement('button', {
        type: 'button', style: actionStyle, onClick: () => { void ssh.deleteGroup(group.id).catch(() => {}) },
      }, t('vault.deleteGroup')),
    ),
    unlocking
      ? createElement('div', { style: rowStyle },
        createElement('input', {
          style: { ...fieldStyle, flex: '1 1 180px', minWidth: 0 },
          type: 'password',
          placeholder: claimable ? t('vault.newTokenPlaceholder') : t('vault.tokenPlaceholder'),
          value: token,
          autoComplete: 'new-password',
          onChange: (event) => { setToken(event.target.value) },
        }),
        createElement('button', {
          type: 'button',
          style: primaryStyle,
          disabled: token === '',
          onClick: () => {
            const submit = claimable ? ssh.setToken(group.id, token) : ssh.unlock(group.id, token)
            void submit
              .then(() => { setToken(''); setTokenError(undefined); setUnlocking(false) })
              // Shown beside the box that was filled in, not at the foot of the
              // panel: a refusal is about THIS token, and the reader is looking
              // right here.
              .catch((error: unknown) => {
                setTokenError(error instanceof Error ? error.message : String(error))
              })
          },
        }, claimable ? t('vault.setToken') : t('vault.unlock')),
        createElement('button', {
          type: 'button', style: actionStyle,
          onClick: () => { setToken(''); setTokenError(undefined); setUnlocking(false) },
        }, t('vault.cancel')),
      )
      : null,
    tokenError !== undefined
      ? createElement('div', { style: { ...errorStyle, paddingInlineStart: 10 } }, tokenError)
      : null,
    ...inside.map(credential => createElement('div', {
      key: credential.id,
      style: { ...rowStyle, paddingInlineStart: 10 },
      'data-dshell-vault-credential': credential.id,
    },
      createElement('span', { style: { fontSize: 12, flex: '1 1 140px', minWidth: 0, overflowWrap: 'anywhere' } },
        credential.name,
        ' · ',
        credential.kind === 'key' ? t('auth.key') : t('auth.password'),
        credential.hasPassphrase ? ` · ${t('device.passphrase')}` : ''),
      usedBy(credential) === ''
        ? createElement('span', { style: { ...noteStyle, fontSize: 11 } }, t('vault.unused'))
        : createElement('span', { style: { ...noteStyle, fontSize: 11 } },
          t('vault.usedBy', { names: usedBy(credential) })),
      createElement('button', {
        type: 'button', style: actionStyle,
        onClick: () => { void ssh.deleteCredential(credential.id).catch(() => {}) },
      }, t('vault.deleteCredential')),
    )),
    inside.length === 0 && !group.sealed
      ? createElement('span', { style: warnStyle }, t('vault.plainWarning'))
      : null,
    createElement(NewCredentialForm, { group, ssh, t }),
  )
}

/**
 * The add-credential form, one per group.
 *
 * It lives inside the group rather than as a global "new credential" button
 * because which group a secret lands in IS the encryption decision, and a form
 * that asked for the name first and the group later is a form where most people
 * pick the wrong one.
 */
function NewCredentialForm(props: {
  group: VaultGroupView
  ssh: SshClientService
  t: SshTranslate
}): ReactElement {
  const { group, ssh, t } = props
  const [name, setName] = useState('')
  const [kind, setKind] = useState<CredentialKind>('key')
  const [secret, setSecret] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [open, setOpen] = useState(false)
  const [disk, setDisk] = useState<readonly SshKeyFile[] | undefined>(undefined)
  const [diskOpen, setDiskOpen] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  // A sealed, locked group cannot be written to: the host would have to open the
  // existing rows to be sure of the shape, and it has no key to do it with. The
  // form is therefore closed rather than shown-and-failing.
  if (group.sealed && group.locked) {
    // Two different doors, and the difference is whether a key exists to be
    // typed into one. An unclaimed group needs a token SET before anything can
    // be stored; sending the reader to an unlock box there would send them to a
    // door with no lock.
    return createElement('div', { style: { ...noteStyle, paddingInlineStart: 10 } },
      group.hasToken ? t('vault.needUnlock') : t('vault.needToken'))
  }
  return createElement('div', { style: { ...rowStyle, paddingInlineStart: 10 } },
    open
      ? createElement('div', { style: { flexBasis: '100%', display: 'flex', flexDirection: 'column', gap: 6 } },
        createElement('div', { style: rowStyle },
          createElement('input', {
            style: { ...fieldStyle, flex: '1 1 120px', minWidth: 0 },
            placeholder: t('vault.credentialNamePlaceholder'),
            value: name,
            onChange: (event) => { setName(event.target.value) },
          }),
          createElement('button', {
            type: 'button',
            style: kind === 'key' ? primaryStyle : actionStyle,
            onClick: () => { setKind('key') },
          }, t('auth.key')),
          createElement('button', {
            type: 'button',
            style: kind === 'password' ? primaryStyle : actionStyle,
            onClick: () => { setKind('password') },
          }, t('auth.password')),
        ),
        createElement('textarea', {
          style: { ...fieldStyle, minHeight: 60, fontFamily: 'monospace', fontSize: 12 },
          placeholder: kind === 'key' ? t('vault.keyPlaceholder') : t('vault.passwordPlaceholder'),
          value: secret,
          onChange: (event: ChangeEvent<HTMLTextAreaElement>) => { setSecret(event.target.value) },
        }),
        kind === 'key'
          ? createElement('input', {
            style: fieldStyle,
            type: 'password',
            placeholder: t('vault.passphrasePlaceholder'),
            value: passphrase,
            autoComplete: 'new-password',
            onChange: (event) => { setPassphrase(event.target.value) },
          })
          : null,
        // The picker is offered only for a key. It lists `~/.ssh` and fills the
        // box with whichever one is clicked — never a default, because the whole
        // point is that the user knows which key opens which machine.
        kind === 'key'
          ? createElement('div', { style: rowStyle },
            createElement('button', {
              type: 'button', style: actionStyle, onClick: () => {
              if (disk === undefined) void ssh.listKeys().then(setDisk)
              setDiskOpen(value => !value)
            },
            }, t('vault.pickFromDisk')),
            diskOpen && disk === undefined
              ? createElement('span', { style: noteStyle }, t('vault.picking'))
              : null,
            diskOpen && disk !== undefined && disk.length === 0
              ? createElement('span', { style: noteStyle }, t('vault.keyPickEmpty'))
              : null,
            ...(diskOpen && disk !== undefined ? disk : []).map(candidate => createElement('button', {
              key: candidate.path,
              type: 'button',
              style: keyChipStyle,
              title: candidate.path,
              onClick: () => {
                void ssh.readKey(candidate.path).then((body) => {
                  // A refused read leaves the box as it was: an emptied secret
                  // would be saved as "no credential".
                  if (body === undefined) return
                  setSecret(body)
                  setDiskOpen(false)
                })
              },
            }, candidate.name)),
          )
          : null,
        createElement('div', { style: rowStyle },
          createElement('button', {
            type: 'button',
            style: primaryStyle,
            disabled: name.trim() === '' || secret.trim() === '',
            onClick: () => {
              void ssh.saveCredential({
                group: group.id,
                name: name.trim(),
                kind,
                secret,
                ...kind === 'key' && passphrase !== '' ? { passphrase } : {},
              }).then(() => {
                setName(''); setSecret(''); setPassphrase(''); setError(undefined); setOpen(false)
              }).catch((reason: unknown) => {
                // A refusal here is usually the group's: it was locked between
                // the form opening and the save landing. Saying so beats a
                // button that does nothing.
                setError(reason instanceof Error ? reason.message : String(reason))
              })
            },
          }, t('vault.addCredential')),
          createElement('button', {
            type: 'button', style: actionStyle,
            onClick: () => { setOpen(false); setName(''); setSecret(''); setPassphrase(''); setError(undefined) },
          }, t('vault.cancel')),
        ),
        error !== undefined
          ? createElement('div', { style: errorStyle }, error)
          : null,
      )
      : createElement('button', {
        type: 'button', style: actionStyle, onClick: () => { setOpen(true) },
      }, t('vault.addCredential')),
  )
}

/** The create-group form. The token comes first, and skipping it is a choice. */
function NewGroupForm(props: { ssh: SshClientService; t: SshTranslate }): ReactElement {
  const { ssh, t } = props
  const [name, setName] = useState('')
  const [token, setToken] = useState('')
  const plain = token === ''
  return createElement('div', { style: { ...groupStyle, borderStyle: 'dashed' } },
    createElement('div', { style: rowStyle },
      createElement('input', {
        style: { ...fieldStyle, flex: '1 1 140px', minWidth: 0 },
        placeholder: t('vault.groupNamePlaceholder'),
        value: name,
        onChange: (event) => { setName(event.target.value) },
      }),
      createElement('input', {
        style: { ...fieldStyle, flex: '1 1 140px', minWidth: 0 },
        type: 'password',
        placeholder: t('vault.newTokenPlaceholder'),
        value: token,
        autoComplete: 'new-password',
        onChange: (event) => { setToken(event.target.value) },
      }),
      createElement('button', {
        type: 'button',
        style: primaryStyle,
        disabled: name.trim() === '',
        onClick: () => {
          void ssh.createGroup(name.trim(), token === '' ? null : token).then(() => {
            setName('')
            setToken('')
          }).catch(() => {})
        },
      }, t('vault.createGroup')),
    ),
    createElement('div', { style: plain ? warnStyle : noteStyle },
      plain ? t('vault.plainWarning') : t('vault.tokenNote')),
  )
}
