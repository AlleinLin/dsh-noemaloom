import {
  Component,
  createElement,
  useEffect,
  useRef,
  useSyncExternalStore,
  type CSSProperties,
  type ReactElement,
} from 'react'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { IconQuestionOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { readShellCaret, type ShellCaret } from '@nexus-aethra/dshell-std'
import { shellReportCwd } from './shell-report.js'
import type { PtyStreamService } from '@nexus-aethra/dshell-terminal-bridge/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { CompletionState, ShellCompletion } from './completion.js'
import type { CommandHints } from './command-hint.js'
import { useShellHelpers } from './shell-settings.js'
import { useDshellTheme } from './theme.js'
import type { TerminalModeClient } from './terminal-mode.js'
import type { SessionMode } from './types.js'

const controlsRowStyle: CSSProperties = { position: 'relative', display: 'flex', alignItems: 'center', gap: 8 }

/**
 * An icon control in the composer row, in dsh's own grammar: a bare 28px glyph
 * whose fill appears only under the pointer, which is why the resting fill lives
 * in `composer-css.ts` — an inline `background` would outrank that `:hover` rule.
 */
const controlStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 28,
  height: 28,
  padding: 0,
  border: 'none',
  color: 'var(--dsw-alias-label-secondary)',
  cursor: 'pointer',
  borderRadius: 'var(--dsw-radius-sm)',
  fontFamily: 'inherit',
}

/**
 * How long the reader has to stop typing before the host is sent to look.
 *
 * A warm is a guess about what the next Tab will ask, and the guess is only
 * worth its cost if the answer is in memory when the key lands: too eager and a
 * device runs a process per keystroke, too late and the Tab pays for it anyway.
 * A quarter of a second is under the pause before a Tab and over the gap between
 * the characters of a word, and the host's caches do the rest — a longer word
 * reuses the answer taken for its prefix.
 */
const WARM_DELAY_MS = 250

/**
 * The shell-integration report that closes a command record: `ESC ] 133 ; D`.
 *
 * The host's splitter reads the same bytes for the exit code, so this is the
 * existing, already-trusted signal for "a command finished" — no new channel and
 * nothing to keep in step.
 */
const COMMAND_DONE_MARKER = '\u001b]133;D'

/**
 * How often a settled command may start a warm.
 *
 * A command's output arrives in many chunks and each one may carry the marker
 * (a prompt redraw reprints it), so the signal is throttled rather than trusted
 * to be rare. One warm a second is far more than a reader can type into.
 */
const WARM_AFTER_COMMAND_MS = 1_000

/** The completion seat, created once per browser face and shared with the list. */
export interface DshellInputCompletion {
  readonly completion: ShellCompletion
  /** The ghost's store and query, created once and shared with the ghost. */
  readonly hints: CommandHints
}

export interface DshellInputStandardProps {
  /**
   * Live composer state — the submit router reads the draft and the pending
   * attachment ids. The declared shape is the subset dshell touches; the stock
   * store carries more.
   */
  useInput?: <S>(sel: (state: { draft: string; attachmentIds?: readonly string[] }) => S, eq?: (a: S, b: S) => boolean) => S
  /** Programmatic draft writes (the router clears the composer after a shell send). */
  inputActions?: { setDraft(text: string): void }
}

/**
 * Compact dshell controls rendered into the stock composer's
 * `conversation.input.left` slot, plus the dual-mode submit router.
 *
 * Mode is a per-session store (`shell` | `agent`, default `shell`):
 *  - `agent` — the stock composer behaves exactly like dsh: Enter runs
 *    the command adjudication / sends the prompt, `/` and `@` popups,
 *    model select, context ring, attachments all untouched.
 *  - `shell` — Enter (and the stock send button) is captured and the
 *    draft goes to the bridge-owned main PTY instead of the model. A
 *    leading `/` is left to the stock command pipeline in both modes
 *    (`/new`, `/compact`, skills), so the composer's command surface keeps
 *    working. The stock internals expose no submit hook for plain text
 *    (`matchEnter` is only polled for trigger-prefixed lines), so the
 *    router is a capture-phase listener on the composer card that reads
 *    the draft from the stock input store and clears it through
 *    `inputActions`.
 */
