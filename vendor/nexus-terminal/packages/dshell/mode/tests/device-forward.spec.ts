/**
 * The forward seat's pure half: which forward carries a port, and what the
 * button on that port says.
 *
 * The drawing is checked elsewhere; what is worth pinning here is the two
 * decisions a reader sees without noticing them: the port that already has a
 * forward names the local port it landed on, and a port that does not offers
 * one.
 */

import { describe, expect, it } from 'vitest'
import type { DshellForwardView } from '@nexus-aethra/dshell-std'
import { forwardFor, forwardLabel } from '../src/client/device-forward.js'

function view(over: Partial<DshellForwardView> = {}): DshellForwardView {
  return {
    sessionId: 's-device',
    deviceId: 'web',
    deviceName: 'build-box',
    devicePort: 8080,
    localPort: 18080,
    localAddress: '127.0.0.1',
    status: 'running',
    error: undefined,
    ...over,
  }
}

describe('the forward seat', () => {
  it('finds the forward that carries a port', () => {
    const forwards = [view({ devicePort: 3000 }), view({ devicePort: 8080 })]

    expect(forwardFor(forwards, 8080)?.localPort).toBe(18080)
    expect(forwardFor(forwards, 9999)).toBeUndefined()
  })

  it('offers a forward for a port that has none, and names the one that has', () => {
    // The word a button says is a function of the answer, so the two halves
    // cannot disagree about which one a port is in.
    expect(forwardLabel(undefined, 'forward')).toBe('forward')
    expect(forwardLabel(view(), 'forward')).toBe('18080')
  })
})
