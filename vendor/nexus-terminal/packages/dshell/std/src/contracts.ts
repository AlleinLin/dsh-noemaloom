/**
 * Every dshell wire contract: the `/api/dshell/*` paths and the shapes that
 * cross them.
 *
 * Layering rule for this file, and for this package as a whole: it declares
 * FACTS, not behaviour. No dsh packages, no runtime state, and no imports except
 * types from this package's own sibling modules — so both halves of every plugin
 * (host route and browser face) can import the same declaration, and a contract
 * change is a compile error on both sides instead of a silent drift. The browser
 * faces used to restate these shapes by hand precisely because there was nowhere
 * shared to put them.
 *
 * Sections below were moved verbatim from the packages' own protocol modules,
 * which now re-export from here; the package-local headers are kept because they
 * carry the reasoning for each shape.
 */

// ─── files — the file navigator: listing, completion, their requests/responses ───
// moved from packages/dshell/files/src/protocol.ts

// The one import this file has, and it is a type: completion answers carry the
// position the shell reads (see `DshellCompletion.position`), and that type
// belongs to the line scanner rather than to this file because the host and the
// scanner must agree on exactly one spelling of it.
import type { ShellPosition } from './shell-line.js'

/**
 * The file navigator's wire vocabulary, shared by the host route and the
 * browser face.
 *
 * Deliberately free of value imports: the browser half imports this module, and
 * anything it pulls in would be bundled into `client.js`.
 *
 * A path on the wire is always the CANONICAL absolute path **in the session's
 * own execution world** — the host path for a local session, the device path
 * for a device-bound one. That is the string the client shows, splits into
 * segments, trims for `..`, and hands back to list again, so both ends agree on
 * one spelling without either knowing which world produced it.
 */

/** The exact `/api` path the file navigator talks to. */
export const DSHELL_FILES_PATH = '/api/dshell/files'

/** One entry's kind, in the filesystem seam's own vocabulary. */
export type DshellFileKind = 'file' | 'directory' | 'other'

/**
 * A completion row's kind: a filesystem entry, the shell's command word, or a
 * word only the shell itself could name.
 *
 * `command` is not a filesystem kind — a command is a name the shell's world
 * offers, found on its PATH — but it belongs in the same union because it is
 * the same list: the completion menu draws one glyph per kind, and a command
 * must not borrow a file's. `flag` (`-x`/`--long`) and `word` come from the
 * session's own shell (a subcommand, an option, a branch — the shell's
 * completion function knows and this side does not), and `word` is the honest
 * kind for an answer whose nature is unknown.
 */
export type DshellCompletionKind = DshellFileKind | 'command' | 'flag' | 'word'

/**
 * Why a completion came back with nothing, as a code rather than a sentence.
 *
 * The route knows the reason; the browser owns the language the reader chose.
 * Sending the reason as one of these and writing the line in the client is the
 * same division the rest of dshell's wire uses.
 */
export type DshellCompletionNote = 'noMatch' | 'noDirectory' | 'notDirectory' | 'noCommand'

/** One directory entry, with only the facts a row draws. */
export interface DshellFileEntry {
  readonly name: string
  readonly kind: DshellFileKind
  /** Byte size for a regular file, when the backend reports one. */
  readonly size?: number | undefined
}

/** One directory's listing, as the route answers it. */
export interface DshellFilesListing {
  /** Canonical absolute path of the listed directory, in the session's world. */
  readonly path: string
  readonly entries: readonly DshellFileEntry[]
  /** The listing hit the route's entry cap, so entries are missing. */
  readonly truncated: boolean
  /**
   * Whether the host can move the session's shell into a directory (`cd`).
   *
   * False when the composition has no terminal bridge, which is the only thing
   * that can drive a session's main shell; the pane then draws no jump button
   * rather than one that cannot work. It is a fact about the composition, so it
   * is the same on every listing of one boot.
   */
  readonly canCd: boolean
}

/** One browser face request. */
export interface DshellFilesRequest {
  /**
   * `list` reads a directory, `cd` sends the session's shell into one,
   * `resolve` canonicalizes a path in the session's world (how the composer
   * learns what `cd` did), and `complete` answers a shell line's last token
   * from that same world.
   *
   * `warm` asks the same question `complete` would and throws the answer away,
   * so that the pieces it needs are already in the host's memory when a Tab
   * arrives. It exists because a device world answers every one of those pieces
   * with a process of its own, and paying for them on the keystroke is what made
   * Tab feel broken there (see the route's cache).
   */
  readonly action: 'list' | 'cd' | 'resolve' | 'complete' | 'warm'
  /** The session whose execution world the path belongs to. */
  readonly sessionId: string
  /** Absolute path in that world; omitted means the session's own directory. */
  readonly path?: string | undefined
  /** The directory a relative path resolves against, for `resolve`/`complete`. */
  readonly cwd?: string | undefined
  /** The composer's draft, for `complete`. */
  readonly line?: string | undefined
  /** Caret offset within `line`, for `complete`. */
  readonly cursor?: number | undefined
  /**
   * Which pass of `complete` this is: the fast one (the default) answers from
   * what this side already knows, and `refine` asks the session's own shell for
   * the words only it has (see `DshellCompletion.pending`).
   */
  readonly phase?: 'fast' | 'refine' | undefined
  /**
   * Whether `warm` may ask the session's own shell too, not only the file
   * system. The switch that governs the oracle lives in the browser (like every
   * other dshell switch), so the browser is the only side that can say whether
   * the probe is wanted; without it, a warm would run a process per context for
   * a reader who turned that off.
   */
  readonly oracle?: boolean | undefined
}

/** One candidate for the shell line's last token. */
export interface DshellCompletionCandidate {
  readonly name: string
  readonly kind: DshellCompletionKind
  /** Byte size for a regular file, when the backend reports one. */
  readonly size?: number | undefined
  /** A short right-hand hint (kind, size) the list draws. */
  readonly hint?: string | undefined
}

