/**
 * A credential that exists only in memory.
 *
 * The vault used to unseal a secret into a file under `run/`, because the
 * external `ssh` could only be handed a path to read. The transport is a
 * library now, so it is handed the bytes — and a sealed group's plaintext is
 * never written down at all.
 *
 * Two things are pinned here. The first is the promise itself: the plaintext
 * exists in no file, and an installation upgraded from the old design has its
 * leftover directory swept at start-up. The second is the invariant the
 * materialization gave for free: a group that is locked must take the plaintext
 * away from a connection that had already resolved it, because a reader who
 * locks a group is saying "this is not in use any more".
 */

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DSHELL_HOME_ENV } from '@nexus-aethra/dshell-std'
import { SshRouter } from '../src/router.js'
import { connectConfig } from '../src/transport/auth.js'
import { classifyDeviceError } from '../src/transport/errors.js'
import { VaultLockedError } from '../src/vault.js'
import type { DshellSshTranslate } from '../src/host-locales.js'

/** A translator that answers with the key; the refusals are not what is under test. */
const translate = ((key: string): string => key) as DshellSshTranslate

/** A secret long enough that finding it in a file would not be a coincidence. */
const SECRET = 'sup3r-secret-p4ss'

let home = ''
let saved: string | undefined

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'dshell-credential-secret-'))
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
async function sealedDevice(
  router: SshRouter,
  name: string,
): Promise<{ groupId: string; deviceId: string; credentialId: string }> {
  const group = await router.vault.createGroup(name, 'correct horse')
  const credential = await router.credentials.save({
    group: group.id, name: `${name} 的口令`, kind: 'password', secret: SECRET,
  })
  const device = await router.saveDevice({
    name, host: '10.0.0.1', port: 22, user: 'root', remoteRoot: '/srv',
    auth: 'password', credentialId: credential.id,
  })
  return { groupId: group.id, deviceId: device.id, credentialId: credential.id }
}

/** The directory the whole SSH feature keeps its state in. */
function sshRoot(): string {
  return join(home, 'dshell', 'ssh')
}

describe('a sealed credential', () => {
  it('is opened as bytes and written to no file', async () => {
    const router = await settled()
    const { credentialId } = await sealedDevice(router, '测试机')

    // Opening it produces the plaintext, and the plaintext comes back as
    // bytes: there is no file for it to live in.
    expect(await router.credentials.open(credentialId, 'secret')).toBe(`${SECRET}\n`)

    // And now the promise itself: not one file under the data root holds it.
    const root = sshRoot()
    const files = await readdir(root, { recursive: true })
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const body = await readFile(join(root, file as string), 'utf8').catch(() => '')
      expect(body).not.toContain(SECRET)
    }
  })

  it('leaves no run/ directory behind', async () => {
    const router = await settled()
    await sealedDevice(router, '测试机')
    expect(await readdir(sshRoot())).not.toContain('run')
  })

  it('sweeps the run/ directory an older installation left behind', async () => {
    // The upgrade path: the old design kept the plaintext there, and nothing
    // writes there any more, so the directory is pure leftover. A host killed
    // rather than stopped may have left a sealed group's secret in it.
    await mkdir(join(sshRoot(), 'run'), { recursive: true })
    await writeFile(join(sshRoot(), 'run', 'device-secret'), `${SECRET}\n`, { mode: 0o600 })

    const router = await settled()
    expect(await readdir(sshRoot())).not.toContain('run')
  })
})

describe('a group that is locked', () => {
  it('takes the plaintext away from a connection that had already resolved it', async () => {
    // The invariant the materialization gave for free: the plaintext lived in a
    // file the lock swept, so a connection holding the path could not use it
    // any more. With the plaintext in memory the lock has to take it away by
    // refusing the read — and it does, because every read goes through the
    // group.
    const router = await settled()
    const { deviceId, groupId } = await sealedDevice(router, '测试机')
    const connection = router.deviceFor(deviceId)
    if (connection === undefined) throw new Error('the device has no connection')

    // It works while the group is open.
    expect((await connectConfig(connection)).password).toBe(SECRET)

    await router.lockGroups(groupId)

    // The connection that was already built cannot open the secret any more.
    await expect(connectConfig(connection)).rejects.toBeInstanceOf(VaultLockedError)
    // And it names the group, so the panel can open the right unlock box.
    await connectConfig(connection).catch((error: unknown) => {
      expect((error as VaultLockedError).groupId).toBe(groupId)
    })
    // It is an authentication problem, not a transport one: re-dialling would
    // fail the same way.
    expect(classifyDeviceError(new VaultLockedError('locked', groupId))).toBe('auth')
  })

  it('gives it back when the group is unlocked', async () => {
    const router = await settled()
    const { deviceId, groupId } = await sealedDevice(router, '测试机')
    const connection = router.deviceFor(deviceId)
    if (connection === undefined) throw new Error('the device has no connection')

    await router.lockGroups(groupId)
    await router.unlockGroup(groupId, 'correct horse')
    expect((await connectConfig(connection)).password).toBe(SECRET)
  })
})

describe('a device whose own secret is not on disk any more', () => {
  it('says the credential is unusable, without naming a path', async () => {
    // The failure this replaces: a raw ENOENT carrying the host's absolute
    // path. It read as a broken filesystem, said nothing about what the reader
    // could do about it, and leaked a path that means nothing outside this
    // host. The path stays in `cause`, where a log has it.
    const router = await settled()
    const device = await router.saveDevice({
      name: '自带密钥', host: '10.0.0.9', port: 22, user: 'root', remoteRoot: '/srv',
      auth: 'password', password: SECRET,
    })
    const connection = router.deviceFor(device.id)
    if (connection === undefined) throw new Error('the device has no connection')
    expect((await connectConfig(connection)).password).toBe(SECRET)

    // The file is removed out of band, the way an operator cleaning up would.
    const stored = join(sshRoot(), 'keys', `${device.id}.password`)
    await rm(stored, { force: true })

    const error = await connectConfig(connection).catch((raised: unknown) => raised)
    expect((error as Error).message).toContain('credential for this device could not be read')
    expect((error as Error).message).not.toContain(stored)
    expect((error as Error).message).not.toContain('ENOENT')
    // The original is not lost: it is what a log reads.
    expect((error as { cause?: { code?: string } }).cause?.code).toBe('ENOENT')
  })
})
