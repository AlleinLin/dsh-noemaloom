/**
 * Shell-mode path completion for the composer, and the list that shows it.
 *
 * The composer IS dshell's input line: the terminal region in the block view is
 * a read-only mirror (`disableStdin`), so every keystroke the user aims at their
 * shell is typed here and routed to the PTY on Enter. dsh's own completion menu
 * cannot help with that text — it only fires on the `/` and `@` triggers — so
 * `cd /home/wp<Tab>` had nowhere to go and Tab simply moved focus out.
 *
 * This module is the missing half: the state the Tab interceptor in
 * `controls.ts` writes and the floating list above the composer reads, plus the
 * two route calls behind it. Completion itself belongs to the host (`complete`
 * and `resolve` in dshell-files), because the path has to be resolved in the
 * SESSION'S world — this machine for a local session, the device for a bound one
 * — and the browser cannot know which that is.
 *
 * The wire shapes are restated here rather than imported: dshell-files has no
 * `/client` namespace, and importing its root would drag host-only code
 * (`node:os`, the terminal bridge) into this bundle.
 */

import { createElement, useEffect, useRef, useSyncExternalStore, type CSSProperties, type ReactElement, type RefObject } from 'react'
import {
  DSHELL_FILES_PATH, DSHELL_PTY_PATH,
  type DshellCompletionCandidate, type DshellCompletionNote, type ShellPosition,
} from '@nexus-aethra/dshell-std'
import { FileTypeIcon, classifyFileType, useAnchoredMaxHeight } from '@deepseek-ai/dsh-client-ui-primitives'
// Type-only: pulls the Conversation SlotMap (`conversation.input.overlay`) and
// the SessionStandardProps that hand a slot its `useInput`/`inputActions`.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { useDshellTheme } from './theme.js'
import type { TerminalModeClient } from './terminal-mode.js'
import { NOTE_KEYS, type DshellModeKey } from './locales.js'

/** The files route, from the shared contract: dshell-files owns it. */
const FILES_PATH = DSHELL_FILES_PATH

/**
 * The bridge's history route, from the same place (`DSHELL_PTY_PATH`). Both
 * paths used to be restated here by hand because the client could not import a
 * host module; the standard layer exists so that drift like that is a compile
 * error instead of a 404 the user finds.
 */
const HISTORY_PATH = DSHELL_PTY_PATH

/** One candidate, whose kind the list draws a glyph and a label for. */
export type CompletionCandidate = DshellCompletionCandidate

/** One open completion over the composer's draft. */
export interface CompletionState {
  readonly sessionId: string
  /**
   * Where the candidates came from. `history` replaces the whole line; `path`
   * and `command` both replace the token the host measured, at the offsets the
   * host sent.
   */
  readonly source: 'path' | 'command' | 'history'
  /**
   * Where in the line the completion happened, as the host's line scanner read
   * it (`std/shell-line.ts`). Carried because the browser needs it to decide
   * whether an empty answer is worth showing — and because deciding that from
   * the token's shape here is exactly the second copy of the position rule that
   * this feature was rebuilt to remove. Undefined for history, whose "line" is a
   * whole command from the past.
   */
  readonly position: ShellPosition | undefined
  /**
   * Whether a better answer is still on its way (see the wire contract, and
   * `controls.ts` where the second request is made). The list must not draw an
   * EMPTY answer while this is true: the host is saying the shell has not
   * answered yet, and a "no matches" note now would be a lie the reader has to
   * unsee.
   */
  readonly pending: boolean
  /** Offsets in the draft the candidates replace (the basename, not the prefix). */
  readonly start: number
  readonly end: number
  /** Where the candidates came from, in the session's world (`PATH` for commands). */
  readonly dir: string
  readonly items: readonly CompletionCandidate[]
  /** Which candidate is highlighted. */
  readonly index: number
  /** Why the list is empty, when the host had something to say about it. */
  readonly note: DshellCompletionNote | undefined
  /** The draft exactly as this completion left it, so a foreign edit closes it. */
  readonly draft: string
}

/** The smallest store the two ends need: a snapshot plus subscribers. */
class CompletionStore {
  private state: CompletionState | null = null
  private readonly listeners = new Set<() => void>()

  getSnapshot = (): CompletionState | null => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  set(next: CompletionState | null): void {
    if (this.state === next) return
    this.state = next
    for (const listener of this.listeners) listener()
  }
}

