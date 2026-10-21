/**
 * `ctx.deviceFs`, the seat the transfer and buffer relays read.
 *
 * The seat's only public behaviour is `forInitiator()`, which returns a
 * `DeviceFsOps` for the ambient call's session, `undefined` when the session
 * runs on this machine, and a refusal when it is bound to a device nothing can
 * serve — `undefined` is read as "operate locally" by every caller, which for a
 * device session would put its bytes on this machine. These specs pin that
 * contract: an unbound session is `undefined`, a bound session is a real ops
 * object, an unservable one throws, and a bound session whose helper just
 * disappeared is still answered (the seat does not decide on helper liveness —
 * the wrapped `RemoteFileSystem` does, by falling back to the assembled-command
 * lane).
 *
 * The adapter's role is to drop the rich return types of `RemoteFileSystem`
 * down to the simpler `DeviceFsOps` contract — `writeBytes` becomes `void`,
 * `copy` returns the destination path instead of `{ version }`. Those
 * mappings are what the relay engine relies on; this spec makes them
 * unmissable.
 */
import { FsError } from '@deepseek-ai/dsh-fs'
import { DEVICE_FS_SERVICE } from '@nexus-aethra/dshell-std'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DeviceFsAdapter, DshellDeviceFsProvider } from '../src/device-fs-provider.js'
import type { DshellSshTranslate } from '../src/host-locales.js'
import type { RemoteFileSystem } from '../src/remote-fs.js'
import { SSH_ROUTING_SERVICE } from '../src/router.js'

interface RoutingFake {
  targetForSession: (id: string) => { device: { id: string; remoteRoot: string }; remoteRoot: string; mount: string | undefined } | undefined
  /** The raw binding, which is what separates "local" from "bound but unservable". */
  assignmentForSession: (id: string) => { sessionId: string; deviceId: string } | undefined
  unservableMessage: (deviceId: string) => string
  helperConnection: (deviceId: string) => { request: (...args: unknown[]) => Promise<unknown> } | undefined
}

function makeCtx(args: {
  initiator: string | undefined
  cwd?: string | undefined
  routing: RoutingFake
}) {
  return {
    agents: {
      currentInitiator: () => args.initiator === undefined
        ? undefined
        : { id: args.initiator, session: { header: { cwd: args.cwd } } },
    },
    [SSH_ROUTING_SERVICE]: args.routing,
  }
}

const hostCopy: DshellSshTranslate = ((key: string) => key) as unknown as DshellSshTranslate

const baseRouting = (): RoutingFake => ({
  targetForSession: () => undefined,
  assignmentForSession: () => undefined,
  unservableMessage: (deviceId: string) => `unservable:${deviceId}`,
  helperConnection: () => undefined,
})

describe('DshellDeviceFsProvider', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('uses dshellDeviceFs as the cordis service name', () => {
    expect(DEVICE_FS_SERVICE).toBe('dshellDeviceFs')
  })

  it('returns undefined when there is no ambient initiator', () => {
    const ctx = makeCtx({ initiator: undefined, routing: baseRouting() })
    const seat = new DshellDeviceFsProvider(ctx, { diffBasisMaxBytes: 0 }, hostCopy)
    expect(seat.forInitiator()).toBeUndefined()
  })

  it('returns undefined when the session has no binding', () => {
    const routing: RoutingFake = { ...baseRouting(), targetForSession: () => undefined }
    const ctx = makeCtx({ initiator: 'session-x', routing })
    const seat = new DshellDeviceFsProvider(ctx, { diffBasisMaxBytes: 0 }, hostCopy)
    expect(seat.forInitiator()).toBeUndefined()
  })

  it('refuses a bound session whose binding has no mount', () => {
    // `undefined` is what every caller reads as "operate locally", so a device
    // session with nothing to translate with has to fail instead of answering.
    const routing: RoutingFake = {
      ...baseRouting(),
      targetForSession: () => ({ device: { id: 'd1', remoteRoot: '/root' }, remoteRoot: '/root', mount: undefined }),
      assignmentForSession: () => ({ sessionId: 'session-x', deviceId: 'd1' }),
    }
    const ctx = makeCtx({ initiator: 'session-x', routing })
    const seat = new DshellDeviceFsProvider(ctx, { diffBasisMaxBytes: 0 }, hostCopy)
    expect(() => seat.forInitiator()).toThrow('unservable:d1')
  })

  it('refuses a session whose device is gone', () => {
    const routing: RoutingFake = {
      ...baseRouting(),
      targetForSession: () => undefined,
      assignmentForSession: () => ({ sessionId: 'session-x', deviceId: 'deleted-device' }),
    }
    const ctx = makeCtx({ initiator: 'session-x', routing })
    const seat = new DshellDeviceFsProvider(ctx, { diffBasisMaxBytes: 0 }, hostCopy)
    expect(() => seat.forInitiator()).toThrow('unservable:deleted-device')
  })

  it('returns an ops object for a bound session with a mount', () => {
    const routing: RoutingFake = {
      ...baseRouting(),
      targetForSession: () => ({ device: { id: 'd1', remoteRoot: '/root' }, remoteRoot: '/root', mount: '/tmp/d1' }),
      helperConnection: () => undefined,
    }
    const ctx = makeCtx({ initiator: 'session-x', cwd: '/tmp/d1', routing })
    const seat = new DshellDeviceFsProvider(ctx, { diffBasisMaxBytes: 0 }, hostCopy)
    const ops = seat.forInitiator()
    expect(ops).toBeDefined()
    expect(ops).toMatchObject({
      writeBytes: expect.any(Function),
      mkdir: expect.any(Function),
      remove: expect.any(Function),
      rename: expect.any(Function),
      sha256: expect.any(Function),
      copy: expect.any(Function),
    })
  })

  it('asks the routing table for the live helper connection each call', () => {
    const helperSpy = vi.fn(() => undefined)
    const targetSpy = vi.fn(() => ({ device: { id: 'd1', remoteRoot: '/root' }, remoteRoot: '/root', mount: '/tmp/d1' }))
    const routing: RoutingFake = {
      ...baseRouting(),
      targetForSession: targetSpy,
      helperConnection: helperSpy,
    }
    const ctx = makeCtx({ initiator: 'session-x', routing })
    const seat = new DshellDeviceFsProvider(ctx, { diffBasisMaxBytes: 0 }, hostCopy)
    seat.forInitiator()
    seat.forInitiator()
    expect(targetSpy).toHaveBeenCalledTimes(2)
    expect(targetSpy).toHaveBeenNthCalledWith(1, 'session-x')
    expect(helperSpy).toHaveBeenCalledTimes(2)
    expect(helperSpy).toHaveBeenNthCalledWith(1, 'd1')
  })
})

