/**
 * A device record, as the SSH client's own configuration.
 *
 * This is the one place that turns a stored secret into what the client is
 * handed. Everything above it speaks about devices; everything below it speaks
 * about `ssh2`'s `ConnectConfig`; and the shape in between is deliberately
 * small — a password, or a key with an optional passphrase — because that is
 * all a device record can hold.
 *
 * Nothing here opens a file. The secret arrives as plaintext, resolved by the
 * device store at the moment the connection is made: the transport used to be
 * handed a path to a key file, and that file was the only reason a sealed
 * secret had to be unsealed onto the disk at all. A library is given bytes.
 *
 * Two rules carry over from the `ssh` client this replaces, and both are about
 * NOT reaching for an identity the reader did not choose:
 *
 *  - **No stored key means no key at all.** The old `-i` + `IdentitiesOnly=yes`
 *    pair existed so a device's own key was the only one offered; ssh2 has no
 *    agent to consult unless one is configured, and dshell never configured
 *    one. Leaving `privateKey` out therefore reproduces the same refusal: a
 *    device with no secret authenticates by nothing and fails, rather than
 *    quietly connecting as whoever's key happens to be loaded.
 *  - **A passphrase is only ever read for a key.** It is stored per-device next
 *    to the key it unlocks, and a password device is never asked for one.
 */
import type { ConnectConfig } from 'ssh2'
import type { DeviceConnection } from '../devices.js'

/**
 * A secret without the newline its writer appended.
 *
 * Every writer in this package ends a secret with exactly one `\n` — OpenSSH's
 * key parser wants it, and the askpass hook this replaces used to read the file
 * verbatim and let `ssh` strip it. The strip belongs here now that nothing
 * strips for us:
 * a trailing newline in a password is a refused login, and a trailing newline in
 * a passphrase is a key that will not decrypt.
 *
 * @param text - the secret as it was stored.
 * @returns the secret as it should be sent.
 */
function withoutTrailingNewline(text: string): string {
  return text.endsWith('\n') ? text.slice(0, -1) : text
}

/**
 * The connection configuration for one device.
 *
 * @param device - the resolved connection, its secret opened on demand.
 * @returns what `ssh2` needs to dial it; never an agent, never an ambient key.
 */
export async function connectConfig(device: DeviceConnection): Promise<ConnectConfig> {
  const base: ConnectConfig = {
    host: device.host,
    port: device.port,
    username: device.user,
    // A dead link must be noticed by the keepalive rather than by a caller
    // waiting on a command that will never produce output: the old
    // `ServerAliveInterval=15, CountMax=3` becomes 15s × 3 unanswered probes.
    keepaliveInterval: 15_000,
    keepaliveCountMax: 3,
    // The handshake itself is bounded, so a filtered port fails as a refusal
    // instead of a hang. This is the old `ConnectTimeout=10`.
    readyTimeout: 10_000,
  }
  const secret = await device.secret?.open()
  if (secret === undefined) return base
  if (device.auth === 'password') return { ...base, password: withoutTrailingNewline(secret) }
  const passphrase = await device.secret?.passphrase?.()
  return {
    ...base,
    // A key KEEPS its trailing newline: it is part of the PEM encoding, and
    // OpenSSH's parser rejects a key that does not end with one. A password and
    // a passphrase do not — one is a refused login, the other a key that will
    // not decrypt.
    privateKey: secret,
    ...passphrase === undefined ? {} : { passphrase: withoutTrailingNewline(passphrase) },
  }
}
