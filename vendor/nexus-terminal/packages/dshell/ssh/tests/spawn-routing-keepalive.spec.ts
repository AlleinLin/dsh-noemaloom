/**
 * Binding another session must not cost the device its LIVE connection.
 *
 * A device keeps one connection for the host's life, and every session bound to
 * that device shares it — the terminal's shell, the file layer, the helper RPC.
 * The bind hook used to release that connection on its way in, so binding the
 * second session to a device tore the first session's terminal off the wire and
 * then paid for a probe, a dial and a handshake to build the identical
 * connection back. The reader saw it as a terminal that had been working
 * dropping to "connecting" for a second or more.
 *
 * The rule this pins: a bind warms nothing that is already there, and only a
 * SAVED or REMOVED device invalidates what was verified against it.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const source = readFileSync(
  fileURLToPath(new URL('../src/spawn-routing.ts', import.meta.url)),
  'utf8',
)

/** The body of the `router.onDeviceChanged` handler, as written. */
function deviceChangedBody(): string {
  const start = source.indexOf('router.onDeviceChanged = (deviceId, event) => {')
  expect(start, 'the device-changed hook is gone').toBeGreaterThanOrEqual(0)
  const end = source.indexOf('\n  }', start)
  expect(end, 'the hook has no closing brace').toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('binding a session to a device', () => {
  it('does not release the connection the other sessions are using', () => {
    const body = deviceChangedBody()
    // The release must sit AFTER the bind branch has returned, so a bind can
    // never reach it. Comparing positions is the point: a `release` that
    // appears anywhere above the `return` is the defect.
    const release = body.indexOf('connections.release(deviceId)')
    const bindReturn = body.lastIndexOf('return')
    expect(release, 'nothing releases the connection on a device change').toBeGreaterThanOrEqual(0)
    expect(
      release,
      'a bind releases the live connection again — the shell it was serving drops to connecting',
    ).toBeGreaterThan(bindReturn)
  })

  it('still invalidates a device that was actually saved', () => {
    const body = deviceChangedBody()
    // The invalidation is not gone, only moved: a saved device's target and the
    // connection verified against it no longer apply.
    expect(body).toContain('connections.release(deviceId)')
    expect(body).toContain('targets.drop(deviceId)')
  })

  it('warms the helper a bind needs without holding the caller', () => {
    const body = deviceChangedBody()
    expect(body).toContain('connections.forDevice(device, target)')
    // The warm-up may await INSIDE its own async function, but the hook itself
    // must not await anything: it runs inside a bind's round trip, so a probe
    // here would hold the caller for the device's whole timeout. A `void`
    // applied to the call is what makes it fire-and-forget.
    expect(body).toContain('void (async () => {')
    const hookHead = body.slice(0, body.indexOf('void (async () => {'))
    expect(hookHead, 'the bind hook awaits before returning').not.toContain('await ')
  })
})
