/**
 * The dshell-mode page's terminal card: the terminal palette, and the switches
 * for the shell helpers that read the composer's line.
 *
 * One card per question: the page it is mounted on (`config-page.ts`, the
 * `dshell-mode` row's configuration in the Plugins panel) carries dshell's
 * OTHER document too — where it keeps its files, `dshell-data` — as a second
 * card rather than a group here, because the two answer different questions
 * (see `data-card.ts`).
 *
 * It follows the card shape dsh's settings surfaces use — a header button
 * naming what the card governs over a line that says what its settings are set
 * to, collapsed until opened — so it reads as one of the cards rather than a
 * permanently open panel. The chevron is the same `›`-rotated control dshell
 * uses for its other fold affordances.
 *
 * This is a card without a form. A palette applies the moment it is picked and
 * a switch takes effect on its click — that is what the user is judging — so
 * there is no staged edit and no save button; each write goes to the Host
 * settings document immediately (see `theme.ts` and `shell-settings.ts`), and
 * every other seat follows the store.
 *
 * The card is keyed by the settings namespace it edits (`dshell`), which is
 * how the Plugins section pairs it with the namespace the Host serves. It
 * draws its own chrome rather than importing dsh's `PluginCard`, because a
 * client plugin reaches another client plugin through slots and services, not
 * through value imports. `Switch` is the exception that proves that rule: it
 * comes from the platform primitive set the module table serves, the same place
 * the file icons come from.
 */

import { createElement, useState, type CSSProperties, type ReactElement } from 'react'
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { DEVICE_POLL_CHOICES, type DevicePollMs, type DshellShellHelper } from '../settings.js'
import type { DshellModeKey } from './locales.js'
import { THEMES, getTheme, setTheme, useDshellTheme } from './theme.js'
import { setShellHelper, useShellHelpers } from './shell-settings.js'
import { setDevicePollMs, useDevicePollMs } from './device-poll.js'

const cardStyle: CSSProperties = {
  listStyle: 'none',
  border: '0.5px solid var(--dsw-alias-border-l4)',
  borderRadius: 16,
  background: 'var(--dsw-alias-bg-layer-3)',
  transition: 'border-color .16s, background .16s',
}

/** An open card reads as the one being worked on, not merely taller. */
const openCardStyle: CSSProperties = {
  background: 'var(--dsw-alias-bg-layer-2)',
  borderColor: 'var(--dsw-alias-label-dimmed)',
}

const headerStyle: CSSProperties = {
  width: '100%',
  appearance: 'none',
  border: 0,
  background: 'none',
  font: 'inherit',
  color: 'inherit',
  textAlign: 'left',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: '14px 16px',
  borderRadius: 12,
}

/** Name over description: the description is what tells two cards apart. */
const headTextStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
}

const descStyle: CSSProperties = {
  fontSize: 13,
  lineHeight: '20px',
  color: 'var(--dsw-alias-label-primary)',
  opacity: 0.7,
}

const bodyStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 8,
  padding: '0 16px 16px',
}

/** A group heading inside the card, on its own line above what it governs. */
const groupStyle: CSSProperties = {
  flexBasis: '100%',
  fontSize: 12,
  fontWeight: 600,
  letterSpacing: '.02em',
  color: 'var(--dsw-alias-label-primary)',
  opacity: 0.55,
}

const noteStyle: CSSProperties = {
  flexBasis: '100%',
  fontSize: 12,
  opacity: 0.6,
  marginTop: 2,
}

/** One helper switch: what it is, what it does, and the control. */
const helperRowStyle: CSSProperties = {
  flexBasis: '100%',
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: '10px 12px',
  border: '0.5px solid var(--dsw-alias-border-l4)',
  borderRadius: 12,
}

const helperTextStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
}

const helperLabelStyle: CSSProperties = {
  fontSize: 13,
  color: 'var(--dsw-alias-label-primary)',
}

const helperDetailStyle: CSSProperties = {
  fontSize: 12,
  lineHeight: '18px',
  opacity: 0.62,
}

