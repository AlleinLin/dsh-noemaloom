/**
 * The transport, driven by a client that is not ssh2.
 *
 * Everything here runs against a fake connection, because the decisions worth
 * pinning are about SHAPE rather than about bytes on a wire: what a command is
 * handed, what is collected, when a run is terminated, which connection a device
 * keeps, and what a host key means. A real server would answer all of those and
 * none of the wrong ones — the acceptance container is where that is proven.
 */

import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Duplex, PassThrough } from 'node:stream'
import type { ClientChannel, ConnectConfig, ExecOptions } from 'ssh2'
import { afterAll, describe, expect, it } from 'vitest'
import type { DeviceConnection } from '../src/devices.js'
import { readKnownHosts, recordHostKey } from '../src/transport/known-hosts.js'
import { DeviceTransport, type SshClient } from '../src/transport/transport.js'

/** A directory the host-key file is read from and written to. */
const home = mkdtempSync(join(tmpdir(), 'dshell-transport-'))
const previousHome = process.env.DSHELL_HOME
process.env.DSHELL_HOME = home
afterAll(() => {
  if (previousHome === undefined) delete process.env.DSHELL_HOME
  else process.env.DSHELL_HOME = previousHome
  rmSync(home, { recursive: true, force: true })
})

function device(over: Partial<DeviceConnection> = {}): DeviceConnection {
  return {
    id: 'web',
    name: 'web',
    host: 'example.test',
    port: 22,
    user: 'ops',
    remoteRoot: '~',
    auth: 'key',
    secret: undefined,
    ...over,
  }
}

/** A device holding one secret, opened the way the store opens it. */
function holding(secret: string): DeviceConnection {
  return device({ secret: { open: async () => secret } })
}

/** An ed25519 public key blob, as the handshake hands one over. */
const ED25519 = Buffer.concat([
  Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'),
  Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 7),
])

/**
 * One fake channel: a duplex whose two directions are independent, the way a
 * real SSH channel's are.
 *
 * `end()` closes the WRITABLE half only — a command whose stdin reached EOF can
 * still be producing output — and nothing here destroys itself, because a
 * channel that closed is an outcome and a half-closed one is not.
 */
class FakeChannel extends Duplex {
  readonly stderr = new PassThrough({ autoDestroy: false })
  readonly signals: string[] = []
  /** Everything written to this channel's stdin, in order. */
  readonly written: Buffer[] = []
  closed = false

  constructor() {
    super({ autoDestroy: false, read: () => undefined, write: (chunk, _enc, done) => {
      this.written.push(chunk)
      done()
    } })
  }

  signal(name: string): void {
    this.signals.push(name)
  }

  close(): void {
    this.closed = true
    this.emit('close')
  }

  /** What the device sends on this channel's stdout. */
  output(text: string): void {
    this.push(Buffer.from(text))
  }

  /** End the command the way a device would. */
  finish(code: number | null, signal?: string): void {
    this.emit('exit', code, signal)
    this.close()
  }
}

/** How ssh2 spells the verifier a connection is configured with. */
type HostVerifier = (key: Buffer, verify: (success: boolean) => void) => void

/**
 * A fake ssh2 client.
 *
 * It models the one thing the transport's correctness depends on: the host key
 * is decided DURING the handshake, before `ready`, and a refusal arrives as an
 * `error` rather than as a channel that never opens. A key set on `offered` is
 * presented during `connect`, exactly as a device would present one.
 */
class FakeClient extends EventEmitter implements SshClient {
  readonly execs: { command: string; options: ExecOptions }[] = []
  readonly channels: FakeChannel[] = []
  config: ConnectConfig | undefined
  ended = false
  /** The key this client presents during its handshake, when it presents one. */
  offered: Buffer | undefined
  /**
   * Whether a connection with no key to present becomes ready on its own.
   *
   * Off for the cases that answer the host key by hand: a real client is not
   * ready until that answer is in, so a fake that pretended otherwise would let
   * a command reach a device whose key was just refused.
   */
  autoReady = true
  /** Set to make the next exec fail, as a connection that died would. */
  failNextExec: Error | undefined
  private verifier: HostVerifier | undefined

  connect(config: ConnectConfig): void {
    this.config = config
    this.verifier = config.hostVerifier as HostVerifier | undefined
    const offered = this.offered
    if (offered === undefined) {
      if (this.autoReady) queueMicrotask(() => { this.emit('ready') })
      return
    }
    queueMicrotask(() => {
      this.verifier?.(offered, (success: boolean) => { this.verdict(success) })
    })
  }

