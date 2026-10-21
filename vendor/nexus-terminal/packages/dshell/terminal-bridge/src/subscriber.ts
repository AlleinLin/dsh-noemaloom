/**
 * One carrier for the bridge's outbound frames.
 *
 * The bridge's frame model has always been one-way and per-subscriber: fan a
 * JSON frame out to everyone watching a session, and drop whoever is gone. The
 * `WebSocket` object itself used to be that subscriber, which is what tied the wire
 * to the upgrade route — and therefore to `webServer`, which the desktop shell
 * does not compose. Naming the carrier instead of naming the socket lets the
 * same frames run over a Response body, where the only thing that changes is
 * who does the writing.
 *
 * `send` takes an already-serialized frame on purpose: both carriers put one
 * JSON object on one line, and serializing once per broadcast keeps a chatty
 * shell from paying for it per subscriber.
 */

import { WebSocket } from 'ws'

/** One live consumer of the bridge's frames. */
export interface PtySubscriber {
  /** Whether the carrier can still accept a frame. */
  readonly open: boolean
  /** Write one serialized frame. */
  send(data: string): void
  /** End the carrier; the reason is for a carrier that has somewhere to put it. */
  close(code: number, reason: string): void
}

/** The ws carrier: one browser socket bound to one session. */
export class WsSubscriber implements PtySubscriber {
  constructor(private readonly socket: WebSocket) {}

  get open(): boolean {
    return this.socket.readyState === WebSocket.OPEN
  }

  send(data: string): void {
    if (!this.open) return
    try {
      this.socket.send(data)
    } catch {
      // The client closed mid-write; the socket's own close handler drops the
      // boundSession entry, nothing else to do here.
    }
  }

  close(code: number, reason: string): void {
    if (this.socket.readyState !== WebSocket.OPEN) return
    this.socket.close(code, reason)
  }
}

/**
 * How far a stream subscriber may fall behind before the bridge gives up on it.
 *
 * A Response body has no socket buffer to push back on, so a consumer that
 * stops reading would otherwise grow this process's memory for as long as the
 * shell keeps printing. Past this the subscriber is closed like a ws whose
 * buffer overflowed: the client sees the stream end and rebinds, which hands it
 * the current scrollback instead of the backlog it was not reading.
 */
const MAX_QUEUED_BYTES = 4 * 1024 * 1024

/** The fetch carrier: one long-lived Response body for one session. */
export class FetchSubscriber implements PtySubscriber {
  private readonly encoder = new TextEncoder()
  private live = true

  constructor(
    /** The id both halves of this client's stream carry. */
    readonly clientId: string,
    private readonly controller: ReadableStreamDefaultController<Uint8Array>,
  ) {}

  get open(): boolean {
    return this.live
  }

  send(data: string): void {
    if (!this.live) return
    const desired = this.controller.desiredSize
    if (desired !== null && desired <= -MAX_QUEUED_BYTES) {
      // Reported as a close, not as a dropped frame: a partial stream would
      // leave the client rendering a shell whose output has a hole in it.
      this.close(1000, 'stream subscriber fell behind')
      return
    }
    try {
      this.controller.enqueue(this.encoder.encode(`${data}\n`))
    } catch {
      // The consumer is gone; cancelling the stream is what tells the bridge,
      // and until it arrives, silently dropping is the only correct answer.
      this.live = false
    }
  }

  close(_code: number, _reason: string): void {
    if (!this.live) return
    this.live = false
    try {
      this.controller.close()
    } catch {
      // Already closed or errored by the consumer; both mean the same here.
    }
  }
}