/**
 * The interval control, in ONE box.
 *
 * The copy and the buttons used to be two sibling rows of the same bordered
 * shape, which drew two stacked lines with the body's gap between them and read
 * as a separator rather than as one control. Stacking them inside a single
 * border makes the ladder part of the setting it chooses.
 */
const pollRowStyle: CSSProperties = {
  ...helperRowStyle,
  flexDirection: 'column',
  alignItems: 'stretch',
  gap: 10,
}

const pollLadderStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 6,
}

/**
 * The switches, in the order the card shows them.
 *
 * The labels are dictionary keys resolved against the bound translator at
 * render, so the copy follows a language switch; the Host stores three booleans
 * and never reads a word of this.
 */
const HELPER_ROWS: readonly { field: DshellShellHelper; labelKey: DshellModeKey; detailKey: DshellModeKey }[] = [
  {
    field: 'tabCompletion',
    labelKey: 'settings.helper.tabCompletion.label',
    detailKey: 'settings.helper.tabCompletion.detail',
  },
  {
    field: 'historyList',
    labelKey: 'settings.helper.historyList.label',
    detailKey: 'settings.helper.historyList.detail',
  },
  {
    field: 'commandHint',
    labelKey: 'settings.helper.commandHint.label',
    detailKey: 'settings.helper.commandHint.detail',
  },
  {
    field: 'completionShellOracle',
    labelKey: 'settings.helper.completionShellOracle.label',
    detailKey: 'settings.helper.completionShellOracle.detail',
  },
]

/** One interval button on the poll ladder. */
function PollChoice(props: { ms: DevicePollMs; current: DevicePollMs; label: string; onPick: (ms: DevicePollMs) => void }): ReactElement {
  const { ms, current, label, onPick } = props
  return createElement('button', {
    type: 'button',
    'aria-pressed': current === ms,
    'data-dshell-poll': String(ms),
    onClick: () => { onPick(ms) },
    style: {
      flex: '1 1 72px',
      padding: '7px 4px',
      borderRadius: 10,
      cursor: 'pointer',
      font: 'inherit',
      fontSize: 12,
      fontVariantNumeric: 'tabular-nums',
      color: 'var(--dsw-alias-label-secondary)',
      border: current === ms
        ? '1px solid var(--dsw-alias-brand-primary)'
        : '0.5px solid var(--dsw-alias-border-l4)',
      background: current === ms ? 'var(--dsw-alias-bg-module-platform)' : 'transparent',
    },
  }, label)
}

/**
 * Disclosure chevron, drawn rather than imported: it must read as the same
 * control as the cards this one sits among (down when collapsed, rotated when
 * open), and a client plugin cannot import dsh's icon set.
 */
function Chevron({ open }: { open: boolean }): ReactElement {
  return createElement('svg', {
    width: 14,
    height: 14,
    viewBox: '0 0 16 16',
    'aria-hidden': true,
    style: {
      flex: '0 0 auto',
      opacity: 0.7,
      transition: 'transform .16s ease',
      transform: open ? 'rotate(180deg)' : 'none',
    } as CSSProperties,
  },
    createElement('path', {
      d: 'M4 6.5 L8 10.5 L12 6.5',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.4,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    }),
  )
}

/**
 * Render the dshell settings card.
 * @param props - the framework-injected `t` seat for this namespace.
 * @returns the card element.
 */
