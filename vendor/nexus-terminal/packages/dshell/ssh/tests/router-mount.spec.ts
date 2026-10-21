/**
 * A binding always carries the mapping its file operations need.
 *
 * The shell seam routes by device alone, but the filesystem seam refuses to
 * guess: a binding with no `mount` leaves every `ctx.fs` call on this machine
 * while the terminal beside it answers from the device. No caller ever named a
 * mount — the derivation is the router's — so these cases pin both halves of it:
 * the bind that derives one, and the load that gives an already-stored binding
 * the mapping it was written without.
 */

import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DSHELL_HOME_ENV } from '@nexus-aethra/dshell-std'
import { mountBase } from '../src/paths.js'
import { SshRouter } from '../src/router.js'
import type { DshellSshTranslate } from '../src/host-locales.js'

/** A translator that answers with the key; the refusals are not what is under test. */
const translate = ((key: string): string => key) as DshellSshTranslate

/** One device document, with the directory a session on it runs in. */
const DEVICES = {
  devices: [
    { id: 'dev-a', name: 'A', host: '10.0.0.1', port: 22, user: 'root', remoteRoot: '/srv', auth: 'key' },
  ],
}

let home = ''
let saved: string | undefined

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'dshell-router-'))
  saved = process.env[DSHELL_HOME_ENV]
  process.env[DSHELL_HOME_ENV] = home
  await mkdir(join(home, 'dshell', 'ssh'), { recursive: true })
  await writeFile(join(home, 'dshell', 'ssh', 'devices.json'), JSON.stringify(DEVICES), 'utf8')
})

afterEach(() => {
  if (saved === undefined) delete process.env[DSHELL_HOME_ENV]
  else process.env[DSHELL_HOME_ENV] = saved
})

/** A router over the fixture, with its one-time load settled. */
async function settled(bindings?: unknown): Promise<SshRouter> {
  if (bindings !== undefined) {
    await writeFile(join(home, 'dshell', 'ssh', 'bindings.json'), JSON.stringify(bindings), 'utf8')
  }
  const router = new SshRouter(() => join(home, 'dshell', 'ssh'))
  router.bindCopy(translate)
  // The load runs in the constructor; this is the first call that waits for it.
  await router.list()
  return router
}

/** The stored assignments, as the next start will read them. */
async function document(): Promise<Record<string, { mount?: string }>> {
  return JSON.parse(await readFile(join(home, 'dshell', 'ssh', 'bindings.json'), 'utf8')) as
    Record<string, { mount?: string }>
}

describe('a bind derives the mount', () => {
  it('takes the device tree when the caller names none', async () => {
    const router = await settled()
    await router.bind('session-1', 'dev-a')
    const [entry] = await router.assignments()
    expect(entry?.mount).toBe(join(mountBase(), 'dev-a', 'srv'))
    // The stand-in has to exist: a session bound after its creation has nothing
    // else that would make it, and the file seam addresses it.
    expect((await stat(entry!.mount!)).isDirectory()).toBe(true)
  })

  it('takes the session root when the caller named one', async () => {
    const router = await settled()
    await router.bind('session-2', 'dev-a', '/srv/app')
    const [entry] = await router.assignments()
    expect(entry?.mount).toBe(join(mountBase(), 'dev-a', 'srv', 'app'))
  })

  it('keeps a mount the caller did name', async () => {
    const router = await settled()
    const named = join(home, 'elsewhere')
    await router.bind('session-3', 'dev-a', null, named)
    const [entry] = await router.assignments()
    expect(entry?.mount).toBe(named)
  })

  it('drops the assignment, and its mapping with it, on a local bind', async () => {
    const router = await settled()
    await router.bind('session-4', 'dev-a')
    await router.bind('session-4', null)
    expect(await router.assignments()).toEqual([])
  })
})

describe('a load adopts the mappings it is missing', () => {
  it('gives a stored binding the mount its device implies', async () => {
    const router = await settled({ 'session-old': { deviceId: 'dev-a', remoteRoot: '/srv' } })
    const [entry] = await router.assignments()
    expect(entry?.mount).toBe(join(mountBase(), 'dev-a', 'srv'))
    // Written down, not merely answered: the point is that the NEXT start does
    // not have to derive it again, and neither does a reader of the document.
    expect((await document())['session-old']?.mount).toBe(join(mountBase(), 'dev-a', 'srv'))
  })

  it('uses the device directory for a binding that named no root', async () => {
    const router = await settled({ 'session-bare': { deviceId: 'dev-a' } })
    const [entry] = await router.assignments()
    expect(entry?.mount).toBe(join(mountBase(), 'dev-a', 'srv'))
  })

  it('leaves a mapping that was recorded alone', async () => {
    const kept = join(home, 'recorded')
    const router = await settled({ 'session-kept': { deviceId: 'dev-a', remoteRoot: '/srv', mount: kept } })
    const [entry] = await router.assignments()
    expect(entry?.mount).toBe(kept)
  })

  it('leaves a binding whose device is gone alone', async () => {
    // Inventing a directory name for a device nothing can reach would only add
    // a mapping no seam can honour.
    const router = await settled({ 'session-ghost': { deviceId: 'dev-ghost' } })
    const [entry] = await router.assignments()
    expect(entry?.mount).toBeUndefined()
    expect((await document())['session-ghost']?.mount).toBeUndefined()
  })
})
