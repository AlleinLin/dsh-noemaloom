/**
 * What a device connection failure IS, in this package's own vocabulary.
 *
 * The assembled path used to learn these facts by matching English text out of
 * the ssh client's stderr, which reported a non-English device's permission
 * problem as an unknown fault. An in-process client knows the difference
 * structurally, so the classification is made here once and every consumer
 * reads a kind rather than a sentence.
 */

import { VaultLockedError } from '../vault.js'

/** Why a connection or command could not be served. */
export type DeviceFailureKind =
  /** The device refused the credentials this package holds. */
  | 'auth'
  /** The host key does not match what this plugin recorded for it. */
  | 'hostKey'
  /** The device could not be reached at all. */
  | 'unreachable'
  /** The transport itself failed, after the connection was established. */
  | 'transport'

/** A device failure carrying its kind, so no caller has to re-derive it. */
export class DeviceSshError extends Error {
  constructor(
    readonly kind: DeviceFailureKind,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'DeviceSshError'
  }
}

/** The host key a device presented is not the one this plugin recorded. */
export function hostKeyMismatch(host: string, port: number, expected: string | undefined, offered: string): DeviceSshError {
  return new DeviceSshError('hostKey',
    expected === undefined
      ? `the device ${host}:${String(port)} presented no host key`
      : `the host key of ${host}:${String(port)} changed (recorded ${expected}, device offered ${offered})`,
  )
}

/** Levels ssh2 reports on a failed connection, mapped to the kinds above. */
const LEVEL_KINDS: Readonly<Record<string, DeviceFailureKind>> = {
  'client-timeout': 'unreachable',
  'connection-timeout': 'unreachable',
  'client-socket': 'unreachable',
  'client-authentication': 'auth',
  'agent': 'auth',
}

/**
 * Classify a failure raised while connecting or running.
 *
 * Our own errors are authoritative: they were raised where the cause was known.
 * Everything else is read off ssh2's structured `level`, and an unrecognized
 * level is a transport failure rather than a guess at connectivity.
 *
 * @param error - what the client or the channel raised.
 * @returns the kind, for a caller that wants to decide what to say.
 */
export function classifyDeviceError(error: unknown): DeviceFailureKind {
  if (error instanceof DeviceSshError) return error.kind
  // A credential whose group is locked is an authentication problem, not a
  // transport one: re-dialling would fail the same way, and the refusal names
  // the group to unlock.
  if (error instanceof VaultLockedError) return 'auth'
  const level = (error as { level?: unknown } | undefined)?.level
  if (typeof level === 'string' && level in LEVEL_KINDS) return LEVEL_KINDS[level]
  return 'transport'
}
