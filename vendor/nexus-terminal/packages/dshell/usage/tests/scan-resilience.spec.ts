/**
 * A scan survives a log it cannot read.
 *
 * This is the difference between "the index is a week stale" and "one broken
 * artifact stops all accounting forever": dsh refuses to migrate some older
 * logs (`Session migration from v3 to v4 refuses…`), and a scan that lets that
 * refusal escape aborts before writing anything — which is exactly what
 * happened before this rule existed. The skipped session must also keep its
 * cursor, or the next scan would consider it counted and never revisit it.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { closeUsageStore, openUsageStore } from '../src/index-store.js'
import { UsageScanner, type UsageSessionQuery } from '../src/scan.js'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'

const GOOD = 'session-good'
const BROKEN = 'session-broken'

/** One counted turn, as `usageOf` reads it. */
function turn(seq: number, time: number, provider: string, model: string, input: number): SessionEvent {
  return {
    type: 'assistant/message',
    seq,
    time,
    data: {
      turn: 1,
      step: 1,
      usage: { inputTokens: input, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
      message: { source: { kind: 'model', provider, model } },
    },
  } as unknown as SessionEvent
}

/** A query whose broken session throws on read, the way the migration refusal does. */
function query(): UsageSessionQuery {
  const events: Record<string, SessionEvent[]> = {
    [GOOD]: [turn(1, Date.UTC(2026, 8, 20, 3), 'minimax-cn', 'MiniMax-M3', 100)],
    [BROKEN]: [turn(1, Date.UTC(2026, 8, 20, 4), 'minimax-cn', 'MiniMax-M3', 400)],
  }
  return {
    listSessions: async () => [{ header: { id: GOOD } }, { header: { id: BROKEN } }],
    listEvents: async (sessionId: string) => (events[sessionId] ?? []).map(event => ({ seq: event.seq })),
    readSession: async (sessionId: string) => {
      if (sessionId === BROKEN) throw new Error('Session migration from v3 to v4 refuses the transformed artifact')
      return { events: events[sessionId] ?? [] }
    },
  }
}

let store: ReturnType<typeof openUsageStore> | undefined

afterEach(() => {
  if (store !== undefined) closeUsageStore(':memory:')
  store = undefined
})

describe('a scan with an unreadable session', () => {
  it('counts every other session and reports the skipped one', async () => {
    store = openUsageStore(':memory:')
    const scanner = new UsageScanner(store, query())
    const outcome = await scanner.rescan()

    expect(outcome.skipped).toBe(1)
    expect(outcome.skipReason).toContain('migration')
    expect(outcome.read).toBe(1)
    expect(outcome.turns).toBe(1)
    expect(outcome.written).toBe(true)
    // The readable session's usage really landed in the index.
    expect(store.summary(null).totals.reduce((sum, row) => sum + row.uncachedInputTokens, 0)).toBe(100)
  })

  it('leaves the skipped session its cursor, so a later scan retries it', async () => {
    store = openUsageStore(':memory:')
    const scanner = new UsageScanner(store, query())
    await scanner.rescan()
    expect(store.cursors().has(BROKEN)).toBe(false)
    expect(store.cursors().get(GOOD)).toBe(1)
  })
})
