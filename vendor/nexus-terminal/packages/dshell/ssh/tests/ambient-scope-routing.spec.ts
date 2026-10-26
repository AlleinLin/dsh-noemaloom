/**
 * A browser-initiated read of a DEVICE file, through dsh's own file service.
 *
 * dsh's `workspace-files` service reads files with bare `this.ctx.fs.*` calls,
 * so no initiator agent is in scope and this provider cannot tell a device-bound
 * session from a local one — the read used to be answered by this machine's
 * disk, with the device's path rewritten into a local one, and the reader saw
 * "file not found".
 *
 * The call itself carries the answer: the Gateway hangs the call it is
 * dispatching on the context the receiving method runs under, Cordis rebinds
 * `this.ctx` to that context for every service the method reaches, and the
 * scope the read was made under travels as the session id. So the provider can
 * learn the session from the call, and dispatch the read to the device.
 *
 * These specs drive that whole chain the way the Gateway does — a real
 * `Context`, a real service reached through `ctx.extend({ invocation })`, and
 * the real provider — and assert WHERE the read was answered. The probe sits
 * on the device LANE, below the path translation, so what it records is the
 * path the device itself was asked about.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { FsVersion } from '@deepseek-ai/dsh-fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DshellFileSystem } from '../src/fs-routing.js'
import type { DshellSshTranslate } from '../src/host-locales.js'
import { ShellFsTransport } from '../src/remote-fs-shell.js'
import { SSH_ROUTING_SERVICE } from '../src/router.js'

/** The session bound to a device. */
const DEVICE_SESSION = 's-device'

/** A session that runs on this machine. */
const LOCAL_SESSION = 's-local'

/** A translator that answers with the key; the wording is not what is under test. */
const translate = ((key: string): string => key) as DshellSshTranslate

/**
 * A stand-in for dsh's `workspace-files` service: a Cordis service whose method
 * reads a file through `this.ctx.fs`, the way the stock one does.
 */
class WorkspaceReader extends Service {
  constructor(ctx: Context) {
    super(ctx, 'workspaceReader')
  }

  /**
   * Read one file the way dsh's service does: the workspace root first, then
   * the file, each through `this.ctx.fs`.
   * @param workspaceRoot - the session's workspace root, as the scope names it.
   * @param path - the file to read.
   */
  async read(workspaceRoot: string, path: string): Promise<void> {
    await this.ctx.fs.resolve(workspaceRoot, {})
    await this.ctx.fs.lstat(path, { cwd: workspaceRoot })
    await this.ctx.fs.resolve(path, { cwd: workspaceRoot })
  }
}

/** The ambient call the Gateway leaves on the context it dispatches under. */
function ambientCall(scope: string | undefined): {
  readonly service: string
  readonly request: {
    readonly namespace: string
    readonly method: string
    readonly args: Readonly<Record<string, unknown>>
  }
} {
  return {
    service: 'workspaceFiles',
    request: {
      namespace: 'workspaceFiles',
      method: 'read',
      args: scope === undefined ? { path: '/root/.bashrc' } : { workspaceFileScopeId: scope, path: '/root/.bashrc' },
    },
  }
}

let root = ''
let hostCwd = ''
let mount = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dshell-ambient-scope-'))
  hostCwd = join(root, 'home')
  mount = join(root, 'mount')
  vi.restoreAllMocks()
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/**
 * A context with the services this provider needs, and one session bound to a
 * device.
 * @returns the context, with the provider installed as `ctx.fs`.
 */
