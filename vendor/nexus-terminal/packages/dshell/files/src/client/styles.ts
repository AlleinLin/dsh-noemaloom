/**
 * Inline styles for the file navigator. Kept apart from the component so the
 * body file stays about behaviour, and drawn in the sidebar's own density: a
 * quiet header of four controls, then plain rows on the background.
 */

import type { CSSProperties } from 'react'

export const rootStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
  flex: 1,
  overflow: 'hidden',
}

export const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 2,
  padding: '2px 4px',
  minWidth: 0,
}

export const navButtonStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  flex: '0 0 auto',
  border: 'none',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  padding: 3,
  borderRadius: 5,
  opacity: 0.8,
}

export const navButtonOffStyle: CSSProperties = {
  ...navButtonStyle,
  opacity: 0.28,
  cursor: 'default',
}

/** The crumb strip: one line, scrolled rather than wrapped when it runs long. */
export const pathStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  flex: '1 1 auto',
  minWidth: 0,
  overflowX: 'auto',
  whiteSpace: 'nowrap',
  fontSize: 12,
  scrollbarWidth: 'none',
}

export const crumbStyle: CSSProperties = {
  flex: '0 0 auto',
  border: 'none',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  font: 'inherit',
  fontSize: 12,
  padding: '1px 3px',
  borderRadius: 4,
  opacity: 0.72,
}

export const crumbCurrentStyle: CSSProperties = {
  ...crumbStyle,
  opacity: 1,
  cursor: 'default',
  fontWeight: 600,
}

export const separatorStyle: CSSProperties = {
  flex: '0 0 auto',
  opacity: 0.4,
  margin: '0 1px',
}

export const bodyStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
  flex: '1 1 auto',
  overflowY: 'auto',
  paddingBottom: 8,
}

export const levelStyle: CSSProperties = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
}

export const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  width: '100%',
  boxSizing: 'border-box',
  border: 'none',
  // No `background` here on purpose: the resting colour and the `:hover`
  // highlight both live in the stylesheet `injectHoverCss` installs, because an
  // inline declaration would win over the `:hover` rule and kill the highlight.
  color: 'inherit',
  cursor: 'pointer',
  textAlign: 'left',
  font: 'inherit',
  fontSize: 13,
  padding: '4px 8px',
}

export const iconStyle: CSSProperties = { flex: '0 0 auto' }

/**
 * What a row that can be dragged needs.
 *
 * The drag itself is the pointer handling in `drag.ts`; this only stops a
 * press-and-move over the label from being taken as the start of a text
 * selection, which would otherwise paint the row blue while it is being
 * dragged to the terminal.
 */
export const dragSourceStyle: CSSProperties = {
  userSelect: 'none',
}

export const nameStyle: CSSProperties = {
  flex: '1 1 auto',
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

/** The `..` row: the same shape as a folder row, monospaced so it reads as a token. */
export const parentNameStyle: CSSProperties = {
  ...nameStyle,
  fontFamily: 'monospace',
  letterSpacing: 1,
  opacity: 0.85,
}

export const noteStyle: CSSProperties = {
  padding: '3px 10px 4px 32px',
  fontSize: 12,
  opacity: 0.5,
}

export const errorStyle: CSSProperties = {
  padding: '3px 10px 4px 32px',
  fontSize: 12,
  color: '#f87171',
}