/** What the interceptor and the list share. */
export interface ShellCompletion {
  readonly store: CompletionStore
  /** The directory the session's terminal stands in, once known. */
  cwdFor(sessionId: string): string | undefined
  /**
   * Ask the host what `cd <line>` did, so the next completion resolves against
   * the right directory. The shell's own directory is process state with no
   * channel back, so the line the composer routes is the source of truth.
   */
  trackCd(sessionId: string, line: string): void
  /**
   * One completion for the draft's line at the caret.
   *
   * @param phase - `fast` answers from what the host already knows, `refine`
   *   asks the session's own shell for the words only it has. A fast answer
   *   carries `pending: true` when the second pass is worth making.
   * @returns the state to show, or null when the host had nothing (no request
   *   was possible, or the token is not a path).
   */
  request(sessionId: string, line: string, cursor: number, phase?: 'fast' | 'refine'): Promise<CompletionState | null>
  /**
   * Get the host's caches ready for the Tab this line is heading towards.
   *
   * Nothing is returned and nothing is drawn: this asks the same question
   * {@link request} would and throws the answer away, so that the host already
   * holds the pieces when a Tab arrives a moment later. It exists because
   * asking a DEVICE for them costs a process per piece, which is a price worth
   * paying while the reader is still typing and not worth paying on the key.
   *
   * @param oracle - whether the session's own shell may be asked too. The
   *   switch that governs the shell oracle is this side's (like every other
   *   dshell switch), so this side is the only one that can say.
   */
  warm(sessionId: string, line: string, cursor: number, oracle: boolean): void
  /**
   * Adopt the directory the session's own shell reported it is in.
   *
   * The composer's `cwd` mirror used to be filled only by a `cd` typed through
   * it, which left two ordinary cases with no directory at all: a device session
   * whose shell starts somewhere other than the session's recorded tree, and any
   * session entered after the shell had already moved. The host falls back to
   * the session's own directory in that state, so the pre-warm read the wrong
   * place — and a Tab on the right one paid a device round trip for it.
   *
   * The report is the same OSC 3008 the shell prints before every prompt (see
   * `shell-report.ts`), so this costs a regex over bytes the client already
   * sees, and it is what makes the warm after a settled command aim at the
   * directory the command LANDED in rather than the one it left.
   *
   * @param cwd - the reported absolute path; ignored when empty.
   */
  trackShellCwd(sessionId: string, cwd: string): void
  /**
   * The session's command history, as the up-arrow list.
   *
   * `draft` is the query: only commands *starting with* it — compared
   * case-insensitively, spaces included — come back, newest first in the answer
   * and oldest first in the list, so a half-typed line pulls its own past
   * spellings up with the newest match on the bottom row. An empty draft is
   * plain history.
   *
   * The matching happens on the host because the host owns the index over the
   * whole history: filtering here could only ever see the rows this request was
   * sent, which is precisely the ceiling that made an old command unfindable.
   *
   * @returns the state to show, or null when nothing matches.
   */
  requestHistory(sessionId: string, draft: string): Promise<CompletionState | null>
  /** The draft with candidate `index` substituted, and the state that follows. */
  apply(state: CompletionState, index: number, draft: string): { text: string; state: CompletionState } | undefined
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

/** Candidates one history answer lists. */
const MAX_HISTORY_ITEMS = 60

/**
 * How long a directory that a completion just landed in stays "already warmed".
 *
 * Tab-Tab-Tab through a candidate list is one gesture, and every stop on a
 * directory is a place the reader might continue from — so the landing is worth
 * a warm, but cycling back and forth over the same few names is not worth a read
 * each time.
 */
const WARM_INSIDE_MS = 2_000

/** A `cd` argument the composer can hand to the host, or undefined for none. */
export function cdTargetOf(line: string): string | undefined | null {
  const trimmed = line.trim()
  if (!/^cd(\s|$)/u.test(trimmed)) return null
  const rest = trimmed.slice(2).trim()
  if (rest.length === 0) return '~'
  // Anything with expansion or chaining is beyond "which directory did we
  // land in": leave the tracked cwd alone rather than guess wrong.
  if (/[$`(){};&|<>]/u.test(rest)) return null
  const target = rest.startsWith('-') ? undefined : rest.split(/\s/u)[0]
  if (target === undefined || target === '' || target === '-') return null
  const unquoted = target.replace(/^(['"])(.*)\1$/u, '$2')
  return unquoted
}

/** Create the shared completion state for one browser face. */
export function createShellCompletion(): ShellCompletion {
  const store = new CompletionStore()
  const cwds = new Map<string, string>()
  // Directories this face has already sent a warm for, so cycling a list does not
  // read the same name again (see WARM_INSIDE_MS).
  const warmedDirs = new Map<string, number>()

  /**
   * Warm the directory a taken candidate just landed the reader inside.
   *
   * Taking a directory is a promise about the NEXT keystroke: the composer now
   * holds `logs/`, and the next Tab asks what is inside it. On a device that
   * question is three round trips, and it used to be exactly the one nobody had
   * pre-answered — the reader walked into a directory and the following Tab paid
   * for the privilege. The shell is not asked here: a caret inside a path is a
   * question for the directory, which is the half being warmed.
   */
  const warmInside = (state: CompletionState, index: number, text: string): void => {
    const item = state.items[index]
    if (item === undefined || item.kind !== 'directory') return
    const key = `${state.sessionId}\u0000${state.dir}\u0000${item.name}`
    const now = Date.now()
    for (const [other, at] of warmedDirs) if (now - at >= WARM_INSIDE_MS) warmedDirs.delete(other)
    if (warmedDirs.has(key)) return
    warmedDirs.set(key, now)
    const cwd = cwds.get(state.sessionId)
    void post(FILES_PATH, {
      action: 'warm',
      sessionId: state.sessionId,
      line: text,
      cursor: text.length,
      oracle: false,
      ...cwd === undefined ? {} : { cwd },
    }).catch(() => { /* the Tab that follows pays what it would have paid */ })
  }

  return {
    store,
    cwdFor: sessionId => cwds.get(sessionId),

    trackShellCwd(sessionId, cwd) {
      if (cwd.length === 0) return
      if (cwds.get(sessionId) === cwd) return
      cwds.set(sessionId, cwd)
    },

    trackCd(sessionId, line) {
      const target = cdTargetOf(line)
      if (target === undefined || target === null) return
      const cwd = cwds.get(sessionId)
      void post(FILES_PATH, {
        action: 'resolve',
        sessionId,
        path: target,
        ...cwd === undefined ? {} : { cwd },
      })
        .then((body) => {
          const resolved = body.resolved
          if (typeof resolved === 'string' && resolved.length > 0) cwds.set(sessionId, resolved)
        })
        .catch(() => { /* the shell still moved; only our mirror is stale */ })
    },

    async request(sessionId, line, cursor, phase) {
      const cwd = cwds.get(sessionId)
      const body = await post(FILES_PATH, {
        action: 'complete',
        sessionId,
        line,
        cursor,
        ...cwd === undefined ? {} : { cwd },
        ...phase === undefined ? {} : { phase },
      })
      const completion = body.completion
      if (completion === null || typeof completion !== 'object') return null
      const value = completion as {
        start: number
        end: number
        dir: string
        position: ShellPosition
        pending?: boolean
        candidates: readonly CompletionCandidate[]
        note?: DshellCompletionNote
      }
      return {
        sessionId,
        // The command position is the one the host read off the line: the last
        // word before this one was not a command, so this word is its name. It
        // used to be inferred here from the literal `dir === 'PATH'`, which was
        // one string away from being wrong the moment a second source answered
        // commands — and it is no longer the client's business either way.
        source: value.position === 'command' ? 'command' : 'path',
        position: value.position,
        pending: value.pending === true,
        start: value.start,
        end: value.end,
        dir: value.dir,
        items: value.candidates,
        index: 0,
        note: value.note,
        draft: line,
      }
    },

    warm(sessionId, line, cursor, oracle) {
      const cwd = cwds.get(sessionId)
      // Deliberately not awaited and deliberately silent: the answer is the
      // host's caches, this side never reads the reply, and a warm that failed
      // has cost the reader nothing — the Tab that follows simply pays what it
      // would have paid anyway.
      void post(FILES_PATH, {
        action: 'warm',
        sessionId,
        line,
        cursor,
        oracle,
        ...cwd === undefined ? {} : { cwd },
      }).catch(() => { /* see above */ })
    },

    async requestHistory(sessionId, draft) {
      // The draft travels with the request. A whitespace-only draft is the
      // plain-history case; anything else is a literal prefix, spaces included,
      // because `git ` really is a prefix of `git status`.
      const query = draft.trim().length === 0 ? '' : draft
      const body = await post(HISTORY_PATH, {
        action: 'history',
        sessionId,
        draft: query,
        limit: MAX_HISTORY_ITEMS,
      })
      const raw = Array.isArray(body.commands) ? body.commands : []
      const entries = raw.flatMap((entry) => {
        const command = (entry as { command?: unknown }).command
        return typeof command === 'string' && command.trim().length > 0 ? [command] : []
      })
      if (entries.length === 0) return null
      // Chronological, like a terminal: the newest command is the BOTTOM row
      // and up-arrow walks upward into the past. The host already answered with
      // the newest matches in that order, so a filter here would only re-apply
      // a local rule to a set that is no longer the whole story.
      return {
        sessionId,
        source: 'history',
        position: undefined,
        pending: false,
        // A command replaces the whole line, so the span is all of it.
        start: 0,
        end: draft.length,
        dir: '',
        items: entries.map(command => ({ name: command, kind: 'command' as const })),
        // The bottom row is the newest, which is where the gesture starts.
        index: entries.length - 1,
        note: undefined,
        draft,
      }
    },

    apply(state, index, draft) {
      const item = state.items[index]
      if (item === undefined) return undefined
      // What follows a taken candidate is the shell's own rhythm: a directory
      // opens with the slash that walks into it, and every other kind of word —
      // a command, a flag, a word only the shell could name — is finished, so
      // the next word starts after a space. The span covers what was written, so
      // cycling from `dock⇥ ` to the next candidate still replaces the whole
      // word rather than appending to it.
      const name = item.kind === 'directory'
        ? `${item.name}/`
        : item.kind === 'command' || item.kind === 'flag' || item.kind === 'word' ? `${item.name} `
          : item.name
      const text = draft.slice(0, state.start) + name + draft.slice(state.end)
      // Every path that takes a candidate comes through here — the auto-applied
      // single one, the cycled one, the clicked one — so this is the one place a
      // landed directory can be warmed without three copies of the rule.
      warmInside(state, index, text)
      return {
        text,
        state: { ...state, index, pending: false, end: state.start + name.length, draft: text },
      }
    },
  }
}

/** Design cap on the list height, clamped at runtime to the space above. */
const MAX_LIST_HEIGHT = 240

/**
 * The list's own card: the overlay layer is a zero-height absolutely
 * positioned box at the card's top edge, so entries float THEMSELVES — the
 * same `bottom: calc(100% + 4px)` the stock trigger menu uses. Flow layout
 * here would spill the list down over the composer card instead of lifting it
 * above, which is what made the first cut unreadable.
 */
function listStyle(theme: ReturnType<typeof useDshellTheme>, maxHeight: number): CSSProperties {
  return {
    position: 'absolute',
    bottom: 'calc(100% + 4px)',
    left: 0,
    right: 0,
    zIndex: 100,
    // Border-box so the runtime clamp is the card's real height, padding and
    // border included.
    boxSizing: 'border-box',
    maxHeight,
    overflowY: 'auto',
    borderRadius: 10,
    padding: '4px 0',
    fontSize: 12,
    background: theme.menuBg,
    border: `1px solid ${theme.menuBorder}`,
    boxShadow: '0 8px 22px rgba(0,0,0,.28)',
  }
}

/** One row: a glyph, the name, and a hint, with the highlighted row washed. */
function row(
  item: CompletionCandidate,
  active: boolean,
  theme: ReturnType<typeof useDshellTheme>,
  onPick: () => void,
  activeRef: RefObject<HTMLDivElement>,
  t: (key: DshellModeKey) => string,
): ReactElement {
  return createElement('div', {
    key: item.name,
    // The highlighted row is the one the list keeps in view (see the effect in
    // ShellCompletionList): a long directory would otherwise walk the selection
    // off the bottom edge with no way to see it.
    ref: active ? activeRef : null,
    'data-dshell-completion-item': item.kind,
    onMouseDown: (event: { preventDefault: () => void }) => { event.preventDefault(); onPick() },
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '3px 10px',
      cursor: 'pointer',
      background: active ? theme.accentFaint : 'transparent',
      color: active ? theme.accentText : theme.text,
    },
  },
    createElement('span', { style: { display: 'flex', alignItems: 'center', flex: '0 0 auto', opacity: 0.85 } },
      // One glyph per kind, and none of them borrowed: `$` says "a name this
      // shell can run", `-` says a flag (its own spelling already starts with
      // one), `·` says a word the shell offered — a subcommand, a target, a
      // branch — whose nature this side does not know and must not pretend to.
      // A file's icon would lie for all three.
      item.kind === 'command'
        ? createElement('span', {
          style: { width: 14, textAlign: 'center', fontSize: 11, opacity: 0.6 },
        }, '$')
        : item.kind === 'flag' || item.kind === 'word'
          ? createElement('span', {
            style: { width: 14, textAlign: 'center', fontSize: 11, opacity: 0.6 },
          }, item.kind === 'flag' ? '-' : '·')
          : createElement(FileTypeIcon, {
            kind: item.kind === 'directory' ? 'folder' : classifyFileType(item.name),
            size: 14,
          })),
    createElement('span', {
      style: { flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
    }, item.kind === 'directory' ? `${item.name}/` : item.name),
    // A command's kind is what its `$` already said, and the shell's own words
    // say theirs with their glyph: the hint column is left to files (their size)
    // and to directories (which the slash says).
    item.kind === 'command'
      ? createElement('span', { style: { opacity: 0.6, flex: '0 0 auto' } }, t('completion.command'))
      : item.kind !== 'directory' && item.hint !== undefined && item.hint !== ''
        ? createElement('span', {
          style: { opacity: 0.6, flex: '0 0 auto' },
        }, item.hint)
        : null,
  )
}

/**
 * The completion list, mounted in the composer card's floating overlay — the
 * same seat dsh's own trigger menu uses, so it sits above the input line
 * without pushing the layout.
 */
export function ShellCompletionList(
  props: {
    readonly completion: ShellCompletion
    readonly modes: TerminalModeClient
    readonly sessionId: SessionId | undefined
  } & PropsRuntime<'conversation.input.overlay'> & PropsLocale<'dshellMode'>,
): ReactElement | null {
  const { t } = props
  const theme = useDshellTheme()
  const state = useSyncExternalStore(props.completion.store.subscribe, props.completion.store.getSnapshot)
  // The draft and its writer come from the composer's own standard kit, so the
  // list stays in step with typing it did not initiate.
  const draft = props.useInput(state2 => state2.draft)
  // Bottom-anchored, so only the top edge can collide with the viewport; the
  // clamp is dsh's own (the slash menu uses the same hook).
  const listRef = useRef<HTMLDivElement>(null)
  const maxHeight = useAnchoredMaxHeight(listRef, MAX_LIST_HEIGHT, state)
  // Keep the highlight visible. The browser never scrolls a row into view by
  // itself here — the keyboard moved the selection, not the caret — so Tab/arrow
  // walking past the bottom edge would leave the user selecting something they
  // cannot see. Same treatment the stock trigger menu gives its own list.
  const activeRef = useRef<HTMLDivElement>(null)
  const activeIndex = state?.index ?? -1
  useEffect(() => {
    if (activeIndex < 0) return
    activeRef.current?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])
  if (state === null) return null
  // An empty answer that is still on its way somewhere is not drawn: the shell
  // has not answered yet, and "no matches" now would be replaced by a list a
  // moment later (see `CompletionState.pending`).
  if (state.pending && state.items.length === 0) return null
  const pick = (index: number): void => {
    const next = props.completion.apply(state, index, draft)
    if (next === undefined) return
    // dsh's draft editor calls `text.replace`, so an undefined answer would
    // crash the whole session slot (and blank the view) instead of doing
    // nothing — the guard is the difference between a no-op and a crash.
    if (typeof next.text === 'string') props.inputActions.setDraft(next.text)
    props.completion.store.set(next.state)
  }
  return createElement('div', {
    ref: listRef,
    style: listStyle(theme, maxHeight),
    'data-dshell-completion': '',
    'data-dshell-completion-source': state.source,
    role: 'listbox',
    title: state.source === 'history' ? t('completion.historyCount', { count: state.items.length }) : state.dir,
  },
    state.items.length === 0
      ? createElement('div', { style: { padding: '3px 10px', opacity: 0.6 } },
          t(state.note === undefined ? 'completion.noMatch' : NOTE_KEYS[state.note]))
      : state.items.map((item, index) => row(item, index === state.index, theme, () => { pick(index) }, activeRef, t)),
  )
}
