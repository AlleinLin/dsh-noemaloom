/**
 * The command hint: the tail of a recent command, ghosted after the caret and
 * taken a token at a time with the right arrow.
 *
 * A shell's own line editor has suggestions because it owns the line; here the
 * composer is the line and the history is on the host, so the two ends are
 * joined by the same per-session record the up-arrow list reads — the bridge's
 * command splitter, which pairs every submitted line with its output and
 * belongs to the SESSION, not to this browser.
 *
 * Two gestures, one source, no overlap: `↑` retrieves (it walks every match,
 * and the host searches the whole history through its index), while the ghost
 * only ever *proposes* the newest command that extends what is already typed.
 * Tab stays the path completer: it REWRITES the token under the caret, which is
 * why it can fold capitals, whereas the ghost can only append — so its match is
 * an exact prefix, since a case-insensitive one could suggest a command spelled
 * differently from the draft and then append a tail that continues the wrong
 * word.
 */

import { createElement, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactElement } from 'react'
import { DSHELL_PTY_PATH } from '@nexus-aethra/dshell-std'
// Type-only: pulls the Conversation SlotMap (`conversation.input.overlay`) and
// the SessionStandardProps that hand a slot its `useInput`/`inputActions`.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { useShellHelpers } from './shell-settings.js'
import { useDshellTheme } from './theme.js'
import type { TerminalModeClient } from './terminal-mode.js'

/** How long typing pauses before the history is asked. */
const DEBOUNCE_MS = 140

/**
 * How many prefix matches to read.
 *
 * More than one because the newest match can BE the draft — re-typing a line
 * already in the history — and the useful hint is then the next one that has
 * somewhere to go. Eight is enough for that and still one small answer.
 */
const CANDIDATES = 8

/** The ghost's state: one command, for one session. */
export interface CommandHint {
  readonly sessionId: string
  /**
   * The whole matching command, not its tail: the tail is derived from the
   * draft at read time, so accepting a chunk advances the ghost without another
   * round trip (and a draft that moved on simply stops matching).
   */
  readonly command: string
}

/** The smallest store the two ends need: a snapshot plus subscribers. */
class CommandHintStore {
  private state: CommandHint | null = null
  private readonly listeners = new Set<() => void>()

  getSnapshot = (): CommandHint | null => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  set(next: CommandHint | null): void {
    if (this.state === next) return
    this.state = next
    for (const listener of this.listeners) listener()
  }
}

/**
 * Whether a ghost is drawn right now.
 *
 * The legend names the arrow key only while there is a suggestion to take, and
 * "the store holds a hint" is not that claim: the ghost is not drawn once the
 * caret has left the end of the draft, and a key the legend promises has to be a
 * key that does something (see `accept`).
 */
class HintVisibility {
  private state = false
  private readonly listeners = new Set<() => void>()

  getSnapshot = (): boolean => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  set(next: boolean): void {
    if (this.state === next) return
    this.state = next
    for (const listener of this.listeners) listener()
  }
}

/** What the interceptor and the ghost share. */
export interface CommandHints {
  readonly store: CommandHintStore
  /** Whether the ghost is drawn, for the legend that names its key. */
  readonly visible: HintVisibility
  /**
   * Offer a draft to the history, debounced.
   *
   * Called on every draft change, which is why the round trip is debounced and
   * sequence-guarded: the answer to a keystroke that has already been overtaken
   * must not land. The query goes to the host because the host owns the index
   * over the whole history — filtering a window here is exactly the ceiling
   * that makes an old command unfindable.
   */
  offer(sessionId: string, draft: string): void
  /** Forget the hint: the mode left shell, the session changed, or the line ran. */
  clear(): void
  /**
   * The tail to ghost for this session's draft, or undefined when there is
   * nothing to say.
   *
   * The session is an argument and not an assumption because the hint's text is
   * only ever a suggestion for the line it was asked about: a draft that matches
   * by coincidence after a switch must not carry another session's command into
   * this one, and testing that here — rather than only when the switch's effect
   * runs — leaves not even one frame that could draw or take the wrong tail.
   */
  suffixFor(sessionId: string, draft: string): string | undefined
  /** The draft with the hint's next chunk appended, or undefined when there is none. */
  accept(sessionId: string, draft: string): string | undefined
}

/** One route call; the same shape the file navigator uses. */
async function post(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return await response.json() as Record<string, unknown>
}

/**
 * One chunk of a suggestion: the space that separates it, the word, and the
 * space that ends it.
 *
 * A press therefore finishes the word being typed and lands on the next one,
 * which is the rhythm the gesture is for — `docker` + → + → walks
 * `docker run nginx` a word at a time. A tail with no space left to give (the
 * command ends) is taken whole, so the last press completes the line.
 */
export function nextChunk(suffix: string): string {
  const match = /^\s*\S+\s?/u.exec(suffix)
  return match === null ? suffix : match[0]
}

