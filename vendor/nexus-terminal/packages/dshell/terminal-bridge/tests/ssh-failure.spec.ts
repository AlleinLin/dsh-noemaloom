import { describe, expect, it } from 'vitest'
import { classifyDeviceFailure, lockedVaultRefusal } from '../src/pty.js'

/**
 * A transport refusal, spelled the way one arrives here: the device transport
 * raises a `DeviceSshError` carrying the kind where the cause was known, and
 * this package reads that field structurally rather than importing the SSH
 * plugin to ask.
 */
function deviceRefusal(kind: string): Error {
  const error = new Error('the device refused the connection')
  ;(error as Error & { kind: string }).kind = kind
  return error
}

describe('classifyDeviceFailure', () => {
  it('names a changed host key', () => {
    expect(classifyDeviceFailure(deviceRefusal('hostKey'))).toBe('hostKey')
  })

  it('names a refused secret', () => {
    expect(classifyDeviceFailure(deviceRefusal('auth'))).toBe('passphrase')
  })

  // The ordering that matters: a device whose host key changed refuses the
  // connection outright, but a host that will not say which of the two it is
  // can surface the same key as an authentication failure. Reading that as a
  // bad secret would send the user to fix a secret that is correct.
  it('prefers the host key over an authentication failure', () => {
    const both = deviceRefusal('auth')
    ;(both as Error & { kind: string }).kind = 'hostKey'
    expect(classifyDeviceFailure(both)).toBe('hostKey')
  })

  // A device that cannot be reached is retried, and a transport fault is waited
  // out; neither is something re-entering a secret fixes.
  it('leaves an unreachable device unnamed', () => {
    expect(classifyDeviceFailure(deviceRefusal('unreachable'))).toBeUndefined()
    expect(classifyDeviceFailure(deviceRefusal('transport'))).toBeUndefined()
  })

  it('leaves an ordinary spawn failure alone', () => {
    expect(classifyDeviceFailure(new Error('ssh: connect to host web port 22: Connection refused'))).toBeUndefined()
    expect(classifyDeviceFailure(new Error('分组已锁定'))).toBeUndefined()
  })

  it('is not fooled by something that is not an error at all', () => {
    expect(classifyDeviceFailure('hostKey')).toBeUndefined()
    expect(classifyDeviceFailure(undefined)).toBeUndefined()
  })
})

describe('lockedVaultRefusal', () => {
  /** The refusal the SSH router raises, spelled the way it arrives here. */
  function vaultRefusal(): Error {
    const error = new Error('分组「远程验收」已锁定，先解锁才能读取或写入它的凭据')
    error.name = 'VaultLockedError'
    return error
  }

  // Recognised so the client can keep its retry budget for the attempt that
  // follows the unlock, and offer the token on the failure screen. Matching the
  // message text instead would make every future rewording a behaviour change.
  it('names the vault refusal by its error name', () => {
    expect(lockedVaultRefusal(vaultRefusal())).toBe(true)
  })

  it('leaves an ordinary spawn failure alone', () => {
    expect(lockedVaultRefusal(new Error('ssh: connect to host web port 22: Connection refused'))).toBe(false)
    expect(lockedVaultRefusal(new Error('分组已锁定'))).toBe(false)
  })

  it('is not fooled by something that is not an error at all', () => {
    expect(lockedVaultRefusal('VaultLockedError')).toBe(false)
    expect(lockedVaultRefusal(undefined)).toBe(false)
  })
})