export function DshellLeftControls(props: {
  sessionId: SessionId | undefined
  mode: SnapshotStore<SessionMode> | undefined
  pty: PtyStreamService | undefined
  /** The terminal-mode flag; the wrapper gates on it, the chip never sees off. */
  modes: TerminalModeClient
  setMode(next: SessionMode): void
  submitShell(text: string): void
} & DshellInputStandardProps & DshellInputCompletion & PropsLocale<'dshellMode'>): ReactElement | null {
  const { t } = props
  const theme = useDshellTheme()
  const mode = useSyncExternalStore(
    props.mode?.subscribe ?? (() => () => {}),
    props.mode?.getSnapshot ?? (() => 'shell' as SessionMode),
  )
  // Latest draft, kept in a ref so the DOM-level listener reads it
  // without re-subscribing on every keystroke.
  const draft = props.useInput?.(state => state.draft) ?? ''
  const draftRef = useRef(draft)
  draftRef.current = draft
  // A pending attachment is the one thing bash cannot receive. Routing is
  // decided here, not in bash: with a file attached the stock pipeline runs,
  // which is what puts the image in front of the model.
  const attachmentCount = props.useInput?.(state => state.attachmentIds?.length ?? 0) ?? 0
  const attachmentsRef = useRef(attachmentCount)
  attachmentsRef.current = attachmentCount
  const modeRef = useRef(mode)
  modeRef.current = mode
  const sessionIdRef = useRef(props.sessionId)
  sessionIdRef.current = props.sessionId
  // Agent mode gives the keyboard back to the stock composer editor. The
  // block view never takes focus for itself, so nothing has to be blurred.
  useEffect(() => {
    if (mode !== 'agent') return
    const editor = document.querySelector('[contenteditable="true"][role="textbox"]')
    if (editor instanceof HTMLElement) editor.focus()
  }, [mode])
  const pty = props.pty
  const sendShell = props.submitShell
  const clearDraft = props.inputActions?.setDraft
  const completion = props.completion
  const hints = props.hints
  // The switches the shell helpers are gated by. Held in a ref as well, because
  // the key interceptor is a DOM-level listener that has to read the current
  // value without being re-registered on every flip.
  const helpers = useShellHelpers()
  const helpersRef = useRef(helpers)
  helpersRef.current = helpers
  // The pending warm, and the question it was scheduled for. Both are refs
  // because the keydown interceptor is a DOM listener that must not be
  // re-registered per keystroke.
  const warmTimerRef = useRef<number | undefined>(undefined)
  /**
   * The session whose entry warm is waiting for the shell to say where it is.
   *
   * Held in a ref rather than state: the chunk listener is registered once per
   * session and reads it at call time, so a state update would only re-register
   * a listener to tell it the same thing.
   */
  const entryWarmRef = useRef<string | undefined>(undefined)
  const warmKeyRef = useRef('')
  const completeOpen = useSyncExternalStore(
    completion.store.subscribe,
    () => completion.store.getSnapshot() !== null,
  )
  // The legend names the ghost's key only while the ghost is actually drawn —
  // not merely while a hint is in hand, since a caret parked mid-line hides it.
  const hintVisible = useSyncExternalStore(hints.visible.subscribe, hints.visible.getSnapshot)
  // The ghost follows the draft, wherever the draft came from. Driving it from
  // an effect rather than from the keydown handler is what makes typing work:
  // the handler runs before the composer has taken the character, so it can only
  // ever offer the PREVIOUS line. Switched off, it must not even ask: the query
  // is what would put a hint in hand for the arrow to take.
  useEffect(() => {
    if (mode !== 'shell' || props.sessionId === undefined || !helpers.commandHint) { hints.clear(); return }
    hints.offer(String(props.sessionId), draft)
  }, [mode, props.sessionId, draft, hints, helpers.commandHint])
  // A settled command is the moment the world changed while the reader is
  // reading its output: the shell may have moved, a directory may have gained or
  // lost files, and the next Tab — `cd <Tab>`, `ls <Tab>` — reads exactly that
  // directory. Reading it NOW costs nothing the reader can feel, and it is what
  // turns a path completion after a pause from a second of waiting into a local
  // match on a device (see the host's `readings.ts`).
  //
  // The signal is the shell-integration report the bridge already relies on, and
  // it also rides the replay a fresh attach sends — which is what warms the first
  // Tab of a session nobody has typed in yet.
  //
  // The same chunk usually carries the shell's report of where it now stands
  // (OSC 3008, written before every prompt). That is adopted FIRST, so a warm
  // triggered by a settled command aims at the directory the command landed in
  // rather than the one it left — which is what `cd <Tab>` reads.
  useEffect(() => {
    const sessionId = props.sessionId
    if (mode !== 'shell' || sessionId === undefined || pty === undefined) return
    let tail = ''
    let last = 0
    return pty.onChunk((chunkSession, chunk) => {
      if (chunkSession !== sessionId) return
      // Both reports can straddle two chunks, so the scan carries a little of the
      // previous text rather than trusting the frame boundary.
      const text = tail + chunk.text
      tail = text.slice(-96)
      const reported = shellReportCwd(text)
      if (reported !== undefined && reported !== completion.cwdFor(sessionId)) {
        completion.trackShellCwd(sessionId, reported)
        // …and this is the entry warm's real moment: the shell has spoken, so the
        // session's world is up (for a device, its connection exists) and the
        // directory is one the shell itself named. Entering a session walks a
        // replay that ends with this report, so a reader who lands in a device
        // session and reaches for Tab without typing anything first still finds
        // the directory already read.
        if (entryWarmRef.current === sessionId && helpersRef.current.tabCompletion) {
          entryWarmRef.current = undefined
          const draft = draftRef.current
          completion.warm(sessionId, draft, draft.length, helpersRef.current.completionShellOracle)
        }
      }
      if (!text.includes(COMMAND_DONE_MARKER)) return
      const now = Date.now()
      if (now - last < WARM_AFTER_COMMAND_MS) return
      last = now
      if (!helpersRef.current.tabCompletion) return
      const draft = draftRef.current
      completion.warm(sessionId, draft, draft.length, helpersRef.current.completionShellOracle)
    })
  }, [mode, props.sessionId, pty, completion])
  // …and once when a session is opened, so the FIRST Tab of a session nobody has
  // typed in is warm too. The replay a fresh attach sends usually carries the
  // settle marker, but nothing guarantees this side was subscribed in time to see
  // it, and one look at the directory the shell starts in is the cheapest way to
  // make that first key feel like every other one.
  //
  // Entering arms a second warm as well, which the chunk effect fires when the
  // shell reports where it stands (see `shell-report.ts`). The pair is deliberate:
  // the warm here can only use the session's recorded directory, and on a device
  // it may run before the connection exists at all; the one the report triggers
  // runs when both are facts. Two requests, one of which is answered from the
  // host's cache.
  useEffect(() => {
    const sessionId = props.sessionId
    if (mode !== 'shell' || sessionId === undefined) return
    if (!helpersRef.current.tabCompletion) return
    entryWarmRef.current = sessionId
    const draft = draftRef.current
    completion.warm(String(sessionId), draft, draft.length, helpersRef.current.completionShellOracle)
  }, [mode, props.sessionId, completion])
  // A gesture switched off mid-flight must not leave its list behind: the list
  // is the only place its keys are explained, so it goes with them. Which switch
  // owns the open list is the list's own `source` — Tab opened one and ↑ opened
  // another, and those two settings are independent.
  useEffect(() => {
    const open = completion.store.getSnapshot()
    if (open === null) return
    const enabled = open.source === 'history' ? helpers.historyList : helpers.tabCompletion
    if (!enabled) completion.store.set(null)
  }, [completion, helpers.tabCompletion, helpers.historyList])

  useEffect(() => {
    if (pty === undefined || clearDraft === undefined) return
    const route = (): boolean => {
      if (modeRef.current !== 'shell') return false
      // Leave an attached message to the stock sender: a shell has no way to
      // read an image, and dropping the attachment silently is worse than
      // answering in the wrong surface.
      if (attachmentsRef.current > 0) return false
      const text = draftRef.current
      if (text.trim().length === 0) return false
      // A leading slash belongs to the stock command/trigger pipeline
      // (`/new`, `/compact`, skills, …) in both modes — never to bash.
      if (text.trimStart().startsWith('/')) return false
      sendShell(text)
      // The terminal owns the directory; this is how our mirror of it follows.
      completion.trackCd(String(sessionIdRef.current), text)
      clearDraft('')
      return true
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target
      const inComposer = target instanceof Element && target.closest('[data-composer-card]') !== null
      // Terminal chords must behave the same whether the keyboard is in the
      // canvas or the composer: the composer is the input line too, so
      // Ctrl+C interrupts the foreground job and Ctrl+Shift+C copies the
      // terminal selection from either focus owner.
      if (inComposer && modeRef.current === 'shell' && !event.isComposing) {
        const mod = event.ctrlKey || event.metaKey
        const key = event.key.toLowerCase()
        if (event.ctrlKey && !event.metaKey && !event.shiftKey && key === 'c') {
          // Bash's line editor abandons the current line on Ctrl+C, so the
          // draft goes with it.
          event.preventDefault()
          event.stopImmediatePropagation()
          clearDraft('')
          pty.send('\u0003')
          return
        }
        if (mod && event.shiftKey && key === 'v' && navigator.clipboard !== undefined) {
          event.preventDefault()
          event.stopImmediatePropagation()
          void navigator.clipboard.readText().then(
            (text) => { if (text.length > 0) pty.send(text) },
            () => { /* clipboard denied */ },
          )
          return
        }
      }
      if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
      if (!inComposer) return
      // A completion mid-gesture owns Enter: it accepts the highlight (see
      // onCompletionKey), and running a half-built line is exactly what the
      // user asked not to happen.
      if (completion.store.getSnapshot() !== null) return
      if (!route()) return
      event.preventDefault()
      event.stopImmediatePropagation()
    }
    // Shell-mode completion. dsh's trigger menu floats in the same overlay and
    // marks itself `data-trigger-menu`.
    const stockMenu = (): boolean => document.querySelector('[data-trigger-menu]') !== null
    /**
     * Whether dsh's menu is the one that should answer Tab.
     *
     * Its slash rule is positional, not path-aware: any `/` after punctuation
     * opens a command trigger, so typing `ls ~/` pops the command list with an
     * empty query and Tab would PICK a command, mangling the shell line. Only a
     * leading slash is a command here (`/new`); a slash later in the line is
     * an argument, which in shell mode is a path.
     */
    const stockCommand = (): boolean => stockMenu() && draftRef.current.trimStart().startsWith('/')
    /**
     * Close the stock menu the way the framework closes it on a click outside
     * the composer (MenuView's own pointerdown listener asks the controller to
     * dismiss). Called before this completion takes the overlay so the two
     * never stack, and because leaving it open is what let Tab reach it.
     */
    const dismissStock = (): void => {
      if (!stockMenu()) return
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }))
    }
    const pathLike = (token: string): boolean =>
      token.startsWith('/') || token.startsWith('.') || token.startsWith('~') || token.includes('/')
    /**
     * Whether an empty answer is worth a card.
     *
     * "No matches" is the shell's answer to a path that is not there, and the
     * reader is owed it when a word was really up for completion. A bare word in
     * an argument position (`echo hi<Tab>`) is not a failed completion — `hi` is
     * just a word, and a card saying nothing matched would be noise; a word
     * carrying a slash (`ls none/<Tab>`) is a path request, so its miss is
     * reported. A FLAG is the one position that says nothing about a miss: the
     * shell's own completion is silent there (`git checkout --<Tab>` lists
     * nothing and says nothing), and the reader is typing a spelling, not asking
     * about the world. The position comes from the line scanner, so this rule and
     * the host's dispatch agree by construction rather than by both sides
     * remembering the same rule.
     */
    const worthSaying = (caret: ShellCaret): boolean =>
      caret.position === 'command' || caret.position === 'redir'
      || pathLike(caret.dirPart + caret.prefix)
    const onCompletionKey = (event: KeyboardEvent): boolean => {
      const sessionId = sessionIdRef.current
      if (modeRef.current !== 'shell' || sessionId === undefined || clearDraft === undefined) return false
      /**
       * Write a completion into the composer.
       *
       * A directory lands with its trailing slash, and a trailing slash is a
       * live trigger for dsh's menu — a command list, which is never what a
       * shell line wants there. The trigger pass runs after this write, so the
       * dismiss is deferred one task rather than fired inline.
       */
      const writeDraft = (text: string | undefined): void => {
        // Never hand the editor an undefined draft: it calls `text.replace`.
        clearDraft(typeof text === 'string' ? text : '')
        window.setTimeout(dismissStock, 0)
      }
      /**
       * Whether an answer that has just arrived is still the one being waited for.
       *
       * A round trip outlives the keystroke that started it. In that window the
       * session can be switched, the mode flipped, the draft typed on, or the
       * assist switched off — and an answer landing then would rewrite a line
       * nobody asked about (or, with the session changed, write into the wrong
       * one). The switch is the case the Host cannot know about, which is why
       * the gesture is re-checked here rather than only where it is claimed.
       */
      const stillWanted = (
        sid: string,
        draftNow: string,
        gesture: 'tabCompletion' | 'historyList',
      ): boolean =>
        sessionIdRef.current === sid
        && modeRef.current === 'shell'
        && draftRef.current === draftNow
        && helpersRef.current[gesture]
      /**
       * Put one answer up — the whole gesture, from either phase.
       *
       * One candidate is applied and closes the list (a directory with its
       * slash, a finished word with the space after it, which is how the shell's
       * rhythm resumes), several open it, and an empty answer the reader was not
       * owed stays quiet rather than showing a card.
       *
       * @param caret - the line's reading, from the shared scanner.
       * @param state - the host's answer, or null when it had none.
       */
      const settle = (draftNow: string, caret: ShellCaret, state: CompletionState | null): void => {
        if (state === null) { completion.store.set(null); return }
        // An empty answer that is still on its way is held rather than drawn:
        // the list renders nothing for it, and holding it is what lets the
        // refine below prove it is answering the SAME question.
        if (state.items.length === 0 && state.pending) { completion.store.set(state); return }
        if (state.items.length === 0 && !worthSaying(caret)) { completion.store.set(null); return }
        if (state.items.length === 1) {
          const next = completion.apply(state, 0, draftNow)
          if (next !== undefined) writeDraft(next.text)
          completion.store.set(null)
          return
        }
        completion.store.set(state)
      }
      /**
       * Ask the session's own shell for the words only it has — the second pass.
       *
       * The fast answer is already on screen, so this one is allowed to be late:
       * it is applied only while the store still holds the very state it was
       * asked about, which `pending` marks and any other gesture (Escape, a
       * cycled candidate, another Tab, a keystroke) clears. That is what keeps a
       * late list from appearing over a line the reader has since changed.
       */
      const refine = (sid: string, draftNow: string, caret: ShellCaret, from: CompletionState): void => {
        if (!helpersRef.current.tabCompletion || !helpersRef.current.completionShellOracle) return
        void completion.request(sid, draftNow, caret.end, 'refine').then((answer) => {
          if (!stillWanted(sid, draftNow, 'tabCompletion')) return
          if (completion.store.getSnapshot() !== from) return
          settle(draftNow, caret, answer)
        }).catch(() => { /* the fast answer stands */ })
      }
      /**
       * Ask the host for the candidates under the caret and put the answer up.
       *
       * The request carries the line and the caret offset, not a token: the host
       * reads the line itself, so it is the one that decides what is where — and
       * when its answer says more is coming (`pending`), the shell gets asked
       * too, without making the reader wait for it.
       */
      const ask = (sid: string, draftNow: string, caret: ShellCaret): void => {
        dismissStock()
        void completion.request(sid, draftNow, caret.end).then((state) => {
          if (!stillWanted(sid, draftNow, 'tabCompletion')) return
          settle(draftNow, caret, state)
          if (state !== null && state.pending) refine(sid, draftNow, caret, state)
        }).catch(() => { completion.store.set(null) })
      }
      /**
       * Get the host's caches ready for the Tab this line is heading towards.
       *
       * A completion against a device is a round trip the reader feels: the
       * session's world is another machine, and everything this side needs from
       * it — a directory's children, the shell's own vocabulary — is asked for
       * over the wire, one process per answer. So the same question is asked
       * EARLY, in the background, and thrown away: by the time the key lands the
       * answer is in the host's memory and the Tab costs a local match.
       *
       * The question is everything BEFORE the word being typed, so typing costs
       * one warm per word rather than one per character — `docker r` and
       * `docker re` are the same question, and the host reuses the answer it
       * took for the shorter prefix.
       */
      const scheduleWarm = (sid: string, draftNow: string): void => {
        if (!helpersRef.current.tabCompletion) return
        // A blank line, or an operator under the caret, names no word: there is
        // nothing a Tab there would ask for.
        const caret = readShellCaret(draftNow, draftNow.length)
        if (caret === undefined) return
        const key = `${caret.position}\u0000${draftNow.slice(0, caret.start - caret.dirPart.length)}`
        if (key === warmKeyRef.current) return
        if (warmTimerRef.current !== undefined) window.clearTimeout(warmTimerRef.current)
        warmTimerRef.current = window.setTimeout(() => {
          warmTimerRef.current = undefined
          // The reader has stopped for a moment. Going stale the other way is
          // what this re-check is for: the pause can end in a session switch, a
          // mode flip, or a line that no longer looks like this one.
          if (modeRef.current !== 'shell' || sessionIdRef.current !== sid) return
          warmKeyRef.current = key
          completion.warm(sid, draftRef.current, draftRef.current.length, helpersRef.current.completionShellOracle)
        }, WARM_DELAY_MS)
      }
      const open = completion.store.getSnapshot()
      const key = event.key
      if (key === 'Escape') {
        if (open === null) return false
        completion.store.set(null)
        return true
      }
      // Tab and the arrows are the same gesture over an open list: move the
      // highlight AND put it in the draft. Applying on the move is what keeps
      // the visible text and the highlight from ever disagreeing — the composer
      // is the input line, so whatever is highlighted has to be what Enter
      // would send.
      const cycling = open !== null && open.items.length > 0
      if (cycling && (key === 'Tab' || key === 'ArrowDown' || key === 'ArrowUp')) {
        // Up is the previous (older) row in every source: history lists its
        // newest command at the bottom, so its array order already reads that
        // way, and a directory listing is a plain ring.
        const back = key === 'ArrowUp' || (key === 'Tab' && event.shiftKey)
        const index = (open.index + (back ? -1 : 1) + open.items.length) % open.items.length
        const next = completion.apply(open, index, draftRef.current)
        if (next !== undefined) {
          writeDraft(next.text)
          completion.store.set(next.state)
        }
        return true
      }
      // Enter ACCEPTS the highlight instead of sending the line: a completion
      // mid-gesture means the line is still being built, and running a
      // half-finished path is never what was meant. Accepting stops there —
      // the highlighted name goes into the draft and the list closes. It does
      // NOT descend into a directory, because walking deeper is the user's
      // decision, not this key's: another Tab asks for the next list.
      if (key === 'Enter' && !event.shiftKey && open !== null) {
        if (open.items.length === 0) {
          // Nothing to accept — the card was saying so. Closing it is the whole
          // answer, so this Enter does not fall through to the sender either.
          completion.store.set(null)
          return true
        }
        const next = completion.apply(open, open.index, draftRef.current)
        if (next === undefined) return false
        writeDraft(next.text)
        completion.store.set(null)
        return true
      }
      // Up without a list to walk is the shell's own gesture: the history list,
      // oldest row at the top and the newest at the BOTTOM, so up starts on
      // that bottom row and keeps walking upward into the past. `draft` is the
      // query: only entries sharing a prefix with it are listed, in the same
      // chronological order, so the bottom row is still the most recent match.
      if (key === 'ArrowUp' && !cycling) {
        // Switched off, ↑ is the browser's again — a caret move in the line.
        if (!helpersRef.current.historyList) return false
        const draftNow = draftRef.current
        void completion.requestHistory(sessionId, draftNow).then((state) => {
          if (!stillWanted(sessionId, draftNow, 'historyList')) return
          if (state === null) { completion.store.set(null); return }
          const next = completion.apply(state, state.index, draftNow)
          if (next === undefined) { completion.store.set(state); return }
          writeDraft(next.text)
          completion.store.set(next.state)
        }).catch(() => { completion.store.set(null) })
        return true
      }
      // The right arrow takes one word of the ghost hint — the gesture that makes
      // a suggestion usable rather than decoration. It claims the key only when
      // there IS a chunk to take, so the caret keeps its ordinary behaviour
      // whenever the ghost is not showing one. (Ctrl+→ and Alt+→ never reach
      // this handler — the full-mode guard refuses them — while Shift+→ is let
      // through above as the selection it is.)
      if (key === 'ArrowRight' && !event.shiftKey) {
        const next = hints.accept(sessionId, draftRef.current)
        if (next !== undefined) {
          writeDraft(next)
          // The list's offsets assume the caret sits at the end of the draft it
          // was built for, and that draft has just moved on.
          completion.store.set(null)
          return true
        }
      }
      if (key !== 'Tab') {
        // Any other edit or caret move invalidates the list: its offsets assume
        // the caret sits at the end of the draft. The next Tab rebuilds it.
        const edited = key.length === 1 || key === 'Backspace' || key === 'Delete'
        const stales = edited || key === 'ArrowLeft' || key === 'ArrowRight'
        if (open !== null && stales) completion.store.set(null)
        // The line has moved, so the answer the next Tab wants may have too.
        if (edited) scheduleWarm(sessionId, draftRef.current)
        return false
      }
      // A fresh Tab: ask the host for the candidates under the caret.
      // Switched off, Tab is the browser's again — which in a composer is what
      // it always was: the next focusable control below.
      if (!helpersRef.current.tabCompletion) return false
      const draftNow = draftRef.current
      // The caret is at the end of the draft: the composer IS the input line, and
      // a shell line is typed left to right. The scanner is the SAME one the host
      // answers with (`std/src/shell-line.ts`), so the two halves cannot disagree
      // about what sits at the caret. It used to be decided here instead, by a
      // second local rule (first word = command, a slash = path), and the two
      // copies of the rule drifted the moment a line was more than one word.
      const caret = readShellCaret(draftNow, draftNow.length)
      // Nothing to complete: a blank line, or an operator under the caret (which
      // names no word at all). Tab still must not leave the input — letting it
      // fall through is what landed the user on the composer's buttons. Shift+Tab
      // is left alone as the way back out.
      if (caret === undefined) return !event.shiftKey
      // dsh's own triggers keep their keys: `@` is its file reference, whose
      // menu the stock pipeline arbitrates (a leading slash never reaches here —
      // see stockCommand).
      if (caret.dirPart === '' && caret.prefix.startsWith('@')) return false
      // A visible stock menu here is a command list for what is really a path
      // (see stockCommand): close it before the one round trip, so the two
      // overlays never share the seat.
      event.preventDefault()
      event.stopImmediatePropagation()
      ask(sessionId, draftNow, caret)
      return true
    }
    const onKeyDownFull = (event: KeyboardEvent): void => {
      const target = event.target
      const inCard = target instanceof Element && target.closest('[data-composer-card]') !== null
      if (!inCard || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return
      if (stockCommand()) return
      if (onCompletionKey(event)) {
        event.preventDefault()
        event.stopImmediatePropagation()
      }
    }
    const onPointerDown = (event: MouseEvent): void => {
      const target = event.target
      if (!(target instanceof Element)) return
      if (target.closest('[class*="_primary"]') === null) return
      if (target.closest('[data-composer-card]') === null) return
      if (!route()) return
      event.preventDefault()
      event.stopImmediatePropagation()
    }
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('keydown', onKeyDownFull, true)
    document.addEventListener('click', onPointerDown, true)
    return () => {
      // A warm that has not fired yet belongs to a listener that is going away.
      if (warmTimerRef.current !== undefined) window.clearTimeout(warmTimerRef.current)
      warmTimerRef.current = undefined
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('keydown', onKeyDownFull, true)
      document.removeEventListener('click', onPointerDown, true)
    }
  }, [pty, sendShell, clearDraft, completion, sessionIdRef])

  if (props.sessionId === undefined) return null
  /** The legend, naming each assist only while it is switched on: promising a
   * key the settings card has turned off is a worse answer than a shorter line. */
  const legendFor = (...leading: readonly string[]): string => [
    ...leading,
    ...helpers.tabCompletion ? [t('composer.legend.tab')] : [],
    ...helpers.historyList ? [t('composer.legend.history')] : [],
    t('composer.legend.ctrlC'),
  ].join(' · ')
  /**
   * What the `?` reveals: the legend for the mode in force, live — a completion
   * mid-gesture names its own keys, an attachment says why the line will not run.
   */
  const legend = mode === 'shell'
    ? (attachmentCount > 0
      ? t('composer.legend.attachments')
      : completeOpen
        ? t('composer.legend.completionOpen')
        // The ghost is the one gesture with no visible affordance of its own,
        // so the legend names its key while a ghost is actually drawn — and
        // only then, since → is an ordinary caret move the rest of the time.
        : hintVisible
          ? legendFor(t('composer.legend.acceptWord'), t('composer.legend.continueHint'))
          : legendFor(t('composer.legend.idle')))
    : t('composer.legend.agent')
  // The mode as the one glyph that names it — `$` for shell, `✦` for agent —
  // and nothing else: the word was the chip's whole width, and the ink says
  // which mode it is as well as the glyph does. Clicking it still flips the
  // mode, and the tooltip spells the symbol out.
  const next: SessionMode = mode === 'shell' ? 'agent' : 'shell'
  const glyph = mode === 'shell' ? '$' : '✦'
  const modeLabel = `${glyph} ${t(mode === 'shell' ? 'composer.mode.shell' : 'composer.mode.agent')}`
  const modeStyle: CSSProperties = {
    ...controlStyle,
    color: mode === 'shell' ? theme.accentText : theme.muted,
    fontSize: 14,
    lineHeight: 1,
  }
  const modeButton: ReactElement = createElement('button', {
    type: 'button',
    'data-dshell-control': '',
    style: modeStyle,
    'aria-label': modeLabel,
    onClick: () => { props.setMode(next) },
  }, glyph)
  // One `?` in place of the legend: the row it costs is the row the model
  // selector and the send button need, and the legend is read once, not every
  // time. It is a button so the keyboard can reach it, wrapped in dsh's own
  // tooltip — the same 500ms hover the composer's other controls use.
  // Typed as a plain element on purpose: Tooltip's anchor contract is a weak
  // type (every field optional), and the `?` carries no handler for the check to
  // match on — the tooltip supplies the ones it needs.
  const legendButton: ReactElement = createElement('button', {
    type: 'button',
    'data-dshell-control': '',
    style: controlStyle,
    'aria-label': legend,
  }, createElement(IconQuestionOutlineRegular, { size: 14 }))
  // The way into full screen is NOT here: it is `/fullscreen`, for the same
  // reason the mode switch is a command — a control that is used once does not
  // deserve a place in the row the model selector and the send button share.
  return createElement('div', { style: controlsRowStyle },
    createElement(Tooltip, { label: modeLabel, side: 'top', delayMs: 500, children: modeButton }),
    createElement(Tooltip, { label: legend, side: 'top', delayMs: 500, children: legendButton }),
  )
}

/** Temporary diagnostic boundary: surfaces a render failure inside the
 * dshell view instead of letting the stock slot boundary swallow it. */
export class DshellViewBoundary extends Component<{ children: ReactElement }, { error: string | null }> {
  constructor(props: { children: ReactElement }) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error: unknown): { error: string } {
    return { error: error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error) }
  }

  override render(): ReactElement {
    if (this.state.error !== null) {
      return createElement('pre', {
        'data-dshell-view-error': '',
        style: {
          color: 'var(--dsw-alias-state-error-primary)',
          fontSize: 12, whiteSpace: 'pre-wrap', padding: 12,
        },
      }, this.state.error)
    }
    return this.props.children
  }
}