/** A `RemoteFileSystem` is a class; this stub exposes the six methods the adapter calls as vi.fn(). */
function remoteStub(): {
  writeBytes: ReturnType<typeof vi.fn>
  mkdir: ReturnType<typeof vi.fn>
  remove: ReturnType<typeof vi.fn>
  rename: ReturnType<typeof vi.fn>
  sha256: ReturnType<typeof vi.fn>
  copy: ReturnType<typeof vi.fn>
} {
  return {
    writeBytes: vi.fn(async () => undefined),
    mkdir: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    rename: vi.fn(async () => undefined),
    sha256: vi.fn(async () => ''),
    copy: vi.fn(async () => ({ destination: { version: 'v0' }, sourceSha256: '', bytes: 0 })),
  }
}

function adapterFrom(remote: ReturnType<typeof remoteStub>): DeviceFsAdapter {
  return new DeviceFsAdapter(remote as unknown as RemoteFileSystem)
}

describe('DeviceFsAdapter', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('forwards writeBytes to the wrapped filesystem and returns void', async () => {
    const remote = remoteStub()
    const adapter = adapterFrom(remote)
    const result = await adapter.writeBytes('/x', new Uint8Array([1, 2, 3]))
    expect(remote.writeBytes).toHaveBeenCalledWith('/x', new Uint8Array([1, 2, 3]), undefined)
    expect(result).toBeUndefined()
  })

  it('forwards mkdir with paths and recursive flag', async () => {
    const remote = remoteStub()
    const adapter = adapterFrom(remote)
    await adapter.mkdir(['/a', '/c'], true)
    expect(remote.mkdir).toHaveBeenCalledWith(['/a', '/c'], true, undefined)
  })

  it('forwards remove and rename, discarding the wrapped {version} return', async () => {
    const remote = remoteStub()
    const adapter = adapterFrom(remote)
    await adapter.remove('/a', true)
    expect(remote.remove).toHaveBeenCalledWith('/a', true, undefined)
    await adapter.rename('/a', '/b', false)
    expect(remote.rename).toHaveBeenCalledWith('/a', '/b', false, undefined)
  })

  it('returns the device sha256 verbatim', async () => {
    const remote = remoteStub()
    const adapter = adapterFrom(remote)
    remote.sha256.mockResolvedValueOnce('feedface')
    expect(await adapter.sha256('/x')).toBe('feedface')
  })

  it('returns the destination path verbatim on copy, dropping the version field', async () => {
    const remote = remoteStub()
    const adapter = adapterFrom(remote)
    remote.copy.mockResolvedValueOnce({ destination: { version: 'v0' }, sourceSha256: 'h', bytes: 12 })
    const onProgress = vi.fn()
    const result = await adapter.copy('/src', '/dst', false, undefined, onProgress, new AbortController().signal)
    expect(result).toEqual({ destination: '/dst', sourceSha256: 'h', bytes: 12 })
    expect(remote.copy).toHaveBeenCalledWith('/src', '/dst', false, undefined, onProgress, expect.any(AbortSignal))
  })

  it('propagates FsError from the wrapped filesystem verbatim', async () => {
    const remote = remoteStub()
    const adapter = adapterFrom(remote)
    const typed = new FsError('not observed', 'FS_NOT_OBSERVED')
    remote.mkdir.mockRejectedValueOnce(typed)
    await expect(adapter.mkdir(['/a'], true)).rejects.toBe(typed)
  })
})