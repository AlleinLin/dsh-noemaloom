/**
 * The browser half's pipe state: one snapshot of links, tickets and grants,
 * refreshed from the route after every mutation, plus the panel's open state.
 *
 * The open state lives here rather than inside the panel component because the
 * entry button (dshell-mode's terminal section) is a different bundle and
 * cannot value-import this one; it reaches the toggle through the
 * `dshellBuffer` service, exactly as dshell-mode reaches dshell-ssh.
 */

import { Service, type Context } from '@deepseek-ai/cordis'
// Type-only: pulls the locale service merge (ctx.locale) and this namespace's keys.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from './locales.js'
import {
  DSHELL_BUFFER_PATH, type BufferGrant, type BufferLink, type BufferListing, type BufferRequest,
  type BufferResponse, type BufferTicket, type BufferTransfer,
} from '../protocol.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Cross-session pipe state provided by dshell-buffer's browser half. */
    dshellBuffer: BufferClientService
  }
}

/** What the pipe panel renders from. */
export interface BufferSnapshot {
  readonly links: readonly BufferLink[]
  readonly tickets: readonly BufferTicket[]
  readonly grants: readonly BufferGrant[]
  /** Chunked transfers in flight (and the freshly settled), for progress UI. */
  readonly transfers: readonly BufferTransfer[]
  /**
   * Sessions dsh disposed that it still lists until the next start. The
   * panel drops their nodes: dsh cannot tear a loaded session down, so the
   * id outlives its pipes and would otherwise draw as an orphan node.
   */
  readonly departed: readonly string[]
  /**
   * The device root each bound endpoint runs in, keyed by session id: the
   * label beside a peer names the world it stands in, not the host-side
   * stand-in directory its session was created with.
   */
  readonly worlds: Readonly<Record<string, string>>
  /** The last refusal or transport failure, shown until the next call. */
  readonly error: string | undefined
  /** Whether the host has answered at least once. */
  readonly loaded: boolean
  /** Whether the pipe panel is on screen. */
  readonly open: boolean
}

const EMPTY: BufferSnapshot = {
  links: [], tickets: [], grants: [], transfers: [], departed: [], worlds: {},
  error: undefined, loaded: false, open: false,
}

/** How often an open panel re-reads the state, so progress is visible live. */
const POLL_MS = 3000
/** How fast progress moves while a chunked transfer is in flight. */
const TRANSFER_POLL_MS = 1000

/** The slice of the session list the panel renders peer labels from. */
export interface SessionSeat {
  getSnapshot: () => {
    readonly ids: readonly string[]
    readonly byId: Record<string, {
      readonly displayTitle: string
      readonly cwd?: string | undefined
      /** Whether a turn is running — the graph marks such nodes. */
      readonly running?: boolean | undefined
    }>
    readonly current: string | undefined
    /**
     * Sessions dsh has archived. They are put away rather than wired, so the
     * panel neither draws them nor offers them as an endpoint; a session that
     * already has a pipe stays in the graph so the pipe keeps both its ends.
     */
    readonly archived?: readonly string[] | undefined
    /**
     * The sessions the pipe feature serves: dshell's terminal sessions.
     *
     * A pipe is between sessions a reader works in — a shell, or an agent on a
     * device — and every other dsh session (plain conversations, subagents) is
     * offered by neither the graph nor the endpoint pickers. Undefined means
     * the composition has no terminal-mode registry, so nothing can tell and
     * nothing is filtered.
     */
    readonly terminals?: readonly string[] | undefined
  }
  subscribe: (listener: () => void) => () => void
}

/** This package's copy namespace. */
const NS = 'dshellBuffer'

/** Pipe state mirror plus its mutations. */
export class BufferClientService extends Service {
  private snapshot: BufferSnapshot = EMPTY
  private readonly listeners = new Set<() => void>()
  private readonly t: TranslateNS<'dshellBuffer'>
  private poll: ReturnType<typeof setInterval> | undefined

  constructor(ctx: Context) {
    super(ctx, 'dshellBuffer')
    this.t = ctx.locale.bind(NS)
  }

  getSnapshot = (): BufferSnapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Open or close the pipe panel; opening starts the refresh poll. */
  setOpen(open: boolean): void {
    if (this.snapshot.open === open) return
    this.publish({ ...this.snapshot, open })
    this.syncPoll()
    if (open) void this.load()
  }

