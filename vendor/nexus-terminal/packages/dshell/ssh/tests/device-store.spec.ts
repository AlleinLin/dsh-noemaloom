/**
 * The device registry's helper-status durability: old documents still load,
 * successful installs survive a restart, and a connection edit retires the
 * stale status so a later check starts from `absent` again.
 */

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { DeviceStore } from '../src/devices.js'
import { CredentialStore } from '../src/credentials.js'
import { SecretVault } from '../src/vault.js'

const translate = (key: string) => key

describe('DeviceStore helper status', () => {
  it('reads legacy documents that do not carry helper status', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshell-devices-'))
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'devices.json'), JSON.stringify({
      devices: [
        { id: 'legacy', host: '10.0.0.1', user: 'root', name: '', port: 22, remoteRoot: '~', auth: 'key' },
      ],
    }, null, 2), 'utf8')
    const store = new DeviceStore(() => root)
    const devices = await store.list()
    expect(devices).toHaveLength(1)
    expect(devices[0].helper).toBeUndefined()
  })

  it('round-trips a verified helper status and keeps it across reloads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshell-devices-'))
    await mkdir(root, { recursive: true })
    const store = new DeviceStore(() => root)
    const saved = await store.save({
      name: 'device-1', host: '10.0.0.2', port: 22, user: 'pi', remoteRoot: '~/app', auth: 'key',
    }, translate)
    expect(saved.helper).toBeUndefined()

    // Simulate the install/verification path persisting a status.
    const status = {
      state: 'present' as const,
      onDevice: 'abcd',
      expected: 'abcd',
      path: '/home/pi/.dshell/helper/helper-abcd.mjs',
      message: 'verified',
    }
    await writeFile(join(root, 'devices.json'), JSON.stringify({
      devices: [
        { ...saved, helper: status },
      ],
    }, null, 2), 'utf8')

    const reloaded = new DeviceStore(() => root)
    const devices = await reloaded.list()
    expect(devices).toHaveLength(1)
    expect(devices[0].helper).toEqual(status)
  })

  it('retires helper status when the connection string changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshell-devices-'))
    await mkdir(root, { recursive: true })
    const store = new DeviceStore(() => root)
    const saved = await store.save({
      name: 'device-1', host: '10.0.0.2', port: 22, user: 'pi', remoteRoot: '~/app', auth: 'key',
    }, translate)
    await writeFile(join(root, 'devices.json'), JSON.stringify({
      devices: [
        {
          ...saved,
          helper: {
            state: 'present',
            onDevice: 'abcd',
            expected: 'abcd',
            path: '/home/pi/.dshell/helper/helper-abcd.mjs',
            message: 'verified',
          },
        },
      ],
    }, null, 2), 'utf8')

    await store.save({
      id: saved.id,
      name: 'device-1',
      host: '10.0.0.3',
      port: 2222,
      user: 'pi',
      remoteRoot: '~/app',
      auth: 'key',
    }, translate)

    const refreshed = new DeviceStore(() => root)
    const devices = await refreshed.list()
    expect(devices).toHaveLength(1)
    expect(devices[0].helper).toBeUndefined()
  })
})

describe('DeviceStore credential references', () => {
  /** A store whose vault holds one plain group with one password credential. */
  async function storeWithCredential(): Promise<{ store: DeviceStore; credentialId: string }> {
    const root = await mkdtemp(join(tmpdir(), 'dshell-devices-'))
    await mkdir(root, { recursive: true })
    const vault = new SecretVault(() => root)
    const credentials = new CredentialStore(() => root, vault)
    const group = await vault.createGroup('plain', null)
    const credential = await credentials.save({
      group: group.id, name: 'pw', kind: 'password', secret: 'hunter2',
    })
    return { store: new DeviceStore(() => root, credentials), credentialId: credential.id }
  }

  const base = { name: 'device-1', host: '10.0.0.9', port: 22, user: 'root', remoteRoot: '~' } as const

  it('reads an empty credential reference as no credential', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshell-devices-'))
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'devices.json'), JSON.stringify({
      devices: [
        { id: 'cleared', host: '10.0.0.1', user: 'root', name: '', port: 22, remoteRoot: '~', auth: 'key', credentialId: '' },
      ],
    }, null, 2), 'utf8')
    const store = new DeviceStore(() => root, new CredentialStore(() => root, new SecretVault(() => root)))
    const devices = await store.list()
    expect(devices[0].credentialId).toBeUndefined()
    expect(devices[0].hasSecret).toBe(false)
  })

  it('stores no reference when the form clears one, and derives the login method when it sets one', async () => {
    const { store, credentialId } = await storeWithCredential()

    const cleared = await store.save({ ...base, auth: 'key', credentialId: '' }, translate)
    expect(cleared.credentialId).toBeUndefined()
    expect(cleared.hasSecret).toBe(false)

    const attached = await store.save({ ...base, credentialId }, translate)
    expect(attached.credentialId).toBe(credentialId)
    expect(attached.hasSecret).toBe(true)
    // The credential is a password, so the device logs in by password even
    // though the submitted auth said key.
    expect(attached.auth).toBe('password')

    const back = await store.save({ ...base, credentialId: '' }, translate)
    expect(back.credentialId).toBeUndefined()
    expect(back.hasSecret).toBe(false)
  })
})
