/**
 * The chrome the WSL card draws with.
 *
 * The 管理台's device cards draw as siblings of one page, so they read as
 * siblings only while they share one set of styles — same card shell, same
 * header, same row and action measures. This file is that set, copied from
 * dshell-ssh's client (where the SSH registry card uses the original) because
 * client bundles are per-package: the day a shared client-style seat exists,
 * this copy goes and both cards import the seat. Until then, a change here or
 * there is a change in BOTH files or the cards drift apart.
 *
 * Everything here is dsh-token driven; no card logic lives in this file.
 */

import { createElement, type CSSProperties, type ReactElement } from 'react'

export const cardStyle: CSSProperties = {
  listStyle: 'none',
  border: '0.5px solid var(--dsw-alias-border-l4)',
  borderRadius: 16,
  background: 'var(--dsw-alias-bg-layer-3)',
  transition: 'border-color .16s, background .16s',
}

export const openCardStyle: CSSProperties = {
  background: 'var(--dsw-alias-bg-layer-2)',
  borderColor: 'var(--dsw-alias-label-dimmed)',
}

export const headerStyle: CSSProperties = {
  width: '100%', appearance: 'none', border: 0, background: 'none', font: 'inherit',
  color: 'inherit', textAlign: 'left', cursor: 'pointer', display: 'flex',
  alignItems: 'center', gap: 12, padding: '14px 16px', borderRadius: 12,
}

export const headTextStyle: CSSProperties = { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }

export const titleStyle: CSSProperties = {
  fontSize: 14, lineHeight: '22px', color: 'var(--dsw-alias-label-primary)',
}

export const descStyle: CSSProperties = {
  fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-primary)', opacity: 0.7,
}

export const bodyStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 10, padding: '0 16px 16px' }

export const rowStyle: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8, fontSize: 13,
  // Wrapping is what makes the helper line below work: it carries
  // `flexBasis: 100%`, and in a nowrap line that basis competes with the row's
  // own children instead of starting a second line — the actions were squeezed
  // until their labels broke one character per line.
  flexWrap: 'wrap',
  padding: '8px 10px', borderRadius: 10, background: 'var(--dsw-alias-bg-module-platform)',
}

export const rowTitleStyle: CSSProperties = {
  flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
}

export const actionGroupStyle: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0,
}

export const actionStyle: CSSProperties = {
  border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer',
  // An action keeps its own measure: the title already ellipsizes, so there is
  // nothing to gain by letting these shrink, and a shrunken one wraps its
  // label instead of truncating it.
  whiteSpace: 'nowrap', flexShrink: 0,
  fontSize: 12, opacity: 0.75, padding: '2px 6px', borderRadius: 6,
}

export const helperStyle: CSSProperties = {
  // `minWidth: 0` lets the line shrink to the row, and `anywhere` breaks the
  // path/digest run: a helper path is one long unbreakable token, and without
  // both it painted straight past the card's edge.
  flexBasis: '100%', minWidth: 0, overflowWrap: 'anywhere',
  fontSize: 11, lineHeight: '16px', opacity: 0.65, padding: '2px 4px 0',
}

export const noteStyle: CSSProperties = { fontSize: 12, opacity: 0.65 }

/** The disclosure chevron the card headers share. */
export function Chevron({ open }: { open: boolean }): ReactElement {
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
