/**
 * The name the DEVICE should use for a program the caller resolved for the host.
 *
 * The device is a POSIX machine whatever the host is, so the answer cannot
 * depend on the host's path rules — and it cannot be a path in the host's
 * filesystem, because the device cannot execute one. What it CAN be is a bare
 * name, which the device resolves from its own PATH.
 *
 * The case that made this a rule rather than a nicety: a Windows host resolves
 * `rg` to `rg.exe` and every other program to `C:\…\something.exe`, and a
 * check for the forward slash alone read the whole path as a bare name. The
 * device was then asked to run `C:\Windows\System32\cmd.exe`, and it answered
 * with an ENOENT that named a directory it had never heard of.
 */

import { describe, expect, it } from 'vitest'
import { deviceProgram } from '../src/spawn-routing.js'

describe('a program the device is to run', () => {
  it('is the bare name, for the device to resolve', () => {
    expect(deviceProgram('ls')).toBe('ls')
    expect(deviceProgram('grep')).toBe('grep')
  })

  it('is the device own rg, whatever the host called it', () => {
    expect(deviceProgram('rg')).toBe('rg')
    // The single-file runtime's sidecar.
    expect(deviceProgram('codex-rg')).toBe('rg')
    // A Windows host resolves the same program with an extension.
    expect(deviceProgram('rg.exe')).toBe('rg')
    // And with a path in front of it, on either platform.
    expect(deviceProgram('/usr/local/bin/rg')).toBe('rg')
    expect(deviceProgram('C:\\Users\\dev\\AppData\\Local\\rg.exe')).toBe('rg')
  })

  it('is not a path in the host filesystem', () => {
    // The device cannot execute a location on the host's disk, and a
    // location handed over as a name would run whatever happens to carry
    // that name there — or nothing at all.
    expect(deviceProgram('/usr/bin/ls')).toBeUndefined()
    expect(deviceProgram('C:\\Windows\\System32\\cmd.exe')).toBeUndefined()
    expect(deviceProgram('C:\\Program Files\\nodejs\\node.exe')).toBeUndefined()
  })
})
