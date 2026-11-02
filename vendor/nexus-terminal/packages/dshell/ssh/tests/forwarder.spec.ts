/**
 * The forwarder, driven by a transport that is not ssh2.
 *
 * What is worth pinning here is the SHAPE: that a forward listens on THIS
 * machine, that a connection accepted on it is carried to the device, that a
 * device which refuses is refused while the reader is still looking at the
 * answer, and that a forward stops when the session stops. The bytes on the
 * wire are ssh2's business, and the acceptance container is where those are
 * proven.
 */

import { EventEmitter } from 'node:events'
import { connect } from 'node:net'
import { Duplex, PassThrough } from 'node:stream'
import type { ClientChannel } from 'ssh2'
import { describe, expect, it } from 'vitest'
import type { DeviceConnection } from '../src/devices.js'
import { Forwarder, type ForwardTransport } from '../src/forward/forwarder.js'

/**
 * One fake forwarded channel: a duplex whose two directions are independent, the
 * way a real SSH channel's are.
 *
 * The readable half yields what the device sent, because that is the half the
 * caller reads: a tunnel that cannot carry the answer back carries nothing.
 */
class FakeChannel extends Duplex {
  readonly stderr = new PassThrough({ autoDestroy: false })
  closed = false
  /** Everything written to this channel, in order. */
  readonly written: Buffer[] = []

  constructor() {
    super({
      autoDestroy: false,
      read: () => undefined,
      write: (chunk, _enc, done) => {
        this.written.push(Buffer.from(chunk as Buffer))
        done()
      },
    })
  }

  close(): void {
    this.closed = true
    this.emit('close')
  }

  /** What the device sends on this channel. */
  output(text: string): void {
    this.push(Buffer.from(text))
  }
}

/**
 * A transport that opens fake channels, and remembers what it was asked for.
 *
 * The refusal is modelled the way a device refuses: the callback answers with
 * an error, not with a channel that never opens.
 */
class FakeTransport implements ForwardTransport {
  readonly asked: { srcIP: string; srcPort: number; dstIP: string; dstPort: number }[] = []
  readonly channels: FakeChannel[] = []
  /** Set to make the next open fail, as a device that refuses would. */
  refuseWith: Error | undefined

  async forward(
    _device: DeviceConnection,
    srcIP: string,
    srcPort: number,
    dstIP: string,
    dstPort: number,
  ): Promise<ClientChannel> {
    this.asked.push({ srcIP, srcPort, dstIP, dstPort })
    if (this.refuseWith !== undefined) {
      const error = this.refuseWith
      this.refuseWith = undefined
      throw error
    }
    const channel = new FakeChannel()
    this.channels.push(channel)
    return channel as unknown as ClientChannel
  }
}

function device(over: Partial<DeviceConnection> = {}): DeviceConnection {
  return {
    id: 'web',
    name: 'web-server',
    host: 'example.test',
    port: 22,
    user: 'ops',
    remoteRoot: '~',
    auth: 'key',
    secret: undefined,
    ...over,
  }
}

/**
 * Send one request to a local port and read the answer.
 *
 * The write side is closed after the request, the way an HTTP client closes
 * it. The read side stays open, because the answer comes after — and the
 * tunnel keeps it that way, so nothing closes the socket on its own.
 *
 * @param port - the port to talk to.
 * @param body - what to send.
 * @param complete - what says the answer is finished.
 * @returns what came back.
 */
function send(port: number, body: string, complete: (answer: string) => boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ port, host: '127.0.0.1' }, () => {
      socket.write(body)
      socket.end()
    })
    let answer = ''
    socket.on('data', (chunk: Buffer) => {
      answer += chunk.toString()
      if (complete(answer)) { socket.destroy(); resolve(answer) }
    })
    socket.on('error', reject)
    socket.on('close', () => { resolve(answer) })
  })
}

/**
 * Wait for a thing to become true.
 *
 * The tunnel opens its channel in response to a connection, so a test that
 * looks for the channel immediately after connecting is looking before the
 * answer arrived. Polling is the honest way to wait for that: the event
 * that carries it is the socket's own, and nothing here can subscribe to it
 * from outside.
 *
 * @param predicate - what to wait for.
 * @returns what the predicate returned.
 * @throws When it did not become true in time.
 */
async function waitFor<T>(predicate: () => T | undefined): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = predicate()
    if (value !== undefined && value !== false) return value as T
    await new Promise((resolve) => { setTimeout(resolve, 10) })
  }
  throw new Error('the forward did not answer in time')
}