/** A session's hint, and the debounced history query behind it. */
export function createCommandHints(): CommandHints {
  const store = new CommandHintStore()
  const visible = new HintVisibility()
  let timer: ReturnType<typeof setTimeout> | undefined
  /** Which query's answer is still wanted; anything older is dropped. */
  let sequence = 0

  const ask = async (sessionId: string, draft: string, mine: number): Promise<void> => {
    let body: Record<string, unknown>
    try {
      body = await post(DSHELL_PTY_PATH, { action: 'history', sessionId, draft, limit: CANDIDATES })
    } catch {
      return
    }
    if (mine !== sequence) return
    const commands = (Array.isArray(body.commands) ? body.commands : []).flatMap((entry) => {
      const command = (entry as { command?: unknown }).command
      return typeof command === 'string' ? [command] : []
    })
    // Newest match that still has somewhere to go: the answer is oldest-first,
    // so the walk back from the end is the walk from the most recent.
    let chosen: string | undefined
    for (let index = commands.length - 1; index >= 0; index -= 1) {
      const command = commands[index] as string
      if (command.startsWith(draft) && command.length > draft.length) { chosen = command; break }
    }
    store.set(chosen === undefined ? null : { sessionId, command: chosen })
  }

  const clear = (): void => {
    if (timer !== undefined) { clearTimeout(timer); timer = undefined }
    // Bump the sequence so an answer already in flight cannot land after this.
    sequence += 1
    store.set(null)
  }

  const suffixFor = (sessionId: string, draft: string): string | undefined => {
    const hint = store.getSnapshot()
    if (hint === null || hint.sessionId !== sessionId || draft.length === 0) return undefined
    if (!hint.command.startsWith(draft)) return undefined
    const suffix = hint.command.slice(draft.length)
    // A tail of nothing but spaces is nothing to show and nothing to take: the
    // command is over, or it is the draft re-typed. Claiming → for an invisible
    // chunk would move the caret for a line nobody can see.
    return suffix.trim().length === 0 ? undefined : suffix
  }

  return {
    store,
    visible,
    offer(sessionId, draft) {
      // The store holds one hint, and it belongs to one session. A switch retires
      // it here — at the new session's first offer — so the old line is not kept
      // while the new answer is in flight (suffixFor would refuse it anyway; this
      // is what keeps it from lingering at all).
      const held = store.getSnapshot()
      if (held !== null && held.sessionId !== sessionId) store.set(null)
      // An empty line has nothing to extend, and asking then would be a request
      // per idle keystroke for a suggestion nobody typed towards.
      if (draft.trim().length === 0) { clear(); return }
      if (timer !== undefined) clearTimeout(timer)
      sequence += 1
      const mine = sequence
      timer = setTimeout(() => { void ask(sessionId, draft, mine) }, DEBOUNCE_MS)
    },
    clear,
    suffixFor,
    accept(sessionId, draft) {
      // What is not on screen must not be taken: the ghost hides whenever the
      // caret leaves the end of the draft, and the arrow must agree with what the
      // reader can see (see caretAtDraftEnd).
      if (caretAtDraftEnd(draft) === undefined) return undefined
      const suffix = suffixFor(sessionId, draft)
      return suffix === undefined ? undefined : draft + nextChunk(suffix)
    },
  }
}

/**
 * The composer's caret, when it sits at the end of `draft`.
 *
 * The end-of-draft test is part of reading it, not a separate concern: the hint
 * is the tail of a command the draft is a prefix OF, so a caret parked mid-line
 * would ghost the continuation of text that is no longer being typed. Comparing
 * the text up to the caret against the draft answers both at once, and works
 * through the editor's own text nodes — the only description of the line that is
 * always right.
 *
 * Both ends ask this: the ghost, before it draws, and the right arrow, before it
 * takes anything. A suggestion nobody can see must not be accepted — the same
 * rule that makes the completion list apply on every highlight move, because the
 * composer is what Enter sends.
 */
function caretAtDraftEnd(draft: string): { editor: HTMLElement; caret: Range } | undefined {
  const editor = document.querySelector('[data-composer-input]')
  if (!(editor instanceof HTMLElement)) return undefined
  const selection = window.getSelection()
  if (selection === null || selection.rangeCount === 0 || !selection.isCollapsed) return undefined
  const caret = selection.getRangeAt(0)
  if (!editor.contains(caret.startContainer)) return undefined
  const lead = document.createRange()
  lead.selectNodeContents(editor)
  lead.setEnd(caret.startContainer, caret.startOffset)
  if (lead.toString() !== draft) return undefined
  return { editor, caret }
}

/** Where the next character would be, and the metrics to draw it with. */
interface CaretBox {
  readonly left: number
  readonly top: number
  readonly height: number
  readonly fontSize: string
  readonly fontFamily: string
  readonly letterSpacing: string
}

