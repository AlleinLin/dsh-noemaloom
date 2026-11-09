import { describe, expect, it } from 'vitest'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { PtyBlock } from '@nexus-aethra/dshell-terminal-bridge/client'
import { assembleTimeline } from '../src/client/block-model.js'
import { createFold, emptyBlock, type BlockFold } from '../src/client/blocks.js'
import type { TurnBlock } from '../src/client/blocks.js'
import type { ViewItem } from '../src/client/block-model.js'

const t = ((key: string) => key) as TranslateNS<'dshellMode'>

/**
 * The shape the timeline used to be assembled in, kept here as the oracle.
 *
 * It scanned every folded block for every host carrier and inserted each
 * unmatched block into the growing array one at a time. The production code
 * does the same work with an index and a sort; this copy is what proves the
 * two agree, on shapes the hand-written cases do not reach.
 */
function legacyAssemble(hostBlocks: readonly PtyBlock[], fold: { readonly blocks: readonly TurnBlock[] }): ViewItem[] {
  const items: ViewItem[] = []
  const used = new Set<string>()
  const agentItemOf = (block: TurnBlock): ViewItem | undefined => {
    if (block.rows.length > 0 && block.steps === 0 && block.stream === undefined
      && block.rows.every(row => row.role === 'command')) {
      const [head, ...rest] = block.rows.map(row => row.text)
      return { kind: 'command', key: block.key, time: block.startedAt, text: [`/${head ?? ''}`, ...rest].join(' · ') }
    }
    if (block.rows.length === 0 && block.stream === undefined && block.steps === 0
      && block.tokens === 0 && block.status !== 'running') {
      return undefined
    }
    return { kind: 'agent', key: block.key, time: block.startedAt, block }
  }
  const visible = (text: string): boolean => text.replace(/\s/gu, '').length > 0
  for (const host of hostBlocks) {
    if (host.kind === 'shell') {
      if (visible(host.text)) {
        items.push({ kind: 'shell', key: `shell:${String(host.seq)}`, time: host.startedAt, text: host.text })
      }
      continue
    }
    for (const block of fold.blocks) {
      const matches = host.turn === undefined
        ? host.commandId !== undefined && block.commandId === host.commandId
        : block.turn === host.turn
      if (!matches || used.has(block.key)) continue
      used.add(block.key)
      const item = agentItemOf(block)
      if (item !== undefined) items.push(item)
    }
  }
  for (const block of fold.blocks) {
    if (used.has(block.key)) continue
    used.add(block.key)
    const node = agentItemOf(block)
    if (node === undefined) continue
    const at = items.findIndex(item => item.time > block.startedAt)
    if (at < 0) items.push(node)
    else items.splice(at, 0, node)
  }
  return items
}

/** A deterministic pseudo-random generator, so a failure is reproducible. */
function rng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x100000000
  }
}

describe('the assembled timeline is the one the old assembly produced', () => {
  it('agrees on random shapes, including orphans and shared turns', () => {
    for (let seed = 1; seed <= 60; seed += 1) {
      const next = rng(seed)
      const fold = createFold()
      const blockCount = 1 + Math.floor(next() * 8)
      for (let index = 0; index < blockCount; index += 1) {
        const block = emptyBlock(`block:${String(index)}`, Math.floor(next() * 60), `title-${String(index)}`)
        // A turn, a command, or neither: the three identities the host can name.
        const kind = next()
        if (kind < 0.4) block.turn = 1 + Math.floor(next() * 3)
        else if (kind < 0.7) block.commandId = `cmd-${String(Math.floor(next() * 3))}`
        block.steps = 1
        block.status = 'done'
        fold.blocks.push(block)
      }
      const host: PtyBlock[] = []
      const hostCount = 1 + Math.floor(next() * 8)
      for (let index = 0; index < hostCount; index += 1) {
        const time = Math.floor(next() * 60)
        const kind = next()
        if (kind < 0.4) {
          host.push({ seq: index + 1, kind: 'shell', startedAt: time, text: next() < 0.3 ? '   ' : `out-${String(index)}` })
        } else if (kind < 0.7) {
          host.push({ seq: index + 1, kind: 'agent', startedAt: time, turn: 1 + Math.floor(next() * 3) })
        } else {
          host.push({ seq: index + 1, kind: 'agent', startedAt: time, commandId: `cmd-${String(Math.floor(next() * 3))}` })
        }
      }
      const expected = legacyAssemble(host, fold).map(item => `${item.kind}:${item.key}:${String(item.time)}`)
      const actual = assembleTimeline(host, fold).map(item => `${item.kind}:${item.key}:${String(item.time)}`)
      expect(actual, `seed ${String(seed)}`).toEqual(expected)
    }
  })
})