/**
 * One completion answer: the span of the line to replace, plus the candidates.
 *
 * `start`/`end` are offsets into the line the caller sent, so the composer
 * substitutes exactly the basename while everything the user typed before it
 * (including a `~` or a relative prefix) stays as written.
 */
export interface DshellCompletion {
  readonly start: number
  readonly end: number
  /**
   * Where the candidates came from: the directory in the session's world for a
   * path, the literal `PATH` for a command (whose names come from every
   * directory the world's shell searches, not from one).
   */
  readonly dir: string
  readonly candidates: readonly DshellCompletionCandidate[]
  /** The listing hit the route's cap, so candidates are missing. */
  readonly truncated: boolean
  /**
   * Where in the line this completion happened, as the SHELL reads it.
   *
   * The host decides it from the whole line (`./shell-line.ts`) because a
   * position is a property of the line and not of the word — `dock` names a
   * command, `cd dock` an argument, `tee > dock` a file. Answering with it keeps
   * the browser from re-deriving the same thing from the token's shape, which is
   * how the two halves of this feature drifted apart once already: the client
   * needs it to know when an empty answer deserves to be shown (`noCommand` on a
   * command word is worth a card, the same miss on a non-path argument is not).
   */
  readonly position: ShellPosition
  /**
   * Whether a better answer is still coming.
   *
   * Two sources answer this line and one of them is a shell function on the
   * other side of the world, which is worth a round trip but not worth blocking
   * the keystroke. So the fast answer says `pending: true` when the shell could
   * know more than the file system does — a flag, or a bare word in an argument
   * position — and the browser answers it by asking again with `refine`, which
   * is the phase whose answer carries this field false. It also tells the
   * browser not to draw an EMPTY answer yet: a note that says "no matches" while
   * the real answer is in flight is a lie the reader would have to unsee.
   */
  readonly pending?: boolean | undefined
  /** Why there are no candidates, when the reason is worth showing. */
  readonly note?: DshellCompletionNote | undefined
}

/** One browser face response: whichever subject was asked for, or why none was produced. */
export interface DshellFilesResponse {
  readonly listing?: DshellFilesListing | undefined
  /** The directory the session's shell was sent to, for the `cd` action. */
  readonly cdTo?: string | undefined
  /** The canonical path, for the `resolve` action. */
  readonly resolved?: string | undefined
  /** The token's candidates, for the `complete` action. */
  readonly completion?: DshellCompletion | undefined
  /**
   * Acknowledgement of a `warm`: the work it starts runs in the background, so
   * the answer says only that the request was understood. The browser never
   * reads a value out of it — the whole point of a warm is that nobody waits.
   */
  readonly warmed?: boolean | undefined
  readonly error?: string | undefined
}

// ─── files — the two-world transfer view ───
// moved from packages/dshell/files/src/transfer-protocol.ts

/**
 * The file-transfer wire vocabulary: one device session's two file trees, and
 * the copies between them.
 *
 * Separate from `./protocol.ts` because it is a different route with a
 * different subject. The navigator's route answers about ONE world (the
 * session's); this one is about the pair — this machine and the device the
 * session runs on — and about work that outlives one request.
 *
 * Deliberately free of value imports: the browser face imports this module, and
 * anything it pulled in would be bundled into `client.js`. `Buffer`-style host
 * types are not needed on the browser side at all.
 */

/** The exact `/api` path the transfer view talks to. */
export const DSHELL_TRANSFER_PATH = '/api/dshell/transfer'

/**
 * Which end of the pair a request names.
 *
 * `local` is the machine the harness runs on — for a device session, the side
 * the user is sitting at. `remote` is the device that session is bound to.
 * Both spell paths in their OWN namespace: a local path is a host path, a
 * remote path is a device path.
 */
export type TransferSide = 'local' | 'remote'

/** One entry of one side, with only the facts a row draws. */
export interface TransferEntry {
  readonly name: string
  readonly kind: 'file' | 'directory' | 'other'
  /** Byte size for a regular file, when the backend reports one. */
  readonly size?: number | undefined
}

/** One directory listing of one side. */
export interface TransferListing {
  /** Canonical absolute path of the listed directory, in that side's namespace. */
  readonly path: string
  readonly entries: readonly TransferEntry[]
  /** The listing hit the route's entry cap, so entries are missing. */
  readonly truncated: boolean
}

/** What the view needs before it can draw two trees. */
export interface TransferSetup {
  /** The local pane's starting directory: the harness user's home. */
  readonly localRoot: string
  /** The device pane's starting directory, when the session is bound. */
  readonly remoteRoot?: string | undefined
  /** The device this session runs on, when it is bound. */
  readonly device?: { readonly id: string; readonly name: string } | undefined
  /**
   * Whether a transfer is possible at all.
   *
   * False for a session with no device (nothing to transfer between) and for a
   * binding without a mount directory — the filesystem seam then stays local
   * while the shell seam is remote, so the two sides would silently disagree
   * about which machine a path names.
   */
  readonly canTransfer: boolean
  /** Why not, when `canTransfer` is false. */
  readonly reason?: string | undefined
}

/** Where one copy is in its life. */
export type TransferJobState = 'walking' | 'copying' | 'done' | 'failed' | 'cancelled'

