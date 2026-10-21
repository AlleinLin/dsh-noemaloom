import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { BlockLog } from '../src/blocks.js'

describe('BlockLog command carriers', () => {
  it('persists separate command identities between shell regions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dshell-blocks-'))
    try {
      const path = join(dir, 'blocks.json')
      const log = new BlockLog(path)
      log.append('before', 10)
      log.startTurn(undefined, 20, 'permission-1')
      log.endTurn(21)
      log.append('middle', 30)
      log.startTurn(undefined, 40, 'compact-1')
      log.endTurn(41)
      log.append('after', 50)
      await log.flush()
      const restored = new BlockLog(path)
      await restored.load()
      expect(restored.snapshot()).toEqual(log.snapshot())
      expect(restored.snapshot().filter(block => block.kind === 'agent').map(block => block.commandId))
        .toEqual(['permission-1', 'compact-1'])
      expect(restored.append('tail', 60).seq).toBe(5)
      await restored.flush()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('loads existing carriers without treating absent identities as equal', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dshell-blocks-'))
    try {
      const path = join(dir, 'blocks.json')
      await writeFile(path, JSON.stringify([
        { seq: 1, kind: 'agent', startedAt: 20, endedAt: 21, text: '' },
        { seq: 2, kind: 'shell', startedAt: 30, text: 'after' },
      ]))
      const log = new BlockLog(path)
      await log.load()
      expect(log.snapshot()[0]?.commandId).toBeUndefined()
      expect(log.startTurn(undefined, 40, 'compact-1').commandId).toBe('compact-1')
      await log.flush()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
