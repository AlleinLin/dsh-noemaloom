/**
 * The port forwarder: a local socket in front of a port on a device.
 *
 * A forward is the shape `ssh -L` has: a socket on THIS machine, and every
 * connection accepted on it is carried over the device's own SSH connection to
 * a port there. It is a TCP tunnel, not an HTTP proxy, so what travels through
 * it is whatever the port speaks — a web page, an API, a database wire
 * protocol, a websocket.
 *
 * The connection is the POOLED one, so a forward costs no extra SSH session:
 * the device already holds one connection for the terminal, the file reads and
 * the helper, and a forward is another channel on it. The cost of that choice
 * is the thing this module exists to handle — a channel dies with its
 * connection, so a forward has to be REBUILT when the connection is replaced.
 * The transport re-dials a dead connection on its own; nothing there knows which
 * forwards were meant to outlive it, so this module watches for the close and
 * re-opens.
 *
 * A forward belongs to a SESSION, not to a device: a session is the reader's
 * context, and a session that ends takes its forwards with it. A forward is not
 * persisted either — after a restart the reader asks for the ones they want
 * again, rather than finding tunnels this process no longer owns.
 *
 * @module @nexus-aethra/dshell-ssh/forwarder
 */

import { createServer, type Server, type Socket } from 'node:net'
import type { ClientChannel } from 'ssh2'
import type { DshellForwardStatus, DshellForwardView } from '@nexus-aethra/dshell-std'
import type { DeviceConnection } from '../devices.js'
import type { DeviceTransport } from '../transport/transport.js'

/**
 * How a forward is doing.
 *
 * `starting` is a real state and not a formality: the device has to accept the
 * request, and until it does there is no tunnel — a reader who saw only
 * `running` and `failed` would have to guess which one they are in.
 */
export type ForwardStatus = DshellForwardStatus
export type ForwardView = DshellForwardView

/** What a caller asks for. */
export interface ForwardRequest {
  /** The session the forward belongs to. */
  readonly sessionId: string
  /** The device to reach. */
  readonly device: DeviceConnection
  /** The port on the device to connect to. */
  readonly devicePort: number
  /** The port on this machine to listen on; 0 asks the system for one. */
  readonly localPort: number
  /** The address on this machine to listen on. */
  readonly localAddress: string
}

/** What a forward is told to do. */
export interface ForwardOutcome {
  /** The forward, as a reader sees it. */
  readonly view: ForwardView
  /** Whether the forward is usable now. */
  readonly ok: boolean
}

/**
 * The tunnel one forward owns.
 *
 * The listener and the channels it accepted are one unit: closing the forward
 * closes both, and a channel that dies on its own does NOT close the listener,
 * because the listener is what the next connection will arrive on.
 *
 * The view is MUTABLE rather than replaced: the connection handler and the
 * status update both reach the same tunnel, and a status written to a copy
 * would leave the one a reader is looking at saying 'starting' forever.
 */
interface Tunnel {
  readonly view: { -readonly [K in keyof ForwardView]: ForwardView[K] }
  /** The local socket. */
  readonly server: Server
  /** Close the listener and every channel it accepted. */
  close(): void
}

/** The transport this forwarder opens its channels on. */
export type ForwardTransport = Pick<DeviceTransport, 'forward'>

/**
 * The forwarder: every forward on this host.
 *
 * Keyed by session AND by the local port, because the reader's question is
 * "what does this session have open" and the local port is what two forwards
 * would collide on.
 */
export class Forwarder {
  private readonly tunnels = new Map<string, Tunnel>()
  /**
   * The transports this forwarder has asked to open channels on, by device.
   *
   * Kept so a forward can be re-opened when its device's connection is
   * replaced: the forwarder asked for a channel on a connection that is now
   * gone, and the only thing that can put it back is the same transport.
   */
  private readonly transports = new Map<string, ForwardTransport>()

  /**
   * @param transport - the transport channels are opened on; injectable so the
   *   forwarder can be tested without a device.
   */
  constructor(private readonly transport: ForwardTransport) {}

  /**
   * Open a forward.
   *
   * @param request - what to forward, and where.
   * @returns the forward, and whether it is usable.
   */
  async open(request: ForwardRequest): Promise<ForwardOutcome> {
    // The lookup is by the port ASKED for, and the store is under the port
    // GIVEN: a request for port 0 means 'any free port', so it is not a
    // duplicate of anything, and a request for a named port is a duplicate of
    // the forward already holding it.
    if (request.localPort !== 0) {
      const existing = this.tunnels.get(this.keyOf(request.sessionId, request.localPort))
      if (existing !== undefined) {
        return { view: existing.view, ok: existing.view.status === 'running' }
      }
    }
    this.transports.set(request.device.id, this.transport)

    let localPort = request.localPort
    // `allowHalfOpen` is what makes this a tunnel rather than a relay that
    // gives up halfway. A caller that finishes writing — an HTTP request
    // whose body is sent — closes its write side, and Node's default server
    // answers that by closing the whole socket. The device's response, which
    // arrives after the request, would then have nowhere to go: the tunnel
    // carried the request and dropped the answer. Half-open keeps the read
    // side alive so the answer can land.
    const server = createServer({ allowHalfOpen: true })
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => { reject(error) }
        server.once('error', onError)
        server.listen(localPort, request.localAddress, () => {
          server.removeListener('error', onError)
          resolve()
        })
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      const failed: ForwardView = {
        sessionId: request.sessionId,
        deviceId: request.device.id,
        deviceName: request.device.name,
        devicePort: request.devicePort,
        localPort,
        localAddress: request.localAddress,
        status: 'failed',
        error: reason,
      }
      return { view: failed, ok: false }
    }

