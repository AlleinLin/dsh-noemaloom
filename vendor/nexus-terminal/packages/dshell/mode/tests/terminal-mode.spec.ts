/**
 * The terminal-session identity table: what it writes, what it adopts, and what
 * it refuses to lose.
 *
 * These specs use a REAL directory under `os.tmpdir()`, because every claim
 * here is a claim about files — that a write leaves no temp file behind, that a
 * document a crash truncated is set aside instead of being replaced with an
 * empty table, that an id-list document from before the table existed is
 * adopted rather than ignored.
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createTerminalModeRoute, TerminalModeRegistry } from '../src/terminal-mode.js'
import { DSHELL_TERMINAL_MODE_PATH } from '../src/terminal-mode-protocol.js'

/** Every directory a spec made, removed afterwards. */
const made: string[] = []

afterEach(() => {
  for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true })
})

/** A registry over a fresh document in its own scratch directory. */
function table(document = 'terminal-mode.json', deps?: {
  catalog?: () => Promise<readonly string[] | undefined>
  onOrphan?: (ids: readonly string[]) => void
}): { registry: TerminalModeRegistry; file: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dshell-terminal-mode-'))
  made.push(dir)
  const file = join(dir, document)
  return { registry: new TerminalModeRegistry(file, '/home/u', deps), file, dir }
}

/** The document as JSON, or undefined when there is none. */
function read(file: string): Record<string, unknown> | undefined {
  if (!existsSync(file)) return undefined
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
}

describe('the identity table on disk', () => {
  it('starts empty, and writes one record with the facts it was given', async () => {
    const { registry, file } = table()
    await registry.load()
    expect(registry.list()).toEqual([])

    await registry.set('session-a', true, { origin: 'section', cwd: '/home/u', title: '终端会话 21:28' })
    const record = registry.record('session-a')
    expect(record?.origin).toBe('section')
    expect(record?.cwd).toBe('/home/u')
    expect(record?.title).toBe('终端会话 21:28')
    expect(typeof record?.createdAt).toBe('number')

    const body = read(file)
    expect(body?.version).toBe(2)
    expect(body?.records).toEqual([record])
    // One write leaves one file: the temp name is renamed, not left behind.
    expect(readdirSync(join(file, '..'))).toEqual(['terminal-mode.json'])
  })

  it('keeps the facts a record already has when a later write omits them', async () => {
    const { registry } = table()
    await registry.set('session-a', true, { origin: 'section', cwd: '/home/u', title: '终端会话 21:28' })
    await registry.setMode('session-a', 'agent')
    await registry.markStarted('session-a')

    const record = registry.record('session-a')
    expect(record).toMatchObject({ origin: 'section', cwd: '/home/u', title: '终端会话 21:28', mode: 'agent', started: true })
  })

  it('drops the record when a session stops being a terminal session', async () => {
    const { registry, file } = table()
    await registry.set('session-a', true, { origin: 'section' })
    await registry.set('session-a', false)
    expect(registry.isOn('session-a')).toBe(false)
    expect(read(file)?.records).toEqual([])
  })

  it('patches one record and leaves the others alone', async () => {
    const { registry } = table()
    await registry.set('session-a', true, { origin: 'section' })
    await registry.set('session-b', true, { origin: 'workspace' })
    await registry.setArchived('session-a', true)

    expect(registry.record('session-a')?.archived).toBe(true)
    expect(registry.record('session-b')?.archived).toBeUndefined()
    expect(registry.snapshot()).toEqual(['session-a', 'session-b'])
  })

  it('clears the archive bit again, in the document and not just in memory', async () => {
    const { registry, file } = table()
    await registry.set('session-a', true, { origin: 'section' })
    await registry.setArchived('session-a', true)
    await registry.setArchived('session-a', false)

    expect(registry.record('session-a')?.archived).toBeUndefined()
    // Absence is the off state, so the key must be GONE: an `archived: false`
    // left in the document would be re-read as a record that says something.
    const body = read(file)
    expect(JSON.stringify(body?.records)).not.toContain('archived')
  })

  it('writes nothing for a session it has no record of', async () => {
    const { registry, file } = table()
    await registry.set('session-a', true, { origin: 'section' })
    const before = readFileSync(file, 'utf8')
    await registry.setMode('session-missing', 'agent')
    await registry.setTitle('session-missing', 'nope')
    expect(readFileSync(file, 'utf8')).toBe(before)
  })

  it('lands both of two mutations made at once', async () => {
    const { registry } = table()
    await registry.set('session-a', true, { origin: 'section' })
    // The document is rewritten whole, so two overlapping read-modify-write
    // cycles would each drop the other's field; the chain is what prevents it.
    await Promise.all([
      registry.set('session-b', true, { origin: 'workspace' }),
      registry.setArchived('session-a', true),
      registry.useWorkspace('workspace-1'),
      registry.setFolded(true),
    ])
    expect(registry.snapshot()).toEqual(['session-a', 'session-b'])
    expect(registry.record('session-a')?.archived).toBe(true)
    expect(registry.workspaceId).toBe('workspace-1')
    expect(registry.folded).toBe(true)
  })
})

