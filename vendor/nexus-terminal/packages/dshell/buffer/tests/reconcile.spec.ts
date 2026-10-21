/**
 * The boot reconciliation: pipes whose session dsh's catalog no longer lists
 * are settled and dropped, and pipes whose session is merely not opened since
 * the last start are left exactly alone.
 *
 * The catalog is the cold listing dsh's own sidebar is built from, so the
 * dangerous confusion is a session that exists but is not materialized — which
 * is exactly what a terminal session is until somebody opens it. The other
 * half of the rule is that an unanswered catalog (absent, or throwing) changes
 * nothing: no answer and an empty answer are different facts.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { DSHELL_HOME_ENV } from '@nexus-aethra/dshell-std'
import { BufferService } from '../src/service.js'

const GONE = 'session-gone'
const KEPT = 'session-kept'
const IDLE = 'session-idle-but-alive'

let home = ''

afterEach(() => {
  if (home.length > 0) rmSync(home, { recursive: true, force: true })
  home = ''
  delete process.env[DSHELL_HOME_ENV]
})

/** One service over a state document this spec wrote itself. */
function service(catalog: readonly string[] | undefined | 'throw'): BufferService {
  home = mkdtempSync(join(tmpdir(), 'dshell-buffer-reconcile-'))
  const root = join(home, 'dshell', 'buffer')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'state.json'), `${JSON.stringify({
    version: 1,
    links: [
      { id: 'link-dead', a: GONE, b: KEPT, createdAt: 1 },
      { id: 'link-live', a: KEPT, b: IDLE, createdAt: 2 },
    ],
    tickets: [],
    grants: [],
  }, null, 2)}\n`)
  process.env[DSHELL_HOME_ENV] = home
  const ctx = {
    get: (key: unknown) => {
      if (key !== 'sessionQuery') return undefined
      if (catalog === undefined) return undefined
      if (catalog === 'throw') return { listSessions: async () => { throw new Error('catalog down') } }
      return { listSessions: async () => catalog.map(id => ({ header: { id } })) }
    },
    inject: () => {},
    on: () => () => {},
  } as unknown as Context
  return new BufferService(ctx, ((key: string) => key) as never)
}

/** The links the service persisted back. */
function persistedLinks(): readonly { id: string }[] {
  const parsed = JSON.parse(readFileSync(join(home, 'dshell', 'buffer', 'state.json'), 'utf8')) as {
    links: readonly { id: string }[]
  }
  return parsed.links
}

describe('reconcile', () => {
  it('drops the pipes of sessions the catalog no longer lists', async () => {
    const svc = service([KEPT, IDLE])
    await svc.reconcile()
    expect(svc.snapshot().links.map(link => link.id)).toEqual(['link-live'])
    expect(persistedLinks().map(link => link.id)).toEqual(['link-live'])
    expect(svc.snapshot().departed).toContain(GONE)
    expect(svc.snapshot().departed).not.toContain(IDLE)
  })

  it('leaves every pipe alone when the catalog cannot answer', async () => {
    for (const catalog of [undefined, 'throw'] as const) {
      const svc = service(catalog)
      await svc.reconcile()
      expect(svc.snapshot().links.map(link => link.id).sort()).toEqual(['link-dead', 'link-live'])
      expect(persistedLinks().map(link => link.id).sort()).toEqual(['link-dead', 'link-live'])
    }
  })
})