/** One copy, as the view draws it. */
export interface TransferJobView {
  readonly id: string
  readonly from: TransferSide
  readonly to: TransferSide
  /** The copied entry's own absolute path, in the source side's namespace. */
  readonly fromPath: string
  /** The destination DIRECTORY, in the destination side's namespace. */
  readonly toDir: string
  readonly state: TransferJobState
  /** Entries written so far; for a file, 0 then 1. */
  readonly files: number
  /** Known after the walk: how many entries the copy will write. */
  readonly totalFiles?: number | undefined
  /** Bytes written so far. */
  readonly bytes: number
  /** Known after the walk: how large the copy is. */
  readonly totalBytes?: number | undefined
  /** Chunked relay progress, when the current file rides it. */
  readonly chunksDone?: number | undefined
  readonly chunksTotal?: number | undefined
  /** The entry being written, relative to the copied root; empty for one file. */
  readonly current?: string | undefined
  /** Source entries that are neither files nor directories, so were not copied. */
  readonly skipped: number
  /** Why the copy stopped, or why it is waiting for a decision. */
  readonly error?: string | undefined
  /**
   * The copy stopped because an entry already exists and `overwrite` was not
   * given. The view offers to retry with it instead of showing a bare failure,
   * because a name collision is a question, not an error.
   */
  readonly conflict?: boolean | undefined
  readonly createdAt: number
  readonly settledAt?: number | undefined
}

/** One browser face request. */
export type TransferRequest =
  | { readonly action: 'state'; readonly sessionId: string }
  | { readonly action: 'list'; readonly sessionId: string; readonly side: TransferSide; readonly path: string }
  | {
    readonly action: 'copy'
    readonly sessionId: string
    readonly from: TransferSide
    /** The side the bytes land on; always the other one today, named on the wire. */
    readonly to: TransferSide
    /** The entry to copy: an absolute path in the source side's namespace. */
    readonly fromPath: string
    /** The destination directory, in the destination side's namespace. */
    readonly toDir: string
    /** Replace files that already exist; without it a collision stops the copy. */
    readonly overwrite?: boolean | undefined
  }
  | { readonly action: 'job'; readonly jobId: string }
  | { readonly action: 'cancel'; readonly jobId: string }

/** One browser face response: whichever of the three subjects was asked for. */
export interface TransferResponse {
  readonly setup?: TransferSetup | undefined
  readonly listing?: TransferListing | undefined
  readonly job?: TransferJobView | undefined
  readonly error?: string | undefined
}

// ─── buffer — the cross-session pipe: links, tickets, grants, transfers ───
// moved from packages/dshell/buffer/src/protocol.ts

/**
 * The buffer's wire vocabulary, shared by the host route and the browser face.
 *
 * Deliberately free of value imports: the browser half imports this module, and
 * anything it pulls in would be bundled into `client.js`. Identifiers that the
 * host validates against (a request `action`, a ticket `state`) are plain
 * strings here and narrowed on the host side.
 *
 * Session ids travel as plain strings rather than the branded `SessionId`
 * because this is a JSON boundary; the host converts at the edges.
 */

/** The exact `/api` path the pipe UI talks to. */
export const DSHELL_BUFFER_PATH = '/api/dshell/buffer'

/** The plugin name every buffer-authored message carries as its provenance. */
export const BUFFER_PLUGIN = 'dshell-buffer'

/** Lifecycle of one deferred request. */
export type BufferTicketState =
  | 'queued'
  | 'running'
  | 'done'
  | 'failed'
  | 'timeout'
  | 'cancelled'

/** States after which a ticket is settled and never changes again. */
export const SETTLED_STATES: readonly BufferTicketState[] = ['done', 'failed', 'timeout', 'cancelled']

/** One directory the grant may confer on an area. */
export type BufferRight = 'read' | 'write'

/**
 * One directory (or file) the grant confers on an area, with the rights it
 * holds there.
 *
 * `as` is the area's name in the grantee's buffer namespace: the grantee
 * addresses everything under it as `/name/sub/file` instead of by the
 * granter's real path. One segment, no separators — it is a mount name, not a
 * path. The service ASSIGNS it at creation (the caller's `as`, else the path's
 * last segment, suffixed to stay unique among the names that session already
 * holds), and it is the only handle the two sessions exchange. It is optional
 * in the type alone: state written before names existed has none until the
 * service names it at load.
 */
export interface BufferArea {
  /** Absolute path in the GRANTER's namespace, or one relative to its cwd. */
  readonly path: string
  readonly rights: readonly BufferRight[]
  /** The area's name in the grantee's buffer namespace. */
  readonly as?: string | undefined
}

/**
 * A durable link between two sessions, established by the user.
 *
 * Undirected: the user connects two sessions, and either may then delegate to
 * the other. Direction belongs to the ticket and to the grant, not to the link
 * — a "pipe" is a relationship, not a one-way channel.
 */
export interface BufferLink {
  readonly id: string
  /** The two connected sessions, ordered as the user created them. */
  readonly a: string
  readonly b: string
  /** The pipe's name — what this pair calls the relationship. */
  readonly label?: string | undefined
  /**
   * What the pipe is for, in prose.
   *
   * The name says which pipe this is; this says what it is FOR, and it is what
   * a peer's model reads before deciding whether a request belongs here. Either
   * end may write it (the user in the pipe panel, an agent through
   * `dshell_buffer action="describe"`).
   */
  readonly description?: string | undefined
  /**
   * The session that last wrote the name or the description; absent means the
   * user wrote it from the panel. Recorded so a reader can tell a peer's own
   * note from their own — the panel says so, and a name refined by an agent
   * should not read as the user's words.
   */
  readonly annotatedBy?: string | undefined
  readonly createdAt: number
}

/** One progress report a worker filed against a ticket. */
export interface BufferReport {
  readonly time: number
  readonly text: string
  readonly kind: 'progress' | 'blocked'
}

/**
 * One deferred request from one session to another.
 *
 * The lifecycle fields are mutable by design: the service is the single writer,
 * and a ticket is a state machine advanced in place before it is persisted.
 */