function contextWithDevice(): Context {
  const ctx = new Context()
  const initiators = new AsyncLocalStorage<{ id: string; session: { header: { cwd: string } } }>()
  ctx.provide('sandboxPolicy', {
    defaultMode: 'danger-full-access',
    workspaceRoot: hostCwd,
    resolve: () => ({ mode: 'danger-full-access', workspaceRoot: hostCwd }),
  } as never)
  ctx.provide('agents', {
    currentInitiator: () => initiators.getStore(),
    withInitiator: <T>(agent: { id: string }, operation: () => T): T => initiators.run(agent, operation),
  } as never)
  ctx.provide('sessionController', {
    resolveAgent: async (sessionId: string) => sessionId === DEVICE_SESSION
      ? { agent: { id: sessionId, session: { header: { cwd: hostCwd } } } }
      : { error: { code: 'session/not-found' } },
  } as never)
  ctx.provide('subprocess', {} as never)
  ctx.provide(SSH_ROUTING_SERVICE, {
    targetForSession: (id: string) => id === DEVICE_SESSION
      ? { device: { id: 'dev-1', name: 'tencent' }, remoteRoot: '/root', mount }
      : undefined,
    assignmentForSession: (id: string) => id === DEVICE_SESSION ? { deviceId: 'dev-1' } : undefined,
    ensureDeviceRoot: async () => '/root',
    helperConnection: () => undefined,
    unservableMessage: (deviceId: string) => `device "${deviceId}" cannot serve this session`,
  } as never)
  new DshellFileSystem(ctx, { cwd: hostCwd, diffBasisMaxBytes: 1024 }, translate)
  return ctx
}

/**
 * Answer every device question without a device, and record what was asked.
 *
 * The probe sits on the lane, so the path it records is the one the device
 * itself would have been asked about — after the seam's own translation.
 */
function stubDevice(): void {
  vi.spyOn(ShellFsTransport.prototype, 'resolve').mockImplementation(async (path: string) => path)
  vi.spyOn(ShellFsTransport.prototype, 'stat')
    .mockResolvedValue({ kind: 'file', size: 12, version: FsVersion('v1') })
}

/** The device paths the lane was asked about. */
function devicePaths(): string[] {
  return vi.mocked(ShellFsTransport.prototype.resolve).mock.calls.map(call => call[0])
}

describe('a browser-initiated read of a device file', () => {
  it('is answered by the device, not by this machine', async () => {
    const ctx = contextWithDevice()
    stubDevice()

    const reader = new WorkspaceReader(ctx)
    const receiver = ctx.extend({ invocation: ambientCall(DEVICE_SESSION) }).get('workspaceReader') as WorkspaceReader
    await receiver.read(hostCwd, '/root/.bashrc')

    // The workspace root the scope named is this machine's directory, and the
    // device's answer to it is the device's own root.
    expect(devicePaths()).toContain('/root')
    expect(devicePaths()).toContain('/root/.bashrc')
  })

  it('is answered by this machine when the call names no session', async () => {
    const ctx = contextWithDevice()
    stubDevice()

    const reader = new WorkspaceReader(ctx)
    const receiver = ctx.get('workspaceReader') as WorkspaceReader
    await receiver.read(hostCwd, '/root/.bashrc')

    expect(devicePaths()).toEqual([])
  })

  it('is answered by this machine when the named session runs here', async () => {
    const ctx = contextWithDevice()
    stubDevice()

    const reader = new WorkspaceReader(ctx)
    const receiver = ctx.extend({ invocation: ambientCall(LOCAL_SESSION) }).get('workspaceReader') as WorkspaceReader
    await receiver.read(hostCwd, '/root/.bashrc')

    expect(devicePaths()).toEqual([])
  })

  it('is answered by this machine when the named session cannot be resolved', async () => {
    const ctx = contextWithDevice()
    stubDevice()

    const reader = new WorkspaceReader(ctx)
    const receiver = ctx.extend({ invocation: ambientCall('s-unknown') }).get('workspaceReader') as WorkspaceReader
    await reader.read(hostCwd, '/root/.bashrc')

    expect(devicePaths()).toEqual([])
  })

  it('keeps the initiator the tool layer set', async () => {
    const ctx = contextWithDevice()
    stubDevice()

    const reader = new WorkspaceReader(ctx)
    // The tool layer's own session is the one that decides: the ambient scope
    // of a different session must not take the call away from it.
    const receiver = ctx.extend({ invocation: ambientCall(LOCAL_SESSION) }).get('workspaceReader') as WorkspaceReader
    await ctx.agents.withInitiator(
      { id: DEVICE_SESSION, session: { header: { cwd: hostCwd } } } as never,
      async () => await receiver.read(hostCwd, '/root/.bashrc'),
    )

    expect(devicePaths()).toContain('/root/.bashrc')
  })
})
