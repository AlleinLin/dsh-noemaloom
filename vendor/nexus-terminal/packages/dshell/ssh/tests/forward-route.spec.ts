/**
 * The forward route, driven by a forwarder that opens nothing.
 *
 * What is worth pinning here is the ROUTING: that a request names a session and
 * the session decides the device, that a session on this machine is told so
 * rather than guessed at, and that the answer carries every forward the reader
 * may see.
 */

import { describe, expect, it } from 'vitest'
import type { DeviceConnection } from '../src/devices.js'
import { createForwardRoute, type ForwardSeat } from '../src/forward/route.js'
import type { DshellForwardView } from '@nexus-aethra/dshell-std'

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

/** A forward, as the route would report one. */
function view(over: Partial<DshellForwardView> = {}): DshellForwardView {
  return {
    sessionId: 's-1',
    deviceId: 'web',
    deviceName: 'web-server',
    devicePort: 3000,
    localPort: 8080,
    localAddress: '127.0.0.1',
    status: 'running',
    error: undefined,
    ...over,
  }
}

/** A forwarder that records what it was asked. */
class FakeSeat implements ForwardSeat {
  readonly opened: unknown[] = []
  readonly stopped: { sessionId: string; localPort: number }[] = []
  forwards: DshellForwardView[] = []

  list(): readonly DshellForwardView[] {
    return this.forwards
  }

  listSession(sessionId: string): readonly DshellForwardView[] {
    return this.forwards.filter(forward => forward.sessionId === sessionId)
  }

  async open(request: {
    readonly sessionId: string
    readonly device: DeviceConnection
    readonly devicePort: number
    readonly localPort: number
    readonly localAddress: string
  }): Promise<{ readonly view: DshellForwardView; readonly ok: boolean }> {
    this.opened.push(request)
    const opened = view({
      sessionId: request.sessionId,
      deviceId: request.device.id,
      deviceName: request.device.name,
      devicePort: request.devicePort,
      localPort: request.localPort === 0 ? 8080 : request.localPort,
    })
    this.forwards = [...this.forwards, opened]
    return { view: opened, ok: true }
  }

  stop(sessionId: string, localPort: number): boolean {
    this.stopped.push({ sessionId, localPort })
    const before = this.forwards.length
    this.forwards = this.forwards.filter(forward => !(forward.sessionId === sessionId && forward.localPort === localPort))
    return this.forwards.length !== before
  }
}

/** A router that says one session is on a device and another is not. */
function routerWith(device: DeviceConnection | undefined) {
  return {
    targetForSession: (sessionId: string) =>
      device === undefined || sessionId !== 's-device'
        ? undefined
        : { device, remoteRoot: '/root', mount: undefined },
  } as never
}

describe('the forward route', () => {
  it('lists every forward when it is asked for none in particular', async () => {
    const seat = new FakeSeat()
    seat.forwards = [view({ sessionId: 's-1' }), view({ sessionId: 's-2' })]
    const route = createForwardRoute({ forwarder: seat, router: routerWith(device()) })

    const response = await route.fetch(new Request('http://host/api/dshell/ssh/forward'))
    const body = await response.json() as { forwards: DshellForwardView[] }

    expect(body.forwards).toHaveLength(2)
  })

  it('opens a forward for the device the session is on', async () => {
    const seat = new FakeSeat()
    const route = createForwardRoute({ forwarder: seat, router: routerWith(device()) })

    const response = await route.fetch(new Request('http://host/api/dshell/ssh/forward', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'open', sessionId: 's-device', devicePort: 3000 }),
    }))
    const body = await response.json() as { forwards: DshellForwardView[]; forward?: DshellForwardView }

    expect(body.forward?.devicePort).toBe(3000)
    expect(body.forward?.status).toBe('running')
    // The DEVICE comes from the session, never from the request: a request
    // that could name a device would be a request that could reach one the
    // reader has no session for.
    const asked = seat.opened[0] as { device: DeviceConnection }
    expect(asked.device.id).toBe('web')
  })

  it('says so when the session does not run on a device', async () => {
    const seat = new FakeSeat()
    const route = createForwardRoute({ forwarder: seat, router: routerWith(undefined) })

    const response = await route.fetch(new Request('http://host/api/dshell/ssh/forward', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'open', sessionId: 's-local', devicePort: 3000 }),
    }))
    const body = await response.json() as { error?: string }

    expect(body.error).toBeTruthy()
    expect(seat.opened).toHaveLength(0)
  })

  it('stops a forward by its local port', async () => {
    const seat = new FakeSeat()
    seat.forwards = [view()]
    const route = createForwardRoute({ forwarder: seat, router: routerWith(device()) })

    const response = await route.fetch(new Request('http://host/api/dshell/ssh/forward', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'stop', sessionId: 's-1', localPort: 8080 }),
    }))
    const body = await response.json() as { forwards: DshellForwardView[] }

    expect(seat.stopped).toEqual([{ sessionId: 's-1', localPort: 8080 }])
    expect(body.forwards).toHaveLength(0)
  })

  it('says so when there is no such forward to stop', async () => {
    const seat = new FakeSeat()
    const route = createForwardRoute({ forwarder: seat, router: routerWith(device()) })

    const response = await route.fetch(new Request('http://host/api/dshell/ssh/forward', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'stop', sessionId: 's-1', localPort: 9999 }),
    }))
    const body = await response.json() as { error?: string }

    expect(body.error).toBe('no such forward')
  })
})