export interface BufferTicket {
  readonly id: string
  readonly linkId: string
  /** The requesting session. */
  readonly from: string
  /** The working session. */
  readonly to: string
  readonly subject: string
  readonly detail?: string | undefined
  state: BufferTicketState
  /** Grants this ticket holds open; each is released when it settles. */
  readonly grantIds: readonly string[]
  readonly createdAt: number
  startedAt?: number | undefined
  settledAt?: number | undefined
  /** When the watchdog settles the ticket as `timeout`, if nothing else did. */
  readonly deadlineAt: number
  result?: string | undefined
  error?: string | undefined
  readonly reports: BufferReport[]
}

/** A scoped, revocable folder grant, alive while at least one ticket references it. */
export interface BufferGrant {
  readonly id: string
  /** The granting session — the tree these areas live in. */
  readonly from: string
  /** The session allowed to touch them. */
  readonly to: string
  /** The granter's own account of what the areas are for. */
  readonly description: string
  readonly areas: readonly BufferArea[]
  /** Outstanding tickets; reaching zero revokes the grant immediately. */
  count: number
  readonly createdAt: number
  revokedAt?: number | undefined
}

/**
 * One cross-world chunked transfer, in flight or freshly finished.
 *
 * In-memory only: it exists so progress surfaces (the status card) can show
 * live movement, and entries drop shortly after they settle. Nothing here is
 * durable state — a restart simply loses the progress view, never the data.
 */
export interface BufferTransfer {
  readonly id: string
  /** The session whose tool call drives the transfer. */
  readonly sessionId: string
  /** Human label: source path → destination path. */
  readonly label: string
  readonly bytesDone: number
  readonly bytesTotal: number
  readonly chunksDone: number
  readonly chunksTotal: number
  readonly startedAt: number
  readonly finishedAt?: number | undefined
  readonly error?: string | undefined
}

/** Everything the pipe UI renders from. */
export interface BufferState {
  readonly links: readonly BufferLink[]
  readonly tickets: readonly BufferTicket[]
  readonly grants: readonly BufferGrant[]
  /** Transfers in flight, plus the freshly settled ones (pruned after a beat). */
  readonly transfers: readonly BufferTransfer[]
  /**
   * Sessions that have been deleted from dshell but are still in dsh's own
   * session list, because dsh cannot tear a loaded session down: their log is
   * removed at the next start. The pipe UI must not draw them — their pipes are
   * already gone, so they would appear as orphan nodes.
   *
   * Process-lifetime, never persisted: after a restart these ids are purged
   * during composition and leave dsh's list, so there is nothing left to hide.
   * Populated only by the deletion path (`detachSession`), never by archiving —
   * and released again by `restoreSession`, because cancelling a scheduled
   * deletion puts the session back in use while dsh still lists it.
   */
  readonly departed: readonly string[]
  /**
   * Where each pipe endpoint actually stands, in its own world's spelling:
   * the device root a bound session runs in, keyed by session id. A bound
   * session's own cwd is the directory it was created in on the host — a
   * stand-in, not the world its shell and file tools answer from — so the
   * UI labels peers from this map and falls back to the cwd only for
   * sessions that are not bound. Absent keys mean "runs here".
   */
  readonly worlds: Readonly<Record<string, string>>
}

/**
 * One row of the pipe detail page's buffer browser.
 *
 * A ROOT entry (one per mapped area) carries the grant it belongs to and its
 * provenance, so the user can see which side offered it and descend into it;
 * entries below the root are plain directory children.
 */
export interface BufferUserEntry {
  /** Last segment for children; the mapped name (`as`) for a root. */
  readonly name: string
  readonly kind: 'directory' | 'file' | 'other'
  readonly size?: number | undefined
  /** Root entries only: the grant this mapping belongs to. */
  readonly grantId?: string
  /** Root entries only: the mapped name and its rights. */
  readonly as?: string
  readonly rights?: readonly string[]
  /** Root entries only: the two ends of the grant (granter → grantee). */
  readonly from?: string
  readonly to?: string
  /** Root entries only: the real path behind the mapping, in the granter's world. */
  readonly origin?: string
}

/** One answer to a `buffer-ls` request. */
export interface BufferListing {
  /** The real path listed (root listings answer `/`). */
  readonly path: string
  readonly entries: readonly BufferUserEntry[]
  readonly truncated: boolean
}

/** One browser face request. `state` also travels as the GET shape. */
export type BufferRequest =
  | { readonly action: 'state' }
  | {
      readonly action: 'link'
      readonly a: string
      readonly b: string
      readonly label?: string
      readonly description?: string
    }
  | {
      /** Name a pipe or state what it is for; empty strings clear the field. */
      readonly action: 'annotate'
      readonly linkId: string
      readonly label?: string
      readonly description?: string
    }
  | { readonly action: 'unlink'; readonly linkId: string }
  | { readonly action: 'revoke'; readonly grantId: string }
  | { readonly action: 'cancel'; readonly ticketId: string }
  | { readonly action: 'buffer-ls'; readonly linkId: string; readonly grantId?: string; readonly path?: string }

/** One browser face response: the committed state plus an optional refusal. */
export interface BufferResponse extends BufferState {
  readonly error?: string | undefined
  /** Present only on a `buffer-ls` request. */
  readonly listing?: BufferListing | undefined
}

// ─── ssh — devices, bindings, their requests/responses ───
// moved from packages/dshell/ssh/src/protocol.ts

/**
 * dshell-ssh wire — one exact `/api/dshell/ssh` route, plus the device shapes
 * both halves agree on.
 *
 * The route carries what must not travel through the settings document: the
 * private keys themselves. A device's durable record is small JSON; its key is
 * a separate file written 0600 under `$DSH_HOME/dshell/ssh/keys/`.
 *
 * This module is imported by the browser half through the package's
 * `./protocol` subpath, so it must stay free of value imports: anything it
 * pulls in would be bundled into the client.
 */

/** Exact `/api` route path owned by the SSH device registry. */
export const DSHELL_SSH_PATH = '/api/dshell/ssh'

