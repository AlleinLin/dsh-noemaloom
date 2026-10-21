/**
 * What a stored secret becomes on the wire, and what it never becomes.
 *
 * The old `ssh` path answered these questions with argv options — `BatchMode`,
 * `IdentitiesOnly`, an askpass hook pointed at one file — and the mistake each
 * guarded against was quiet in both directions: an encrypted key that could not
 * be asked for failed with no explanation, and a device that reached for an
 * ambient identity connected as someone else. The transport answers the same
 * questions structurally, so these pin the same decisions one layer down.
 */

import { describe, expect, it } from 'vitest'
import { connectConfig } from '../src/transport/auth.js'
import { DeviceSshError } from '../src/transport/errors.js'
import type { DeviceConnection } from '../src/devices.js'

/**
 * One stored secret, as the store keeps it.
 *
 * Every writer in this package ends a secret with exactly one newline. The
 * transport strips it from a password and from a passphrase, and keeps it on a
 * key — where it is part of the PEM encoding.
 */
function stored(body: string): string {
  return body.endsWith('\n') ? body : `${body}\n`
}

const KEY_BODY = '-----BEGIN OPENSSH PRIVATE KEY-----\nbody\n-----END OPENSSH PRIVATE KEY-----\n'
const keyBody = stored(KEY_BODY)
const passphraseBody = stored('correct horse battery staple')
const passwordBody = stored('not a real password')

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

/**
 * A device holding one secret, and optionally the passphrase beside it.
 *
 * The secret is handed over as a resolver, the way the device store hands it
 * over: opened when the connection is made, not remembered from an earlier read
 * — because a secret sealed in the vault is opened through its group, and a group
 * that is locked refuses to open it.
 */
function holding(secret: string | undefined, passphrase?: string): DeviceConnection {
  return device({
    secret: {
      open: async () => secret,
      ...(passphrase === undefined ? {} : { passphrase: async () => passphrase }),
    },
  })
}

describe('a key device', () => {
  it('offers exactly its own key, and nothing else', async () => {
    const config = await connectConfig(holding(keyBody))
    expect(config.privateKey).toBe(KEY_BODY)
    // No agent is ever configured, so an ambient identity cannot be reached by
    // accident — the same guarantee `IdentitiesOnly=yes` used to give.
    expect(config.agent).toBeUndefined()
    expect(config.password).toBeUndefined()
    expect(config.passphrase).toBeUndefined()
  })

  it('carries the passphrase with the key it unlocks', async () => {
    const config = await connectConfig(holding(keyBody, passphraseBody))
    expect(config.privateKey).toBe(KEY_BODY)
    // The stored secret ends with the newline its writer appended, and a
    // passphrase that carries it is a key that will not decrypt.
    expect(config.passphrase).toBe('correct horse battery staple')
  })

  it('never sends a passphrase where there is no key to unlock', async () => {
    const config = await connectConfig(holding(undefined, passphraseBody))
    expect(config.privateKey).toBeUndefined()
    expect(config.passphrase).toBeUndefined()
  })
})

describe('a password device', () => {
  it('sends the password and never a key', async () => {
    const config = await connectConfig(device({
      auth: 'password', secret: { open: async () => passwordBody },
    }))
    expect(config.password).toBe('not a real password')
    expect(config.privateKey).toBeUndefined()
  })

  it('ignores a passphrase recorded beside the password', async () => {
    // A stray passphrase must not become the password: the two answer different
    // prompts, and only one of them is asked for here.
    const config = await connectConfig(device({
      auth: 'password',
      secret: { open: async () => passwordBody, passphrase: async () => passphraseBody },
    }))
    expect(config.password).toBe('not a real password')
    expect(config.passphrase).toBeUndefined()
  })
})

describe('a device with no stored secret', () => {
  it('offers nothing at all', async () => {
    // Refusing loudly is the honest outcome: the alternative — reaching for an
    // ambient identity — would connect as whoever the host happens to be.
    const config = await connectConfig(device())
    expect(config.password).toBeUndefined()
    expect(config.privateKey).toBeUndefined()
    expect(config.passphrase).toBeUndefined()
  })
})

describe('a credential that cannot be opened', () => {
  it('fails the connection rather than connecting with no identity', async () => {
    // The device store refuses here — a secret that is not on disk any more is
    // a credential problem, and the refusal says so without naming the path.
    // The transport has to pass that refusal on: falling through to a config
    // with no password would reach for an ambient identity, which is the one
    // thing this module is built to refuse.
    const error = await connectConfig(device({
      auth: 'password',
      secret: {
        open: async () => {
          throw new DeviceSshError('auth', 'the credential for this device could not be read; re-enter the secret for this device')
        },
      },
    })).catch((raised: unknown) => raised)
    expect(error).toBeInstanceOf(DeviceSshError)
    expect((error as Error).message).toContain('credential for this device could not be read')
  })
})

describe('every device', () => {
  it('keeps a dead link observable', async () => {
    // The old `ServerAliveInterval=15, CountMax=3` and `ConnectTimeout=10`, so a
    // half-open connection is noticed rather than waited on forever.
    const config = await connectConfig(device())
    expect(config.keepaliveInterval).toBe(15_000)
    expect(config.keepaliveCountMax).toBe(3)
    expect(config.readyTimeout).toBe(10_000)
    expect(config.host).toBe('example.test')
    expect(config.port).toBe(22)
    expect(config.username).toBe('ops')
  })
})
