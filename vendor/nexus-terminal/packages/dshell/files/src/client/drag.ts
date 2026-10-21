/**
 * Dragging a directory out of the pane and dropping it on the terminal.
 *
 * Deliberately NOT HTML5 drag-and-drop. This gesture has exactly one source (a
 * directory row in this pane) and one target (the terminal view), and a native
 * drag session is the wrong tool for it: the browser arbitrates the session as
 * a black box, so when the drop is refused there is no event to observe and no
 * handler to correct — the only symptom is the "no drop" cursor, which is
 * exactly what a real mouse was hitting here.
 *
 * Pointer events carry the same gesture without asking anyone's permission: the
 * press, the move and the release are all ours, the target is decided by where
 * the pointer is, and touch and pen work by the same code. The drag also stays
 * a *click* until it moves: nothing happens below a small threshold, so a row
 * still expands on one click and opens on two.
 *
 * Feedback is the pane's own: the whole terminal view is outlined while the
 * pointer is over it, and the page cursor says a drop is possible. The gesture
 * is only live while this pane draws a tree whose host reported it can drive a
 * shell — the same condition as the jump button, which this mirrors.
 */

/** The block view's seat: the area a drop counts as "on the terminal". */
const TERMINAL_VIEW = '[data-dshell-terminal-view]'

/** Pixels the pointer must travel, button down, before this counts as a drag. */
const DRAG_THRESHOLD = 6

/** The outline drawn over the terminal while a dragged directory can land there. */
const OUTLINE = '2px dashed rgba(127,127,127,.65)'

/** Where a press on a directory row landed, until it either moves or does not. */
interface Press {
  readonly path: string
  readonly x: number
  readonly y: number
}

/** The live gesture, as the rows drive it. */
export interface DirectoryDrag {
  /**
   * Note a press on one directory row.
   *
   * Called from the row's own pointer handler, which must stay synchronous and
   * must not default the event: the row is still a button, and a click has to
   * reach it when the pointer never moves.
   * @param event - the row's `pointerdown`.
   * @param path - absolute directory path in the session's world.
   */
  readonly begin: (event: { readonly clientX: number; readonly clientY: number; readonly button: number }, path: string) => void
  /** Stop watching, for the effect that installed this. */
  readonly dispose: () => void
}

/**
 * Watch a directory-row drag until the returned handle is disposed.
 * @param land - called with the directory dropped on the terminal.
 * @returns the handle the rows begin drags through.
 */
export function installDirectoryDrag(land: (path: string) => void): DirectoryDrag {
  /** Set by a press, cleared when the gesture ends either way. */
  let press: Press | undefined
  /** The path being dragged, once the press has moved far enough to be one. */
  let dragging: string | undefined
  /** The area currently outlined, so the outline can be put back. */
  let outlined: HTMLElement | undefined
  /** Put the page's cursor back when the gesture ends. */
  let cursorBefore: string | undefined

  const unoutline = (): void => {
    if (outlined !== undefined) {
      outlined.style.outline = ''
      outlined.style.outlineOffset = ''
      outlined = undefined
    }
    if (cursorBefore !== undefined) {
      document.body.style.cursor = cursorBefore
      cursorBefore = undefined
    }
  }
  const end = (): void => {
    press = undefined
    dragging = undefined
    unoutline()
  }

  /** The terminal view under one point, if the pointer is over it. */
  const viewAt = (target: EventTarget | null): HTMLElement | undefined => {
    if (!(target instanceof Element)) return undefined
    return target.closest<HTMLElement>(TERMINAL_VIEW) ?? undefined
  }

  const onMove = (event: PointerEvent): void => {
    if (press === undefined) return
    if (dragging === undefined) {
      // The button may already be up — a release outside the window leaves
      // `buttons` at zero and no `up` — and then there was no drag at all.
      if (event.buttons === 0) {
        end()
        return
      }
      if (Math.hypot(event.clientX - press.x, event.clientY - press.y) < DRAG_THRESHOLD) return
      dragging = press.path
      cursorBefore = document.body.style.cursor
      document.body.style.cursor = 'copy'
    }
    const view = viewAt(event.target)
    if (view === undefined) {
      if (outlined !== undefined) {
        outlined.style.outline = ''
        outlined.style.outlineOffset = ''
        outlined = undefined
      }
      return
    }
    if (view === outlined) return
    if (outlined !== undefined) {
      outlined.style.outline = ''
      outlined.style.outlineOffset = ''
    }
    view.style.outline = OUTLINE
    view.style.outlineOffset = '-2px'
    outlined = view
  }

  const onUp = (event: PointerEvent): void => {
    const path = dragging
    const drop = path !== undefined && viewAt(event.target) !== undefined
    end()
    if (drop && path !== undefined) land(path)
  }

  document.addEventListener('pointermove', onMove, true)
  document.addEventListener('pointerup', onUp, true)
  // A cancelled pointer (a touch turning into a scroll, the window losing the
  // gesture) is not a drop; it just ends the drag.
  document.addEventListener('pointercancel', end, true)
  return {
    begin(event, path) {
      if (event.button !== 0) return
      press = { path, x: event.clientX, y: event.clientY }
    },
    dispose() {
      end()
      document.removeEventListener('pointermove', onMove, true)
      document.removeEventListener('pointerup', onUp, true)
      document.removeEventListener('pointercancel', end, true)
    },
  }
}
