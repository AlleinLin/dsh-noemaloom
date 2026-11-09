/**
 * Which screen a session's terminal connection gets.
 *
 * The rules here are a precedence, and a precedence is exactly the thing a test
 * should pin: five facts decide between "nothing", "a marker on the output the
 * user is reading" and "a screen of its own", and the order they are consulted
 * in is what stops a machine with no shell from being presented as a flaky
 * network.
 */

import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { LockedDoor, connectionView, type ConnectionFacts } from '../src/client/connection-notice.js'
import { getTheme } from '../src/client/palettes.js'

/** The facts a session is in by default: an idle local session, nothing wrong. */
function facts(over: Partial<ConnectionFacts> = {}): ConnectionFacts {
  return {
    status: 'idle', since: 0, ready: false, attempt: 0, recovering: false, bound: false,
    localUnsupported: false, failure: undefined, ...over,
  }
}

/**
 * The clock every expectation is read against.
 *
 * Far past `since`, so the grace period is expired unless a case says
 * otherwise: these rules are about which screen a state gets, not about how
 * long it took to appear, and the grace period has its own block below.
 */
const SETTLED = 10_000

describe('a machine that cannot host a local shell', () => {
  it('gets a screen of its own, not a marker on output that does not exist', () => {
    // The case this exists for: on Windows a local spawn fails immediately, so
    // `ready` is false and there is no output behind it to append a line to.
    const view = connectionView(facts({ status: 'error', localUnsupported: true }), SETTLED)
    expect(view).toEqual({ kind: 'panel', phase: 'unsupported' })
  })

  it('outranks a local session still starting up', () => {
    // Otherwise a Windows reader gets the "waiting for a device" screen for a
    // session that is not on a device at all.
    const view = connectionView(facts({
      status: 'connecting', bound: false, ready: false, localUnsupported: true,
    }), SETTLED)
    expect(view).toEqual({ kind: 'panel', phase: 'unsupported' })
  })

  it('leaves a DEVICE session alone — its shell runs on the device', () => {
    // The whole point of the bound check: Windows is a perfectly good place to
    // run an ssh client from, so a bound session must still get its normal
    // connecting screen and its retry.
    const view = connectionView(facts({
      status: 'connecting', bound: true, ready: false, localUnsupported: true,
    }), SETTLED)
    expect(view).toEqual({ kind: 'panel', phase: 'connecting' })
  })

  it('stays quiet while no terminal has been asked for', () => {
    // The flag is set by a failed spawn, but a reader who has not opened a
    // terminal yet should not be met by a screen about one.
    expect(connectionView(facts({ status: 'idle', localUnsupported: true }), SETTLED))
      .toEqual({ kind: 'none' })
  })

  it('forgets the fact for the next session', () => {
    expect(connectionView(facts({ status: 'error', localUnsupported: true }), SETTLED))
      .toEqual({ kind: 'panel', phase: 'unsupported' })
    // A fresh bind starts clean, so an ordinary failure is an ordinary failure.
    expect(connectionView(facts({ status: 'error' }), SETTLED))
      .toEqual({ kind: 'notice', tone: 'failed' })
  })
})

describe('the screens that were already there', () => {
  it('keeps a bound session that never answered on the connecting screen', () => {
    expect(connectionView(facts({ status: 'connecting', bound: true }), SETTLED))
      .toEqual({ kind: 'panel', phase: 'connecting' })
  })

  it('says nothing while a shell that HAD answered is rebound', () => {
    // Changed deliberately: this used to draw a "connecting" marker. A rebind of
    // a shell that is still running is a round trip on this machine, and the
    // marker over working output read as a connection that keeps dropping.
    expect(connectionView(facts({ status: 'connecting', bound: true, ready: true }), SETTLED))
      .toEqual({ kind: 'none' })
  })

  it('shows a first local failure as a plain retry notice', () => {
    expect(connectionView(facts({ status: 'error' }), SETTLED))
      .toEqual({ kind: 'notice', tone: 'failed' })
  })

  it('says nothing at all about a local session that is merely starting', () => {
    expect(connectionView(facts({ status: 'connecting' }), SETTLED)).toEqual({ kind: 'none' })
  })
})

