/**
 * One PTY connection, whichever carrier the page can actually use.
 *
 * The wire model is unchanged — JSON frames in both directions, the same
 * `WireFrame` kinds the relay has always spoken. What varies is the carrier:
 *
 * - the browser gets a websocket, one socket for the session's whole life and
 *   no per-frame request, which is why it stays the default where it exists;
 * - the desktop shell has no port and no ws authority (its page runs on the
 *   `dsh-app://` scheme and its transport is a framed byte pipe), so it gets the
 *   stream pair the host also serves: a long-lived GET whose body is one JSON
 *   frame per line, plus a POST per upstream frame.
 *
 * The carrier is chosen by what the page can reach, not by a build flag, so the
 * same bundle runs in both shells. `localStorage['dshell.transport']` overrides
 * it — that is the only way to exercise the stream path from a browser, and the
 * only way to fall back to ws in a shell where the stream path misbehaves.
 */

import { DSHELL_STREAM_PATH, DSHELL_STREAM_SEND_PATH } from '@nexus-aethra/dshell-std'
import type { PtyBlock } from './index.js'

/** One wire frame from the bridge (the § 5 protocol). */
export interface WireFrame {
  kind?: string
  sessionId?: string
  chunk?: string
  time?: number
  replay?: boolean
  reason?: string
  /** `closed`/`error` frames: the connection diagnostic found in the output. */
  detail?: string
  message?: string
  /** `info`/`ready` frames: whether the shell has reached a prompt. */
  ready?: boolean
  /** `agent-info` frames: whether the agent shell exists at all. */
  live?: boolean
  /**
   * `error` frames: the host machine has no shell this terminal could run, so
   * the failure is the platform and not the session. The client picks a whole
   * screen from this rather than reading the message text for a hint of it.
   */
  localUnsupported?: boolean
  /**
   * `error` frames: the spawn was refused because the session's device draws
   * its credential from a locked vault group. The one failure with a way out
   * the reader can take without leaving the terminal, and the one an automatic
   * retry cannot fix — so the client keeps its retry budget for the attempt
   * that follows the unlock.
   */
  lockedGroup?: boolean
  /**
   * `error` frames: the host never attempted a shell for this session, because
   * the session has no live agent to run one.
   *
   * A session in agent mode owns no shell until it is asked to do something,
   * and the bridge reports that exactly as it reports a shell that failed to
   * start. The two need opposite presentations — one is a session waiting, the
   * other is a session in trouble — so the client is told which it got instead
   * of reading it out of the message.
   */
  noShell?: boolean
  /**
   * `closed`/`error` frames: a failure the reader can act on, when the message
   * alone does not say which action. A refused secret and a changed host key
   * both arrive as one sentence, and only one of them is fixable by re-entering
   * a secret.
   */
  failure?: 'passphrase' | 'hostKey'
  /** `info` frames: OS identity the dock uses to build bash prompts. */
  user?: string
  host?: string
  home?: string
  /** `(time, length)` pairs the host kept for the replayed text. */
  timeline?: [number, number][]
  /** `blocks` frames: the host's ordered block list, replacing the client's. */
  blocks?: PtyBlock[]
  /** `block-text` frames: a delta appended to one open block. */
  seq?: number
  text?: string
  /** `tui` frames: the program holding the terminal, or null for the shell. */
  program?: string | null
  /** `tui` frames: whether the alternate screen is in use. */
  alt?: boolean
  /** `tui` frames: whether the surface should be handed to that program. */
  active?: boolean
}

/** What a channel reports back to its owner. */
export interface PtyChannelHandlers {
  /** One decoded frame arrived from the host. */
  onFrame(frame: WireFrame): void
  /** The carrier is up; the owner sends its bind and remembered state here. */
  onOpen(): void
  /** The carrier ended: a closed stream, a socket close, a failed request. */
  onClose(): void
  /** A connection-level failure the owner shows as an error state. */
  onError(): void
}

/** Options one channel is opened with. */
export interface PtyChannelOptions {
  /** The session this channel carries. */
  readonly sessionId: string
  /** The user's main shell, or the agent panel's shell. */
  readonly stream: 'main' | 'agent'
  readonly handlers: PtyChannelHandlers
}

/** One live connection to the bridge. */
export interface PtyChannel {
  /**
   * Carrier lifecycle. `connecting` is distinct from `closed` because it is
   * the state a caller must leave alone: the session list churns several times
   * around a switch, and re-opening a channel that is still coming up would
   * leave two carriers feeding one history.
   */
  readonly status: 'connecting' | 'open' | 'closed'
  /** Which carrier this channel turned out to be, for the debug handle. */
  readonly transport: 'ws' | 'stream'
  /** Send one upstream frame; dropped unless {@link status} is `open`. */
  send(frame: Record<string, unknown>): void
  /** End the carrier on purpose; no `onClose` follows a deliberate dispose. */
  dispose(): void
}

