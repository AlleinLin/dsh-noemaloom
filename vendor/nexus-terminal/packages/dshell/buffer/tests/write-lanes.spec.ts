/**
 * The three lanes `writeBytesAs` chooses between, and why the middle one exists.
 *
 * A buffer transfer ends by writing bytes into ONE session's world, and the
 * world decides how: a device with its helper up stages them through
 * `deviceFs`, a device WITHOUT a helper takes them over the shell seam as
 * base64 on stdin, and a session that runs here writes here. The dangerous
 * confusion is that `ctx.fs.processPath` spells a DEVICE path for a device
 * world — so the in-process `node:fs` lane, reached by mistake, would create
 * that spelling on THIS machine instead of failing: a device session silently
 * writing the host's filesystem is the one thing the whole package forbids.
 *
 * These specs pin the lane choice itself, because the live harness always has
 * a helper up and therefore never walks the middle lane.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { DSHELL_HOME_ENV, DEVICE_FS_SERVICE, type DeviceFsOps } from '@nexus-aethra/dshell-std'
import { BufferService } from '../src/service.js'

interface ShellCall {
  readonly command: string
  readonly stdin: string | undefined
  readonly workdir: string | undefined
}

interface World {
  readonly id: string
  readonly session: { readonly header: { readonly cwd: string } }
}

interface Harness {
  readonly ctx: Context
  readonly shellCalls: ShellCall[]
  readonly opsCalls: string[]
}

/**
 * One fake composition.
 * @param options - `deviceOps` answers `deviceFs.forInitiator()`; `bound` makes
 *   the router report the session as a device session.
 */
function harness(options: { deviceOps: DeviceFsOps | undefined; bound: boolean; opsCalls: string[] }): Harness {
  const shellCalls: ShellCall[] = []
  const shell = {
    resolve: (spec: { command: string; workdir?: string }) => spec,
    execute: async (spec: { command: string; workdir?: string; stdin?: string }) => {
      shellCalls.push({ command: spec.command, stdin: spec.stdin, workdir: spec.workdir })
      return { result: async () => ({ exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }) }
    },
  }
  const ctx = {
    get: (key: unknown) => {
      if (key === 'shell') return shell
      if (key === DEVICE_FS_SERVICE) {
        return options.deviceOps === undefined ? undefined : { forInitiator: () => options.deviceOps }
      }
      if (key === 'dshellSshRouting') {
        return { targetForSession: () => (options.bound ? { remoteRoot: '/root', mount: '/mnt/dev/root' } : undefined) }
      }
      return undefined
    },
    inject: () => {},
    on: () => () => {},
    fs: { processPath: (target: { path: string }) => target.path },
    agents: { withInitiator: <T>(_world: unknown, fn: () => T): T => fn() },
  } as unknown as Context
  return { ctx, shellCalls, opsCalls: options.opsCalls }
}

const BYTES = new Uint8Array(Buffer.from('lane-bytes-77'))

/** The service's private writer, reached directly: the lanes are the unit. */
function writeBytesAs(service: BufferService, world: World, path: string): Promise<void> {
  const inner = service as unknown as {
    writeBytesAs(world: World, target: { path: string; targetKey: string }, bytes: Uint8Array): Promise<void>
  }
  return inner.writeBytesAs(world, { path, targetKey: path }, BYTES)
}

const DEVICE: World = { id: 'session-device', session: { header: { cwd: '/root' } } }
const LOCAL: World = { id: 'session-local', session: { header: { cwd: '/home/reader' } } }

let home = ''

afterEach(() => {
  if (home.length > 0) rmSync(home, { recursive: true, force: true })
  home = ''
  delete process.env[DSHELL_HOME_ENV]
})

/** One service over an empty, throwaway harness home. */
function service(h: Harness): BufferService {
  home = mkdtempSync(join(tmpdir(), 'dshell-buffer-lanes-'))
  process.env[DSHELL_HOME_ENV] = home
  return new BufferService(h.ctx, ((key: string) => key) as never)
}

describe('writeBytesAs lanes', () => {
  it('a device with its helper stages the bytes through deviceFs', async () => {
    const opsCalls: string[] = []
    const ops = {
      mkdir: async (paths: string[], recursive: boolean) => { opsCalls.push(`mkdir ${paths.join(',')} ${String(recursive)}`) },
      writeBytes: async (path: string, bytes: Uint8Array) => { opsCalls.push(`write ${path} ${String(bytes.length)}`) },
      sha256: async () => '',
    } as unknown as DeviceFsOps
    const h = harness({ deviceOps: ops, bound: true, opsCalls })
    await writeBytesAs(service(h), DEVICE, '/root/in/deep.bin')
    expect(opsCalls).toEqual(['mkdir /root/in true', 'write /root/in/deep.bin 13'])
    expect(h.shellCalls).toEqual([])
  })

  it('a device without a helper takes the shell seam, never node:fs', async () => {
    const h = harness({ deviceOps: undefined, bound: true, opsCalls: [] })
    const svc = service(h)
    const target = join(home, 'device-spelled.bin')
    await writeBytesAs(svc, DEVICE, target)
    expect(h.shellCalls).toHaveLength(1)
    expect(h.shellCalls[0]?.command).toContain('base64 -d >')
    expect(h.shellCalls[0]?.command).toContain(target)
    expect(h.shellCalls[0]?.stdin).toEqual(Buffer.from(BYTES).toString('base64'))
    expect(h.shellCalls[0]?.workdir).toEqual('/root')
    // The node:fs lane would have created exactly this file on this machine.
    expect(existsSync(target)).toBe(false)
  })

  it('a session that runs here writes here', async () => {
    const h = harness({ deviceOps: undefined, bound: false, opsCalls: [] })
    const svc = service(h)
    const target = join(home, 'local.bin')
    await writeBytesAs(svc, LOCAL, target)
    expect(h.shellCalls).toEqual([])
    expect(readFileSync(target)).toEqual(Buffer.from(BYTES))
  })
})
