/**
 * The forwarder, end to end, against a REAL ssh2 server.
 *
 * The other specs in this package drive a client that is not ssh2, because the
 * decisions worth pinning there are about SHAPE: what is asked for, what is
 * collected, which connection a device keeps. None of that says whether a
 * tunnel CARRIES anything.
 *
 * This one does: a real SSH handshake, a real channel opened by the device for a
 * forwarded connection, a real socket on this machine, and real bytes over the
 * wire. The server is ssh2's own, so the protocol is the protocol — not a
 * script of what the protocol is supposed to do.
 *
 * The half-close case is the one worth reading. A caller that finishes writing
 * closes its write side, and Node's default server answers that by closing the
 * whole socket — so the device's response, which arrives after the request,
 * has nowhere to go. The tunnel would carry the request and drop the answer,
 * which is a failure that looks like a working tunnel until you read what came
 * back. Both the case and the fix are here, so the fix cannot be undone
 * quietly.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ssh2 from 'ssh2'
import { afterAll, describe, expect, it } from 'vitest'
import type { DeviceConnection } from '../src/devices.js'
import { Forwarder } from '../src/forward/forwarder.js'
import { DeviceTransport } from '../src/transport/transport.js'

const { Server: SshServer } = ssh2

/** A directory the known-hosts file is read from and written to. */
const home = mkdtempSync(join(tmpdir(), 'dshell-forward-e2e-'))
const previousHome = process.env.DSHELL_HOME
process.env.DSHELL_HOME = home
afterAll(() => {
  if (previousHome === undefined) delete process.env.DSHELL_HOME
  else process.env.DSHELL_HOME = previousHome
  rmSync(home, { recursive: true, force: true })
})

/**
 * A real SSH server that carries a forwarded connection to a port.
 *
 * The client asks the device to open a channel to a port; the device opens it
 * and pipes it to the service there. That is the whole of what `ssh -L` does,
 * and it is what the tunnel on the other side has to reach.
 *
 * @returns the server, and the port it listens on.
 */
async function sshServer(): Promise<{ server: SshServer; port: number }> {
  const server = new SshServer({
    hostKeys: [ssh2.utils.generateKeyPairSync('ed25519').private],
  }, (client) => {
    // Accept the client whatever it offers: this server exists to carry a
    // forwarded connection, not to judge a credential.
    client.on('authentication', (ctx) => { ctx.accept() })
    client.on('ready', () => {
      client.on('tcpip', (accept, reject, info) => {
        const channel = accept()
        const upstream = net.connect(info.destPort, info.destIP, () => {
          channel.pipe(upstream)
          upstream.pipe(channel)
        })
        upstream.on('error', () => { channel.destroy(); reject() })
        channel.on('error', () => { upstream.destroy() })
      })
    })
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('the ssh server did not bind a port')
  return { server, port: address.port }
}

/**
 * The service the forward is FOR, on the device's side.
 *
 * @returns the service, and the port it listens on.
 */
async function deviceService(): Promise<{ service: Server; port: number }> {
  const service = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end('hello from the device')
  })
  await new Promise<void>((resolve) => { service.listen(0, '127.0.0.1', resolve) })
  const address = service.address()
  if (address === null || typeof address === 'string') throw new Error('the service did not bind a port')
  return { service, port: address.port }
}

/**
 * Write a request to a port and read the answer, closing the write side.
 *
 * The write side is closed the way a browser closes it after its request, and
 * the read side stays open, because the answer comes after.
 *
 * @param port - the port to talk to.
 * @returns what came back.
 */
function ask(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ port, host: '127.0.0.1' }, () => {
      socket.write('GET /probe HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n')
      socket.end()
    })
    let answer = ''
    socket.on('data', (chunk) => { answer += chunk.toString() })
    socket.on('error', reject)
    socket.on('close', () => { resolve(answer) })
  })
}

/** The device the tunnel reaches. */
function device(port: number): DeviceConnection {
  return {
    id: 'dev',
    name: 'dev',
    host: '127.0.0.1',
    port,
    user: 'ops',
    remoteRoot: '~',
    auth: 'password',
    secret: { open: async () => 'secret' },
  }
}

describe('the forwarder, against a real ssh server', () => {
  it('carries a request to the device and brings the answer back', async () => {
    const ssh = await sshServer()
    const deviceSide = await deviceService()
    const forwarder = new Forwarder(new DeviceTransport())

    try {
      const outcome = await forwarder.open({
        sessionId: 's-1',
        device: device(ssh.port),
        devicePort: deviceSide.port,
        localPort: 0,
        localAddress: '127.0.0.1',
      })

      expect(outcome.ok).toBe(true)
      expect(outcome.view.status).toBe('running')

      // The answer has to ARRIVE, not just start arriving: the request is
      // half-closed before the device has answered, and a tunnel that closes
      // with it drops the answer.
      const answer = await ask(outcome.view.localPort)

      expect(answer).toContain('200 OK')
      expect(answer).toContain('hello from the device')
    } finally {
      forwarder.stopAll()
      deviceSide.service.close()
      ssh.server.close()
    }
  })

  it('carries a request whose body was sent, which is what a browser does', async () => {
    // The same tunnel, asked the way an HTTP client asks: the request is
    // written and the write side closed. Node's default server answers that
    // by closing the whole socket, and the answer has nowhere to go.
    const ssh = await sshServer()
    const deviceSide = await deviceService()
    const forwarder = new Forwarder(new DeviceTransport())

    try {
      const outcome = await forwarder.open({
        sessionId: 's-1',
        device: device(ssh.port),
        devicePort: deviceSide.port,
        localPort: 0,
        localAddress: '127.0.0.1',
      })
      expect(outcome.ok).toBe(true)

      const answer = await ask(outcome.view.localPort)

      expect(answer).toContain('hello from the device')
    } finally {
      forwarder.stopAll()
      deviceSide.service.close()
      ssh.server.close()
    }
  })
})