describe('coming back to a terminal that never failed', () => {
  // Switching session and returning is the ordinary way a device terminal is
  // used, and it re-opens the carrier: the wire is briefly `connecting` while
  // the socket's handshake runs. That is not a retry, and the retry marker is
  // the one thing on screen that would say otherwise — so a switch must never
  // be able to leave a count behind it.
  it('never shows a retry count for a rebind with nothing to retry', () => {
    // attempt 0 is what the bind resets it to, and a shell that already answered
    // with no attempt spent is a rebind: nothing to narrate, nothing to count.
    expect(connectionView(facts({ status: 'connecting', bound: true, ready: true, attempt: 0 }), SETTLED))
      .toEqual({ kind: 'none' })
  })

  it('still shows the count for a retry that really is running', () => {
    // The complement: a genuine failure must keep its count visible, or the
    // reader loses the one signal that says how much of the budget is gone.
    const view = connectionView(facts({ status: 'closed', bound: true, ready: true, attempt: 2 }), SETTLED)
    expect(view).toEqual({ kind: 'notice', tone: 'failed' })
  })
})

describe('a host key that changed', () => {
  it('gets a screen, because the only way out is a decision, not a retry', () => {
    expect(connectionView(facts({ status: 'error', bound: true, failure: 'hostKey' }), SETTLED))
      .toEqual({ kind: 'panel', phase: 'hostKey' })
  })

  it('outranks the never-came-up screen', () => {
    // Both are full screens for a bound session; the changed key is the more
    // specific fact and the retry it would otherwise offer cannot work.
    expect(connectionView(facts({ status: 'error', bound: true, ready: false, failure: 'hostKey' }), SETTLED))
      .toEqual({ kind: 'panel', phase: 'hostKey' })
  })

  it('still gets a screen for a shell that HAD answered', () => {
    // A terminal the reader was working in loses its link because the machine
    // was rebuilt: the marker rule would hide that behind a retry.
    expect(connectionView(facts({ status: 'error', bound: true, ready: true, failure: 'hostKey' }), SETTLED))
      .toEqual({ kind: 'panel', phase: 'hostKey' })
  })

  it('never applies to a local session', () => {
    // Nothing here runs ssh, so there is no host key to have changed.
    expect(connectionView(facts({ status: 'error', failure: 'hostKey' }), SETTLED))
      .toEqual({ kind: 'notice', tone: 'failed' })
  })

  it('says nothing about an idle session', () => {
    expect(connectionView(facts({ bound: true, failure: 'hostKey' }), SETTLED)).toEqual({ kind: 'none' })
  })
})

describe('a passphrase that was refused', () => {
  // Deliberately NOT a screen: the remedy is re-entering a secret in the device
  // form, and this panel is not where that form lives.
  it('keeps the ordinary failure presentation', () => {
    expect(connectionView(facts({ status: 'error', bound: true, failure: 'passphrase' }), SETTLED))
      .toEqual({ kind: 'panel', phase: 'failed' })
  })
})

describe('a spawn a locked vault group refused', () => {
  const t = ((key: string) => key) as TranslateNS<'dshellMode'>
  const locked = { id: 'g-1', name: '远程验收' }

  /** The door, rendered the way the failure screen mounts it. */
  function door(): string {
    return renderToStaticMarkup(createElement(LockedDoor, {
      group: locked,
      theme: getTheme('midnight'),
      onUnlock: () => Promise.resolve(),
      t,
    }))
  }

  // The whole point of the door: the session cannot start, the group is named,
  // and the token that opens it is taken here instead of sending the reader to
  // the settings panel to find it.
  it('offers the group token on the failure screen itself', () => {
    const markup = door()
    expect(markup).toContain('connection.locked.detail')
    expect(markup).toContain('connection.locked.unlock')
    // A password box, never a text one: the token is a secret, and a shoulder
    // behind the reader is the whole threat model the vault exists for.
    expect(markup).toContain('type="password"')
  })
})