/** Which carrier to use, as a preference; `auto` means "whatever works here". */
export type PtyTransport = 'auto' | 'ws' | 'stream'

/** Storage key for the transport override. */
const TRANSPORT_KEY = 'dshell.transport'

/**
 * How long the websocket handshake may take before it counts as a failure.
 *
 * Longer than a healthy loopback or LAN handshake by a wide margin, so only a
 * socket that is genuinely stuck reaches it — a NAT that dropped the mapping, a
 * laptop that slept mid-handshake, a host that stopped accepting while the page
 * was in the background. Without a bound, that state is indistinguishable from
 * "still connecting": no close, no error, no retry, and a screen that never
 * resolves.
 */
const CONNECT_TIMEOUT_MS = 15_000

/** Read the persisted preference; anything unrecognized means `auto`. */
export function transportPreference(): PtyTransport {
  try {
    const stored = globalThis.localStorage?.getItem(TRANSPORT_KEY)
    if (stored === 'ws' || stored === 'stream') return stored
  } catch {
    // Storage can be unavailable (blocked cookies, private mode); the page's
    // own capabilities are still a correct answer, so this is not a failure.
  }
  return 'auto'
}

/** Persist a preference; `auto` clears it. */
export function setTransportPreference(preference: PtyTransport): void {
  try {
    if (preference === 'auto') globalThis.localStorage?.removeItem(TRANSPORT_KEY)
    else globalThis.localStorage?.setItem(TRANSPORT_KEY, preference)
  } catch {
    // Without storage the override lasts the page's life; the capability
    // detection below still picks a working carrier.
  }
}

/**
 * Whether this page can open a ws to the host.
 *
 * A websocket to a page's own authority only makes sense where the page was
 * served over http(s). The desktop shell's page runs on its own scheme, where
 * `ws://<host>` names nothing, and that is exactly the shell the stream path
 * exists for.
 */
function wsReachable(): boolean {
  const protocol = globalThis.location?.protocol
  return protocol === 'http:' || protocol === 'https:'
}

/** The carrier this page will actually use. */
export function resolvedTransport(): 'ws' | 'stream' {
  const preference = transportPreference()
  if (preference === 'ws') return 'ws'
  if (preference === 'stream') return 'stream'
  return wsReachable() ? 'ws' : 'stream'
}

/** A ws-backed channel: one socket, frames as JSON text. */
class WsChannel implements PtyChannel {
  readonly transport = 'ws' as const
  private readonly socket: WebSocket
  private state: 'connecting' | 'open' | 'closed' = 'connecting'
  private deliberate = false
  /** Guards the handshake; cleared on open, on close, and on dispose. */
  private connectTimer: ReturnType<typeof setTimeout> | undefined

  constructor(url: string, handlers: PtyChannelHandlers) {
    this.socket = new WebSocket(url)
    // A socket that never finishes connecting is the one failure this carrier
    // cannot otherwise report: the browser keeps it in CONNECTING through a
    // silent network, so neither `onopen` nor `onclose` ever runs and the screen
    // stays on "connecting" forever without spending a retry attempt. Closing it
    // ourselves turns that silence into the ordinary close path, which is where
    // the retry budget lives.
    this.connectTimer = setTimeout(() => {
      if (this.state !== 'connecting') return
      // The state moves first: closing the socket raises `onclose` too, and the
      // handler there must see a closed carrier rather than report one close
      // twice (which would spend two retry attempts on one failure).
      this.state = 'closed'
      try { this.socket.close() } catch { /* already gone */ }
      handlers.onError()
      handlers.onClose()
    }, CONNECT_TIMEOUT_MS)
    this.socket.onopen = () => {
      clearTimeout(this.connectTimer)
      this.state = 'open'
      handlers.onOpen()
    }
    this.socket.onmessage = (event) => {
      let frame: WireFrame
      try {
        frame = JSON.parse(String(event.data)) as WireFrame
      } catch {
        return
      }
      handlers.onFrame(frame)
    }
    this.socket.onclose = () => {
      clearTimeout(this.connectTimer)
      const alreadyClosed = this.state === 'closed'
      this.state = 'closed'
      if (!this.deliberate && !alreadyClosed) handlers.onClose()
    }
    this.socket.onerror = () => {
      if (!this.deliberate) handlers.onError()
    }
  }

