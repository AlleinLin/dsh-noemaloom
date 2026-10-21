/**
 * One bindings document, every host on the machine.
 *
 * The web host and the desktop host run side by side over the same data root,
 * so the document is a shared file, not one host's state. A store that caches
 * it at startup and writes the cache back whole turns the other host's binds
 * into deletions — a session silently loses its device and its terminal keeps
 * the shell it already had, which reads as "the pill lies". Every mutation is
 * therefore a read-modify-write, and every listing re-reads: these cases run
 * two routers over one document, the way the machine runs two hosts.
 */

import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DSHELL_HOME_ENV } from '@nexus-aethra/dshell-std'
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
  home = await mkdtemp(join(tmpdir(), 'dshell-shared-'))
  saved = process.env[DSHELL_HOME_ENV]
  process.env[DSHELL_HOME_ENV] = home
  await mkdir(join(home, 'dshell', 'ssh'), { recursive: true })
  await writeFile(join(home, 'dshell', 'ssh', 'devices.json'), JSON.stringify(DEVICES), 'utf8')
})

afterEach(() => {
  if (saved === undefined) delete process.env[DSHELL_HOME_ENV]
  else process.env[DSHELL_HOME_ENV] = saved
})

/** A host: a router over the shared root, with its startup load settled. */
async function host(): Promise<SshRouter> {
  const router = new SshRouter(() => join(home, 'dshell', 'ssh'))
  router.bindCopy(translate)
  await router.list()
  return router
}

/** The document on disk, as the next start — or the other host — sees it. */
async function document(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(home, 'dshell', 'ssh', 'bindings.json'), 'utf8')) as
    Record<string, unknown>
}

describe('two hosts over one bindings document', () => {
  it('keeps a binding the other host wrote after this one started', async () => {
    const first = await host()
    const second = await host()
    await first.bind('session-a', 'dev-a')
    await second.bind('session-b', 'dev-a')
    expect(Object.keys(await document()).sort()).toEqual(['session-a', 'session-b'])
    expect((await first.assignments()).map(entry => entry.sessionId).sort()).toEqual([
      'session-a',
      'session-b',
    ])
  })

  it('keeps the other host\'s binding when this one releases its own', async () => {
    const first = await host()
    const second = await host()
    await first.bind('session-a', 'dev-a')
    await second.bind('session-b', 'dev-a')
    await second.bind('session-b', null)
    expect(Object.keys(await document())).toEqual(['session-a'])
  })

  it('answers a binding the other host wrote without a local mutation', async () => {
    const first = await host()
    const second = await host()
    await first.bind('session-a', 'dev-a')
    // The pill is drawn from this listing; a stale cache here is a pill that
    // names the wrong machine until something happens to refresh it.
    expect((await second.assignments()).map(entry => entry.sessionId)).toEqual(['session-a'])
  })

  it('keeps a startup mount backfill from deleting the other host\'s rows', async () => {
    // A binding written before mounts existed, stored while no host is up.
    await writeFile(
      join(home, 'dshell', 'ssh', 'bindings.json'),
      JSON.stringify({ 'session-old': { deviceId: 'dev-a', remoteRoot: '/srv' } }),
      'utf8',
    )
    const first = await host()
    // The second host starts later and backfills nothing (the mount is there),
    // then binds: the old row must survive both the backfill and the bind.
    const second = await host()
    await second.bind('session-b', 'dev-a')
    expect(Object.keys(await document()).sort()).toEqual(['session-b', 'session-old'])
    expect((await first.assignments()).map(entry => entry.sessionId).sort()).toEqual([
      'session-b',
      'session-old',
    ])
  })
})