  /** Answer the host key by hand, the way ssh2 would. */
  answerHostKey(key: Buffer): boolean {
    let allowed: boolean | undefined
    this.verifier?.(key, (success: boolean) => {
      allowed = success
      this.verdict(success)
    })
    return allowed ?? false
  }

  /** What a host key verdict does to the connection. */
  private verdict(success: boolean): void {
    if (success) {
      this.emit('ready')
      return
    }
    this.emit('error', Object.assign(new Error('Host verification failed'), {
      level: 'client-authentication',
    }))
  }

  exec(command: string, options: ExecOptions, callback: (error: Error | undefined, channel: ClientChannel) => void): void {
    this.execs.push({ command, options })
    const failure = this.failNextExec
    this.failNextExec = undefined
    const channel = new FakeChannel()
    queueMicrotask(() => {
      if (failure !== undefined) {
        callback(failure, undefined as unknown as ClientChannel)
        return
      }
      this.channels.push(channel)
      callback(undefined, channel as unknown as ClientChannel)
    })
  }

  end(): void {
    this.ended = true
  }
}

/**
 * The channel a fake client has opened, once the run has adopted it.
 *
 * Two waits, not one. The channel appearing is not enough: the transport
 * subscribes to its outcome in a later microtask, and a `finish` that lands
 * before that subscription is an event nobody heard — the run would never
 * settle. So this also waits for the outcome listener, which is the moment the
 * channel is genuinely the test's to drive.
 *
 * And the wait is against a WALL-CLOCK deadline rather than a count of
 * event-loop turns, because dialing reads the credential off disk: how many
 * turns that takes is a fact about how loaded the machine is, and a turn count
 * that is generous on an idle box starves on a busy one.
 */
async function channelOf(client: FakeClient, at = 0): Promise<FakeChannel> {
  const deadline = Date.now() + 10_000
  for (;;) {
    const channel = client.channels[at]
    if (channel !== undefined && channel.listenerCount('exit') > 0) return channel
    if (Date.now() >= deadline) throw new Error('the fake client never opened a channel')
    await new Promise(resolve => setTimeout(resolve, 2))
  }
}

/** One turn of the event loop, for a config or a handshake to land. */
async function tick(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve))
}

/** A factory handing out the clients a test wants, in order. */
function factory(...clients: FakeClient[]): () => SshClient {
  const handed: FakeClient[] = []
  return () => {
    const client = clients[handed.length] ?? new FakeClient()
    handed.push(client)
    return client
  }
}

/** One stored secret, as the device store writes it. */
function stored(body: string): string {
  return `${body}\n`
}

describe('running one command', () => {
  it('collects both streams and the exit status', async () => {
    const client = new FakeClient()
    const transport = new DeviceTransport(factory(client))
    const running = transport.exec(device(), 'echo hi')
    const channel = await channelOf(client)
    channel.output('out')
    channel.stderr.write('err')
    channel.finish(0)
    expect(await running).toMatchObject({ stdout: 'out', stderr: 'err', exitCode: 0, signal: null })
  })

  it('passes the command through as one remote line', async () => {
    const client = new FakeClient()
    const transport = new DeviceTransport(factory(client))
    const running = transport.exec(device(), 'LC_ALL=C stat -c %s -- /tmp/x')
    const channel = await channelOf(client)
    expect(client.execs[0]?.command).toBe('LC_ALL=C stat -c %s -- /tmp/x')
    channel.finish(0)
    expect(await running).toMatchObject({ exitCode: 0 })
  })

  it('feeds stdin and closes it', async () => {
    const client = new FakeClient()
    const transport = new DeviceTransport(factory(client))
    const running = transport.exec(device(), 'sh -c cat', { stdin: 'payload' })
    const channel = await channelOf(client)
    await tick()
    expect(Buffer.concat(channel.written).toString()).toBe('payload')
    expect(channel.writableEnded).toBe(true)
    channel.finish(0)
    await running
  })

  it('leaves stdin open when the caller asked for a pipe', async () => {
    const client = new FakeClient()
    const transport = new DeviceTransport(factory(client))
    const run = await transport.open(device(), 'cat', { openStdin: true })
    const channel = await channelOf(client)
    expect(channel.closed).toBe(false)
    run.terminate()
    expect(channel.closed).toBe(true)
  })

  it('closes stdin for a command that asked for no input', async () => {
    // The remote side must see EOF rather than a pipe nobody writes to, or a
    // program that reads stdin waits for the grace period instead of ending.
    const client = new FakeClient()
    const transport = new DeviceTransport(factory(client))
    await transport.open(device(), 'stat')
    expect((await channelOf(client)).writableEnded).toBe(true)
  })

  it('reports a signal exit as a signal', async () => {
    const client = new FakeClient()
    const transport = new DeviceTransport(factory(client))
    const running = transport.exec(device(), 'sleep 1')
    ;(await channelOf(client)).finish(null, 'SIGTERM')
    expect(await running).toMatchObject({ exitCode: null, signal: 'SIGTERM' })
  })
})

