/**
 * The caches that make a Tab cheap, driven without a world.
 *
 * These are the two rules the completion path depends on and cannot check for
 * itself: a reading is served only while it is young, and two callers asking the
 * same question are answered by ONE read. The second is the one a warm lives or
 * dies by — a warm that started a second read instead of sharing the first would
 * make Tab slower, not faster.
 */

import { describe, expect, it } from 'vitest'
import { ReadingCache, readingKey, SingleFlight, type DirectoryReading } from '../src/readings.js'

/** One directory reading, as the completion path builds it. */
function listing(dir: string, names: readonly string[]): DirectoryReading {
  return { ok: true, dir, children: names.map(name => ({ name, type: 'file' })) }
}

/** A clock a spec moves by hand. */
function clockFrom(start: number): { now: () => number; advance: (ms: number) => void } {
  let at = start
  return { now: () => at, advance: (ms: number) => { at += ms } }
}

describe('readingKey', () => {
  it('separates the same path in two worlds', () => {
    // The mistake the oracle's cache made once and this one must not: a device
    // session's directory answered out of this machine's memory.
    expect(readingKey('local', '/root', undefined)).not.toBe(readingKey('43-138-57-105', '/root', undefined))
  })

  it('separates a relative path from an absolute one under a base', () => {
    expect(readingKey('local', 'src', '/home/reader')).not.toBe(readingKey('local', 'src', '/tmp'))
  })
})

describe('SingleFlight', () => {
  it('runs the work once for callers of the same key', async () => {
    const flight = new SingleFlight<number>()
    let runs = 0
    const produce = async (): Promise<number> => { runs += 1; return runs }
    const [first, second] = await Promise.all([flight.join('k', produce), flight.join('k', produce)])
    expect(runs).toBe(1)
    expect(first).toBe(1)
    expect(second).toBe(1)
  })

  it('runs the work again after it has finished', async () => {
    const flight = new SingleFlight<number>()
    let runs = 0
    const produce = async (): Promise<number> => { runs += 1; return runs }
    await flight.join('k', produce)
    await flight.join('k', produce)
    expect(runs).toBe(2)
  })

  it('keeps different keys apart', async () => {
    const flight = new SingleFlight<string>()
    const produce = async (): Promise<string> => 'answer'
    await Promise.all([flight.join('a', produce), flight.join('b', produce)])
    expect(flight.has('a')).toBe(false)
    expect(flight.has('b')).toBe(false)
  })

  it('forgets a failure, so the next caller tries again', async () => {
    const flight = new SingleFlight<string>()
    await expect(flight.join('k', async () => await Promise.reject(new Error('no')))).rejects.toThrow('no')
    expect(flight.has('k')).toBe(false)
    await expect(flight.join('k', async () => 'later')).resolves.toBe('later')
  })
})