/** Settings namespace owned by this plugin; also the device card's slot key. */
export const SSH_SETTINGS_NAMESPACE = 'dshell-ssh'

/** How a device authenticates. */
export type DeviceAuth = 'key' | 'password'

/**
 * What dshell knows about the helper on a device.
 *
 * Three states the device card surfaces differently:
 *
 *  - `absent` — no helper has ever been deployed to this device. A device
 *    session's RPC lane is unavailable; the assembled-command lane still
 *    works. The Test button reports the absence and offers to install.
 *  - `present` — a helper is deployed whose digest matches the artifact this
 *    build ships. RPC is ready.
 *  - `mismatch` — a helper is deployed but its digest disagrees with this
 *    build's. The next connection will redploy automatically; the card
 *    surfaces the disagreement so the user can decide whether to wait.
 */
export type DeviceHelperState = 'absent' | 'present' | 'mismatch'

/** What the helper deployment looks like right now, when known. */
export interface DeviceHelperStatus {
  readonly state: DeviceHelperState
  /** Digest of the file on the device, when the last check could read it. */
  readonly onDevice?: string
  /** Digest of the artifact this build ships; absent means the build is unbundled. */
  readonly expected?: string
  /** Absolute path the helper lives at, when known. */
  readonly path?: string
  /** Last check's verbatim result; empty on `absent` with no attempt. */
  readonly message: string
}

/** One configured device as the UI sees it — never includes secret material. */
export interface DeviceView {
  readonly id: string
  /** Display name the session picker lists. */
  readonly name: string
  /** Hostname or IP `ssh` connects to. */
  readonly host: string
  /** TCP port; 22 unless the device listens elsewhere. */
  readonly port: number
  /** Login user. */
  readonly user: string
  /** Directory a session bound to this device starts in (the remote path). */
  readonly remoteRoot: string
  /** Selected login method. */
  readonly auth: DeviceAuth
  /**
   * The vault credential this device logs in with.
   *
   * Preferred over {@link hasSecret}: a key shared by thirty machines should be
   * rotated in one place. Absent means the device still carries its own inline
   * secret, which is what every device did before the vault existed.
   */
  readonly credentialId?: string | undefined
  /** Whether the secret for {@link auth} (key or password) is stored. */
  readonly hasSecret: boolean
  /**
   * Whether a passphrase for the stored key is stored alongside it.
   *
   * A key with no passphrase is the common case and needs no `ssh` interaction,
   * while a key with one cannot connect at all unless ssh is allowed to ask —
   * so the device card's two states are different, not cosmetic.
   */
  readonly hasPassphrase?: boolean | undefined
  /** Helper deployment state, when known. Absent for compositions that have not checked. */
  readonly helper?: DeviceHelperStatus | undefined
}

/** One device as submitted by the UI; `key` is write-only. */
export interface DeviceInput {
  readonly id?: string | undefined
  readonly name: string
  readonly host: string
  readonly port?: number | undefined
  readonly user: string
  readonly remoteRoot?: string | undefined
  /** Login method; defaults to `key` on create. */
  readonly auth?: DeviceAuth | undefined
  /**
   * PEM/OpenSSH private key contents, used when `auth` is `key`. Omitted keeps
   * the stored secret; empty string removes it (the device then relies on the
   * harness user's own ssh agent and config).
   */
  readonly key?: string | undefined
  /**
   * Password, used when `auth` is `password`. Same omitted/empty semantics as
   * {@link key}.
   */
  readonly password?: string | undefined
  /**
   * Passphrase for the stored key, used when `auth` is `key`. Same
   * omitted/empty semantics as {@link key}: omitted leaves it, empty removes it.
   *
   * Only meaningful WITH a key — a passphrase for no key is refused rather than
   * stored, because ssh would never read it and a stored secret nothing reads is
   * the exact shape of a credential nobody rotates.
   */
  readonly passphrase?: string | undefined
  /**
   * The vault credential to log in with, instead of an inline secret.
   *
   * Set alongside {@link auth}; supplying it clears any inline key or password,
   * because a device holding both would have two answers to the same question
   * and only one of them gets rotated.
   */
  readonly credentialId?: string | undefined
}

/** What kind of secret a vault credential holds. */
export type CredentialKind = 'key' | 'password'

/**
 * One stored credential, as the UI sees it.
 *
 * Never carries the secret: the same rule the device view has always followed,
 * so a settings document that leaks contains no credential.
 */
export interface CredentialView {
  readonly id: string
  /** The owning group, which decides whether the bytes are sealed. */
  readonly group: string
  readonly name: string
  readonly kind: CredentialKind
  readonly hasSecret: boolean
  /** Only meaningful for a `key`: whether a passphrase is stored with it. */
  readonly hasPassphrase: boolean
}

/** One vault group, as the UI sees it. */
export interface VaultGroupView {
  readonly id: string
  readonly name: string
  /** False means the group's credentials are stored UNENCRYPTED. */
  readonly sealed: boolean
  /** Sealed and not currently open: its credentials cannot be read right now. */
  readonly locked: boolean
  /**
   * Whether the group carries a token at all.
   *
   * A sealed group without one — the default group a fresh vault creates — can
   * never be unlocked: there is no key to derive and nothing to check a guess
   * against. It is waiting to be CLAIMED, and offering it an unlock box would
   * be offering a door with no lock.
   */
  readonly hasToken: boolean
}

/**
 * One private key sitting in the harness user's `~/.ssh`, offered as an
 * alternative to pasting its contents.
 *
 * Naming it rather than its path is deliberate: `name` is what the reader
 * recognises, and `path` is what has to come back to be read, so the browser
 * sends the path back untouched and the host decides whether it may still be
 * read (see the `readKey` action).
 */
export interface SshKeyFile {
  readonly name: string
  readonly path: string
}

