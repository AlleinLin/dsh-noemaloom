/**
 * The initialization page of a terminal session.
 *
 * A terminal session is born blank, and while it is blank its two parameters
 * are still open: where it runs (this machine, or an SSH device) and which
 * Agent preset it will use. The page follows dsh's own blank-session hero — the
 * same centered mark and headline, and the same chip row above the composer —
 * with the run location in the workspace chip's place, because both answer the
 * same question ("where does this session work?"). Chip metrics are copied from
 * `HeroShell.module.css` (28px tall, 4px gap, 8px inset, 13/20 wt500, chevron
 * 12 in the caption ink) so the row reads as the native one.
 *
 * The page leaves with the first input: after that the session's history exists
 * and the host refuses to change either choice.
 */

import { createElement, useEffect, useRef, useState, useSyncExternalStore, type ReactElement } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { DeviceChoiceSeat } from './terminal-mode-switch.js'
import type { DshellModeKey } from './locales.js'
import { dshIcon, type DshIconName } from './dsh-icons.js'
import { getTheme, themeModeStore, themeStore } from './theme.js'

/** dsh's own display names for the built-in presets; a preset that publishes
 *  its own `name` keeps it, and anything unknown falls back to its id. */
const PRESET_NAME_KEYS: Readonly<Record<string, DshellModeKey>> = {
  standard: 'preset.standard',
  ptc: 'preset.ptc',
  minimal: 'preset.minimal',
  cordis: 'preset.cordis',
}

/** A ring spinner, injected once; a keyframe cannot live in an inline style. */
function injectSpinnerCss(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById('dshell-spinner-css') !== null) return
  const style = document.createElement('style')
  style.id = 'dshell-spinner-css'
  style.textContent = '@keyframes dshell-spin { to { transform: rotate(360deg) } }'
  document.head.append(style)
}

/** The preset roster, reached by service key. */
export interface PresetSeat {
  list(): Promise<readonly { readonly id: string; readonly name: string }[]>
  select(sessionId: string, id: string): Promise<void>
}

/** What the page needs. */
export interface CreationPanelSeat {
  readonly sessionId: SessionId | undefined
  readonly sessions: ISessions
  readonly device: DeviceChoiceSeat
  readonly presets: PresetSeat
}

type Props = CreationPanelSeat & PropsLocale<'dshellMode'>