  get status(): 'connecting' | 'open' | 'closed' {
    return this.state
  }

  send(frame: Record<string, unknown>): void {
    if (this.state !== 'open') return
    this.socket.send(JSON.stringify(frame))
  }

  dispose(): void {
    this.deliberate = true
    this.state = 'closed'
    clearTimeout(this.connectTimer)
    this.socket.close()
  }
}

/**
 * A stream-backed channel: a long-lived GET down, one POST per frame up.
 *
 * Upstream requests are chained rather than fired in parallel. A keystroke's
 * frame must not overtake the frame before it (a resize or a signal would then
 * apply out of order), and HTTP gives no ordering guarantee across separate
 * requests even on one connection. The chain waits for each POST's response
 * headers, which through the desktop's local pipe is immediate.
 */
class StreamChannel implements PtyChannel {
  readonly transport = 'stream' as const
  private readonly clientId = newClientId()
  private readonly abort = new AbortController()
  private state: 'connecting' | 'open' | 'closed' = 'connecting'
  private deliberate = false
  private upstream: Promise<void> = Promise.resolve()

  constructor(
    private readonly sessionId: string,
    private readonly stream: 'main' | 'agent',
    private readonly handlers: PtyChannelHandlers,
  ) {
    void this.downstream()
  }

  private async downstream(): Promise<void> {
    try {
      const query = new URLSearchParams({
        clientId: this.clientId,
        sessionId: this.sessionId,
        stream: this.stream,
      })
      const response = await fetch(`${DSHELL_STREAM_PATH}?${query.toString()}`, {
        method: 'GET',
        headers: { accept: 'application/x-ndjson' },
        signal: this.abort.signal,
      })
      if (!response.ok || response.body === null) {
        throw new Error(`dshell stream failed: HTTP ${String(response.status)}`)
      }
      this.state = 'open'
      this.handlers.onOpen()
      await this.read(response.body)
      this.state = 'closed'
      if (!this.deliberate) this.handlers.onClose()
    } catch {
      this.state = 'closed'
      if (this.deliberate) return
      // Reported as an error first so the owner's state names the transport,
      // then as a close so its retry loop runs exactly as on a socket drop.
      this.handlers.onError()
      this.handlers.onClose()
    }
  }

  /** Frames arrive as lines; a chunk boundary can split one, hence the tail. */
  private async read(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let pending = ''
    for (;;) {
      const { done, value } = await reader.read()
      pending += decoder.decode(value, { stream: !done })
      let newline = pending.indexOf('\n')
      while (newline !== -1) {
        const line = pending.slice(0, newline)
        pending = pending.slice(newline + 1)
        if (line !== '') this.dispatch(line)
        newline = pending.indexOf('\n')
      }
      if (done) break
    }
    if (pending !== '') this.dispatch(pending)
  }

  private dispatch(line: string): void {
    let frame: WireFrame
    try {
      frame = JSON.parse(line) as WireFrame
    } catch {
      // A truncated line is not a frame; the next one may be.
      return
    }
    this.handlers.onFrame(frame)
  }

  get status(): 'connecting' | 'open' | 'closed' {
    return this.state
  }

  send(frame: Record<string, unknown>): void {
    if (this.state !== 'open') return
    const body = JSON.stringify({ ...frame, clientId: this.clientId })
    this.upstream = this.upstream.then(async () => {
      if (this.deliberate) return
      try {
        await fetch(DSHELL_STREAM_SEND_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          signal: this.abort.signal,
        })
      } catch {
        // The downstream reader is what reports a broken carrier; a failed
        // control frame has nowhere better to go than the log.
        console.debug('[dshell-pty] control frame not delivered')
      }
    })
  }

  dispose(): void {
    this.deliberate = true
    this.state = 'closed'
    this.abort.abort()
  }
}

/** A per-channel id; `crypto.randomUUID` is absent outside secure contexts. */
function newClientId(): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  if (uuid !== undefined) return uuid
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Open one channel with whichever carrier this page can reach.
 * @param options - the session, which shell, and the frame handlers.
 * @returns the channel; already connecting when it returns.
 */
export function openPtyChannel(options: PtyChannelOptions): PtyChannel {
  if (resolvedTransport() === 'stream') {
    return new StreamChannel(options.sessionId, options.stream, options.handlers)
  }
  const protocol = globalThis.location?.protocol === 'https:' ? 'wss:' : 'ws:'
  const host = globalThis.location?.host ?? 'localhost'
  return new WsChannel(`${protocol}//${host}/dshell/pty`, options.handlers)
}