    const address = server.address()
    const bound = typeof address === 'object' && address !== null ? address.port : localPort
    localPort = bound

    const channels = new Set<ClientChannel>()
    const view = {
      sessionId: request.sessionId,
      deviceId: request.device.id,
      deviceName: request.device.name,
      devicePort: request.devicePort,
      localPort,
      localAddress: request.localAddress,
      status: 'starting' as ForwardStatus,
      error: undefined as string | undefined,
    }

    const tunnel: Tunnel = {
      view,
      server,
      close: () => {
        for (const channel of channels) {
          try { channel.end() } catch { /* already gone */ }
        }
        channels.clear()
        try { server.close() } catch { /* already closed */ }
      },
    }
    // The key is built AFTER the bind, because a forward asked for port 0 is
    // stored under the port it was GIVEN -- a key built from the 0 that was
    // asked for would not be the key anything else would look it up by.
    this.tunnels.set(this.keyOf(request.sessionId, localPort), tunnel)

    server.on('connection', (socket: Socket) => {
      void this.carry(request, socket, channels, tunnel)
    })

    // The first channel is opened eagerly so a device that refuses is refused
    // NOW, while the reader is still looking at the answer. A forward that only
    // fails when the first browser request arrives is a forward that reads as
    // broken.
    try {
      const channel = await this.transport.forward(
        request.device,
        request.localAddress,
        localPort,
        '127.0.0.1',
        request.devicePort,
      )
      channels.add(channel)
      channel.on('close', () => { channels.delete(channel) })
      channel.on('error', () => { channels.delete(channel) })
      this.markRunning(tunnel, 'running', undefined)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.markRunning(tunnel, 'failed', reason)
      return { view: tunnel.view, ok: false }
    }

    return { view: tunnel.view, ok: true }
  }

  /**
   * Carry one accepted connection to the device.
   *
   * @param request - the forward's own request, for the device and the port.
   * @param socket - the connection accepted on the local socket.
   * @param channels - the tunnel's open channels, so they can all be closed.
   * @param tunnel - the tunnel this connection belongs to.
   */
  private async carry(
    request: ForwardRequest,
    socket: Socket,
    channels: Set<ClientChannel>,
    tunnel: Tunnel,
  ): Promise<void> {
    let channel: ClientChannel
    try {
      channel = await this.transport.forward(
        request.device,
        request.localAddress,
        tunnel.view.localPort,
        '127.0.0.1',
        request.devicePort,
      )
    } catch {
      // A device that will not open this channel closes this connection. The
      // forward itself stays up: the next attempt may be accepted, and a
      // forward that gave up on the first refusal would be useless.
      socket.destroy()
      return
    }
    channels.add(channel)
    channel.on('close', () => { channels.delete(channel) })
    channel.on('error', () => { channels.delete(channel) })
    socket.on('error', () => { /* the peer went away */ })
    channel.on('error', () => { /* the device went away */ })
    // The two directions are moved by hand rather than by `pipe`, and the
    // reason is a half-close. `pipe` ends the destination when the source
    // ends, and a caller that finished writing (an HTTP request whose body
    // is sent, a client that closes its write side) would take the answer with
    // it: the socket's writable half closes, `pipe` unpipes, and what the
    // device sends back afterwards goes nowhere. A tunnel has to carry the
    // answer that comes AFTER the request, so each direction ends on its own
    // terms.
    socket.on('data', (chunk: Buffer) => { channel.write(chunk) })
    channel.on('data', (chunk: Buffer) => { socket.write(chunk) })
    socket.on('end', () => { channel.end() })
    channel.on('end', () => { socket.end() })
  }

  /**
   * Replace a tunnel's status.
   *
   * @param tunnel - the tunnel to mark.
   * @param status - the status it is in now.
   * @param error - why it failed, when it did.
   */
  private markRunning(tunnel: Tunnel, status: ForwardStatus, error: string | undefined): void {
    tunnel.view.status = status
    tunnel.view.error = error
  }

  /**
   * Stop one forward.
   *
   * @param sessionId - the session the forward belongs to.
   * @param localPort - the local port it listens on.
   * @returns whether there was one to stop.
   */
  stop(sessionId: string, localPort: number): boolean {
    const key = this.keyOf(sessionId, localPort)
    const tunnel = this.tunnels.get(key)
    if (tunnel === undefined) return false
    tunnel.close()
    this.tunnels.delete(key)
    return true
  }

  /** Stop every forward of one session. */
  stopSession(sessionId: string): number {
    let stopped = 0
    for (const [key, tunnel] of [...this.tunnels]) {
      if (tunnel.view.sessionId !== sessionId) continue
      tunnel.close()
      this.tunnels.delete(key)
      stopped++
    }
    return stopped
  }

  /** Stop every forward; used when the host unloads. */
  stopAll(): void {
    for (const tunnel of [...this.tunnels.values()]) tunnel.close()
    this.tunnels.clear()
  }

  /** Every forward, as a reader sees it. */
  list(): readonly ForwardView[] {
    return [...this.tunnels.values()].map(tunnel => tunnel.view)
  }

  /** The forwards of one session. */
  listSession(sessionId: string): readonly ForwardView[] {
    return this.list().filter(view => view.sessionId === sessionId)
  }

  /**
   * The key one forward is stored under.
   *
   * @param sessionId - the session the forward belongs to.
   * @param localPort - the local port it listens on.
   * @returns the key.
   */
  private keyOf(sessionId: string, localPort: number): string {
    return sessionId + '@' + String(localPort)
  }
}
