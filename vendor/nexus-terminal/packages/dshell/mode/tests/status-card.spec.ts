/**
 * Which presentation a session's terminal link gets.
 *
 * The link's own state is not enough, and the host says why: a session that
 * owns no shell yet reports a closed link exactly as a shell that died does,
 * and a locked credential reports the same one as an unreachable device. The
 * three need opposite things — nothing, a token, a retry — so the host marks
 * the first two structurally and the card reads the marks.
 *
 * The case this exists for: a session that has not been given its first
 * command announced "终端连接中断" — a connection lost that had never been
 * made — and lost the fact that it was simply waiting.
 */

import { describe, expect, it } from 'vitest'
import { linkView, type LinkFacts } from '../src/client/status-card.js'

/** The facts a session's link is in by default: idle, nothing wrong. */
function facts(over: Partial<LinkFacts> = {}): LinkFacts {
  return { status: 'idle', ready: false, noShell: false, lockedGroup: false, ...over }
}

describe('a session that owns no shell yet', () => {
  it('is waiting, not broken', () => {
    expect(linkView(facts({ status: 'error', noShell: true }))).toBe('waiting')
    expect(linkView(facts({ status: 'closed', noShell: true }))).toBe('waiting')
  })

  it('is still waiting when the shell never reached a prompt', () => {
    // `ready` says the shell answered once; it does not say whether a shell
    // was ever attempted, so it cannot decide this on its own.
    expect(linkView(facts({ status: 'error', ready: false, noShell: true }))).toBe('waiting')
  })
})

describe('a credential the reader can unlock', () => {
  it('is locked, not broken', () => {
    // A retry brings back the same refusal, so the one thing that changes it
    // is the token — and the card has to say so.
    expect(linkView(facts({ status: 'error', lockedGroup: true }))).toBe('locked')
  })

  it('is locked even when the host never got as far as trying', () => {
    // The lock is the more specific fact, and it outranks the other one: a
    // locked group is a door, and a session with no agent is not.
    expect(linkView(facts({ status: 'error', noShell: true, lockedGroup: true }))).toBe('locked')
  })
})

describe('a link that really failed', () => {
  it('is broken', () => {
    // A shell that worked and died.
    expect(linkView(facts({ status: 'closed', ready: true }))).toBe('broken')
    // A device that could not be reached, before any shell ran.
    expect(linkView(facts({ status: 'error', ready: false }))).toBe('broken')
  })
})

describe('a link that is doing something', () => {
  it('says connecting', () => {
    expect(linkView(facts({ status: 'connecting' }))).toBe('connecting')
  })

  it('says nothing once it is up or was never asked for', () => {
    expect(linkView(facts({ status: 'open', ready: true }))).toBe('none')
    expect(linkView(facts({ status: 'idle' }))).toBe('none')
  })
})
