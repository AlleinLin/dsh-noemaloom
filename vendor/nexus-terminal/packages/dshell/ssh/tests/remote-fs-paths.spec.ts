/**
 * A path the device cannot be asked about, and what the seam answers instead.
 *
 * The device's protocol admits absolute device paths and nothing else: every
 * request field that names a path is validated as one, and a refusal comes
 * back as a schema error rather than as an answer. That refusal is fatal in
 * the wrong place: dsh asks the filesystem for the session's project root
 * BEFORE the model says anything, and a schema error there ends the turn —
 * so the reader sees a model that never answered, with nothing to act on.
 *
 * The host's own paths are the ones that cannot be asked about. A session
 * that runs on a device still has a working directory on THIS machine, and
 * the walk that looks for a project marker leaves the session's own tree
 * within a step or two. So the seam answers for those: the path is simply
 * not on the device, and the device is never asked.
 *
 * The predicate is lexical — a path is the device's if it is spelled as the
 * device spells paths — and that holds on every platform, but it has a
 * consequence this spec now states rather than hides.
 *
 * The seam refuses a path by its spelling alone: the device's protocol admits an
 * absolute POSIX path and nothing else, so a Windows path is refused on the spot.
 * On a POSIX host there is no such spelling — every absolute path already looks
 * like a device path, and a host path outside the mount cannot be told apart from
 * a device path by anything but the mapping. The three cases below are therefore
 * about a Windows host, and they are skipped elsewhere.
 */

import { describe, expect, it } from 'vitest'
import { join, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { RemoteFileSystem } from '../src/remote-fs.js'
import { HelperFsTransport } from '../src/remote-fs-helper.js'
import { ShellFsTransport } from '../src/remote-fs-shell.js'
import type { DshellSshConnection } from '../src/connection.js'
import type { DeviceConnection } from '../src/devices.js'
import type { DshellSshTranslate } from '../src/host-locales.js'

/** The mount directory, the session's own directory, and the device's root. */
const MOUNT = join(resolve(sep, 'home', 'reader'), '.dsh', 'mnt', 'dev', 'root')
const HOME = resolve(sep, 'home', 'reader')
const MAPPING = { mount: MOUNT, remoteRoot: '/root', alias: HOME }

/**
 * A path in the HOST's grammar: absolute on this machine, and outside the
 * device's tree.
 *
 * A Windows path, because that is the spelling the device's protocol refuses
 * outright. On a POSIX host every absolute path is already a device path, so
 * there is no host spelling to refuse and nothing for these cases to prove.
 */
const HOST_PATH = 'C:\\Windows\\notepad.exe'

/** The three cases below are about a Windows host; see the file's own note. */
const describeWindowsHost = describe.skipIf(process.platform !== 'win32')

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
function remoteOver(fake: FakeConnection): RemoteFileSystem {
  return new RemoteFileSystem({
    ctx: {} as unknown as Context,
    device: { id: 'dev', name: 'dev', host: 'h', port: 22, user: 'root', remoteRoot: '/root' } as unknown as DeviceConnection,
    mapping: MAPPING,
    diffBasisMaxBytes: 1024,
    t: translate,
    connection: fake as unknown as DshellSshConnection,
  })
}

describeWindowsHost('a path the device cannot be asked about', () => {
  it('is not put on the wire', async () => {
    const fake = new FakeConnection()
    const remote = remoteOver(fake)
    const target = await remote.resolve(HOST_PATH)
    expect(fake.asked).toEqual([])
    expect(String(target.targetKey)).toBe(HOST_PATH)
  })

  it('is absent rather than an error', async () => {
    const fake = new FakeConnection()
    const remote = remoteOver(fake)
    const target = await remote.resolve(HOST_PATH)
    expect(await remote.stat(target)).toBeUndefined()
    expect(fake.asked).toEqual([])
  })

  it("is refused in the filesystem's own words when it is written to", async () => {
    const fake = new FakeConnection()
    const remote = remoteOver(fake)
    const target = await remote.resolve(HOST_PATH)
    await expect(remote.writeText(target, 'x')).rejects.toThrow(/path on this machine/u)
    expect(fake.asked).toEqual([])
  })
})

describe('a path the device can be asked about', () => {
  it('is still asked about', async () => {
    const fake = new FakeConnection()
    const remote = remoteOver(fake)
    const target = await remote.resolve('/var/log')
    expect(fake.asked.map(asked => asked.method)).toEqual(['fs.resolve'])
    expect(String(target.targetKey)).toBe('/root')
  })

  it('is asked about through the session tree as well', async () => {
    const fake = new FakeConnection()
    const remote = remoteOver(fake)
    await remote.resolve(join(HOME, 'notes.md'))
    expect(fake.asked.map(asked => asked.params)).toEqual([{ path: '/root/notes.md' }])
  })
})

describe('what each lane can open', () => {
  it("is the device's grammar for the helper", () => {
    // The helper's protocol: absolute device paths only.
    const lane = new HelperFsTransport({} as unknown as DshellSshConnection)
    expect(lane.canOpen('/root')).toBe(true)
    expect(lane.canOpen('~')).toBe(false)
    expect(lane.canOpen('~/notes.md')).toBe(false)
    expect(lane.canOpen(HOST_PATH)).toBe(false)
  })

  it("is the device's grammar, plus the tilde its shell expands, for the assembled lane", () => {
    const lane = new ShellFsTransport({
      ctx: {} as unknown as Context,
      device: { id: 'dev', name: 'dev', host: 'h', port: 22, user: 'root', remoteRoot: '/root' } as unknown as DeviceConnection,
      t: translate,
    })
    expect(lane.canOpen('/root')).toBe(true)
    expect(lane.canOpen('~')).toBe(true)
    expect(lane.canOpen('~/notes.md')).toBe(true)
    expect(lane.canOpen(HOST_PATH)).toBe(false)
  })
})
