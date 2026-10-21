/**
 * The rule that says which Session is on screen.
 *
 * It exists because the host moved it: `0.1.5-rc.2` published
 * `sessions.list.current` and every consumer read the field, while
 * `0.1.6-alpha.2` removed the field and left the answer to retention counts. A
 * rule that four dshell packages need, expressed against a host shape, is the
 * kind of thing this layer exists to hold once — so the cases here are about the
 * reading, not about any one caller.
 */

import { describe, expect, it } from 'vitest'
import { mainSessionId } from '../src/session-view.js'

const held = (id: string, count: number) => ({ id, retainedBy: { mainView: count } })

describe('mainSessionId', () => {
  it('answers with the row a view is holding', () => {
    expect(mainSessionId([held('a', 1), held('b', 0)])).toBe('a')
    expect(mainSessionId([held('a', 0), held('b', 2)])).toBe('b')
  })

  it('answers undefined when nothing is held', () => {
    // A fresh page, and the window between a release and the next retain.
    expect(mainSessionId([])).toBeUndefined()
    expect(mainSessionId([held('a', 0), held('b', 0)])).toBeUndefined()
  })

  it('reads a row whose retention counts arrived without the field', () => {
    // The host freezes these with a null prototype and omits sources at zero,
    // so "no mainView key" and "mainView: 0" have to mean the same thing.
    expect(mainSessionId([{ id: 'a', retainedBy: {} }, { id: 'b' }])).toBeUndefined()
    expect(mainSessionId([{ id: 'a', retainedBy: {} }, { id: 'b', retainedBy: { mainView: 1 } }])).toBe('b')
  })

  it('keeps the id type it was given', () => {
    // The callers pass branded SessionIds and compare the answer against the
    // slot's own sessionId, so the brand has to survive the round trip.
    const ids = [held('a', 1)] as const
    const answer: string | undefined = mainSessionId(ids)
    expect(answer).toBe('a')
  })
})