describe('a rebind of a shell that is already running', () => {
  it('says nothing while the round trip is still in flight', () => {
    // The case this exists for: leaving a terminal tab and coming back
    // re-opens the carrier, and the wire is briefly `connecting`. Announcing
    // that over a terminal which never stopped running is the "正在连接" that
    // made the app look like it was reconnecting on every switch.
    const view = connectionView(facts({
      status: 'connecting', bound: true, ready: true, since: 1_000,
    }), 1_000 + 50)
    expect(view).toEqual({ kind: 'none' })
  })

  it('is still silent while a first bind is in flight, briefly', () => {
    // A local shell is up in milliseconds, so its own startup is not a screen
    // either. A device bind that really stalls is covered by the next case.
    const view = connectionView(facts({ status: 'connecting', since: 1_000 }), 1_050)
    expect(view).toEqual({ kind: 'none' })
  })

  it('says "connecting" once the wait has lasted while recovering', () => {
    // Past the grace period with a failure behind it the state is a real wait,
    // and a reader staring at an unreachable device needs to see it.
    const view = connectionView(facts({
      status: 'connecting', bound: true, ready: true, recovering: true, since: 1_000,
    }), 1_000 + 5_000)
    expect(view).toEqual({ kind: 'notice', tone: 'connecting' })
  })

  it('keeps the first-dial screen for a device that has never answered', () => {
    const view = connectionView(facts({
      status: 'connecting', bound: true, ready: false, since: 1_000,
    }), 1_000 + 5_000)
    expect(view).toEqual({ kind: 'panel', phase: 'connecting' })
  })
})

describe('a rebind that outlasts the grace period', () => {
  it('still says nothing, because nothing failed behind this dial', () => {
    // The grace period alone was not enough: a loaded machine can take longer
    // than that to reopen a carrier, and the reader still must not be told a
    // shell that never stopped running is connecting.
    const view = connectionView(facts({
      status: 'connecting', bound: true, ready: true, recovering: false, since: 1_000,
    }), 1_000 + 30_000)
    expect(view).toEqual({ kind: 'none' })
  })

  it('says "connecting" while a real outage is being recovered', () => {
    // Note the attempt count is 0: the dial resets it, so the recovery fact —
    // not the count — is what has to survive into the view.
    const view = connectionView(facts({
      status: 'connecting', bound: true, ready: true, recovering: true, attempt: 0, since: 1_000,
    }), 1_000 + 30_000)
    expect(view).toEqual({ kind: 'notice', tone: 'connecting' })
  })
})

describe('a device that drops and is retried', () => {
  // The path a green suite missed: every state above was tested in isolation,
  // so nothing walked the transition out of a working terminal and back through
  // a retry dial. That transition is where a dead device went completely
  // silent, because the retry resets the attempt count on the way in.
  const bound = true
  const ready = true

  it('announces the drop', () => {
    // scheduleRetry raises recovering and sets the count.
    expect(connectionView(facts({ status: 'closed', bound, ready, recovering: true, attempt: 1 }), SETTLED))
      .toEqual({ kind: 'notice', tone: 'failed' })
  })

  it('keeps saying "connecting" while the retry is still dialing', () => {
    // THE REGRESSION: the dial resets `attempt` to 0. While the rule keyed on
    // attempt === 0 this returned {kind:'none'} — the device was unreachable and
    // the terminal said nothing, for as long as a black-holed connect held.
    expect(connectionView(facts({
      status: 'connecting', bound, ready, recovering: true, attempt: 0,
    }), SETTLED)).toEqual({ kind: 'notice', tone: 'connecting' })
  })

  it('keeps saying it however long the retry hangs', () => {
    // A TCP connect to a black-holed route stays open for minutes.
    const factsNow = facts({ status: 'connecting', bound, ready, recovering: true, attempt: 0, since: 1_000 })
    expect(connectionView(factsNow, 1_000 + 120_000)).toEqual({ kind: 'notice', tone: 'connecting' })
  })

  it('goes quiet only once the shell answers again', () => {
    // resetRetry clears recovering on the first live output frame.
    expect(connectionView(facts({
      status: 'open', bound, ready, recovering: false, attempt: 0,
    }), SETTLED)).toEqual({ kind: 'none' })
  })

  it('still says nothing for a plain rebind of a working shell', () => {
    // The behaviour the fix was for: no failure behind this dial.
    expect(connectionView(facts({
      status: 'connecting', bound, ready, recovering: false, attempt: 0,
    }), SETTLED)).toEqual({ kind: 'none' })
  })
})
