/**
 * Two namespaces, and the line between them.
 *
 * A device session's paths live in the DEVICE's tree; this machine's live in
 * this machine's. The translation between them has one owner — the mapping —
 * and it has to know which side a path is on BEFORE it measures it. Measuring
 * a path against the wrong side resolves it against this PROCESS's working
 * directory, and that is how the host's own tree ended up spelled as the
 * device's `/root/.dsh/profiles/<profile>/~`: a directory that is in neither
 * world, reported to the reader as if the device had it.
 *
 * Three decisions make the line, and these cases pin each of them:
 *
 *  - a path that is not absolute HERE is never measured against a host root;
 *  - a relative path is joined onto its base in the BASE's grammar;
 *  - a device's root is an absolute device path, and stays one.
 */

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DSHELL_HOME_ENV } from '@nexus-aethra/dshell-std'
import { isDevicePath, mappingFor, toRemotePath } from '../src/mount.js'
import { RemoteFileSystem } from '../src/remote-fs.js'
import { SshRouter } from '../src/router.js'
import type { DshellSshConnection } from '../src/connection.js'
import type { DeviceConnection } from '../src/devices.js'
import type { DshellSshTranslate } from '../src/host-locales.js'
import type { Context } from '@deepseek-ai/cordis'

/** The mount directory, the session's own directory, and the device's root. */
const MOUNT = join(resolve(sep, 'home', 'reader'), '.dsh', 'mnt', 'dev', 'root')
const HOME = resolve(sep, 'home', 'reader')
const MAPPING = { mount: MOUNT, remoteRoot: '/root', alias: HOME }

/** A translator that answers with the key; the refusals are not what is under test. */
const translate = ((key: string): string => key) as DshellSshTranslate

/** One request the fake helper was asked, as the seam sent it. */
interface Asked {
  readonly method: string
  readonly params: unknown
}

/** A helper connection that records what it was asked and answers one fixed reply. */
class FakeConnection {
  readonly asked: Asked[] = []

  async request<T>(method: string, params: unknown, schema: { parse(value: unknown): T }): Promise<T> {
    this.asked.push({ method, params })
    return schema.parse({ path: '/root' })
  }

  deviceRoot(): string | undefined {
    return '/root'
  }
}

/** The device filesystem over a fake helper, so nothing is asked of a real device. */
function remoteOver(fake: FakeConnection, mapping = MAPPING): RemoteFileSystem {
  return new RemoteFileSystem({
    ctx: {} as unknown as Context,
    device: { id: 'dev', name: 'dev', host: 'h', port: 22, user: 'root', remoteRoot: '/root' } as unknown as DeviceConnection,
    mapping,
    diffBasisMaxBytes: 1024,
    t: translate,
    connection: fake as unknown as DshellSshConnection,
  })
}

describe('a path this machine cannot name absolutely', () => {
  /**
   * The host's own directory, as this process sees it.
   *
   * The alias of a session created on this machine IS the reader's home, and
   * the host's working directory is under it — which is what made the leak
   * possible: a relative path measured against that alias is resolved against
   * the working directory, and the host's own tree is pasted under the
   * device's root.
   */
  const WORKING = process.cwd()
  const HOST_MAPPING = { mount: join(WORKING, 'mnt'), remoteRoot: '/root', alias: WORKING }

  it('is never measured against a host root', () => {
    // The leak, in one line: a relative path has not been joined to anything
    // yet, so measuring it against the mount or the alias would resolve it
    // against THIS PROCESS's working directory and paste the host's own tree
    // under the device's root.
    expect(toRemotePath(HOST_MAPPING, '~')).toBe('~')
    expect(toRemotePath(HOST_MAPPING, 'notes.md')).toBe('notes.md')
  })

  it('keeps the host out of the device path', () => {
    // Whatever this process's working directory is, it is not the device's
    // business — and it is not spelled as the device's either.
    const remote = toRemotePath(HOST_MAPPING, '~')
    expect(remote).not.toContain('.dsh')
    expect(remote.startsWith('/root/')).toBe(false)
  })

  it('still re-bases a host path that is absolute here', () => {
    // The translation itself is untouched: a path this machine can name is
    // measured against the mount and the alias as before.
    expect(toRemotePath(MAPPING, join(HOME, 'notes.md'))).toBe('/root/notes.md')
    expect(toRemotePath(MAPPING, join(MOUNT, 'app'))).toBe('/root/app')
  })
})

describe('which side a path is on', () => {
  it('is the device for a path the host does not stand in for', () => {
    expect(isDevicePath(MAPPING, '/root')).toBe(true)
    expect(isDevicePath(MAPPING, '/var/log')).toBe(true)
  })

  it('is the host for a path under the mount or the alias', () => {
    expect(isDevicePath(MAPPING, join(MOUNT, 'app'))).toBe(false)
    expect(isDevicePath(MAPPING, join(HOME, 'notes.md'))).toBe(false)
  })

  it('is neither for a relative path', () => {
    expect(isDevicePath(MAPPING, 'notes.md')).toBe(false)
  })
})

