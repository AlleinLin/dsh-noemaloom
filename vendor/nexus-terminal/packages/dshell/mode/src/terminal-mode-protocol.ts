/**
 * The wire contract of the terminal-session identity table.
 *
 * A terminal session is a dsh session that runs dshell's integrated terminal
 * instead of staying a stock conversation. dsh gives a plugin no durable
 * per-session field of its own — `SessionCreateRequest` carries no metadata, a
 * projection can only fold logged events, and an event type this package
 * declares is unknown to dsh's generated vocabulary, so a log carrying one is
 * refused on the next cold read (`validateStoredEvents` requires the envelope's
 * `ignorable`, which live `append` cannot set). The table is therefore dshell's
 * own document, keyed by the dsh session id, which is already globally unique
 * (`session-<uuid>`) and is the same key the PTY transcript, the block log, the
 * history table and the ssh bindings use.
 *
 * One record per session, not one id in a list: the record is what makes the
 * identity self-describing — where the session runs, what it is called, how it
 * came to exist, and which way its composer reads Enter — so a reader that lost
 * dsh's list still shows a name instead of a bare id, and a start-up
 * reconciliation can tell a deleted session from one it merely cannot see.
 */

/** The route's exact path, behind dsh's own `/api` trust fence. */
export const DSHELL_TERMINAL_MODE_PATH = '/api/dshell/terminal-mode'

/** The host service key the registry is provided under. */
export const DSHELL_TERMINAL_MODE_SERVICE = 'dshellTerminalMode'

/** Which way one session's composer reads Enter; the off state is `shell`. */
export type TerminalComposerMode = 'shell' | 'agent'

/**
 * How a session came to be a terminal session.
 *
 * Recorded because the alternative is inferring it from the session's cwd, and
 * cwd is a fact about where a shell starts, not about what the reader chose:
 * every terminal session runs in the same directory, and so can a stock
 * conversation.
 */
export type TerminalSessionOrigin =
  /** The sidebar section's own new-session button. */
  | 'section'
  /** dsh's new-session action inside the workspace the section adopted. */
  | 'workspace'
  /** Adopted from the id-list document this table replaced. */
  | 'legacy'

/** One terminal session's identity, keyed by the dsh session id. */
export interface TerminalSessionRecord {
  /** The dsh session id; the key every other dshell store uses for it. */
  readonly sessionId: string
  readonly origin: TerminalSessionOrigin
  /** When the record was written, in epoch milliseconds. */
  readonly createdAt: number
  /** The directory the session's shell runs in, when it is known. */
  readonly cwd?: string
  /** The name dshell gave the session; the row's fallback when dsh has none. */
  readonly title?: string
  /** dshell's own archive bit, which is not dsh's. */
  readonly archived?: boolean
  /** Whether the session has taken its first input. */
  readonly started?: boolean
  /** The composer's persisted mode; absent means the default, `shell`. */
  readonly mode?: TerminalComposerMode
}

/** One mutation request; a GET carries no body and means "report". */
export type TerminalModeRequest =
  /** Add or drop one session's record. */
  | {
      readonly action: 'set'
      readonly sessionId: string
      readonly on: boolean
      /** Required when turning a session on: identity is not inferable. */
      readonly origin?: TerminalSessionOrigin
      readonly cwd?: string
      readonly title?: string
    }
  /** Record the workspace the terminal section was adopted as. */
  | { readonly action: 'workspace'; readonly workspaceId: string }
  /** dshell's own archive bit for one terminal session. */
  | { readonly action: 'archive'; readonly sessionId: string; readonly archived: boolean }
  /** Whether the section is folded down to its header at the sidebar's foot. */
  | { readonly action: 'fold'; readonly folded: boolean }
  /** The session has taken its first input; its initialization page is over. */
  | { readonly action: 'start'; readonly sessionId: string }
  /** The reader turned the composer the other way. */
  | { readonly action: 'mode'; readonly sessionId: string; readonly mode: TerminalComposerMode }
  /** Name the session, so its row never falls back to the bare id. */
  | { readonly action: 'title'; readonly sessionId: string; readonly title: string }

/** The committed table, plus the terminal section's own state. */
export interface TerminalModeResponse {
  /** Every terminal session's record, oldest first. */
  readonly records: readonly TerminalSessionRecord[]
  /** The workspace the section was adopted as, once it has been. */
  readonly workspaceId: string | undefined
  /** Whether the reader folded the section down to the sidebar's foot. */
  readonly folded: boolean
  /**
   * The directory a terminal session is created in — the user's home directory,
   * where a shell starts. The sidebar section adopts it as a workspace; it is
   * not an identity test, and no session is a terminal session because of it.
   */
  readonly root: string
}
