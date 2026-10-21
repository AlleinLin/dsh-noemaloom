/**
 * A full-screen program's own terminal, on the whole surface.
 *
 * The timeline's regions are built the other way round on purpose: they render
 * a LOG, so their height is measured from the ink the log carries and their
 * grid is widened to keep a carriage-return redraw on one row. A full-screen
 * program is not a log. It places every character itself, at a grid it was told
 * the size of, and it expects that grid to be exactly what it is drawing in —
 * so this terminal is sized from its BOX, never from its content, and it keeps
 * no scrollback: a program that moves the cursor up by twenty rows must land on
 * the row it thinks is there, not on one the terminal scrolled to.
 *
 * Keys go the other way too. In the timeline the composer is the input line and
 * the terminal is a read-only mirror; here the program owns the keyboard, so
 * every key is forwarded verbatim — and with it every answer xterm produces for
 * the queries the program sends, which is the only way a program that asks its
 * terminal what it is (`ESC[c`, the kitty keyboard flags, the background
 * colour) ever hears back.
 */

import { createElement, useEffect, useRef, type CSSProperties, type ReactElement } from 'react'
import { Terminal as XtermTerminal } from '@xterm/xterm'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { PtyStreamService } from '@nexus-aethra/dshell-terminal-bridge/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { injectXtermCss, xtermTheme, type Theme } from './theme.js'
import { SPAN_FONT, SPAN_FONT_SIZE, SPAN_LINE_HEIGHT } from './block-terminal.js'

/** Hard caps on the grid, matching what the PTY side will accept. */
const MAX_COLS = 500
const MAX_ROWS = 400

