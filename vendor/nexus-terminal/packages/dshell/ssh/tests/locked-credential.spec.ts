/**
 * What a locked group costs the rest of the panel — which is nothing.
 *
 * A device references a credential; the credential is sealed inside a group.
 * Reading the secret needs the group's key, but RECORDING the reference does
 * not, and the refresh that ran on every device save used to build every
 * device's connection — decrypting as it went. One locked group therefore
 * failed the whole refresh: every device edit in the panel was refused, and at
 * start-up the router never finished loading at all.
 *
 * The refresh now skips a device it cannot open and remembers why, so the
 * panel keeps working and the seams refuse a bound session with the group's
 * name rather than a dead end.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { DSHELL_HOME_ENV } from '@nexus-aethra/dshell-std'
import { SshRouter } from '../src/router.js'
import { VaultLockedError } from '../src/vault.js'
import type { DshellSshTranslate } from '../src/host-locales.js'

/** A translator that answers with the key; the refusals are not what is under test. */
const translate = ((key: string): string => key) as DshellSshTranslate

let home = ''
let saved: string | undefined

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'dshell-locked-'))
  saved = process.env[DSHELL_HOME_ENV]
  process.env[DSHELL_HOME_ENV] = home
  await mkdir(join(home, 'dshell', 'ssh'), { recursive: true })
})

afterEach(async () => {
  if (saved === undefined) delete process.env[DSHELL_HOME_ENV]
  else process.env[DSHELL_HOME_ENV] = saved
  await rm(home, { recursive: true, force: true })
})

/** A router over the empty fixture, with its one-time load settled. */
async function settled(): Promise<SshRouter> {
  const router = new SshRouter(() => join(home, 'dshell', 'ssh'))
  router.bindCopy(translate)
  await router.list()
  return router
}

/** A sealed group with one password credential, and a device that points at it. */
async function sealedDevice(router: SshRouter, name: string): Promise<{ groupId: string; deviceId: string }> {
  const group = await router.vault.createGroup(name, 'correct horse')
  const credential = await router.credentials.save({
    group: group.id, name: `${name} 的口令`, kind: 'password', secret: 'p@ss',
  })
  const device = await router.saveDevice({
    name, host: '10.0.0.1', port: 22, user: 'root', remoteRoot: '/srv',
    auth: 'password', credentialId: credential.id,
  })
  return { groupId: group.id, deviceId: device.id }
}

describe('a device whose credential sits in a locked group', () => {
  it('is still saved, and does not fail the refresh for anyone else', async () => {
    // The regression: the refresh used to build every device's connection, so
    // this one locked group refused the save of any device at all.
    const router = await settled()
    const { groupId } = await sealedDevice(router, '锁定设备')
    await router.lockGroups(groupId)

    const other = await router.saveDevice({
      name: '另一台', host: '10.0.0.2', port: 22, user: 'root', remoteRoot: '/srv', auth: 'key',
    })
    expect(other.name).toBe('另一台')
    // And a device in a group that is NOT locked still has its connection.
    await router.refreshDevices()
    expect(router.targetForSession('nothing-bound')).toBeUndefined()
  })

  it('names its group in the refusal a bound session gets', async () => {
    const router = await settled()
    const { deviceId, groupId } = await sealedDevice(router, '锁定设备')
    await router.lockGroups(groupId)

    // The seams read the assignment, never the connection, so a session bound
    // to the device is refused rather than run here — and the refusal names the
    // group to unlock, which is what the route turns into the unlock prompt.
    expect(router.unservableMessage(deviceId)).toContain('锁定设备')
    await expect(router.bind('session-1', deviceId)).rejects.toThrow('锁定设备')
    // Carried, not just said: the panel is opened at THAT group, and a refusal
    // without the id would leave the reader hunting for it.
    await router.bind('session-1', deviceId).catch((error: unknown) => {
      expect(error).toBeInstanceOf(VaultLockedError)
      expect((error as VaultLockedError).groupId).toBe(groupId)
    })
    expect(router.targetForSession('session-1')).toBeUndefined()
  })

  it('names its group when the connection test is refused', async () => {
    const router = await settled()
    const { deviceId, groupId } = await sealedDevice(router, '锁定设备')
    await router.lockGroups(groupId)

    // The test is the reader's first question about a device that will not
    // answer, and it used to read the connection map directly: a device they
    // could see in the panel came back "unknown device", a refusal with no
    // group to open and no way out. It goes through the same seam as every
    // other connection now, so the answer is the group to unlock.
    await expect(router.test(deviceId, {} as Context)).rejects.toThrow('锁定设备')
    await router.test(deviceId, {} as Context).catch((error: unknown) => {
      expect(error).toBeInstanceOf(VaultLockedError)
      expect((error as VaultLockedError).groupId).toBe(groupId)
    })
  })

  it('comes back when the group is unlocked', async () => {
    const router = await settled()
    const { deviceId, groupId } = await sealedDevice(router, '锁定设备')
    await router.lockGroups(groupId)
    expect(router.targetForSession('session-1')).toBeUndefined()

    await router.unlockGroup(groupId, 'correct horse')
    await router.bind('session-1', deviceId)
    expect(router.targetForSession('session-1')?.device.name).toBe('锁定设备')
  })
})