/**
 * One host key this plugin currently trusts, as OpenSSH spells it.
 *
 * A device may present several (an ed25519 and an rsa, say), so this is one
 * ENTRY rather than one fingerprint per destination.
 */
export interface TrustedHostKey {
  /** The host field as known_hosts spells it: bare, or `[host]:port`. */
  readonly host: string
  readonly port: number
  /** `SHA256:…`, OpenSSH's own spelling. */
  readonly fingerprint: string
  /** `ssh-ed25519`, `ecdsa-sha2-nistp256`, … */
  readonly keyType: string
}

/** One session's device binding, kept host-side because execution routing needs it. */
export interface DeviceBinding {
  readonly sessionId: string
  readonly deviceId: string
  /**
   * Directory the session's commands run in on that device, when the session
   * overrides the device's own. Absent means the device's `remoteRoot`.
   */
  readonly remoteRoot?: string | undefined
  /**
   * Local directory standing in for that remote tree, which is also the
   * session's own working directory. Absent on bindings written before
   * mount directories existed.
   */
  readonly mount?: string | undefined
}

/** One request body the route accepts; `list` is also the GET shape. */
export type SshRequest =
  | { readonly action: 'list' }
  | { readonly action: 'save'; readonly device: DeviceInput }
  | { readonly action: 'delete'; readonly deviceId: string }
  | {
    readonly action: 'test'
    readonly deviceId: string
    /**
     * Session directory to also prove creatable, so a failing `mkdir` is found
     * before a session is created rather than after. Absent checks only the
     * connection.
     */
    readonly remoteRoot?: string | null
  }
  | {
    readonly action: 'bind'
    readonly sessionId: string
    readonly deviceId: string | null
    /** Remote directory for this session; null or absent uses the device's. */
    readonly remoteRoot?: string | null
    /** Local mount directory for that tree, as returned by `mount`. */
    readonly mount?: string | null
  }
  | {
    /**
     * The local mount directory for one device tree. The rule is host-owned
     * (it depends on `$DSH_HOME`), so the browser asks rather than deriving it.
     */
    readonly action: 'mount'
    readonly deviceId: string
    readonly remoteRoot?: string | null
  }
  | {
    /**
     * Deploy this build's helper to the device, content-addressed by digest.
     *
     * The route runs `mkdir -p ~/.dshell/helper` and `base64 -d > ~/.dshell/helper/helper-<sha256>.mjs`,
     * then `chmod 0700`. The reply carries the resulting {@link DeviceHelperStatus},
     * which the card renders to confirm the deployment.
     */
    readonly action: 'install'
    readonly deviceId: string
  }
  /** Private keys in the harness user's `~/.ssh`, for the device form's picker. */
  | { readonly action: 'listKeys' }
  /**
   * One of those keys' contents, so the form can offer the file without the
   * browser ever holding a path it could read on its own. The host re-checks
   * that the path is still inside `~/.ssh`.
   */
  | { readonly action: 'readKey'; readonly path: string }
  /** The host keys this plugin records as trusted for one device. */
  | { readonly action: 'hostKeys'; readonly deviceId: string }
  /**
   * Drop what is recorded for one device, so the next connection trusts whatever
   * it presents. The way out of a host key that changed for a legitimate reason.
   */
  | { readonly action: 'revokeHostKey'; readonly deviceId: string }
  /**
   * What one device's host presents RIGHT NOW, for side-by-side comparison with
   * what is trusted.
   *
   * Unauthenticated by construction: it arrives over the very connection whose
   * identity is in question, so a UI may show it but must never trust it.
   */
  | { readonly action: 'probeHostKey'; readonly deviceId: string }
  /** The vault's groups. */
  | { readonly action: 'vaultList' }
  | { readonly action: 'vaultCreateGroup'; readonly name: string; readonly token: string | null }
  | { readonly action: 'vaultRenameGroup'; readonly groupId: string; readonly name: string }
  | { readonly action: 'vaultDeleteGroup'; readonly groupId: string }
  | { readonly action: 'vaultUnlock'; readonly groupId: string; readonly token: string }
  /** Lock one group, or every group when `groupId` is absent. */
  | { readonly action: 'vaultLock'; readonly groupId?: string }
  /**
   * Move a group to token-protected, or off it.
   *
   * Both re-seal the group's stored credentials in the same request, because a
   * policy that applied only to writes would leave the group half-protected
   * with no way to see which rows were the old ones.
   */
  | { readonly action: 'vaultSetToken'; readonly groupId: string; readonly token: string }
  | { readonly action: 'vaultClearToken'; readonly groupId: string }
  /** The credential library. */
  | { readonly action: 'credentialList' }
  | { readonly action: 'credentialSave'; readonly credential: CredentialInput }
  | { readonly action: 'credentialDelete'; readonly credentialId: string }

/** What the UI submits for one credential. Omitted secret keeps the stored one. */
export interface CredentialInput {
  readonly id?: string
  /** The owning group, which decides whether the bytes are sealed. */
  readonly group: string
  readonly name: string
  readonly kind: CredentialKind
  /** Key contents or password. Empty string removes the secret. */
  readonly secret?: string
  /** Passphrase for a key credential. Empty string removes it. */
  readonly passphrase?: string
}