describe('a bounded run', () => {
  it('terminates a command that outruns its grace period', async () => {
    const client = new FakeClient()
    const transport = new DeviceTransport(factory(client))
    const running = transport.exec(device(), 'sleep 100', { graceMs: 5 })
    const channel = await channelOf(client)
    // What we caused is what is reported: the race with the channel's own close
    // must not turn a run we stopped into an outcome nobody knows.
    expect(await running).toMatchObject({ exitCode: null, signal: 'SIGTERM' })
    expect(channel.signals).toContain('SIGTERM')
    expect(channel.closed).toBe(true)
  })

  it('terminates a command whose signal aborted', async () => {
    const client = new FakeClient()
    const transport = new DeviceTransport(factory(client))
    const controller = new AbortController()
    const running = transport.exec(device(), 'sleep 100', { signal: controller.signal })
    await channelOf(client)
    controller.abort()
    expect(await running).toMatchObject({ exitCode: null, signal: 'SIGTERM' })
  })
})

describe('the connection a device keeps', () => {
  it('reuses one client for the commands that follow', async () => {
    const client = new FakeClient()
    const transport = new DeviceTransport(factory(client))
    const first = transport.exec(device(), 'one')
    ;(await channelOf(client)).finish(0)
    await first
    const second = transport.exec(device(), 'two')
    ;(await channelOf(client, 1)).finish(0)
    await second
    expect(client.execs.map(entry => entry.command)).toEqual(['one', 'two'])
  })

  it('re-dials when the pooled connection has died', async () => {
    const dead = new FakeClient()
    dead.failNextExec = Object.assign(new Error('Not connected'), { level: 'client-ssh' })
    const live = new FakeClient()
    const transport = new DeviceTransport(factory(dead, live))
    const running = transport.exec(device(), 'one')
    ;(await channelOf(live)).finish(0)
    expect(await running).toMatchObject({ exitCode: 0 })
    // The dead one was asked for a command and the live one answered it.
    expect(dead.execs).toHaveLength(1)
    expect(live.execs).toHaveLength(1)
  })

  it('re-dials when the credential changed', async () => {
    // A rotated secret keeps its place, so the connection has to be fingerprinted
    // by the secret itself or it would keep answering as the old identity.
    const first = new FakeClient()
    const second = new FakeClient()
    const clients = [first, second]
    const transport = new DeviceTransport(() => clients.shift() ?? new FakeClient())
    const one = transport.exec(holding(stored('one')), 'one')
    ;(await channelOf(first)).finish(0)
    await one
    const two = transport.exec(holding(stored('two')), 'two')
    ;(await channelOf(second)).finish(0)
    await two
    // The newline its writer appended travels with the key: it is part of the
    // PEM encoding, so it is stripped from a password and never from a key.
    expect(first.config?.privateKey).toBe('one\n')
    expect(second.config?.privateKey).toBe('two\n')
  })

  it('ends the connection a release asks for', async () => {
    const client = new FakeClient()
    const transport = new DeviceTransport(factory(client))
    const running = transport.exec(device(), 'one')
    ;(await channelOf(client)).finish(0)
    await running
    transport.release('web')
    expect(client.ended).toBe(true)
  })
})