describe('ReadingCache', () => {
  it('serves a fresh reading without reading again', async () => {
    const clock = clockFrom(1_000)
    const cache = new ReadingCache(3_000, clock.now)
    let reads = 0
    const produce = async (): Promise<DirectoryReading> => { reads += 1; return listing('/w', ['a.txt']) }
    await cache.read('k', produce)
    clock.advance(2_999)
    await cache.read('k', produce)
    expect(reads).toBe(1)
  })

  it('answers at once with a reading that is only usable, and refreshes behind it', async () => {
    const clock = clockFrom(1_000)
    const cache = new ReadingCache(3_000, clock.now)
    let reads = 0
    const produce = async (): Promise<DirectoryReading> => { reads += 1; return listing('/w', [`v${String(reads)}.txt`]) }
    await cache.read('k', produce)
    clock.advance(10_000)
    // The reader gets their list NOW: waiting for a device to re-list a directory
    // they may not have touched is the wait this feature exists to remove.
    const served = await cache.read('k', produce)
    expect(served).toEqual(listing('/w', ['v1.txt']))
    await Promise.resolve()
    await Promise.resolve()
    // …and the truth is fetched behind the answer, so the next Tab has it.
    expect(reads).toBe(2)
    const next = await cache.read('k', produce)
    expect(next).toEqual(listing('/w', ['v2.txt']))
  })

  it('swallows a failed background refresh, which dsh would otherwise treat as fatal', async () => {
    // The refresh behind a stale answer is fire-and-forget, and dsh exits the
    // whole host on an unhandled rejection — so a world that stopped answering
    // (a device whose credential group is locked, say) must not be able to take
    // the process down from a path nobody is waiting on.
    const clock = clockFrom(1_000)
    const cache = new ReadingCache(3_000, clock.now)
    await cache.read('k', async () => listing('/w', ['old.txt']))
    clock.advance(10_000)
    let attempts = 0
    const served = await cache.read('k', async (): Promise<DirectoryReading> => {
      attempts += 1
      throw new Error('分组已锁定')
    })
    // The reader is still answered from what this side holds.
    expect(served).toEqual(listing('/w', ['old.txt']))
    await Promise.resolve()
    await Promise.resolve()
    expect(attempts).toBe(1)
    // And the failure is not remembered, so the next ask tries again.
    clock.advance(60_001)
    await expect(cache.read('k', async () => listing('/w', ['new.txt']))).resolves.toEqual(listing('/w', ['new.txt']))
  })

  it('stops answering once a reading is old enough to be a claim nobody checked', async () => {
    const clock = clockFrom(1_000)
    const cache = new ReadingCache(3_000, clock.now, 60_000)
    await cache.read('k', async () => listing('/w', ['old.txt']))
    clock.advance(60_001)
    expect(cache.peek('k')).toBeUndefined()
    const fresh = await cache.read('k', async () => listing('/w', ['new.txt']))
    expect(fresh).toEqual(listing('/w', ['new.txt']))
  })

  it('tells a fresh reading from a usable one', async () => {
    const clock = clockFrom(1_000)
    const cache = new ReadingCache(3_000, clock.now)
    await cache.read('k', async () => listing('/w', ['a.txt']))
    expect(cache.fresh('k')).toBe(true)
    clock.advance(3_001)
    // Still answerable from memory (so a fast pass can answer), no longer fresh
    // (so a pass that may read goes and reads).
    expect(cache.fresh('k')).toBe(false)
    expect(cache.peek('k')).toEqual(listing('/w', ['a.txt']))
  })

  it('shares one read between callers of the same key', async () => {
    const cache = new ReadingCache()
    let reads = 0
    const produce = async (): Promise<DirectoryReading> => {
      reads += 1
      await new Promise(resolve => setTimeout(resolve, 5))
      return listing('/w', ['a.txt'])
    }
    const [warm, tab] = await Promise.all([cache.read('k', produce), cache.read('k', produce)])
    expect(reads).toBe(1)
    expect(warm).toEqual(tab)
  })

  it('does not remember a failure', async () => {
    const cache = new ReadingCache()
    await expect(cache.read('k', async () => { throw new Error('unreadable') })).rejects.toThrow('unreadable')
    // A world that could not answer may answer next time; remembering the
    // rejection would turn one unlucky moment into a permanent one.
    await expect(cache.read('k', async () => listing('/w', ['a.txt']))).resolves.toEqual(listing('/w', ['a.txt']))
    expect(cache.size).toBe(1)
  })

  it('peeks without reading, which is how a cold fast pass stays quiet', () => {
    const cache = new ReadingCache()
    expect(cache.peek('k')).toBeUndefined()
    expect(cache.size).toBe(0)
  })

  it('forgets one key on demand', async () => {
    const cache = new ReadingCache()
    await cache.read('k', async () => listing('/w', ['a.txt']))
    await cache.read('other', async () => listing('/x', ['b.txt']))
    cache.forget('k')
    expect(cache.peek('k')).toBeUndefined()
    expect(cache.peek('other')).toEqual(listing('/x', ['b.txt']))
  })

  it('separates two worlds that asked for the same path', async () => {
    const cache = new ReadingCache()
    const local = await cache.read(readingKey('local', '/root', undefined), async () => listing('/root', ['here.txt']))
    const device = await cache.read(
      readingKey('43-138-57-105', '/root', undefined),
      async () => listing('/root', ['there.txt']),
    )
    expect(local).toEqual(listing('/root', ['here.txt']))
    expect(device).toEqual(listing('/root', ['there.txt']))
  })
})
