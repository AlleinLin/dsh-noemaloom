/**
 * The forward seat: what the panel shows about forwards, and what it asks for.
 *
 * The panel talks to the HOST over the forward route, the same way the device
 * readout does: this package does not depend on the ssh package, and a forward
 * is a thing the host owns — the socket is on the host's machine, not in the
 * browser.
 *
 * The answers are a snapshot per session, shared: the panel is the only reader
 * today, but the same rule the device readout follows applies — two readers of
 * the same session must cost one request, not two.
 */

import {
  DSHELL_SSH_FORWARD_PATH,
  type DshellForwardRequest,
  type DshellForwardResponse,
  type DshellForwardView,
} from '@nexus-aethra/dshell-std'

/** The read side, stable enough for `useSyncExternalStore`. */
export interface DeviceForwardSeat {
  /** The last answer for one session, or undefined when it was never read. */
  getSnapshot(sessionId: string): DshellForwardResponse | undefined
  subscribe(listener: () => void): () => void
  /** Open a forward and say where it landed. */
  open(sessionId: string, devicePort: number, localPort?: number): Promise<DshellForwardResponse>
  /** Stop one forward, by the local port it listens on. */
  stop(sessionId: string, localPort: number): Promise<DshellForwardResponse>
}

const answers = new Map<string, DshellForwardResponse>()
const listeners = new Set<() => void>()

/** Publish one answer, and tell the readers. */
function publish(sessionId: string, answer: DshellForwardResponse): void {
  answers.set(sessionId, answer)
  for (const listener of [...listeners]) listener()
}

/**
 * Ask the host about one session's forwards.
 *
 * @param sessionId - the session whose forwards are asked for.
 * @param request - what to ask.
 * @returns the host's answer.
 */
async function ask(sessionId: string, request: DshellForwardRequest): Promise<DshellForwardResponse> {
  try {
    const response = await fetch(
      `${DSHELL_SSH_FORWARD_PATH}`,
      {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      },
    )
    const body = await response.json() as DshellForwardResponse
    publish(sessionId, body)
    return body
  } catch {
    // A host that did not answer is said out loud rather than hidden behind the
    // last snapshot: a stale forward list reads like a live one.
    const failed: DshellForwardResponse = { forwards: [], error: 'the host did not answer' }
    publish(sessionId, failed)
    return failed
  }
}

/**
 * Put an answer in the seat, as if the host had sent it.
 *
 * The seat answers from what the host last said, and a drawing needs to show
 * what that answer was. This is how a test draws a panel whose forwards are
 * already known, and how the host's own answer enters the seat when it
 * arrives.
 *
 * @param sessionId - the session the answer is about.
 * @param answer - the host's answer.
 */
export function publishForwards(sessionId: string, answer: DshellForwardResponse): void {
  publish(sessionId, answer)
}

/** The one seat the client hands to the panel. */
export const deviceForwardSeat: DeviceForwardSeat = {
  getSnapshot: (sessionId) => answers.get(sessionId),
  subscribe(listener) {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  },
  open(sessionId, devicePort, localPort) {
    return ask(sessionId, { op: 'open', sessionId, devicePort, ...localPort === undefined ? {} : { localPort } })
  },
  stop(sessionId, localPort) {
    return ask(sessionId, { op: 'stop', sessionId, localPort })
  },
}

/**
 * The forwards of one session, as the panel reads them.
 *
 * @param sessionId - the session whose forwards are asked for.
 * @returns the host's answer.
 */
export async function readForwards(sessionId: string): Promise<DshellForwardResponse> {
  return await ask(sessionId, { op: 'list', sessionId })
}

/**
 * The forward that carries one device port, if there is one.
 *
 * @param forwards - the forwards to look among.
 * @param devicePort - the device port to look for.
 * @returns the forward, or undefined.
 */
export function forwardFor(
  forwards: readonly DshellForwardView[],
  devicePort: number,
): DshellForwardView | undefined {
  return forwards.find(forward => forward.devicePort === devicePort)
}

/**
 * What a port row's forward button says.
 *
 * A port that has no forward offers one; a port that has one names the local
 * port it landed on, because that is the address the reader opens. The word
 * is a FUNCTION of the answer rather than a constant, so the two halves cannot
 * disagree about which one a port is in.
 *
 * @param forward - the forward that carries the port, if there is one.
 * @param offer - the word for offering one.
 * @returns what the button says.
 */
export function forwardLabel(forward: DshellForwardView | undefined, offer: string): string {
  return forward === undefined ? offer : String(forward.localPort)
}
