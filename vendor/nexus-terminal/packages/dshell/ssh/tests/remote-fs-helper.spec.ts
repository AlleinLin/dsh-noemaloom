/**
 * The helper lane, exercised through a fake connection.
 *
 * Each test pins one thing a refactor could silently change: a parameter
 * spelling, a code mapping, the JSON shape the device gets. The fake
 * connection records the request and returns a chosen reply, so the assertions
 * are about what crossed the wire rather than what the device produced.
 */
import { FsError } from '@deepseek-ai/dsh-fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HELPER_OPS } from '../src/helper/protocol.js'
import { HelperFsTransport } from '../src/remote-fs-helper.js'
import type { DshellSshConnection } from '../src/connection.js'

interface Recorded {
  method: string
  params: unknown
  schema: unknown
}

function makeFakeConnection(reply: unknown, error: Error | null = null) {
  const calls: Recorded[] = []
  const request = vi.fn(async (method: string, params: unknown, schema: unknown) => {
    calls.push({ method, params, schema })
    if (error !== null) throw error
    return reply
  })
  return { connection: { request } as unknown as DshellSshConnection, calls }
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('HelperFsTransport.resolve', () => {
  it('carries the path the device should canonicalize', async () => {
    const { connection, calls } = makeFakeConnection({ path: '/root/sub/x.txt' })
    const lane = new HelperFsTransport(connection)
    const resolved = await lane.resolve('/root/sub/x.txt')
    expect(resolved).toBe('/root/sub/x.txt')
    expect(calls[0]?.method).toBe(HELPER_OPS.fsResolve)
    expect(calls[0]?.params).toEqual({ path: '/root/sub/x.txt' })
  })
})

describe('HelperFsTransport.stat', () => {
  it('asks the device to follow the final symlink for stat', async () => {
    const { connection, calls } = makeFakeConnection({ kind: 'file', size: 7, version: 'v0' })
    const lane = new HelperFsTransport(connection)
    const info = await lane.stat('/root/file', true)
    expect(calls[0]?.method).toBe(HELPER_OPS.fsStat)
    expect(calls[0]?.params).toEqual({ path: '/root/file' })
    expect(info).toMatchObject({ kind: 'file', size: 7 })
  })

  it('asks the device NOT to follow it for lstat', async () => {
    const { connection, calls } = makeFakeConnection({ kind: 'symlink', size: 4, version: 'v0' })
    const lane = new HelperFsTransport(connection)
    const info = await lane.stat('/root/link', false)
    expect(calls[0]?.method).toBe(HELPER_OPS.fsLstat)
    expect(info?.kind).toBe('symlink')
  })

  it('reports an absent path as undefined, not as an FsError', async () => {
    const { connection } = makeFakeConnection(null)
    const lane = new HelperFsTransport(connection)
    expect(await lane.stat('/root/absent', true)).toBeUndefined()
  })
})

describe('HelperFsTransport.list', () => {
  it('brands the device-supplied version tokens', async () => {
    const { connection } = makeFakeConnection({
      entries: [
        { name: 'a', kind: 'file', size: 1, version: 'v1' },
        { name: 'b', kind: 'directory' },
        { name: 'c', kind: 'other' },
      ],
    })
    const lane = new HelperFsTransport(connection)
    const listed = await lane.list('/root')
    expect(listed[0]).toMatchObject({ name: 'a', kind: 'file', size: 1 })
    expect((listed[0] as { version: { __brand: 'FsVersion' } }).version).toBe('v1')
    expect(listed[1]?.size).toBeUndefined()
    expect(listed[2]?.version).toBeUndefined()
  })
})

describe('HelperFsTransport.read', () => {
  it('reads the full window when the file is large, one frame at a time', async () => {
    const callCount = { value: 0 }
    const reply = (offset: number, length: number): { data: string } => {
      callCount.value += 1
      if (callCount.value === 1) {
        // First window: a full 8 MiB, the helper's per-frame ceiling.
        expect(offset).toBe(0)
        expect(length).toBe(8 * 1024 * 1024)
        return { data: Buffer.alloc(length, 0x61).toString('base64') }
      }
      // Second window: the remainder of a 9 MiB file.
      expect(offset).toBe(8 * 1024 * 1024)
      expect(length).toBe(1024 * 1024)
      return { data: Buffer.alloc(length, 0x62).toString('base64') }
    }
    const { connection } = makeFakeConnection({
      get data() { throw 0 },
    } as never)
    const request = vi.fn(async (method: string, params: unknown) => {
      const { offset, length } = params as { offset: number; length: number }
      return reply(offset, length)
    })
    const lane = new HelperFsTransport({ request } as unknown as DshellSshConnection)
    const bytes = await lane.read('/root/big', 0, 9 * 1024 * 1024)
    expect(bytes.byteLength).toBe(9 * 1024 * 1024)
    expect(bytes[0]).toBe(0x61)
    expect(bytes[8 * 1024 * 1024 + 1]).toBe(0x62)
    expect(callCount.value).toBe(2)
    void connection
  })

  it('stops when the device reports a short window — that is the end of the file', async () => {
    let attempts = 0
    const request = vi.fn(async (_method: string, params: unknown) => {
      attempts += 1
      const { offset, length } = params as { offset: number; length: number }
      expect(offset).toBe(0)
      // First reply is short: the file has only five bytes.
      expect(length).toBeGreaterThanOrEqual(5)
      return { data: Buffer.from('hello').toString('base64') }
    })
    const lane = new HelperFsTransport({ request } as unknown as DshellSshConnection)
    const bytes = await lane.read('/root/short', 0, 1024 * 1024)
    expect(bytes.byteLength).toBe(5)
    expect(attempts).toBe(1)
  })
})

describe('HelperFsTransport.write', () => {
  it('sends bytes as base64', async () => {
    const { connection, calls } = makeFakeConnection({ kind: 'file', size: 5, version: 'v1' })
    const lane = new HelperFsTransport(connection)
    const outcome = await lane.write('/root/file', 'hello')
    expect(calls[0]?.method).toBe(HELPER_OPS.fsWrite)
    const params = calls[0]?.params as { path: string; data: string }
    expect(params.path).toBe('/root/file')
    expect(Buffer.from(params.data, 'base64').toString('utf8')).toBe('hello')
    expect(outcome).toMatchObject({ kind: 'file', size: 5 })
  })

  it('refuses here when the content exceeds the per-frame ceiling', async () => {
    const { connection } = makeFakeConnection({ kind: 'file', size: 1, version: 'v1' })
    const lane = new HelperFsTransport(connection)
    await expect(lane.write('/root/big', 'x'.repeat(40 * 1024 * 1024))).rejects.toMatchObject({ code: 'FS_TOO_LARGE' })
  })
})

describe('HelperFsTransport error mapping', () => {
  it('passes the device\'s code through when the seam knows it', async () => {
    const { connection } = makeFakeConnection({}, null)
    const request = vi.fn(async () => {
      throw new (await import('@deepseek-ai/dsh-ssh/protocol')).RemoteOperationError('denied here', 'FS_PERMISSION_DENIED')
    })
    const lane = new HelperFsTransport({ request } as unknown as DshellSshConnection)
    await expect(lane.read('/root/x', 0, 8)).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
    void connection
  })

  it('falls back to FS_IO_ERROR when the device sent a code the seam does not know', async () => {
    const { connection } = makeFakeConnection({}, null)
    const request = vi.fn(async () => {
      throw new (await import('@deepseek-ai/dsh-ssh/protocol')).RemoteOperationError('weird', 'FS_SOMETHING_NEW')
    })
    const lane = new HelperFsTransport({ request } as unknown as DshellSshConnection)
    await expect(lane.read('/root/x', 0, 8)).rejects.toMatchObject({ code: 'FS_IO_ERROR' })
    void connection
  })

  it('reports an abort as FS_ABORTED, not as the device\'s error', async () => {
    const { connection } = makeFakeConnection({}, null)
    const request = vi.fn(async () => {
      throw new (await import('@deepseek-ai/dsh-ssh/protocol')).RemoteOperationError('denied here', 'FS_PERMISSION_DENIED')
    })
    const lane = new HelperFsTransport({ request } as unknown as DshellSshConnection)
    const controller = new AbortController()
    controller.abort()
    await expect(lane.read('/root/x', 0, 8, controller.signal)).rejects.toMatchObject({ code: 'FS_ABORTED' })
    void connection
  })

  it('reports a transport failure as an I/O fault carrying the peer\'s message', async () => {
    const { connection } = makeFakeConnection({}, null)
    const request = vi.fn(async () => { throw new Error('the helper died') })
    const lane = new HelperFsTransport({ request } as unknown as DshellSshConnection)
    const error = await lane.read('/root/x', 0, 8).then(() => null, (e: unknown) => e)
    expect(error).toBeInstanceOf(FsError)
    expect((error as FsError).code).toBe('FS_IO_ERROR')
    expect((error as FsError).message).toContain('the helper died')
    void connection
  })
})