describe('a document from before the table existed', () => {
  it('is adopted, with the archive and started bits carried onto the records', async () => {
    const { registry, file } = table()
    writeFileSync(file, `${JSON.stringify({
      sessions: ['session-old', 'session-kept'],
      archived: ['session-old'],
      started: ['session-kept'],
      workspaceId: 'workspace-9',
      folded: true,
    }, null, 2)}\n`)

    await registry.load()
    expect(registry.snapshot()).toEqual(['session-old', 'session-kept'])
    expect(registry.record('session-old')).toMatchObject({ origin: 'legacy', archived: true })
    expect(registry.record('session-kept')).toMatchObject({ origin: 'legacy', started: true })
    expect(registry.workspaceId).toBe('workspace-9')
    expect(registry.folded).toBe(true)

    // The next write is the migration: the document becomes version 2.
    await registry.setFolded(false)
    expect(read(file)?.version).toBe(2)
    expect(read(file)?.records).toEqual(registry.list())
  })

  it('ignores entries that are not records', async () => {
    const { registry, file } = table()
    writeFileSync(file, `${JSON.stringify({
      version: 2,
      records: [
        { sessionId: 'session-a', origin: 'section', createdAt: 1 },
        { sessionId: 'session-b', origin: 'elsewhere', createdAt: 2 },
        { origin: 'section', createdAt: 3 },
        'session-c',
        { sessionId: 'session-a', origin: 'workspace', createdAt: 4 },
      ],
      orphans: [],
    })}\n`)
    await registry.load()
    expect(registry.snapshot()).toEqual(['session-a'])
    expect(registry.record('session-a')?.createdAt).toBe(1)
  })
})

describe('a document that cannot be read', () => {
  it('is set aside and reported, not replaced with an empty table', async () => {
    const { registry, file } = table()
    await registry.set('session-a', true, { origin: 'section', title: '终端会话 21:28' })
    // What a crash mid-write leaves: half a document.
    writeFileSync(file, '{"version":2,"records":[{"sessionId":"session-a"')

    const fresh = new TerminalModeRegistry(file, '/home/u')
    await expect(fresh.load()).rejects.toThrow(/could not be read and was set aside/)
    expect(existsSync(file)).toBe(false)
    expect(existsSync(`${file}.unreadable`)).toBe(true)
    // The bytes are still there to be recovered by hand.
    expect(readFileSync(`${file}.unreadable`, 'utf8')).toContain('session-a')
  })

  it('is an empty table when there is no document at all', async () => {
    const { registry } = table()
    await expect(registry.load()).resolves.toBeUndefined()
    expect(registry.list()).toEqual([])
  })
})

