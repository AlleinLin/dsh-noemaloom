/**
 * A pipe endpoint's label names the world it stands in.
 *
 * A bound session's own cwd is the directory it was created in on this
 * machine — the mount's stand-in — while its shell and file tools answer from
 * the device. The panel used to print that stand-in beside the peer's title,
 * which reads as "this pipe ends in /home/reader" for a peer that lives on a
 * device; the snapshot therefore carries the device root per endpoint, and
 * these cases pin what goes in it.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { DSHELL_HOME_ENV } from '@nexus-aethra/dshell-std'
import { BufferService } from '../src/service.js'
import type { DshellBufferHostTranslate } from '../src/host-locales.js'

let home = ''
let saved: string | undefined

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dshell-worlds-'))
  saved = process.env[DSHELL_HOME_ENV]
  process.env[DSHELL_HOME_ENV] = home
})

afterEach(() => {
  if (saved === undefined) delete process.env[DSHELL_HOME_ENV]
  else process.env[DSHELL_HOME_ENV] = saved
  rmSync(home, { recursive: true, force: true })
})

/** One fake composition; the routing seat is the only thing under test. */
function harness(routing: unknown): BufferService {
  const ctx = {
    get: (key: unknown) => (key === 'dshellSshRouting' ? routing : undefined),
    inject: () => {},
    on: () => () => {},
  } as unknown as Context
  const translate = ((key: string) => key) as DshellBufferHostTranslate
  return new BufferService(ctx, translate)
}

/** One pipe, so the snapshot has endpoints to place. */
function withOneLink(service: BufferService): void {
  const inner = service as unknown as { links: unknown[] }
  inner.links = [{ id: 'link_x', a: 'session-here', b: 'session-there' }]
}

describe('the pipe snapshot names each endpoint\'s world', () => {
  it('gives a bound endpoint its device root, not the host stand-in', () => {
    const service = harness({
      assignmentForSession: (id: string) =>
        id === 'session-there' ? { deviceId: 'dev-a', remoteRoot: '/root' } : undefined,
      deviceFor: () => ({ remoteRoot: '/root' }),
    })
    withOneLink(service)
    expect(service.snapshot().worlds).toEqual({ 'session-there': '/root' })
  })

  it('falls back to the device record when the binding names only the login dir', () => {
    const service = harness({
      assignmentForSession: (id: string) =>
        id === 'session-there' ? { deviceId: 'dev-a', remoteRoot: '~' } : undefined,
      deviceFor: () => ({ remoteRoot: '/srv' }),
    })
    withOneLink(service)
    expect(service.snapshot().worlds).toEqual({ 'session-there': '/srv' })
  })

  it('leaves an unbound endpoint out, so its label keeps the cwd', () => {
    const service = harness({ assignmentForSession: () => undefined })
    withOneLink(service)
    expect(service.snapshot().worlds).toEqual({})
  })

  it('is empty where no ssh package is composed', () => {
    const service = harness(undefined)
    withOneLink(service)
    expect(service.snapshot().worlds).toEqual({})
  })
})