/** The caret's own rectangle in viewport coordinates, when it is at the draft's end. */
function caretBox(draft: string): CaretBox | undefined {
  const place = caretAtDraftEnd(draft)
  if (place === undefined) return undefined
  const rect = place.caret.getBoundingClientRect()
  // A range in a detached or hidden node can answer 0×0 at the origin; there is
  // no caret to draw at, so the ghost stays away rather than sitting in a corner.
  if (rect.height === 0 && rect.left === 0 && rect.top === 0) return undefined
  const style = getComputedStyle(place.editor)
  return {
    left: rect.left,
    top: rect.top,
    height: rect.height,
    fontSize: style.fontSize,
    fontFamily: style.fontFamily,
    letterSpacing: style.letterSpacing,
  }
}

/**
 * The ghost itself: the hint's tail, drawn where the caret is.
 *
 * It is deliberately NOT a node inside the editor. The composer is a Lexical
 * contenteditable, so an injected node would be reconciled away on the next
 * update — and until it was, the editor would read its selection offsets out of
 * a tree it does not own. A span in the composer's floating layer, placed from
 * the caret's rect, is outside all of that: anywhere the caret can be, wrap
 * included, is where the next character would go.
 */
export function ShellCommandHint(
  props: {
    readonly hints: CommandHints
    readonly modes: TerminalModeClient
    readonly sessionId: SessionId | undefined
  } & PropsRuntime<'conversation.input.overlay'>,
): ReactElement | null {
  const theme = useDshellTheme()
  const helpers = useShellHelpers()
  const draft = props.useInput(state => state.draft)
  useSyncExternalStore(props.hints.store.subscribe, props.hints.store.getSnapshot)
  const sessionId = String(props.sessionId)
  const suffix = props.hints.suffixFor(sessionId, draft)
  const ref = useRef<HTMLSpanElement>(null)
  const [box, setBox] = useState<CaretBox | undefined>(undefined)

  useEffect(() => {
    // Switched off, the ghost is not drawn even for a hint already in hand: the
    // clear that follows the flip runs in the controls' effect, which is a paint
    // later than this render, and a suggestion that flickers after being turned
    // off is exactly what the switch promised would not happen.
    if (!helpers.commandHint || suffix === undefined) {
      setBox(undefined)
      props.hints.visible.set(false)
      return
    }
    const place = (): void => {
      const element = ref.current
      if (element === null) return
      const caret = caretBox(draft)
      if (caret === undefined) {
        setBox(undefined)
        props.hints.visible.set(false)
        return
      }
      // `offsetParent` is the box the span's `left`/`top` are measured from, so
      // the caret converts into the ghost's own coordinates without assuming
      // which ancestor the floating layer was mounted into.
      const parent = element.offsetParent
      const origin = parent instanceof Element ? parent.getBoundingClientRect() : undefined
      setBox({
        ...caret,
        left: caret.left - (origin?.left ?? 0),
        top: caret.top - (origin?.top ?? 0),
      })
      props.hints.visible.set(true)
    }
    place()
    // The caret moves for reasons this component never sees — a click, an arrow
    // key — and the ghost is placed from it.
    document.addEventListener('selectionchange', place)
    window.addEventListener('resize', place)
    // A re-wrap is the one move the selection does not report: the window can stay
    // the size it was while the composer does not (the sidebar opened, the view
    // split), and the same offset then sits on another line. The editor is what
    // wraps, so the editor is what is watched — its own box changes when it does.
    const editor = document.querySelector('[data-composer-input]')
    const observer = editor instanceof HTMLElement && typeof ResizeObserver === 'function'
      ? new ResizeObserver(place)
      : undefined
    if (observer !== undefined && editor instanceof HTMLElement) observer.observe(editor)
    return () => {
      observer?.disconnect()
      props.hints.visible.set(false)
      document.removeEventListener('selectionchange', place)
      window.removeEventListener('resize', place)
    }
  }, [suffix, draft, props.hints, helpers.commandHint])

  if (!helpers.commandHint || suffix === undefined) return null
  return createElement('span', {
    ref,
    'data-dshell-hint': '',
    style: {
      position: 'absolute',
      left: box?.left ?? 0,
      top: box?.top ?? 0,
      // Until the caret has been measured there is no place to sit, so the ghost
      // is invisible for that first frame rather than drawing at the origin.
      // Quiet enough once it lands to read as "not typed yet", which is the whole
      // point of a suggestion — the stock text colour would look like part of the
      // line.
      opacity: box === undefined ? 0 : 0.42,
      pointerEvents: 'none',
      // The tail is a continuation of the line: it must not break where the
      // editor would not, and it must not be selectable or wrap separately.
      whiteSpace: 'pre',
      fontFamily: box?.fontFamily ?? 'inherit',
      fontSize: box?.fontSize ?? 'inherit',
      letterSpacing: box?.letterSpacing ?? 'inherit',
      lineHeight: box === undefined ? 'inherit' : `${String(box.height)}px`,
      color: theme.text,
    } satisfies CSSProperties,
  }, suffix)
}