  /**
   * Keep exactly one poll alive while it is needed: the panel is open, or a
   * chunked transfer is in flight (its progress surfaces in the status card
   * whether or not the pipe panel is on screen).
   */
  private syncPoll(): void {
    const needed = this.snapshot.open
      || this.snapshot.transfers.some(entry => entry.finishedAt === undefined)
    if (needed && this.poll === undefined) {
      this.poll = setInterval(() => { void this.load() }, this.snapshot.open ? POLL_MS : TRANSFER_POLL_MS)
    } else if (!needed && this.poll !== undefined) {
      clearInterval(this.poll)
      this.poll = undefined
    }
  }

  /** Flip the panel's open state. */
  toggle(): void {
    this.setOpen(!this.snapshot.open)
  }

  /** Read the committed state. */
  async load(): Promise<void> {
    await this.send({ action: 'state' })
  }

  /** Connect two sessions. Only the user may do this. */
  async link(a: string, b: string, label?: string, description?: string): Promise<void> {
    await this.send({
      action: 'link',
      a,
      b,
      ...label === undefined || label === '' ? {} : { label },
      ...description === undefined || description === '' ? {} : { description },
    }, { strict: true })
  }

  /**
   * Name a pipe, state what it is for, or clear either (empty string clears).
   * The user is the only caller, which is what unsets the "an agent wrote
   * this" marker on the link.
   */
  async annotate(linkId: string, label: string, description: string): Promise<void> {
    await this.send({ action: 'annotate', linkId, label, description }, { strict: true })
  }

  /** Remove a pipe. Outstanding tickets keep running. */
  async unlink(linkId: string): Promise<void> {
    await this.send({ action: 'unlink', linkId }, { strict: true })
  }

  /** Revoke a grant immediately, releasing its remaining references. */
  async revoke(grantId: string): Promise<void> {
    await this.send({ action: 'revoke', grantId }, { strict: true })
  }

  /** Withdraw an outstanding ticket. */
  async cancel(ticketId: string): Promise<void> {
    await this.send({ action: 'cancel', ticketId }, { strict: true })
  }

  /**
   * One buffer-browser listing for the pipe detail page. Deliberately outside
   * the snapshot: a browsing session is per-component state with its own
   * loading and error display, not shared pipe state every panel re-renders on.
   */
  async listBuffer(linkId: string, grantId?: string, path?: string): Promise<BufferListing> {
    const response = await fetch(DSHELL_BUFFER_PATH, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'buffer-ls',
        linkId,
        ...grantId === undefined ? {} : { grantId },
        ...path === undefined ? {} : { path },
      }),
    })
    const body = await response.json() as BufferResponse
    if (body.error !== undefined) throw new Error(body.error)
    if (body.listing === undefined) throw new Error(this.t('error.missingListing'))
    return body.listing
  }

  /** Clear the last error line. */
  clearError(): void {
    if (this.snapshot.error === undefined) return
    this.publish({ ...this.snapshot, error: undefined })
  }

  /**
   * One route call. The refusal is always published so the panel shows it;
   * `strict` additionally throws it, for callers whose flow must not continue.
   * @param request - request body; `state` travels as a GET.
   * @param options - `strict` rethrows the refusal after publishing it.
   * @returns the response body, or a body synthesized from a transport failure.
   */
  private async send(request: BufferRequest, options?: { strict?: boolean }): Promise<BufferResponse> {
    const strict = options?.strict === true
    let body: BufferResponse
    try {
      const response = await fetch(DSHELL_BUFFER_PATH, {
        method: request.action === 'state' ? 'GET' : 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        ...request.action === 'state' ? {} : { body: JSON.stringify(request) },
      })
      body = await response.json() as BufferResponse
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.publish({ ...this.snapshot, error: reason })
      if (strict) throw new Error(reason)
      return { ...this.snapshot, error: reason }
    }
    this.publish({
      links: body.links,
      tickets: body.tickets,
      grants: body.grants,
      transfers: body.transfers ?? [],
      departed: body.departed ?? [],
      worlds: body.worlds ?? {},
      error: body.error,
      loaded: true,
      open: this.snapshot.open,
    })
    this.syncPoll()
    if (strict && body.error !== undefined) throw new Error(body.error)
    return body
  }

  private publish(snapshot: BufferSnapshot): void {
    this.snapshot = snapshot
    for (const listener of this.listeners) listener()
  }
}
