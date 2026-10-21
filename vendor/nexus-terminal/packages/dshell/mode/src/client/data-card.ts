/**
 * dshell's storage card: where its own files are kept, and the picker for it.
 *
 * A card of its own rather than a group inside the terminal card, because the
 * two answer different questions. The terminal card governs the composer and
 * the shell's helpers — every control on it takes effect on the click that sets
 * it. This one names a directory on the host machine and, at the next start,
 * MOVES the device registry, the keys, the buffer state, the session tags and
 * every transcript into it. That is not an input assist, and a reader looking
 * for "where does this thing write my transcripts" does not open 终端与输入辅助.
 *
 * Both cards are mounted by `config-page.ts` as the `dshell-mode` row's
 * configuration page in the Plugins panel; this one keeps its own document
 * (`dshell-data`) so the two stores stay independent.
 *
 * The card follows the section's shape — a header naming what it governs over a
 * line saying what it is set to, collapsed until opened — and it is a card
 * WITHOUT a form, like its sibling: the choice is stored the moment it is made,
 * and the note is where the reader is told it lands at the next start.
 */

import { createElement, useState, type CSSProperties, type ReactElement } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from './locales.js'
import { setDataDir, useDataDir } from './data-dir.js'
import { DataDirDialog } from './data-dir-dialog.js'

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
}

const headTextStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
}

const descStyle: CSSProperties = {
  fontSize: 12,
  lineHeight: '18px',
  opacity: 0.62,
  overflowWrap: 'anywhere',
}

const bodyStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  padding: '0 16px 16px',
}

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 12,
  padding: '10px 0',
}

const rowTextStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
}

const detailStyle: CSSProperties = {
  fontSize: 12,
  lineHeight: '18px',
  opacity: 0.62,
}

/** The path an applied row shows: monospaced, because it is one. */
const pathStyle: CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 12,
  lineHeight: '18px',
  color: 'var(--dsw-alias-label-primary)',
  overflowWrap: 'anywhere',
}

const actionsStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  flex: '0 0 auto',
}

/** A small bordered button, for an action that is not the card's only one. */
const smallButtonStyle: CSSProperties = {
  border: '1px solid var(--dsw-alias-border-l4)',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  borderRadius: 6,
  padding: '5px 12px',
  font: 'inherit',
  fontSize: 12,
  flex: '0 0 auto',
}

/** An inline text button, for "undo this choice" beside the one that makes it. */
const resetButtonStyle: CSSProperties = {
  border: 'none',
  background: 'none',
  padding: 0,
  font: 'inherit',
  fontSize: 12,
  color: 'var(--dsw-alias-brand-primary)',
  cursor: 'pointer',
  flex: '0 0 auto',
}

const noteStyle: CSSProperties = {
  fontSize: 12,
  lineHeight: '18px',
  opacity: 0.62,
}

/**
 * Disclosure chevron, drawn rather than imported: it must read as the same
 * control the cards beside it use (down when collapsed, rotated when open).
 * @param props - whether the card is open.
 * @returns the chevron element.
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
 * Render the dshell storage card.
 * @param props - the framework-injected `t` seat for this namespace.
 * @returns the card element.
 */
export function DshellDataCard({ t }: PropsLocale<'dshellMode'>): ReactElement {
  const [open, setOpen] = useState(false)
  const [picking, setPicking] = useState(false)
  const dataDir = useDataDir()
  const current = dataDir.length === 0 ? t('data.following') : dataDir
  return createElement('li', {
    style: open ? { ...cardStyle, ...openCardStyle } : cardStyle,
    'data-dshell-card': 'data',
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
        }, t('data.title')),
        createElement('span', { style: descStyle }, t('data.summary', { dir: current })),
      ),
      createElement(Chevron, { open }),
    ),
    open
      ? createElement('div', { style: bodyStyle },
        createElement('div', { style: rowStyle, 'data-dshell-dataDir': 'row' },
          createElement('div', { style: rowTextStyle },
            createElement('div', { style: detailStyle }, t('data.detail')),
            createElement('div', { style: pathStyle }, current),
          ),
          createElement('div', { style: actionsStyle },
            createElement('button', {
              type: 'button',
              style: smallButtonStyle,
              onClick: () => { setPicking(true) },
            }, t('data.choose')),
            dataDir.length === 0
              ? null
              : createElement('button', {
                type: 'button',
                style: resetButtonStyle,
                onClick: () => { setDataDir('') },
              }, t('data.reset')),
          ),
        ),
        createElement('div', { style: noteStyle }, t('data.note')),
      )
      : null,
    picking
      ? createElement(DataDirDialog, {
        t,
        initial: dataDir,
        onPick: (path) => { setDataDir(path); setPicking(false) },
        onClose: () => { setPicking(false) },
      })
      : null,
  )
}
