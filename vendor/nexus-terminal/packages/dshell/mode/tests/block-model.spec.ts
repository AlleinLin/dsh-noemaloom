import { describe, expect, it } from 'vitest'
import type { SessionEventLike } from '@deepseek-ai/dsh-api-session-controller/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { PtyBlock } from '@nexus-aethra/dshell-terminal-bridge/client'
import { assembleTimeline } from '../src/client/block-model.js'
import { createFold, emptyBlock, foldEvent, type BlockFold } from '../src/client/blocks.js'

const t = ((key: string) => key) as TranslateNS<'dshellMode'>

function command(fold: BlockFold, id: string, name: string, seq: number, time: number): void {
  foldEvent(fold, {
    type: 'command/run', seq, time,
    data: { commandId: id, name, source: { kind: 'user' } },
  } as SessionEventLike, t)
  foldEvent(fold, {
    type: 'command/done', seq: seq + 1, time: time + 1,
    data: { commandId: id, kind: 'success', text: 'done' },
  } as SessionEventLike, t)
}

function shell(seq: number, time: number, text: string): PtyBlock {
  return { seq, kind: 'shell', startedAt: time, text }
}

function labels(host: readonly PtyBlock[], fold: BlockFold): string[] {
  return assembleTimeline(host, fold).map(item => item.kind === 'agent' ? item.block.title : item.text)
}

describe('assembleTimeline', () => {
  it('keeps compact between its surrounding shell regions after another command', () => {
    const fold = createFold()
    command(fold, 'permission-1', 'permission', 1, 20)
    command(fold, 'compact-1', 'compact', 3, 40)
    const host: PtyBlock[] = [
      shell(1, 10, 'before'),
      { seq: 2, kind: 'agent', startedAt: 20, endedAt: 21 },
      shell(3, 30, 'middle'),
      { seq: 4, kind: 'agent', startedAt: 40, endedAt: 41 },
      shell(5, 50, 'after'),
    ]
    expect(labels(host, fold)).toEqual([
      'before', '/permission · done', 'middle', '/compact · done', 'after',
    ])
  })

  it('does not pull a turn-less historical request into a compact command', () => {
    const fold = createFold()
    const history = emptyBlock('history', 10, 'older request')
    history.status = 'done'
    history.rows.push({ role: 'user', key: 'user:1', time: 10, text: 'older request', collapsible: false, defaultCollapsed: false })
    fold.blocks.push(history)
    command(fold, 'compact-1', 'compact', 2, 30)
    expect(labels([
      shell(1, 20, 'before compact'),
      { seq: 2, kind: 'agent', startedAt: 30, endedAt: 31 },
      shell(3, 40, 'after compact'),
    ], fold)).toEqual(['older request', 'before compact', '/compact · done', 'after compact'])
  })

  it('matches commands by identity even when their timestamps coincide', () => {
    const fold = createFold()
    command(fold, 'permission-1', 'permission', 1, 20)
    command(fold, 'compact-1', 'compact', 3, 20)
    expect(fold.blocks.map(block => block.commandId)).toEqual(['permission-1', 'compact-1'])
    expect(labels([
      shell(1, 10, 'before'),
      { seq: 2, kind: 'agent', commandId: 'permission-1', startedAt: 20 },
      shell(3, 20, 'middle'),
      { seq: 4, kind: 'agent', commandId: 'compact-1', startedAt: 20 },
      shell(5, 20, 'after'),
    ], fold)).toEqual(['before', '/permission · done', 'middle', '/compact · done', 'after'])
  })

  it('keeps the next question after compact on live folding and full replay', () => {
    const host: PtyBlock[] = [
      shell(1, 10, 'before'),
      { seq: 2, kind: 'agent', commandId: 'compact-1', startedAt: 20 },
      shell(3, 30, 'after compact'),
      { seq: 4, kind: 'agent', turn: 1, startedAt: 40 },
    ]
    const entries = [
      { type: 'command/run', seq: 1, time: 20, data: { commandId: 'compact-1', name: 'compact', source: { kind: 'user' } } },
      { type: 'compaction/start', seq: 2, time: 21, data: { compactionId: 'compaction-1' } },
      { type: 'user/message', seq: 3, time: 22, data: { role: 'user', id: 'checkpoint', content: [{ type: 'text', text: 'compacted summary' }], source: { kind: 'compact-checkpoint', compactionId: 'compaction-1' } } },
      { type: 'compaction/end', seq: 4, time: 23, data: { compactionId: 'compaction-1' } },
      { type: 'command/done', seq: 5, time: 24, data: { commandId: 'compact-1', kind: 'success', text: 'done' } },
      { type: 'turn/start', seq: 6, time: 40, data: { turn: 1 } },
      { type: 'user/message', seq: 7, time: 41, data: { role: 'user', id: 'next', content: [{ type: 'text', text: 'next question' }], source: { kind: 'user' } } },
      { type: 'turn/end', seq: 8, time: 50, data: { turn: 1, reason: { kind: 'completed' } } },
    ] as SessionEventLike[]
    const live = createFold()
    for (const event of entries.slice(0, 5)) foldEvent(live, event, t)
    expect(labels(host.slice(0, 3), live)).toEqual(['before', '/compact · done', 'after compact'])
    for (const event of entries.slice(5)) foldEvent(live, event, t)
    const replay = createFold()
    for (const event of entries) foldEvent(replay, event, t)
    const expected = ['before', '/compact · done', 'after compact', 'next question']
    expect(labels(host, live)).toEqual(expected)
    expect(labels(host, replay)).toEqual(expected)
    expect(live.blocks.map(block => block.key)).toEqual(replay.blocks.map(block => block.key))
  })

  it('keeps every supervised phase at its numbered turn carrier', () => {
    const fold = createFold()
    for (const [key, time] of [['phase one', 20], ['phase two', 40]] as const) {
      const block = emptyBlock(key, time, key)
      block.turn = 1
      block.steps = 1
      block.status = 'done'
      fold.blocks.push(block)
    }
    expect(labels([
      shell(1, 10, 'before'),
      { seq: 2, kind: 'agent', turn: 1, startedAt: 20 },
      shell(3, 30, 'after'),
    ], fold)).toEqual(['before', 'phase one', 'phase two', 'after'])
  })

  it('does not render model-only compaction checkpoints as new requests', () => {
    const fold = createFold()
    foldEvent(fold, {
      type: 'user/message', seq: 1, time: 10,
      data: { role: 'user', id: 'checkpoint', content: [{ type: 'text', text: 'compacted summary' }], source: { kind: 'compact-checkpoint' } },
    } as SessionEventLike, t)
    expect(fold.blocks).toEqual([])
  })
})
