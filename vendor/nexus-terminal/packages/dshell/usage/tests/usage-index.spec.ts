/**
 * The usage index's two load-bearing rules.
 *
 * The fold decides what a number means, and the batch decides whether a rescan
 * double-counts. Both are asserted here because neither is visible from the
 * page: a wrong fold shows a plausible chart, and a wrong batch shows a number
 * that is merely too large.
 */

import { describe, expect, it } from 'vitest'
import { closeUsageStore, localDay, openUsageStore, routeName, total } from '../src/index-store.js'
import { foldTurns, usageOf, type UsageSessionQuery } from '../src/scan.js'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'

/** A fixed instant, so a bucket's day never depends on when the suite runs. */
const at = (iso: string): number => Date.parse(iso)

/** An `assistant/message` carrying what a scan reads, and nothing else. */
function turn(time: number, provider: string, model: string, usage: Record<string, number> | undefined): SessionEvent {
  return {
    type: 'assistant/message',
    seq: 0,
    time,
    data: {
      turn: 1,
      step: 1,
      ...usage === undefined ? {} : { usage },
      message: { source: { kind: 'model', provider, model } },
    },
  } as unknown as SessionEvent
}

describe('reading one turn', () => {
  it('attributes the usage to the route the same event names', () => {
    const counted = usageOf(turn(Date.UTC(2026, 8, 20, 3), 'minimax-cn', 'MiniMax-M3', {
      inputTokens: 100, outputTokens: 20, cacheReadTokens: 7, cacheWriteTokens: 3,
    }))
    expect(counted).toMatchObject({
      provider: 'minimax-cn',
      model: 'MiniMax-M3',
      uncachedInputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 7,
      cacheWriteTokens: 3,
      turns: 1,
    })
  })

  it('ignores a turn that reported no usage', () => {
    expect(usageOf(turn(Date.now(), 'minimax-cn', 'MiniMax-M3', undefined))).toBeUndefined()
  })

  it('ignores a turn with no route, rather than bucketing it under nothing', () => {
    const unnamed = { type: 'assistant/message', seq: 0, time: Date.now(), data: { usage: { inputTokens: 1, outputTokens: 1 } } } as unknown as SessionEvent
    expect(usageOf(unnamed)).toBeUndefined()
  })

  it('counts a missing cache bucket as zero, not as absent', () => {
    const counted = usageOf(turn(Date.now(), 'p', 'm', { inputTokens: 5, outputTokens: 2 }))
    expect(counted?.cacheReadTokens).toBe(0)
    expect(counted?.cacheWriteTokens).toBe(0)
  })
})

describe('folding turns', () => {
  it('adds same-day same-route turns into one row', () => {
    const day = Date.UTC(2026, 8, 20, 3)
    const rows = foldTurns([
      usageOf(turn(day, 'p', 'm', { inputTokens: 1, outputTokens: 2 }))!,
      usageOf(turn(day, 'p', 'm', { inputTokens: 10, outputTokens: 20 }))!,
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ provider: 'p', model: 'm', uncachedInputTokens: 11, outputTokens: 22, turns: 2 })
  })

  it('keeps routes apart even on one day', () => {
    const day = Date.UTC(2026, 8, 20, 3)
    const rows = foldTurns([
      usageOf(turn(day, 'p', 'a', { inputTokens: 1, outputTokens: 0 }))!,
      usageOf(turn(day, 'p', 'b', { inputTokens: 2, outputTokens: 0 }))!,
    ])
    expect(rows.map(row => row.model).sort()).toEqual(['a', 'b'])
  })
})

describe('the index', () => {
  it('adds a batch rather than replacing it, so a rescan cannot double-count', () => {
    const store = openUsageStore(':memory:')
    try {
      const row = { day: '2026-09-20', provider: 'p', model: 'm', uncachedInputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 1 }
      store.applyBatch({ rows: [row], cursors: [{ sessionId: 's1', seq: 4 }], scannedAt: '2026-09-20' })
      // The same session is rescanned, but only its NEW events are handed over —
      // one more turn, so exactly one more turn is counted.
      store.applyBatch({ rows: [{ ...row, turns: 1 }], cursors: [{ sessionId: 's1', seq: 6 }], scannedAt: '2026-09-20' })
      const summary = store.summary(null)
      expect(summary.totals[0]?.turns).toBe(2)
      expect(summary.totals[0]?.uncachedInputTokens).toBe(20)
    }
    finally { closeUsageStore(':memory:') }
  })

  it('remembers a session cursor and reports whether the index is built', () => {
    const store = openUsageStore(':memory:')
    try {
      expect(store.summary(null).built).toBe(false)
      store.applyBatch({ rows: [], cursors: [{ sessionId: 's1', seq: 9 }], scannedAt: '2026-09-20' })
      expect(store.cursorFor('s1')).toBe(9)
      expect(store.summary(null).built).toBe(true)
    }
    finally { closeUsageStore(':memory:') }
  })

  it('leaves out days older than the requested window', () => {
    const store = openUsageStore(':memory:')
    try {
      const today = localDay(new Date())
      const old = localDay(new Date(Date.now() - 40 * 86_400_000))
      const row = (day: string) => ({ day, provider: 'p', model: 'm', uncachedInputTokens: 5, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 1 })
      store.applyBatch({ rows: [row(today), row(old)], cursors: [{ sessionId: 's1', seq: 1 }], scannedAt: today })
      expect(store.summary(null).totals[0]?.turns).toBe(2)
      expect(store.summary(7).totals[0]?.turns).toBe(1)
    }
    finally { closeUsageStore(':memory:') }
  })
})

describe('the scan cursor', () => {
  it('reads only sessions whose log grew past their cursor', async () => {
    const { UsageScanner } = await import('../src/scan.js')
    const store = openUsageStore(':memory:')
    try {
      const events = [turn(at('2026-09-20T03:00:00Z'), 'p', 'm', { inputTokens: 3, outputTokens: 1 })]
      let reads = 0
      const query: UsageSessionQuery = {
        listSessions: async () => [{ header: { id: 's1' } }],
        listEvents: async () => events.map((_, index) => ({ seq: index + 1 })),
        readSession: async () => { reads += 1; return { events } },
      }
      const scanner = new UsageScanner(store, query, { minIntervalMs: 0, debounceMs: 0 })
      await scanner.rescan()
      expect(reads).toBe(1)
      // Nothing changed, so the second pass must not decode the log again.
      await scanner.rescan()
      expect(reads).toBe(1)
      expect(store.summary(null).totals[0]?.turns).toBe(1)
    }
    finally { closeUsageStore(':memory:') }
  })
})

describe('naming', () => {
  it('names a route as provider/model, the way the page lists it', () => {
    expect(routeName({ provider: 'minimax-cn', model: 'MiniMax-M3' })).toBe('minimax-cn/MiniMax-M3')
  })

  it('sums the four buckets for the charts', () => {
    expect(total({ uncachedInputTokens: 1, outputTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 8 })).toBe(15)
  })
})
