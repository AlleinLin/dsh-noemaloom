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
  return { status: 'idle', since: 0, ready: false, retrying: false, noShell: false, lockedGroup: false, ...over }
}

/** Far past `since`: the grace period is expired, so these pin the state's own rule. */
const SETTLED = 10_000

describe('a session that owns no shell yet', () => {
  it('is waiting, not broken', () => {
    expect(linkView(facts({ status: 'error', noShell: true }), SETTLED)).toBe('waiting')
    expect(linkView(facts({ status: 'closed', noShell: true }), SETTLED)).toBe('waiting')
  })

  it('is still waiting when the shell never reached a prompt', () => {
    // `ready` says the shell answered once; it does not say whether a shell
    // was ever attempted, so it cannot decide this on its own.
    expect(linkView(facts({ status: 'error', ready: false, noShell: true }), SETTLED)).toBe('waiting')
  })
})

describe('a credential the reader can unlock', () => {
  it('is locked, not broken', () => {
    // A retry brings back the same refusal, so the one thing that changes it
    // is the token — and the card has to say so.
    expect(linkView(facts({ status: 'error', lockedGroup: true }), SETTLED)).toBe('locked')
  })

  it('is locked even when the host never got as far as trying', () => {
    // The lock is the more specific fact, and it outranks the other one: a
    // locked group is a door, and a session with no agent is not.
    expect(linkView(facts({ status: 'error', noShell: true, lockedGroup: true }), SETTLED)).toBe('locked')
  })
})

describe('a link that really failed', () => {
  it('is broken', () => {
    // A shell that worked and died.
    expect(linkView(facts({ status: 'closed', ready: true }), SETTLED)).toBe('broken')
    // A device that could not be reached, before any shell ran.
    expect(linkView(facts({ status: 'error', ready: false }), SETTLED)).toBe('broken')
  })
})

describe('a link that is doing something', () => {
  it('says connecting', () => {
    expect(linkView(facts({ status: 'connecting' }), SETTLED)).toBe('connecting')
  })

  it('says nothing once it is up or was never asked for', () => {
    expect(linkView(facts({ status: 'open', ready: true }), SETTLED)).toBe('none')
    expect(linkView(facts({ status: 'idle' }), SETTLED)).toBe('none')
  })
})

describe('a link that is briefly connecting', () => {
  it('does not announce a handshake that is only a rebind', () => {
    // The chip sits in the session header, so a chip that said "连接中…" on
    // every session switch read as a link that keeps failing.
    expect(linkView(facts({ status: 'connecting', since: 1_000 }), 1_050)).toBe('none')
  })

  it('announces a connecting state that has lasted', () => {
    expect(linkView(facts({ status: 'connecting', since: 1_000 }), 1_000 + 5_000)).toBe('connecting')
  })

  it('stays silent for a rebind of a shell that already answered', () => {
    // The case that survived the grace period in practice: a busy machine can
    // take longer than the grace to reopen a carrier, and the chip must still
    // not call a live shell's rebind a connecting link.
    expect(linkView(facts({
      status: 'connecting', ready: true, retrying: false, since: 1_000,
    }), 1_000 + 30_000)).toBe('none')
  })

  it('does announce a reconnect that is spending a retry', () => {
    expect(linkView(facts({
      status: 'connecting', ready: true, retrying: true, since: 1_000,
    }), 1_000 + 30_000)).toBe('connecting')
  })
})

describe('a link that is retrying', () => {
  it('keeps the chip on "connecting" through the retry dial', () => {
    // Same regression as the terminal's own notice: the dial resets the count,
    // so a rule keyed on the count went silent while the device was down.
    expect(linkView(facts({ status: 'connecting', ready: true, retrying: true, since: 1_000 }), SETTLED))
      .toBe('connecting')
  })

  it('goes quiet for a rebind with no failure behind it', () => {
    expect(linkView(facts({ status: 'connecting', ready: true, retrying: false, since: 1_000 }), SETTLED))
      .toBe('none')
  })
})
