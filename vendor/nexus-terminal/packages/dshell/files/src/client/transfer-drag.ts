/**
 * Dragging one entry out of one transfer pane and dropping it on the other.
 *
 * Pointer events, not HTML5 drag-and-drop, for the same reason the terminal
 * drop uses them: a native drag session is arbitrated by the browser as a black
 * box, so a refused drop leaves no event to observe and no handler to correct.
 * Here the press, the move and the release are ours; the target is decided by
 * where the pointer is, touch and pen work by the same code, and the gesture
 * stays an ordinary click until it moves far enough to be a drag — which is what
 * keeps single-click (expand) and double-click (enter) working on the same rows.
 *
 * The two panes are told apart by their own attributes: each pane element
 * carries `data-transfer-pane` and `data-transfer-root`, and each directory row
 * carries the path it stands for. A drop lands IN a directory — the row under
 * the pointer when there is one, the pane's current directory otherwise — so the
 * host never has to guess whether a path was a file or a folder.
 */

import type { DshellFileKind } from '../protocol.js'
import type { TransferSide } from '../transfer-protocol.js'

/** A pane: the area that counts as one side, and the directory it shows. */
const PANE = '[data-transfer-pane]'

/** A row that stands for a directory, which a drop can land inside. */
const ROW = '[data-dshell-file-entry="directory"]'

/** Pixels the pointer must travel, button down, before this counts as a drag. */
const DRAG_THRESHOLD = 6

/** The outline drawn around the receiving pane. */
const PANE_OUTLINE = '2px dashed rgba(127,127,127,.65)'

/** The wash under the directory row a drop would land in. */
const ROW_WASH = 'rgba(103,158,254,.18)'

/** One entry a drag carries. */
export interface TransferDragItem {
  /** Absolute path in the source pane's own namespace. */
  readonly path: string
  readonly name: string
  readonly kind: DshellFileKind
  readonly side: TransferSide
}

/** Where a drop would land: the other pane, and one of its directories. */
export interface TransferDrop {
  readonly side: TransferSide
  /** The destination directory, in that side's namespace. */
  readonly dir: string
  /** Whether the pointer was over a directory row rather than the pane's own area. */
  readonly onRow: boolean
}

/** The live gesture, as the rows drive it. */
export interface TransferDrag {
  /**
   * Note a press on one row.
   *
   * Called from the row's own pointer handler, which must stay synchronous and
   * must not default the event: the row is still a button, and a click has to
   * reach it when the pointer never moves.
   * @param event - the row's `pointerdown`.
   * @param item - what the row stands for.
   */
  readonly begin: (event: { readonly clientX: number; readonly clientY: number; readonly button: number }, item: TransferDragItem) => void
  /** Stop watching, for the effect that installed this. */
  readonly dispose: () => void
}

/** The element under a pointer event, tolerating a non-node target. */
function elementAt(event: { readonly target: EventTarget | null; readonly clientX: number; readonly clientY: number }): Element | undefined {
  if (event.target instanceof Element) return event.target
  return document.elementFromPoint(event.clientX, event.clientY) ?? undefined
}

/**
 * Watch one pane-to-pane drag until the returned handle is disposed.
 * @param land - called with the entry and where it was dropped.
 * @returns the handle the rows begin drags through.
 */
export function installTransferDrag(land: (item: TransferDragItem, drop: TransferDrop) => void): TransferDrag {
  /** Set by a press, cleared when the gesture ends either way. */
  let press: { item: TransferDragItem; x: number; y: number } | undefined
  /** The item being dragged, once the press has moved far enough to be one. */
  let dragging: TransferDragItem | undefined
  /** What is currently highlighted, so it can be put back. */
  let outlined: HTMLElement | undefined
  let washed: HTMLElement | undefined
  let cursorBefore: string | undefined

  /** Put the outline and the row wash back, leaving the gesture's cursor alone. */
  const clearMarks = (): void => {
    if (outlined !== undefined) {
      outlined.style.outline = ''
      outlined.style.outlineOffset = ''
      outlined = undefined
    }
    if (washed !== undefined) {
      washed.style.background = ''
      washed = undefined
    }
  }
  const end = (): void => {
    press = undefined
    dragging = undefined
    clearMarks()
    if (cursorBefore !== undefined) {
      document.body.style.cursor = cursorBefore
      cursorBefore = undefined
    }
  }

  /**
   * The drop one pointer position names, or undefined when it is over nothing
   * droppable — no pane, or the pane the drag started in.
   */
  const targetAt = (event: { readonly target: EventTarget | null; readonly clientX: number; readonly clientY: number }): { drop: TransferDrop; pane: HTMLElement; row: HTMLElement | undefined } | undefined => {
    const element = elementAt(event)
    if (element === undefined) return undefined
    const pane = element.closest<HTMLElement>(PANE)
    if (pane === null) return undefined
    const side = pane.dataset.transferPane as TransferSide | undefined
    if (side === undefined || side === dragging?.side) return undefined
    const row = element.closest<HTMLElement>(ROW)
    const root = pane.dataset.transferRoot ?? ''
    const dir = row?.dataset.dshellFilePath ?? root
    if (dir === '') return undefined
    return { drop: { side, dir, onRow: row !== null }, pane, row: row ?? undefined }
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
      dragging = press.item
      cursorBefore = document.body.style.cursor
      document.body.style.cursor = 'copy'
    }
    const hit = targetAt(event)
    if (hit === undefined) {
      clearMarks()
      return
    }
    if (outlined !== hit.pane) {
      if (outlined !== undefined) {
        outlined.style.outline = ''
        outlined.style.outlineOffset = ''
      }
      hit.pane.style.outline = PANE_OUTLINE
      hit.pane.style.outlineOffset = '-2px'
      outlined = hit.pane
    }
    if (washed !== hit.row) {
      if (washed !== undefined) washed.style.background = ''
      if (hit.row !== undefined) hit.row.style.background = ROW_WASH
      washed = hit.row
    }
  }

  const onUp = (event: PointerEvent): void => {
    const item = dragging
    // Resolved BEFORE the marks are cleared: `dragging` is what tells the two
    // panes apart, and the same pane is not a destination.
    const hit = item === undefined ? undefined : targetAt(event)
    end()
    if (item !== undefined && hit !== undefined) land(item, hit.drop)
  }

  document.addEventListener('pointermove', onMove, true)
  document.addEventListener('pointerup', onUp, true)
  // A cancelled pointer (a touch turning into a scroll, the window losing the
  // gesture) is not a drop; it just ends the drag.
  document.addEventListener('pointercancel', end, true)
  return {
    begin(event, item) {
      if (event.button !== 0) return
      press = { item, x: event.clientX, y: event.clientY }
    },
    dispose() {
      end()
      document.removeEventListener('pointermove', onMove, true)
      document.removeEventListener('pointerup', onUp, true)
      document.removeEventListener('pointercancel', end, true)
    },
  }
}
