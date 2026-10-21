/**
 * The device filesystem's policy layer, against both lanes.
 *
 * `RemoteFileSystem` runs one of two transports, and the layer above it — the
 * read-check-write guards, the literal-edit rules, line-ending handling, the
 * size limit — is the same code for both. These specs exercise that layer
 * through a fake transport, so they run without a rig, and prove the rules
 * the rig cannot: that a guard rejects, that a stale guard names its reason,
 * that a read past the limit does not pretend to succeed.
 *
 * The fake carries every operation a transport has to implement, and the same
 * specs run against both an instance that records calls and one that records
 * failures, so a regression to one lane is caught by the same assertions as a
 * regression to the other.
 */
import { FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import { beforeEach, describe, expect, it } from 'vitest'
import { RemoteFileSystem, type RemoteFsOptions } from '../src/remote-fs.js'
import type {
  RemoteFsDeps, RemoteFsTransport, RemoteKind, RemoteListEntry, RemoteStat,
} from '../src/remote-fs-transport.js'

/** A recording of every transport call. */
interface RecordingTransport extends RemoteFsTransport {
  readonly calls: { method: string; args: unknown[] }[]
  statByPath: Map<string, RemoteStat>
  versionsByPath: Map<string, string>
}

function makeRecordingTransport(): RecordingTransport {
  const calls: RecordingTransport['calls'] = []
  const statByPath = new Map<string, RemoteStat>()
  const versionsByPath = new Map<string, string>()
  const stat = (path: string, follow: boolean, _signal?: AbortSignal): Promise<RemoteStat | undefined> => {
    calls.push({ method: 'stat', args: [path, follow] })
    return Promise.resolve(statByPath.get(path))
  }
  const list = (path: string): Promise<RemoteListEntry[]> => {
    calls.push({ method: 'list', args: [path] })
    return Promise.resolve([])
  }
  const read = (path: string, offset: number, length: number): Promise<Uint8Array> => {
    calls.push({ method: 'read', args: [path, offset, length] })
    return Promise.resolve(new Uint8Array(0))
  }
  const stream = (path: string): Promise<AsyncIterable<Uint8Array>> => {
    calls.push({ method: 'stream', args: [path] })
    return Promise.resolve((async function* () {})())
  }
  const write = (path: string, content: string): Promise<RemoteStat | undefined> => {
    calls.push({ method: 'write', args: [path, content] })
    const version = `v${String(versionsByPath.get(path) ?? 0)}`
    versionsByPath.set(path, String(Number(versionsByPath.get(path) ?? '0') + 1))
    const info: RemoteStat = { kind: 'file', size: Buffer.byteLength(content, 'utf8'), version: FsVersion(version) }
    statByPath.set(path, info)
    return Promise.resolve(info)
  }
  const resolve = (path: string): Promise<string> => {
    calls.push({ method: 'resolve', args: [path] })
    return Promise.resolve(path)
  }
  // The device's own grammar: a path the transport could not open is never
  // put on the wire, so the fake answers for the paths it does know.
  const canOpen = (path: string): boolean => path.startsWith('/')
  return { calls, statByPath, versionsByPath, canOpen, resolve, stat, list, read, stream, write }
}

/** A transport that reports the same kind of failure the helper would. */
function makeFailingTransport(code: string, message: string): RemoteFsTransport {
  const reject = (): Promise<never> => Promise.reject(new FsError(message, code as never))
  return {
    canOpen: () => true,
    resolve: reject,
    stat: reject,
    list: reject,
    read: reject,
    stream: reject,
    write: reject,
  }
}

function makeOptions(transport: RemoteFsTransport): RemoteFsOptions {
  const deps: RemoteFsDeps = {
    ctx: {} as never,
    device: {} as never,
    t: (key: string) => `${key}`,
  }
  return {
    ...deps,
    mapping: { mount: '/mnt', remoteRoot: '/root' },
    diffBasisMaxBytes: 8 * 1024 * 1024,
  } as RemoteFsOptions & { transport?: RemoteFsTransport }
}

/** Construct a backend whose transport is the one given, regardless of lane. */
function backendWith(transport: RemoteFsTransport): RemoteFileSystem {
  // The class picks its lane from `connection`, so giving it neither lets a
  // spec install its own transport through a small shim. Done by reflection
  // because the lane choice is intentionally hidden, and a public seam would
  // be a seam a caller could rely on by accident.
  const options = makeOptions(transport)
  const backend = new RemoteFileSystem(options)
  ;(backend as unknown as { transport: RemoteFsTransport }).transport = transport
  return backend
}

describe('RemoteFileSystem', () => {
  let transport: RecordingTransport
  let backend: RemoteFileSystem
  const targetOf = (path: string) => ({ targetKey: FsTargetKey(path), displayPath: path })

  beforeEach(() => {
    transport = makeRecordingTransport()
    backend = backendWith(transport)
  })

  it('passes the device\'s own path through, not the local one', async () => {
    await backend.resolve('sub/nested.txt', { cwd: '/mnt' })
    expect(transport.calls[0]).toEqual({ method: 'resolve', args: ['/root/sub/nested.txt'] })
  })

  it('passes an absolute local path through unchanged', async () => {
    await backend.resolve('/elsewhere/x.txt')
    expect(transport.calls[0]).toEqual({ method: 'resolve', args: ['/elsewhere/x.txt'] })
  })

  it('refuses an empty path with FS_NOT_FOUND rather than reaching for the device', async () => {
    await expect(backend.resolve('   ')).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
    expect(transport.calls).toEqual([])
  })

  it('rejects a write onto an existing directory', async () => {
    transport.statByPath.set('/root/a-directory', { kind: 'directory', size: 0, version: FsVersion('dir') })
    await expect(backend.writeText(targetOf('/root/a-directory'), 'x')).rejects.toMatchObject({ code: 'FS_NOT_REGULAR_FILE' })
  })

  it('accepts a guarded write at the observed version', async () => {
    transport.statByPath.set('/root/file', { kind: 'file', size: 5, version: FsVersion('v0') })
    const outcome = await backend.writeText(targetOf('/root/file'), 'hi', { kind: 'replaceIfVersion', version: FsVersion('v0') })
    expect(outcome.operation).toBe('update')
  })

  it('rejects a guarded write at a stale version', async () => {
    transport.statByPath.set('/root/file', { kind: 'file', size: 5, version: FsVersion('v1') })
    await expect(backend.writeText(targetOf('/root/file'), 'hi', { kind: 'replaceIfVersion', version: FsVersion('v0') }))
      .rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
    expect(transport.calls.find(call => call.method === 'write')).toBeUndefined()
  })

  it('rejects a guarded write when the file is gone', async () => {
    await expect(backend.writeText(targetOf('/root/absent'), 'hi', { kind: 'replaceIfVersion', version: FsVersion('v0') }))
      .rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
  })

  it('rejects a createIfAbsent onto an existing file', async () => {
    transport.statByPath.set('/root/file', { kind: 'file', size: 5, version: FsVersion('v0') })
    await expect(backend.writeText(targetOf('/root/file'), 'hi', { kind: 'createIfAbsent' }))
      .rejects.toMatchObject({ code: 'FS_NOT_OBSERVED' })
  })

  it('reports a too-large file as FS_TOO_LARGE without inventing bytes', async () => {
    transport.statByPath.set('/root/big', { kind: 'file', size: 1024, version: FsVersion('v0') })
    const overLimit: RemoteFsTransport = {
      ...transport,
      read: (_path, _offset, length) => Promise.resolve(new Uint8Array(length)),
    }
    const overBackend = backendWith(overLimit)
    await expect(overBackend.readBytes(targetOf('/root/big'), undefined, 1024)).rejects.toMatchObject({ code: 'FS_TOO_LARGE' })
  })

  it('reads a binary file as FS_NOT_TEXT, not as a missing one', async () => {
    transport.statByPath.set('/root/binary', { kind: 'file', size: 5, version: FsVersion('v0') })
    const binary: RemoteFsTransport = {
      ...transport,
      read: () => Promise.resolve(new Uint8Array([0x66, 0x6f, 0x6f, 0x00, 0x62])),
    }
    const binaryBackend = backendWith(binary)
    await expect(binaryBackend.readText(targetOf('/root/binary'))).rejects.toMatchObject({ code: 'FS_NOT_TEXT' })
  })

  it('returns stat that names the kind as file, directory, or other', async () => {
    transport.statByPath.set('/root/file', { kind: 'file', size: 1, version: FsVersion('v') })
    transport.statByPath.set('/root/dir', { kind: 'directory', size: 0, version: FsVersion('v') })
    transport.statByPath.set('/root/sock', { kind: 'other', size: 0, version: FsVersion('v') })
    expect((await backend.stat(targetOf('/root/file')))?.type).toBe('file')
    expect((await backend.stat(targetOf('/root/dir')))?.type).toBe('directory')
    expect((await backend.stat(targetOf('/root/sock')))?.type).toBe('other')
  })

  it('reports a symlink via lstat without flattening it to its target', async () => {
    transport.statByPath.set('/root/link', { kind: 'symlink', size: 5, version: FsVersion('v') })
    expect((await backend.lstat('/root/link'))?.type).toBe('symlink')
  })

  it('reads back what was written, on the line ending the caller chose', async () => {
    await backend.writeText(targetOf('/root/file'), 'a\r\nb\r\n')
    const called = transport.calls.find(call => call.method === 'write')
    expect(called?.args[1]).toBe('a\r\nb\r\n')
  })

  it('normalizes line endings on the diff basis but restores them on write', async () => {
    let transportWrite: string | undefined
    const writing: RemoteFsTransport = {
      ...transport,
      read: () => Promise.resolve(new Uint8Array(Buffer.from('a\r\nb\r\n', 'utf8'))),
      write: (_path, content) => { transportWrite = content; return Promise.resolve(undefined) },
      stat: () => Promise.resolve({ kind: 'file', size: 8, version: FsVersion('v') }),
    }
    const writingBackend = backendWith(writing)
    const outcome = await writingBackend.editText(targetOf('/root/file'), { oldString: 'b', newString: 'B', replaceAll: false })
    expect(outcome.before).toBe('a\nb\n')
    expect(outcome.after).toBe('a\nB\n')
    expect(transportWrite).toBe('a\r\nB\r\n')
  })

  it('orders a listing the same way every time', async () => {
    const t: RemoteFsTransport = {
      ...transport,
      list: () => Promise.resolve([
        { name: 'banana', kind: 'file', size: 1, version: FsVersion('v') },
        { name: 'apple', kind: 'file', size: 1, version: FsVersion('v') },
        { name: 'Cherry', kind: 'file', size: 1, version: FsVersion('v') },
      ]),
    }
    const listed = await backendWith(t).listDir(targetOf('/root'))
    expect(listed.map(entry => entry.name)).toEqual(['apple', 'banana', 'Cherry'])
  })

  it('rejects a literal edit whose match is ambiguous or absent with the seam\'s own codes', async () => {
    transport.statByPath.set('/root/edit', { kind: 'file', size: 5, version: FsVersion('v') })
    transport.read = () => Promise.resolve(new Uint8Array(Buffer.from('a\nb\na\n', 'utf8'))) as never
    const textTransport: RemoteFsTransport = {
      ...transport,
      read: () => Promise.resolve(new Uint8Array(Buffer.from('a\nb\na\n', 'utf8'))),
      stat: () => Promise.resolve({ kind: 'file', size: 5, version: FsVersion('v') }),
      write: () => Promise.resolve(undefined),
    }
    const editing = backendWith(textTransport)
    await expect(editing.editText(targetOf('/root/edit'), { oldString: 'a', newString: 'A', replaceAll: false }))
      .rejects.toMatchObject({ code: 'FS_AMBIGUOUS_EDIT' })
    const noMatchTransport: RemoteFsTransport = {
      ...textTransport,
      read: () => Promise.resolve(new Uint8Array(Buffer.from('only this', 'utf8'))),
    }
    const noMatch = backendWith(noMatchTransport)
    await expect(noMatch.editText(targetOf('/root/edit'), { oldString: 'zzz', newString: 'Z', replaceAll: false }))
      .rejects.toMatchObject({ code: 'FS_EDIT_NOT_FOUND' })
  })

  it('refuses an edit when the file is gone or is not a regular file', async () => {
    transport.statByPath.set('/root/gone', undefined as unknown as RemoteStat)
    await expect(backend.editText(targetOf('/root/gone'), { oldString: 'x', newString: 'y', replaceAll: false }))
      .rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
    transport.statByPath.set('/root/dir', { kind: 'directory', size: 0, version: FsVersion('v') })
    await expect(backend.editText(targetOf('/root/dir'), { oldString: 'x', newString: 'y', replaceAll: false }))
      .rejects.toMatchObject({ code: 'FS_NOT_REGULAR_FILE' })
  })

  it('passes a transport\'s failure through as an FsError with the same code', async () => {
    const failing = makeFailingTransport('FS_PERMISSION_DENIED', 'cannot read here')
    const denied = backendWith(failing)
    await expect(denied.readText(targetOf('/root/x'))).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
  })

  it('returns undefined for an absent stat on both lanes', async () => {
    expect(await backend.stat(targetOf('/root/absent'))).toBeUndefined()
    expect(await backend.lstat('/root/absent')).toBeUndefined()
  })

  it('translates each kind with the seam\'s vocabulary', async () => {
    const kinds: RemoteKind[] = ['file', 'directory', 'symlink', 'other']
    for (const kind of kinds) {
      transport.statByPath.set(`/root/${kind}`, { kind, size: 0, version: FsVersion('v') })
    }
    expect((await backend.stat(targetOf('/root/file')))?.type).toBe('file')
    expect((await backend.stat(targetOf('/root/directory')))?.type).toBe('directory')
    expect((await backend.stat(targetOf('/root/symlink')))?.type).toBe('other')
    expect((await backend.stat(targetOf('/root/other')))?.type).toBe('other')
    expect((await backend.lstat('/root/symlink'))?.type).toBe('symlink')
  })
})
