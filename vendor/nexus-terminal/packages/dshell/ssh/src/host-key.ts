/**
 * What this machine will accept as a device's host key.
 *
 * Read back from this plugin's OWN known_hosts rather than asked of the device:
 * anything the device reports travels over the very connection whose identity is
 * in question, so an interposed host can answer with whatever fingerprint it
 * likes. The local store is the only source that means "what dshell will accept
 * the next time it connects".
 *
 * The file is parsed and written here, in-process: this used to shell out to
 * `ssh-keygen -F/-R` and `ssh-keyscan`, which is what made host-key work depend
 * on a program being installed and on `PATH`. The grammar is OpenSSH's and is
 * implemented once, in `transport/known-hosts.ts`, where it is tested.
 */
import type { DeviceConnection } from './devices.js'
import { sshKnownHostsPath } from './paths.js'
import { deviceTransport } from './transport/transport.js'
import type { TrustedHostKey } from '@nexus-aethra/dshell-std'
import {
  entriesFor,
  fingerprintOf,
  knownHostsLookup,
  readKnownHosts,
  revokeHostKeys,
} from './transport/known-hosts.js'

/**
 * Every host key recorded for one destination.
 *
 * @param host - device host.
 * @param port - device port.
 * @returns the entries, empty when nothing is recorded.
 */
export function listTrustedHostKeys(host: string, port: number): TrustedHostKey[] {
  const lookup = knownHostsLookup(host, port)
  return entriesFor(readKnownHosts(sshKnownHostsPath()), host, port).map(entry => ({
    host: lookup,
    port,
    keyType: entry.keyType,
    fingerprint: fingerprintOf(entry.blob),
  }))
}

/**
 * The host key fingerprint dshell trusts for one destination.
 *
 * @param host - device host.
 * @param port - device port.
 * @returns the fingerprint, or undefined when nothing is recorded yet.
 */
export function trustedHostKey(host: string, port: number): string | undefined {
  return listTrustedHostKeys(host, port)[0]?.fingerprint
}

/**
 * Drop every host key recorded for one destination.
 *
 * @param host - device host.
 * @param port - device port.
 * @returns true when entries were removed; false when there were none.
 */
export function revokeTrustedHostKeys(host: string, port: number): boolean {
  return revokeHostKeys(sshKnownHostsPath(), host, port)
}

/**
 * What one host presents right now, over a connection that cannot be trusted.
 *
 * The transport dials it, takes the key from `hostVerifier` and refuses before
 * authenticating, so the answer is exactly what an interposed host would want a
 * reader to believe. It is offered for COMPARISON against a fingerprint obtained
 * some other way and never as something to trust on sight — the UI has to say so
 * in as many words.
 *
 * @param host - device host.
 * @param port - device port.
 * @returns the key the host offered, or undefined when it answered nothing.
 */
export async function probeHostKey(host: string, port: number): Promise<TrustedHostKey | undefined> {
  const probed = await deviceTransport().probeHostKey({
    id: 'probe',
    name: host,
    host,
    port,
    user: 'probe',
    remoteRoot: '~',
    auth: 'key',
    secret: undefined,
  } satisfies DeviceConnection)
  return probed === undefined
    ? undefined
    : { host: knownHostsLookup(host, port), port, keyType: probed.keyType, fingerprint: probed.fingerprint }
}