/** One response body; `error` is a refusal the UI shows verbatim. */
export interface SshResponse {
  readonly devices: readonly DeviceView[]
  readonly bindings: readonly DeviceBinding[]
  /** Human-readable result of the last `test`, when one was requested. */
  readonly testResult?: string | undefined
  /** Local mount directory, answering the `mount` action. */
  readonly mountPath?: string | undefined
  /**
   * Helper deployment status from the last check, set when one was requested
   * (`install` action or the eventual three-phase `test` extension).
   */
  readonly helper?: DeviceHelperStatus | undefined
  /** Host keys currently trusted, answering `hostKeys`. */
  readonly hostKeys?: readonly TrustedHostKey[] | undefined
  /** What the device presents now, answering `probeHostKey`. */
  readonly probe?: TrustedHostKey | undefined
  /** Private keys found in `~/.ssh`, answering `listKeys`. */
  readonly keys?: readonly SshKeyFile[] | undefined
  /** One key's contents, answering `readKey`. */
  readonly keyBody?: string | undefined
  /** The vault's groups, answering any `vault*` action. */
  readonly groups?: readonly VaultGroupView[] | undefined
  /** The stored credentials, answering any `credential*` action. */
  readonly credentials?: readonly CredentialView[] | undefined
  /**
   * The vault group a refusal is about, when the refusal IS a locked group.
   *
   * The error string names it too, but a surface that has the vault panel can
   * do better than print a name: this is what lets it open that group's unlock
   * box, so the reader is taken to the door rather than told about it.
   */
  readonly lockedGroup?: { readonly id: string; readonly name: string } | undefined
  readonly error?: string | undefined
}

// ─── terminal-bridge — the shell's history read ───
// moved from packages/dshell/terminal-bridge/src/route.ts

export const DSHELL_PTY_PATH = '/api/dshell/pty'

export interface DshellPtyRequest {
  readonly action: 'history'
  /** The session whose shell history to read. */
  readonly sessionId: string
  /**
   * The line being typed, when the caller wants the history searched rather
   * than listed: only commands *starting with* it come back, compared
   * case-insensitively. Omitted (or empty) means the newest commands, which is
   * plain history for an empty composer.
   *
   * The query travels to the host because the host owns the index; a caller
   * that filters locally can only ever see the rows it was sent.
   */
  readonly draft?: string | undefined
  /**
   * How many matching commands to answer with, newest first (the reply is still
   * ordered oldest-first for the list). Omitted means the route's own cap.
   */
  readonly limit?: number | undefined
}

/** One command the shell ran, as the composer lists it. */
export interface DshellPtyCommand {
  /** The assembled command line. */
  readonly command: string
  /** Bash's exit status, or null when the marker carried none. */
  readonly exitCode: number | null
  /** Epoch ms the command finished. */
  readonly at: number
}

/** One answer: the commands, oldest first (the order they ran in). */
export interface DshellPtyResponse {
  readonly commands?: readonly DshellPtyCommand[] | undefined
  readonly error?: string | undefined
}

// ─── terminal-bridge — the frame stream over the shared API channel ───

/**
 * Downstream half of the frame stream: a long-lived GET whose response body is
 * newline-delimited JSON, one bridge frame per line.
 *
 * The wire itself is unchanged — these are the very frames the ws upgrade
 * carries — but a Response body is reachable from any composition the
 * `connection` service is in, while `registerUpgrade` needs `webServer`, which
 * the desktop shell deliberately does not compose. Identity is explicit because
 * an HTTP stream has no socket to key on: both halves carry the client's own
 * `clientId`, and the GET carries the bind (`sessionId` + `stream`) that a ws
 * would have sent as a frame.
 */
export const DSHELL_STREAM_PATH = '/api/dshell/stream'

/**
 * Upstream half: one POST per control frame (`input`, `resize`, `signal`,
 * `agent-open`, `reconnect`), identified by the same `clientId` the GET opened
 * with. Answers with no body; the stream is the only place results appear.
 */
export const DSHELL_STREAM_SEND_PATH = '/api/dshell/stream/send'

// ─── dshell's own data root, and the directory browser that picks it ───

/**
 * Environment variable holding the directory dshell keeps its own files under.
 *
 * dshell derives every one of its paths from a harness home — `DSH_HOME` when
 * the deployment sets one, `~/.dsh` otherwise — and puts `dshell/` (device
 * registry, buffer state, session tags, mount points) and `dshell-pty/`
 * (transcripts, their timelines, the history database) beneath it.
 *
 * This variable overrides that home for dshell ALONE. The distinct name is the
 * whole point: `DSH_HOME` belongs to the harness and moving it moves sessions,
 * settings and storage too, while a reader who wants their shell transcripts on
 * another disk is not asking to relocate dsh. Two deployments set it — the
 * settings card (`dataDir` in the `dshell` namespace, applied by the host half
 * at start) and a user or unit file exporting it directly, which is what the
 * packaged builds use.
 *
 * It is read at each path resolution rather than cached, for the same reason
 * dsh's own resolution is: the value is a fact about the process, set once
 * before anything asks.
 */
export const DSHELL_HOME_ENV = 'DSHELL_HOME'

/**
 * The bundle package this workspace publishes.
 *
 * Named here because the Plugins panel keys a plugin's own configuration by
 * `<bundle package>#<row id>` (see dsh's ui-plugin-manager slot contract), so a
 * package mounting a config page there has to spell the bundle it ships in —
 * and spelling it in two places is how one of them goes stale.
 */
export const DSHELL_BUNDLE_NAME = '@nexus-aethra/dshell-bundle'

/**
 * Exact `/api` route path owned by dshell's directory browser.
 *
 * The settings card's data-directory field cannot be typed by everyone and
 * cannot be a native folder dialog: a browser has no access to a host path, and
 * the harness may not even be on the machine drawing the page (the desktop
 * shell and a remote `dsh web` are the same client). So the host lists its own
 * directories and the card draws them — the picker is an ordinary route on the
 * shared `/api` channel, under the same trust and authentication policy as the
 * rest of dshell's routes.
 */
export const DSHELL_DIRS_PATH = '/api/dshell/dirs'

