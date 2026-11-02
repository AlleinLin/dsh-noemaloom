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
    status: 'idle', ready: false, attempt: 0, bound: false, localUnsupported: false, failure: undefined, ...over,
  }
}

describe('a machine that cannot host a local shell', () => {
  it('gets a screen of its own, not a marker on output that does not exist', () => {
    // The case this exists for: on Windows a local spawn fails immediately, so
    // `ready` is false and there is no output behind it to append a line to.
    const view = connectionView(facts({ status: 'error', localUnsupported: true }))
    expect(view).toEqual({ kind: 'panel', phase: 'unsupported' })
  })

  it('outranks a local session still starting up', () => {
    // Otherwise a Windows reader gets the "waiting for a device" screen for a
    // session that is not on a device at all.
    const view = connectionView(facts({
      status: 'connecting', bound: false, ready: false, localUnsupported: true,
    }))
    expect(view).toEqual({ kind: 'panel', phase: 'unsupported' })
  })

  it('leaves a DEVICE session alone — its shell runs on the device', () => {
    // The whole point of the bound check: Windows is a perfectly good place to
    // run an ssh client from, so a bound session must still get its normal
    // connecting screen and its retry.
    const view = connectionView(facts({
      status: 'connecting', bound: true, ready: false, localUnsupported: true,
    }))
    expect(view).toEqual({ kind: 'panel', phase: 'connecting' })
  })

  it('stays quiet while no terminal has been asked for', () => {
    // The flag is set by a failed spawn, but a reader who has not opened a
    // terminal yet should not be met by a screen about one.
    expect(connectionView(facts({ status: 'idle', localUnsupported: true })))
      .toEqual({ kind: 'none' })
  })

  it('forgets the fact for the next session', () => {
    expect(connectionView(facts({ status: 'error', localUnsupported: true })))
      .toEqual({ kind: 'panel', phase: 'unsupported' })
    // A fresh bind starts clean, so an ordinary failure is an ordinary failure.
    expect(connectionView(facts({ status: 'error' })))
      .toEqual({ kind: 'notice', tone: 'failed' })
  })
})

describe('the screens that were already there', () => {
  it('keeps a bound session that never answered on the connecting screen', () => {
    expect(connectionView(facts({ status: 'connecting', bound: true })))
      .toEqual({ kind: 'panel', phase: 'connecting' })
  })

  it('keeps a bound session that HAD answered as a marker, not a screen', () => {
    expect(connectionView(facts({ status: 'connecting', bound: true, ready: true })))
      .toEqual({ kind: 'notice', tone: 'connecting' })
  })

  it('shows a first local failure as a plain retry notice', () => {
    expect(connectionView(facts({ status: 'error' })))
      .toEqual({ kind: 'notice', tone: 'failed' })
  })

  it('says nothing at all about a local session that is merely starting', () => {
    expect(connectionView(facts({ status: 'connecting' }))).toEqual({ kind: 'none' })
  })
})

describe('coming back to a terminal that never failed', () => {
  // Switching session and returning is the ordinary way a device terminal is
  // used, and it re-opens the carrier: the wire is briefly `connecting` while
  // the socket's handshake runs. That is not a retry, and the retry marker is
  // the one thing on screen that would say otherwise — so a switch must never
  // be able to leave a count behind it.
  it('never shows a retry count for a rebind with nothing to retry', () => {
    // attempt 0 is what the bind resets it to; the marker's own guard is what
    // this pins, because the count is rendered from this value alone.
    expect(connectionView(facts({ status: 'connecting', bound: true, ready: true, attempt: 0 })))
      .toEqual({ kind: 'notice', tone: 'connecting' })
  })

  it('still shows the count for a retry that really is running', () => {
    // The complement: a genuine failure must keep its count visible, or the
    // reader loses the one signal that says how much of the budget is gone.
    const view = connectionView(facts({ status: 'closed', bound: true, ready: true, attempt: 2 }))
    expect(view).toEqual({ kind: 'notice', tone: 'failed' })
  })
})

describe('a host key that changed', () => {
  it('gets a screen, because the only way out is a decision, not a retry', () => {
    expect(connectionView(facts({ status: 'error', bound: true, failure: 'hostKey' })))
      .toEqual({ kind: 'panel', phase: 'hostKey' })
  })

  it('outranks the never-came-up screen', () => {
    // Both are full screens for a bound session; the changed key is the more
    // specific fact and the retry it would otherwise offer cannot work.
    expect(connectionView(facts({ status: 'error', bound: true, ready: false, failure: 'hostKey' })))
      .toEqual({ kind: 'panel', phase: 'hostKey' })
  })

  it('still gets a screen for a shell that HAD answered', () => {
    // A terminal the reader was working in loses its link because the machine
    // was rebuilt: the marker rule would hide that behind a retry.
    expect(connectionView(facts({ status: 'error', bound: true, ready: true, failure: 'hostKey' })))
      .toEqual({ kind: 'panel', phase: 'hostKey' })
  })

  it('never applies to a local session', () => {
    // Nothing here runs ssh, so there is no host key to have changed.
    expect(connectionView(facts({ status: 'error', failure: 'hostKey' })))
      .toEqual({ kind: 'notice', tone: 'failed' })
  })

  it('says nothing about an idle session', () => {
    expect(connectionView(facts({ bound: true, failure: 'hostKey' }))).toEqual({ kind: 'none' })
  })
})

describe('a passphrase that was refused', () => {
  // Deliberately NOT a screen: the remedy is re-entering a secret in the device
  // form, and this panel is not where that form lives.
  it('keeps the ordinary failure presentation', () => {
    expect(connectionView(facts({ status: 'error', bound: true, failure: 'passphrase' })))
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