describe('reconciling against the sessions dsh still has', () => {
  it('moves a deleted session aside and reports it', async () => {
    const orphans: string[][] = []
    const { registry, file } = table('terminal-mode.json', {
      catalog: async () => ['session-a'],
      onOrphan: (ids) => { orphans.push([...ids]) },
    })
    await registry.set('session-a', true, { origin: 'section' })
    await registry.set('session-b', true, { origin: 'section', title: '终端会话 22:00' })

    expect(await registry.reconcile()).toEqual(['session-b'])
    expect(registry.snapshot()).toEqual(['session-a'])
    expect(orphans).toEqual([['session-b']])
    // Set aside, not deleted: the record and its name are still on disk.
    expect(read(file)?.orphans).toEqual([
      expect.objectContaining({ sessionId: 'session-b', title: '终端会话 22:00' }),
    ])
  })

  it('drops the orphans only on the next reconciliation that still misses them', async () => {
    const { registry, file } = table('terminal-mode.json', { catalog: async () => ['session-a'] })
    await registry.set('session-a', true, { origin: 'section' })
    await registry.set('session-b', true, { origin: 'section' })
    await registry.reconcile()
    await registry.reconcile()
    expect(read(file)?.orphans).toEqual([])
  })

  it('restores nothing when the catalog cannot answer, and changes nothing', async () => {
    for (const catalog of [
      async () => undefined,
      async (): Promise<readonly string[]> => { throw new Error('query engine unavailable') },
    ]) {
      const { registry, file } = table('terminal-mode.json', { catalog })
      await registry.set('session-a', true, { origin: 'section' })
      expect(await registry.reconcile()).toEqual([])
      expect(registry.snapshot()).toEqual(['session-a'])
      expect(read(file)?.orphans).toEqual([])
    }
  })

  it('does nothing at all when no catalog was wired', async () => {
    const { registry } = table()
    await registry.set('session-a', true, { origin: 'section' })
    expect(await registry.reconcile()).toEqual([])
    expect(registry.snapshot()).toEqual(['session-a'])
  })
})

describe('the route', () => {
  /** One request through the route, decoded. */
  async function call(
    registry: TerminalModeRegistry,
    body?: Record<string, unknown>,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const route = createTerminalModeRoute(registry, { onStart: (id) => { started.push(id) } })
    const request = new Request(`http://host${DSHELL_TERMINAL_MODE_PATH}`, body === undefined
      ? { method: 'GET' }
      : { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
    const response = await route.fetch(request)
    return { status: response.status, body: await response.json() as Record<string, unknown> }
  }
  const started: string[] = []

  it('reports the table, the workspace, the fold and the root', async () => {
    const { registry } = table()
    await registry.set('session-a', true, { origin: 'section', cwd: '/home/u' })
    await registry.useWorkspace('workspace-1')
    const answer = await call(registry)
    expect(answer.status).toBe(200)
    expect(answer.body).toEqual({
      records: registry.list(),
      workspaceId: 'workspace-1',
      folded: false,
      root: '/home/u',
    })
  })

  it('writes every mutation it is asked for', async () => {
    const { registry } = table()
    await call(registry, { action: 'set', sessionId: 'session-a', on: true, origin: 'section', cwd: '/home/u' })
    await call(registry, { action: 'mode', sessionId: 'session-a', mode: 'agent' })
    await call(registry, { action: 'title', sessionId: 'session-a', title: '终端会话 21:28' })
    await call(registry, { action: 'archive', sessionId: 'session-a', archived: true })
    await call(registry, { action: 'fold', folded: true })
    await call(registry, { action: 'workspace', workspaceId: 'workspace-1' })

    expect(registry.record('session-a')).toMatchObject({
      origin: 'section', cwd: '/home/u', mode: 'agent', title: '终端会话 21:28', archived: true,
    })
    expect(registry.folded).toBe(true)
    expect(registry.workspaceId).toBe('workspace-1')
  })

  it('reports a start, and hands the session to the host callback', async () => {
    started.length = 0
    const { registry } = table()
    await call(registry, { action: 'set', sessionId: 'session-a', on: true, origin: 'section' })
    await call(registry, { action: 'start', sessionId: 'session-a' })
    expect(started).toEqual(['session-a'])
    expect(registry.record('session-a')?.started).toBe(true)
  })

  it('refuses a request it cannot act on, and still reports the table', async () => {
    const { registry } = table()
    await registry.set('session-a', true, { origin: 'section' })
    expect((await call(registry, { action: 'nonsense' })).status).toBe(400)
    expect((await call(registry, { action: 'set' })).status).toBe(400)
    // A mode that is not one of the two is not written.
    expect((await call(registry, { action: 'mode', sessionId: 'session-a', mode: 'turbo' })).status).toBe(400)
    expect(registry.record('session-a')?.mode).toBeUndefined()
    expect((await call(registry)).body.records).toEqual(registry.list())
  })
})