/** The two choices a terminal session is created with. */
export function CreationPanel({ sessionId, sessions, device, presets, t }: Props): ReactElement {
  const theme = getTheme(useSyncExternalStore(themeStore.subscribe, themeStore.getSnapshot), useSyncExternalStore(themeModeStore.subscribe, themeModeStore.getSnapshot))
  const [roster, setRoster] = useState<readonly { readonly id: string; readonly name: string }[]>([])
  // A refusal is the answer too: a device that cannot be reached, or a preset
  // the host will not swap, says so here instead of looking like a dead chip.
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [open, setOpen] = useState<'place' | 'mode' | null>(null)
  // Choosing a device is not instant: the host connects, proves the directory
  // and mounts the tree there. The page reports that as its own stage instead
  // of a chip that appears to do nothing for a while.
  const [phase, setPhase] = useState<
    | { readonly kind: 'connecting'; readonly name: string }
    | { readonly kind: 'connected'; readonly name: string; readonly detail: string | undefined }
    | undefined
  >(undefined)
  const devices = useSyncExternalStore(device.subscribe, device.snapshot)
  const list = useSyncExternalStore(sessions.list.subscribe, sessions.list.getSnapshot)
  useEffect(() => {
    injectSpinnerCss()
    let live = true
    void presets.list()
      .then(rows => { if (live) setRoster(rows) })
      .catch(error => { if (live) setFailure(message(error)) })
    return () => { live = false }
  }, [presets])

  const selectedDevice = sessionId === undefined
    ? undefined
    : devices.bindings.find(row => row.sessionId === String(sessionId))?.deviceId
  const placeLabel = selectedDevice === undefined
    ? t('creation.local')
    : (devices.devices.find(row => row.id === selectedDevice)?.name ?? selectedDevice)
  const presetId = sessionId === undefined
    ? undefined
    : (list.byId[sessionId]?.projectionValues as { agentPreset?: unknown } | undefined)?.agentPreset
  const presetName = (id: string, name: string): string => {
    const key = PRESET_NAME_KEYS[id]
    return key === undefined ? (name || id) : t(key)
  }
  const currentPreset = typeof presetId === 'string'
    ? presetName(presetId, roster.find(row => row.id === presetId)?.name ?? presetId)
    : (roster[0] === undefined ? t('creation.mode') : presetName(roster[0].id, roster[0].name))

  const pick = (run: Promise<void>): void => {
    setFailure(undefined)
    setOpen(null)
    void run.catch(error => { setFailure(message(error)) })
  }

  // One chip: dsh's workspace chip, with our own icon and value.
  const chip = (icon: DshIconName, label: string, id: 'place' | 'mode'): ReactElement => createElement('button', {
    type: 'button',
    'aria-haspopup': 'menu',
    'aria-expanded': open === id,
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 4,
      maxWidth: 'min(100%, 360px)',
      minHeight: 28,
      padding: '0 8px',
      border: 'none',
      borderRadius: 'var(--dsw-radius-sm)',
      background: open === id ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
      color: 'var(--dsw-alias-label-primary)',
      fontSize: 13,
      lineHeight: '20px',
      fontWeight: 500,
      cursor: 'pointer',
    },
    onClick: () => setOpen(open === id ? null : id),
  },
    createElement(DshIconView, { name: icon, size: 16, color: 'var(--dsw-alias-label-primary)' }),
    createElement('span', { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, label),
    createElement(DshIconView, { name: 'chevronDown', size: 12, color: 'var(--dsw-alias-label-caption)' }),
  )

  // One menu row: dsh's own menu surface, in our tokens.
  const item = (key: string, label: string, active: boolean, onPick: () => void): ReactElement => createElement('button', {
    key,
    type: 'button',
    role: 'menuitem',
    style: {
      display: 'block',
      width: '100%',
      padding: '4px 8px',
      borderRadius: 4,
      border: 'none',
      background: active ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
      color: 'var(--dsw-alias-label-primary)',
      fontSize: 13,
      lineHeight: '20px',
      textAlign: 'left',
      cursor: 'pointer',
    },
    onClick: onPick,
  }, label)

  const menu = (id: 'place' | 'mode'): ReactElement | null => open !== id ? null : createElement('div', {
    role: 'menu',
    style: {
      position: 'absolute',
      top: '100%',
      left: 0,
      zIndex: 40,
      minWidth: 160,
      maxHeight: 280,
      overflowY: 'auto',
      marginTop: 4,
      padding: 4,
      borderRadius: 8,
      border: '1px solid var(--dsw-alias-border-l2)',
      background: 'var(--dsw-alias-bg-layer-3)',
      boxShadow: 'var(--dsw-shadow-md, 0 8px 24px rgb(0 0 0 / 0.2))',
    },
  },
    id === 'place'
      ? [
          item('local', t('creation.local'), selectedDevice === undefined, () => {
            if (sessionId === undefined) return
            setPhase(undefined)
            pick(device.bind(String(sessionId), null))
          }),
          ...devices.devices.map(row => item(row.id, row.name, selectedDevice === row.id, () => {
            if (sessionId === undefined) return
            setFailure(undefined)
            setOpen(null)
            setPhase({ kind: 'connecting', name: row.name })
            void device.bind(String(sessionId), row.id).then(() => {
              const binding = device.snapshot().bindings.find(entry => entry.sessionId === String(sessionId))
              const detail = binding?.mount ?? binding?.remoteRoot
              setPhase({ kind: 'connected', name: row.name, detail: detail === undefined ? undefined : String(detail) })
            }).catch(error => {
              setPhase(undefined)
              setFailure(message(error))
              // A credential sealed behind a locked group is the one refusal
              // with a way out, and this is one of the three moments a token is
              // genuinely needed: the session is being created and the secret is
              // not in memory. Take the reader to the unlock box rather than
              // leaving them to work out where it lives.
              const locked = device.snapshot().lockedGroup
              if (locked === undefined) return
              setFailure(device.revealUnlock(locked)
                ? t('creation.lockedHint', { name: locked.name })
                : t('creation.lockedWhere', { name: locked.name }))
            })
          })),
        ]
      : roster.map(row => item(row.id, presetName(row.id, row.name), presetId === row.id, () => {
          if (sessionId !== undefined) pick(presets.select(String(sessionId), row.id))
        })),
  )

  return createElement('div', {
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100%',
      minWidth: 0,
      padding: '0 24px',
      boxSizing: 'border-box',
      color: 'var(--dsw-alias-label-primary)',
    },
  },
    createElement('div', {
      style: {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 12,
        width: '100%',
        maxWidth: 'var(--dsh-composer-card-max-width, 720px)',
      },
    },
      // Headline: the mark and the title, 26/32 wt500, as the native hero has it.
      createElement('div', {
        style: {
          display: 'flex',
          flexWrap: 'wrap',
          columnGap: 10,
          rowGap: 12,
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 26,
          lineHeight: '32px',
          fontWeight: 500,
        },
      },
        createElement('span', { style: { display: 'inline-flex', flex: 'none', alignItems: 'center', justifyContent: 'center' } },
          createElement(DshIconView, { name: 'whaleTail', size: 24, color: 'var(--dsw-alias-label-primary)' })),
        createElement('span', null, t('creation.title')),
      ),
      // The chip row: the run location where dsh puts the workspace, the preset
      // where dsh puts the preset. While a device is being reached the run
      // location is replaced by its progress, because that is the answer the
      // reader is waiting for.
      createElement('div', {
        style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center', gap: 8 },
      },
        phase?.kind === 'connecting'
          ? createElement('div', {
              style: {
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                minHeight: 28,
                padding: '0 8px',
                color: 'var(--dsw-alias-label-primary)',
                fontSize: 13,
                lineHeight: '20px',
              },
            },
              createElement('span', {
                style: {
                  width: 12,
                  height: 12,
                  borderRadius: 999,
                  border: '1.5px solid var(--dsw-alias-label-caption)',
                  borderTopColor: 'var(--dsw-alias-label-primary)',
                  animation: 'dshell-spin 0.9s linear infinite',
                },
              }),
              `${t('creation.connecting')} ${phase.name}…`,
            )
          : createElement('div', { style: { position: 'relative' } }, chip('globe', placeLabel, 'place'), menu('place')),
        createElement('div', { style: { position: 'relative' } }, chip('agentPreset', currentPreset, 'mode'), menu('mode')),
      ),
      phase?.kind === 'connecting'
        ? createElement('span', { style: { color: 'var(--dsw-alias-label-caption)', fontSize: 12, lineHeight: '18px' } },
            t('creation.connectingHint'))
        : null,
      phase?.kind === 'connected'
        ? createElement('span', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12, lineHeight: '18px' } },
            `${t('creation.connected')} ${phase.name}${phase.detail === undefined ? '' : ` · ${phase.detail}`}`)
        : null,
      failure === undefined ? null : createElement('span', {
        style: { color: theme.danger, fontSize: 12, lineHeight: '18px', textAlign: 'center' },
      }, failure),
    ),
  )
}

/**
 * One icon, in its own ink: the artwork is a DOM factory (dsh-icons.ts), so a
 * span hosts it and the effect sets the colour the chip needs.
 */
function DshIconView({ name, size, color }: { readonly name: DshIconName; readonly size: number; readonly color: string }): ReactElement {
  const host = useRef<HTMLSpanElement | null>(null)
  useEffect(() => {
    const element = host.current
    if (element === null) return
    const svg = dshIcon(name, size)
    svg.style.color = color
    element.replaceChildren(svg)
  }, [name, size, color])
  return createElement('span', { ref: host, style: { display: 'inline-flex', flex: 'none' } })
}

/** One refusal as a line of text. */
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