export function DshellSettingsCard({ t }: PropsLocale<'dshellMode'>): ReactElement {
  const [open, setOpen] = useState(false)
  // The resolved palette, not the bare id: the mode comes with it, and the
  // swatches below must be drawn for the surface dsh is painting right now.
  const theme = useDshellTheme()
  const current = theme.id
  const helpers = useShellHelpers()
  const pollMs = useDevicePollMs()
  // The header says what the card is set TO, so the two groups are readable
  // without opening it: the palette by name, and the assists by how many are off.
  const off = HELPER_ROWS.filter(row => !helpers[row.field])
  const currentTheme = THEMES.find(candidate => candidate.id === current)
  const themeLabel = currentTheme === undefined ? current : t(currentTheme.labelKey)
  const helperSummary = off.length === 0
    ? t('settings.helpers.allOn')
    : t('settings.helpers.off', {
      list: off.map(row => t(row.labelKey)).join(t('settings.helpers.joiner')),
    })
  return createElement('li', {
    style: open ? { ...cardStyle, ...openCardStyle } : cardStyle,
    'data-dshell-card': 'settings',
  },
    createElement('button', {
      type: 'button',
      style: headerStyle,
      'aria-expanded': open,
      onClick: () => { setOpen(value => !value) },
    },
      createElement('span', { style: headTextStyle },
        createElement('span', {
          style: { fontSize: 14, lineHeight: '22px', color: 'var(--dsw-alias-label-primary)' },
        }, t('settings.title')),
        createElement('span', { style: descStyle },
          t('settings.summary', { theme: themeLabel, helpers: helperSummary })),
      ),
      createElement(Chevron, { open }),
    ),
    open
      ? createElement('div', { style: bodyStyle },
        createElement('div', { style: groupStyle }, t('settings.group.theme')),
        THEMES.map(palette => {
          // The palette's own skin for the surface dsh is painting, so the
          // swatch matches what picking it will actually look like.
          const skin = getTheme(palette.id, theme.mode)
          return createElement('button', {
            key: palette.id,
            type: 'button',
            'aria-pressed': current === palette.id,
            onClick: () => { setTheme(palette.id) },
            style: {
              flex: '1 1 140px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              padding: '14px 16px',
              borderRadius: 16,
              cursor: 'pointer',
              font: 'inherit',
              fontSize: 13,
              color: 'var(--dsw-alias-label-primary)',
              border: current === palette.id
                ? '1px solid var(--dsw-alias-brand-primary)'
                : '0.5px solid var(--dsw-alias-border-l4)',
              background: current === palette.id ? 'var(--dsw-alias-bg-module-platform)' : 'transparent',
            },
          },
            createElement('span', {
              style: {
                display: 'inline-block',
                width: 10,
                height: 10,
                borderRadius: 999,
                background: skin.accent,
                border: `1px solid ${skin.borderStrong}`,
              },
            }),
            t(palette.labelKey),
          )
        }),
        createElement('div', { style: noteStyle },
          t('settings.note.theme')),
        createElement('div', { style: groupStyle }, t('settings.group.helpers')),
        HELPER_ROWS.map(row => createElement('div', {
          key: row.field,
          style: helperRowStyle,
          'data-dshell-helper': row.field,
        },
          createElement('div', { style: helperTextStyle },
            createElement('div', { style: helperLabelStyle }, t(row.labelKey)),
            createElement('div', { style: helperDetailStyle }, t(row.detailKey)),
          ),
          createElement(Switch, {
            checked: helpers[row.field],
            onChange: (next: boolean) => { setShellHelper(row.field, next) },
            label: t(row.labelKey),
          }),
        )),
        createElement('div', { style: noteStyle },
          t('settings.note.helpers')),
        createElement('div', { style: groupStyle }, t('settings.group.poll')),
        createElement('div', { style: pollRowStyle, 'data-dshell-setting': 'devicePoll' },
          createElement('div', { style: helperTextStyle },
            createElement('div', { style: helperLabelStyle }, t('settings.poll.label')),
            createElement('div', { style: helperDetailStyle }, t('settings.poll.detail')),
          ),
          createElement('div', { style: pollLadderStyle },
            ...DEVICE_POLL_CHOICES.map(ms => createElement(PollChoice, {
              key: ms,
              ms,
              current: pollMs,
              label: t(`settings.poll.choice.${String(ms)}` as DshellModeKey),
              onPick: (next) => { setDevicePollMs(next) },
            })),
          ),
        ),
        createElement('div', { style: noteStyle }, t('settings.note.poll')),
      )
      : null,
  )
}