/** Cell width of the viewport font at its base size, or 0 when unmeasurable. */
function measureCell(host: HTMLElement): number {
  if (typeof document === 'undefined') return 0
  const probe = document.createElement('span')
  probe.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font:${String(SPAN_FONT_SIZE)}px ${SPAN_FONT}`
  probe.textContent = 'W'.repeat(32)
  host.append(probe)
  const width = probe.getBoundingClientRect().width
  probe.remove()
  return width > 0 ? width / 32 : 0
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value))
}

/** One live viewport onto a full-screen program. */
export interface TuiViewport {
  /** Show the next stretch of the program's output. */
  write(text: string): void
  /** Drop what is on screen and draw `text` from scratch. */
  reset(text: string): void
  /** Re-measure the box: re-column, re-row, and tell the program. */
  fit(): void
  dispose(): void
}

/**
 * Open a terminal in `host` for a full-screen program to draw in.
 * @param host - the element the grid fills.
 * @param theme - the active palette.
 * @param onData - receives every key and every answer xterm produces.
 * @param onSize - called with the grid whenever it changes, so the program can
 *   be told the same numbers this side is drawing at.
 * @returns the handle to write into, refit and dispose.
 */
export function createTuiViewport(
  host: HTMLElement,
  theme: Theme,
  onData: (data: string) => void,
  onSize: (cols: number, rows: number) => void,
): TuiViewport {
  injectXtermCss()
  const cell = measureCell(host) || 8
  const term = new XtermTerminal({
    fontFamily: SPAN_FONT,
    fontSize: SPAN_FONT_SIZE,
    // A screen, not a log: a program that navigates by row would otherwise be
    // re-read as if every `\n` were a new line of output.
    convertEol: false,
    cursorBlink: true,
    // The program owns the display. Scrollback would let a cursor move the
    // program believes stays on screen scroll the grid out from under it.
    scrollback: 0,
    cols: clamp(Math.floor(host.clientWidth / cell), 20, MAX_COLS),
    rows: 24,
    theme: xtermTheme(theme),
  })
  term.open(host)
  // Every key, verbatim, including the mouse reports and the replies xterm
  // itself owes the program (device attributes, the background-colour query).
  const input = term.onData((data) => { onData(data) })
  // Copy has no binding of its own here: xterm's helper textarea holds the
  // focus, so the browser's default never fires. Same chord as the timeline's
  // regions, for the same reason — a selection nobody can copy out is useless.
  term.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown') return true
    const mod = event.ctrlKey || event.metaKey
    if (mod && event.shiftKey && (event.key === 'C' || event.code === 'KeyC')) {
      const text = term.getSelection()
      if (text.length === 0) return false
      if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined) {
        void navigator.clipboard.writeText(text)
      }
      return false
    }
    return true
  })
  const refocus = (): void => { term.focus() }
  host.addEventListener('pointerdown', refocus)

  /**
   * The row height xterm actually renders at, read off its own element.
   *
   * xterm sizes that element to `rows × cell height`, so dividing by the rows
   * it was asked for recovers the real metric — including the fractional part
   * a font's line box produces. A full-screen program notices being one row
   * off in a way the timeline's regions never did, so the estimate a font
   * probe would give is not good enough here.
   */
  const cellHeight = (): number => {
    const element = term.element
    if (element === undefined || term.rows <= 0) return SPAN_LINE_HEIGHT
    const height = element.getBoundingClientRect().height
    return height > 0 ? height / term.rows : SPAN_LINE_HEIGHT
  }

  const fit = (): void => {
    const width = host.clientWidth
    const height = host.clientHeight
    if (width <= 0 || height <= 0) return
    const cols = clamp(Math.floor(width / cell), 20, MAX_COLS)
    const rows = clamp(Math.floor(height / cellHeight()), 4, MAX_ROWS)
    if (cols === term.cols && rows === term.rows) return
    term.resize(cols, rows)
    // The program has to be told the same grid. Its own idea of where the
    // cursor can go is what it draws its screen from, and one row of
    // disagreement puts every later line in the wrong place.
    onSize(cols, rows)
  }

  // Debug handle for headless verification: the screen IS the feature, and a
  // screenshot is not available in every shell this runs in — so the grid and
  // the re-measure are reachable from a console. Cleared on dispose so closed
  // viewports do not pile up.
  const debug = { fit, grid: (): { cols: number; rows: number } => ({ cols: term.cols, rows: term.rows }) }
  const debugSet = (): Set<unknown> | undefined => {
    if (typeof window === 'undefined') return undefined
    const holder = window as unknown as { __DSHELL_TUIS__?: Set<unknown> }
    return (holder.__DSHELL_TUIS__ ??= new Set())
  }
  debugSet()?.add(debug)

  const view: TuiViewport = {
    write: (text) => {
      if (text.length > 0) term.write(text)
    },
    reset: (text) => {
      // `reset` clears the parser and the screen together, so nothing of the
      // previous program survives a replay that starts from the session's
      // beginning — which is also what re-applies the modes (`?25l`, mouse
      // reporting) the replay itself carries.
      term.reset()
      term.write(text)
    },
    fit: () => { fit() },
    dispose: () => {
      debugSet()?.delete(debug)
      host.removeEventListener('pointerdown', refocus)
      input.dispose()
      term.dispose()
    },
  }
  fit()
  term.focus()
  return view
}

const barStyle: CSSProperties = {
  position: 'absolute',
  top: 6,
  right: 8,
  zIndex: 3,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '3px 6px 3px 10px',
  borderRadius: 999,
  fontSize: 11,
  // Click-through everywhere but the button: the bar sits over the program's
  // own screen, and the screen is what the reader is trying to use.
  pointerEvents: 'none',
}

/**
 * The full-screen mode's surface: the program's terminal, plus the one control
 * that has to live here.
 *
 * The way OUT cannot live in the composer, because the composer is exactly what
 * this mode puts away — so it floats over the corner of the program's screen,
 * small enough to ignore and the only thing on the surface that takes a click.
 */
export function TuiSurface(props: {
  sessionId: SessionId | undefined
  pty: PtyStreamService
  theme: Theme
  /** The program the host read on the terminal, for naming it to the reader. */
  program: string | null
  onLeave(): void
  t: TranslateNS<'dshellMode'>
}): ReactElement {
  const { t, pty, theme, sessionId, onLeave } = props
  const host = useRef<HTMLDivElement | null>(null)
  const view = useRef<TuiViewport | undefined>(undefined)
  useEffect(() => {
    const el = host.current
    const id = sessionId === undefined ? undefined : String(sessionId)
    if (el === null || id === undefined) return
    const handle = createTuiViewport(
      el,
      theme,
      (data) => { pty.send(data) },
      (cols, rows) => { pty.resize(cols, rows) },
    )
    view.current = handle
    // Subscribed BEFORE the first draw, so output arriving while the viewport
    // is being built is either already in the replay below or still to come as
    // a live chunk — there is no moment in between for a byte to fall through.
    const stop = pty.onChunk((session, chunk) => {
      if (session !== id) return
      // A replay replaces the history it re-states, so the screen is rebuilt
      // from it rather than appended to.
      if (chunk.replay) handle.reset(pty.read(id))
      else handle.write(chunk.text)
    })
    handle.reset(pty.read(id))
    const observer = new ResizeObserver(() => { handle.fit() })
    observer.observe(el)
    return () => {
      stop()
      observer.disconnect()
      handle.dispose()
      view.current = undefined
    }
  }, [sessionId, pty, theme])
  return createElement('div', {
    'data-dshell-tui-surface': '',
    style: { position: 'relative', height: '100%', minHeight: 0 },
  },
    createElement('div', {
      ref: host,
      style: { position: 'absolute', inset: 0, overflow: 'hidden' },
    }),
    createElement('div', { style: { ...barStyle, background: theme.bg, color: theme.muted, border: `1px solid ${theme.border}` } },
      props.program === null
        ? null
        : createElement('span', null, t('tui.occupying', { program: props.program })),
      createElement('button', {
        onClick: onLeave,
        style: {
          pointerEvents: 'auto',
          cursor: 'pointer',
          font: 'inherit',
          color: theme.accentText,
          background: 'transparent',
          border: `1px solid ${theme.accentBorder}`,
          borderRadius: 999,
          padding: '2px 8px',
        },
      }, t('tui.leave')),
    ),
  )
}