describe('the forwarder', () => {
  it('listens on this machine and reports the port it got', async () => {
    const transport = new FakeTransport()
    const forwarder = new Forwarder(transport)

    const outcome = await forwarder.open({
      sessionId: 's-1',
      device: device(),
      devicePort: 3000,
      localPort: 0,
      localAddress: '127.0.0.1',
    })

    expect(outcome.ok).toBe(true)
    expect(outcome.view.status).toBe('running')
    // Port 0 asks the system for one, so the answer is the port it actually
    // got -- never the 0 that was asked for.
    expect(outcome.view.localPort).toBeGreaterThan(0)
    expect(outcome.view.devicePort).toBe(3000)
    expect(outcome.view.deviceName).toBe('web-server')
    expect(outcome.view.sessionId).toBe('s-1')

    forwarder.stopAll()
  })

  it('carries a connection accepted on it to the device', async () => {
    const transport = new FakeTransport()
    const forwarder = new Forwarder(transport)

    const outcome = await forwarder.open({
      sessionId: 's-1',
      device: device(),
      devicePort: 3000,
      localPort: 0,
      localAddress: '127.0.0.1',
    })
    expect(outcome.ok).toBe(true)

    // The device is asked for the port the forward is FOR, on the device's own
    // loopback -- never for the local port, which means nothing there.
    const asked = transport.asked[0]
    expect(asked?.dstIP).toBe('127.0.0.1')
    expect(asked?.dstPort).toBe(3000)
    expect(asked?.srcPort).toBe(outcome.view.localPort)

    forwarder.stopAll()
  })

  it('carries what the device sends back to the caller', async () => {
    const transport = new FakeTransport()
    const forwarder = new Forwarder(transport)

    const outcome = await forwarder.open({
      sessionId: 's-1',
      device: device(),
      devicePort: 3000,
      localPort: 0,
      localAddress: '127.0.0.1',
    })

    // The first channel is the eager one; the second belongs to the caller, and
    // it appears once the local socket has been accepted and the device has
    // answered -- so it is waited for rather than assumed.
    const pending = send(outcome.view.localPort, 'ping', (answer) => answer.includes('pong'))
    const answering = await waitFor(() => transport.channels[1])
    // What the caller wrote reached the device, which is the other half of
    // the same tunnel.
    await waitFor(() => answering.written.length > 0)
    expect(answering.written.map(chunk => chunk.toString()).join('')).toBe('ping')
    answering.output('pong')
    expect(await pending).toBe('pong')

    forwarder.stopAll()
  })

  it('refuses what the device refuses, while the reader is looking', async () => {
    const transport = new FakeTransport()
    transport.refuseWith = new Error('administratively prohibited')
    const forwarder = new Forwarder(transport)

    const outcome = await forwarder.open({
      sessionId: 's-1',
      device: device(),
      devicePort: 3000,
      localPort: 0,
      localAddress: '127.0.0.1',
    })

    expect(outcome.ok).toBe(false)
    expect(outcome.view.status).toBe('failed')
    expect(outcome.view.error).toContain('prohibited')

    forwarder.stopAll()
  })

  it('stops with the session, and not before', async () => {
    const transport = new FakeTransport()
    const forwarder = new Forwarder(transport)

    const outcome = await forwarder.open({
      sessionId: 's-1',
      device: device(),
      devicePort: 3000,
      localPort: 0,
      localAddress: '127.0.0.1',
    })
    expect(forwarder.listSession('s-1')).toHaveLength(1)
    expect(forwarder.listSession('s-other')).toHaveLength(0)

    expect(forwarder.stopSession('s-1')).toBe(1)
    expect(forwarder.listSession('s-1')).toHaveLength(0)
    // The port is free again, which is what "stopped" has to mean.
    await expect(send(outcome.view.localPort, 'ping', () => true)).rejects.toThrow()
  })

  it('stops one forward by its local port', async () => {
    const transport = new FakeTransport()
    const forwarder = new Forwarder(transport)

    const outcome = await forwarder.open({
      sessionId: 's-1',
      device: device(),
      devicePort: 3000,
      localPort: 0,
      localAddress: '127.0.0.1',
    })

    expect(forwarder.stop('s-1', outcome.view.localPort)).toBe(true)
    expect(forwarder.stop('s-1', outcome.view.localPort)).toBe(false)
    expect(forwarder.list()).toHaveLength(0)
  })

  it('says so when the local port is taken', async () => {
    const transport = new FakeTransport()
    const forwarder = new Forwarder(transport)

    const first = await forwarder.open({
      sessionId: 's-1',
      device: device(),
      devicePort: 3000,
      localPort: 0,
      localAddress: '127.0.0.1',
    })
    expect(first.ok).toBe(true)

    const second = await forwarder.open({
      sessionId: 's-2',
      device: device(),
      devicePort: 3001,
      localPort: first.view.localPort,
      localAddress: '127.0.0.1',
    })
    expect(second.ok).toBe(false)
    expect(second.view.status).toBe('failed')
    expect(second.view.error).toBeTruthy()

    forwarder.stopAll()
  })
})