/** One request body: what to do with the directory being shown. */
export interface DshellDirsRequest {
  /**
   * `list` (the default) reads a directory, `mkdir` creates one inside it.
   *
   * Two actions rather than two routes because they are the same subject read
   * two ways: the picker shows a directory, and the one way out of a tree whose
   * directory does not exist yet is to make it where the reader is standing.
   */
  readonly action?: 'list' | 'mkdir' | undefined
  /**
   * A path on the HOST machine. Absolute, or `~`-prefixed; anything else is
   * resolved against the home directory rather than the process's cwd, which is
   * the one thing a browser could not know and would surprise a reader either
   * way.
   *
   * For `mkdir` this is the PARENT directory, and it must already exist.
   */
  readonly path?: string | undefined
  /**
   * The directory to create, for `mkdir`: ONE path segment, not a path.
   *
   * A name rather than a path on purpose — `mkdir` here is the picker's
   * "new folder", and a field that accepts `a/b/c` is a field that creates
   * three directories somewhere the reader cannot see while typing.
   */
  readonly name?: string | undefined
}

/** One directory below the listed one. Files are not offered: this names a data root. */
export interface DshellDirsEntry {
  /** The directory's own name (the last path segment). */
  readonly name: string
  /** Its absolute path; what the field stores. */
  readonly path: string
}

/**
 * One answer.
 *
 * `parent` is `null` at the file system root, which is how the picker knows to
 * stop drawing an up-one-level control. `created` is the directory a `mkdir`
 * request made, and the listing alongside it is that directory's (empty) own —
 * so the picker lands the reader inside what they just made rather than leaving
 * them to find it. `writable` describes the listed directory itself — the card
 * refuses a read-only choice in words rather than letting the harness fail to
 * write after a restart — and is absent when the host could not tell. `home` is
 * where the picker opens and what 「跟随默认」 points at.
 */
export interface DshellDirsResponse {
  /** The resolved directory that was listed. */
  readonly path?: string
  /** Its parent, `null` at the root, absent when nothing was listed. */
  readonly parent?: string | null
  /** The host user's home directory. */
  readonly home?: string
  /** The directories below `path`, sorted the way the picker draws them. */
  readonly entries?: readonly DshellDirsEntry[]
  /** The directory a `mkdir` created, when one was. */
  readonly created?: string
  /** Whether `path` is writable by the harness; absent when unknown. */
  readonly writable?: boolean
  /** Whether the host cut the listing at its cap; the picker says so rather than lying by omission. */
  readonly truncated?: boolean
  /** Why the answer carries no listing, when it does not. */
  readonly note?: 'noDirectory' | 'notDirectory' | 'noAccess' | 'exists' | 'badName'
  /** A refusal the card shows verbatim. */
  readonly error?: string
}

/**
 * Byte-level filesystem ops on a device, for callers that need them outside
 * the policy fence that `ctx.fs` draws.
 *
 * Two things use it today: the chunked transfer relay in `dshell-files` and
 * the chunked buffer relay in `dshell-buffer`. Both want the operations
 * `ctx.fs` deliberately does not expose — `mkdir`, `remove`, `rename`,
 * `sha256`, `copy` — because the seam's contract is "you read / write text
 * through `ctx.fs`", and the two relays transfer arbitrary bytes.
 *
 * The interface is shaped so a transfer engine does not have to learn anything
 * about the device registry or the routing table. The provider resolves the
 * device from the ambient call's session, and the engine asks for an ops
 * object once, at the top of its function.
 *
 * The shape mirrors `RemoteFileSystem` (which is what the `dshell-ssh`
 * implementation packages): the engine can pass the same paths and read the
 * same replies regardless of which backend answered. A backend that has not
 * pre-deployed a helper rejects with `FsError('FS_NOT_OBSERVED', …)`; an
 * unbound session produces `undefined` from `forInitiator`, the same shape
 * `RemoteFileSystem`'s internal callers expect.
 */
export interface DeviceFsOps {
  /** Publish one file's whole contents on the device, byte for byte. */
  writeBytes(remote: string, bytes: Uint8Array, signal?: AbortSignal): Promise<void>
  /** Create one or more directories, optionally recursive. */
  mkdir(paths: readonly string[], recursive: boolean, signal?: AbortSignal): Promise<void>
  /** Remove one path, recursively and tolerating absence when forced. */
  remove(path: string, force: boolean, signal?: AbortSignal): Promise<void>
  /** Rename one path to another, optionally overwriting an existing one. */
  rename(from: string, to: string, overwrite: boolean, signal?: AbortSignal): Promise<void>
  /** The whole-file SHA-256 of one path, computed on the device. */
  sha256(path: string, signal?: AbortSignal): Promise<string>
  /** Copy one file on the device, end-to-end. */
  copy(
    source: string,
    destination: string,
    overwrite: boolean,
    expectedSha256: string | undefined,
    onProgress: (written: number, totalBytes: number) => void,
    signal: AbortSignal,
  ): Promise<{ destination: string; sourceSha256: string; bytes: number }>
}

/**
 * The byte-level device ops seat.
 *
 * `forInitiator` answers the device for the ambient call's session, or
 * `undefined` when the session is local / unbound / has no helper. The
 * transfer engine reads it once at the top of its function, and passes the
 * resulting ops object down to every chunk — so the routing decision is
 * made exactly once per copy, not once per chunk.
 */
export interface DeviceFsSeat {
  readonly forInitiator: () => DeviceFsOps | undefined
}

/** The cordis service name `DshellFileSystem` publishes under. */
export const DEVICE_FS_SERVICE = 'dshellDeviceFs'

// ─── usage — the per-model token index the settings page charts ───

/**
 * The usage index route: one exact `/api` endpoint behind dsh's existing trust
 * and authentication fence, in the shape every other dshell route uses.
 *
 * The page reads aggregates and triggers the scan through the same endpoint:
 * the scan is the expensive half and belongs on the host, where the session
 * events already are, so the browser asks for it rather than doing it.
 */
export const DSHELL_USAGE_PATH = '/api/dshell/usage'