describe('a channel the far side tears down', () => {
  it('runs the command once more, on the same connection', async () => {
    // A channel can be torn down on its own, and the connection is usually
    // fine. Ending the connection to retry one command would kill every other
    // operation running on it — which is how one lost channel became several
    // failed reads and a dead turn.
    const client = new FakeClient()
    const transport = new DeviceTransport(factory(client))

    const running = transport.exec(device(), 'ls')
    // The far side drops the channel: it closes, and no exit status comes with it.
    ;(await channelOf(client)).close()
    ;(await channelOf(client, 1)).finish(0)

    const result = await running
    expect(result.exitCode).toBe(0)
    // The command ran again — on the same connection, over a new channel.
    expect(client.execs.map(entry => entry.command)).toEqual(['ls', 'ls'])
    // And the connection was left alone: whatever else was running on it is
    // still running.
    expect(client.ended).toBe(false)
  })

  it('reports the loss as a loss, not as a signal that never arrived', async () => {
    const client = new FakeClient()
    const transport = new DeviceTransport(factory(client))

    const running = transport.exec(device(), 'ls')
    ;(await channelOf(client)).close()
    // The retry is dropped too: now the loss is what the caller is told.
    ;(await channelOf(client, 1)).close()

    const result = await running
    expect(result.exitCode).toBeNull()
    expect(result.signal).toBeNull()
    expect(result.connectionLost).toBe(true)
  })

  it('reports a run we stopped as a signal, not as a lost connection', async () => {
    // The two are different facts: we sent SIGTERM, so the signal is what
    // happened. Calling it a lost connection would send the reader looking for
    // a network fault that is not there.
    const client = new FakeClient()
    const transport = new DeviceTransport(factory(client))
    const controller = new AbortController()
    const running = transport.exec(device(), 'sleep 100', { signal: controller.signal })
    const channel = await channelOf(client)
    controller.abort()

    const result = await running
    expect(result.exitCode).toBeNull()
    expect(result.signal).toBe('SIGTERM')
    expect(result.connectionLost).toBeFalsy()
  })
})

describe('readers that arrive together', () => {
  it('share one connection, not one each', async () => {
    // The prompt assembly reads several files at once, and every one of those
    // reads is a device operation. Without one shared dial, each of them found
    // the pool empty, dialled its own connection, and left every connection but
    // the last one orphaned — six connections for one turn, and a pool holding
    // one that nobody was using.
    const client = new FakeClient()
    let dialled = 0
    const transport = new DeviceTransport(() => { dialled += 1; return client })

    const running = [
      transport.exec(device(), 'a'),
      transport.exec(device(), 'b'),
      transport.exec(device(), 'c'),
    ]
    for (const index of [0, 1, 2]) (await channelOf(client, index)).finish(0)
    const results = await Promise.all(running)

    expect(results.map(result => result.exitCode)).toEqual([0, 0, 0])
    // Three commands, one connection.
    expect(client.execs.map(entry => entry.command)).toEqual(['a', 'b', 'c'])
    expect(dialled).toBe(1)
  })
})

describe('the host key', () => {
  it('records an unknown key and connects', async () => {
    const client = new FakeClient()
    client.autoReady = false
    const transport = new DeviceTransport(factory(client))
    const running = transport.exec(device(), 'one')
    await tick()
    // The verifier runs during the handshake, before anything is authenticated.
    expect(client.answerHostKey(ED25519)).toBe(true)
    ;(await channelOf(client)).finish(0)
    await running
    expect(readKnownHosts(join(home, 'dshell', 'ssh', 'known_hosts'))).toHaveLength(1)
  })

  it('refuses a changed key before anything is sent', async () => {
    // A destination of its own: the file is shared by every case in this suite,
    // and a key recorded for `example.test` by another one is not a change.
    recordHostKey(join(home, 'dshell', 'ssh', 'known_hosts'), 'rotated.test', 22, Buffer.concat([
      Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'),
      Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 1),
    ]))
    const client = new FakeClient()
    client.autoReady = false
    const transport = new DeviceTransport(factory(client))
    const running = transport.exec(device({ host: 'rotated.test' }), 'one')
    await tick()
    expect(client.answerHostKey(ED25519)).toBe(false)
    await expect(running).rejects.toThrow(/changed/)
    // No command was ever sent to a device we refused.
    expect(client.execs).toHaveLength(0)
  })
})

describe('probing a host key', () => {
  it('takes the key the device offers and authenticates nothing', async () => {
    const client = new FakeClient()
    client.offered = ED25519
    const transport = new DeviceTransport(factory(client))
    const probed = await transport.probeHostKey(device())
    expect(probed?.keyType).toBe('ssh-ed25519')
    expect(probed?.fingerprint).toMatch(/^SHA256:/u)
    expect(client.config?.privateKey).toBeUndefined()
    expect(client.config?.password).toBeUndefined()
  })
})
