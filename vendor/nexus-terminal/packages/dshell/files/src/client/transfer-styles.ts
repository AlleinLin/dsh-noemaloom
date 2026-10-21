/**
 * Inline styles for the transfer view. Same density as the navigator's, but the
 * subject is two columns: a narrow pane each, a compact header per pane, and one
 * line per copy under both. Kept apart from the component so the body file stays
 * about behaviour.
 */

import type { CSSProperties } from 'react'

/**
 * The view fills the pane it is mounted in.
 *
 * `height: 100%` is what makes that true: the docking kit puts a tab body in a
 * BLOCK pane body that scrolls, so `flex: 1` alone leaves this root at its
 * content height — and a two-pane view whose progress strip sits below the fold
 * is a two-pane view nobody can watch. Filling the pane lets each tree scroll
 * inside its own column and keeps the strip in view; `flex: 1` stays for a
 * layout that does make this a flex item.
 */
export const rootStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  minHeight: 0,
  flex: 1,
  overflow: 'hidden',
}

export const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  padding: '2px 4px',
  minWidth: 0,
}

export const titleStyle: CSSProperties = {
  flex: '1 1 auto',
  minWidth: 0,
  fontSize: 12,
  fontWeight: 600,
  opacity: 0.85,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

/** The two panes: equal halves, each allowed to shrink. */
export const panesStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'stretch',
  gap: 4,
  flex: '1 1 auto',
  minHeight: 0,
  padding: '0 4px',
}

export const paneStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  flex: '1 1 50%',
  minWidth: 0,
  minHeight: 0,
  border: '1px solid var(--dsw-alias-border-l4, rgba(255,255,255,.2))',
  borderRadius: 6,
  overflow: 'hidden',
}

export const paneHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 2,
  padding: '1px 2px 1px 6px',
  minWidth: 0,
}

export const paneLabelStyle: CSSProperties = {
  flex: '1 1 auto',
  minWidth: 0,
  fontSize: 11,
  fontWeight: 600,
  opacity: 0.7,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

/** The crumb line: one row, scrolled rather than wrapped, quiet. */
export const panePathStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  flex: '0 0 auto',
  minWidth: 0,
  overflowX: 'auto',
  whiteSpace: 'nowrap',
  fontSize: 11,
  padding: '0 4px 2px 6px',
  scrollbarWidth: 'none',
}

export const paneBodyStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
  flex: '1 1 auto',
  overflowY: 'auto',
  paddingBottom: 4,
}

/** The copies: one line each, newest first. */
export const jobsStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  flex: '0 0 auto',
  maxHeight: 132,
  overflowY: 'auto',
  gap: 2,
  padding: '4px 6px 6px',
}

export const jobRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  fontSize: 11,
  minWidth: 0,
}

export const jobNameStyle: CSSProperties = {
  flex: '0 1 auto',
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

export const jobArrowStyle: CSSProperties = {
  flex: '0 0 auto',
  opacity: 0.5,
}

export const jobStateStyle: CSSProperties = {
  flex: '0 0 auto',
  opacity: 0.65,
}

export const jobProgressStyle: CSSProperties = {
  flex: '1 1 auto',
  minWidth: 24,
  height: 3,
  borderRadius: 2,
  background: 'rgba(127,127,127,.25)',
  overflow: 'hidden',
}

export const jobBarStyle: CSSProperties = {
  height: '100%',
  background: 'var(--dsw-alias-state-business-primary, #679efe)',
}

export const jobErrorStyle: CSSProperties = {
  flex: '1 1 auto',
  minWidth: 0,
  color: '#f87171',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

export const jobButtonStyle: CSSProperties = {
  flex: '0 0 auto',
  border: 'none',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  font: 'inherit',
  fontSize: 11,
  padding: '0 3px',
  borderRadius: 4,
  opacity: 0.75,
}

export const hintStyle: CSSProperties = {
  padding: '6px 8px',
  fontSize: 12,
  opacity: 0.6,
  lineHeight: 1.5,
}