describe('a relative path is joined in its base own grammar', () => {
  it('lands inside the device tree when the base is the device root', () => {
    // The device's separators, not the host's: the completion and the `cd`
    // that use this land where the device's shell would land them.
    const fake = new FakeConnection()
    const remote = remoteOver(fake)
    void remote.resolve('notes.md', { cwd: '/root' })
    expect(fake.asked.map(asked => asked.params)).toEqual([{ path: '/root/notes.md' }])
  })

  it('still lands in the session tree when the base is the session directory', () => {
    // The host's own directory is the stand-in for the device's root, so a
    // relative path there is the model's relative path, and it travels as the
    // device's.
    const fake = new FakeConnection()
    const remote = remoteOver(fake)
    void remote.resolve('notes.md', { cwd: HOME })
    expect(fake.asked.map(asked => asked.params)).toEqual([{ path: '/root/notes.md' }])
  })

  it('asks the device about an absolute device path as it is', () => {
    const fake = new FakeConnection()
    const remote = remoteOver(fake)
    void remote.resolve('/root/app', { cwd: '/root' })
    expect(fake.asked.map(asked => asked.params)).toEqual([{ path: '/root/app' }])
  })

  it('expands a tilde against the device home', () => {
    // The device's own shell would expand it, and the helper's protocol
    // refuses anything that is not absolute — so the seam expands it, against
    // the device's root, before the device is asked. A panel that opens on the
    // device's home is the common case, and a `~` reaching the device is a
    // panel that says "no such directory".
    const fake = new FakeConnection()
    const remote = remoteOver(fake)
    void remote.resolve('~', { cwd: '~' })
    expect(fake.asked.map(asked => asked.params)).toEqual([{ path: '/root' }])
  })

  it('expands a tilde in the base as well', () => {
    const fake = new FakeConnection()
    const remote = remoteOver(fake)
    void remote.resolve('notes.md', { cwd: '~' })
    expect(fake.asked.map(asked => asked.params)).toEqual([{ path: '/root/notes.md' }])
  })
})

describe("a device's root", () => {
  const DEVICES = {
    devices: [
      { id: 'dev-a', name: 'A', host: '10.0.0.1', port: 22, user: 'root', remoteRoot: '~', auth: 'key' },
    ],
  }

  let home = ''
  let saved: string | undefined

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'dshell-root-'))
    saved = process.env[DSHELL_HOME_ENV]
    process.env[DSHELL_HOME_ENV] = home
    await mkdir(join(home, 'dshell', 'ssh'), { recursive: true })
    await writeFile(join(home, 'dshell', 'ssh', 'devices.json'), JSON.stringify(DEVICES), 'utf8')
    await writeFile(join(home, 'dshell', 'ssh', 'bindings.json'), JSON.stringify({
      'session-1': { deviceId: 'dev-a', mount: join(home, 'mnt') },
    }), 'utf8')
  })

  afterEach(() => {
    if (saved === undefined) delete process.env[DSHELL_HOME_ENV]
    else process.env[DSHELL_HOME_ENV] = saved
  })

  /** A router over the fixture, with its one-time load settled. */
  async function settled(): Promise<SshRouter> {
    const router = new SshRouter(() => join(home, 'dshell', 'ssh'))
    router.bindCopy(translate)
    await router.list()
    return router
  }

  it('is the spelling the reader typed until the device says otherwise', async () => {
    // A `~` root is what the reader typed, and the device is the only party
    // that knows what it means — so it is what the mapping carries until the
    // device has answered.
    const router = await settled()
    expect(router.targetForSession('session-1')?.remoteRoot).toBe('~')
  })

  it('is absolute once the device has said where its home is', async () => {
    // The device's protocol admits absolute paths only, and the containment
    // check compares against an absolute root, so a `~` root is a root the
    // device cannot be asked about.
    const router = await settled()
    router.noteDeviceRoot('dev-a', '/root')
    expect(router.targetForSession('session-1')?.remoteRoot).toBe('/root')
  })

  it('stays absolute when the helper connection goes away', async () => {
    // The helper is a connection that comes and goes; the device's home does
    // not. A root that turned back into a `~` whenever the helper was not up
    // is a root that flaps, and everything built on it flaps with it.
    const router = await settled()
    router.noteDeviceRoot('dev-a', '/root')
    router.helperConnection = () => undefined
    expect(router.targetForSession('session-1')?.remoteRoot).toBe('/root')
  })

  it('is nothing for a device that is not there', async () => {
    // Nothing to ask, so nothing to answer: the caller keeps the spelling
    // the reader typed, and the device is never asked about a path it cannot
    // open.
    const router = await settled()
    expect(await router.ensureDeviceRoot('dev-ghost')).toBeUndefined()
  })
})

describe('the mapping a device session is given', () => {
  it('names the device root, not the host directory', () => {
    // The session's own directory is a stand-in for the device's root, and
    // the stand-in is what the alias is for — the model's relative paths.
    const mapping = mappingFor({ remoteRoot: '/root', mount: MOUNT }, HOME)
    expect(mapping?.remoteRoot).toBe('/root')
    expect(mapping?.alias).toBe(HOME)
  })
})
