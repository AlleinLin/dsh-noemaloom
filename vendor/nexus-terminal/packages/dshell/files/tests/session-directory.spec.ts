/**
 * Where a session stands, in the world that answers for it.
 *
 * A device-bound session's working directory is a path on THIS machine, because
 * the harness created it here and cannot move it. Reading that string as a place
 * in the device's world is what made a terminal session's file pane list the
 * reader's own home while its shell answered from the device: `/home/reader`
 * passes through the mapping untouched, so the device was asked about a
 * directory it does not have. These cases pin the translation, and the one case
 * that must NOT translate — a session created inside the mount, whose directory
 * is a real place in both worlds.
 */

import { describe, expect, it } from 'vitest'
import { sessionDirectory } from '../src/route.js'
import type { TransferRoutingSeat } from '../src/transfer.js'

/** A routing seat with one assignment, or none at all. */
function seat(target?: { remoteRoot: string; mount?: string }): () => TransferRoutingSeat | undefined {
  if (target === undefined) return () => undefined
  return () => ({
    targetForSession: (sessionId: string) => sessionId === 'session-1'
      ? { device: { id: 'dev-a', name: 'A' }, remoteRoot: target.remoteRoot, ...target.mount === undefined ? {} : { mount: target.mount } }
      : undefined,
  })
}

describe('sessionDirectory', () => {
  it('is the session directory when nothing routes it', () => {
    expect(sessionDirectory(seat(), 'session-1', '/home/reader')).toBe('/home/reader')
    // No routing seat composed at all: the local answer, unchanged.
    expect(sessionDirectory(() => undefined, 'session-1', '/home/reader')).toBe('/home/reader')
  })

  it('is the device root for a session whose directory is not in its world', () => {
    // The terminal session: created in the reader's home, pointed at a device
    // afterwards, so its directory names no place on that device.
    const bound = seat({ remoteRoot: '/srv', mount: '/home/reader/.dsh/dshell/mnt/dev-a/srv' })
    expect(sessionDirectory(bound, 'session-1', '/home/reader')).toBe('/srv')
    expect(sessionDirectory(bound, 'session-1', undefined)).toBe('/srv')
  })

  it('keeps a directory that is inside the mount', () => {
    // Created by the device dialog: the harness made this directory, and the
    // seam translates it — translating here too would lose the subdirectory.
    const mount = '/home/reader/.dsh/dshell/mnt/dev-a/srv'
    const bound = seat({ remoteRoot: '/srv', mount })
    expect(sessionDirectory(bound, 'session-1', mount)).toBe(mount)
    expect(sessionDirectory(bound, 'session-1', `${mount}/app`)).toBe(`${mount}/app`)
  })

  it('does not mistake a sibling of the mount for a directory under it', () => {
    const bound = seat({ remoteRoot: '/srv', mount: '/mnt/dev-a/srv' })
    expect(sessionDirectory(bound, 'session-1', '/mnt/dev-a/srv-other')).toBe('/srv')
  })

  it('is the device root for a binding with no mount', () => {
    // A mapping that was never recorded routes no file operation, so the local
    // directory is not a fallback worth keeping: the world that answers is the
    // device's either way.
    expect(sessionDirectory(seat({ remoteRoot: '/srv' }), 'session-1', '/home/reader')).toBe('/srv')
  })

  it('leaves another session alone', () => {
    const bound = seat({ remoteRoot: '/srv', mount: '/mnt/dev-a/srv' })
    expect(sessionDirectory(bound, 'session-2', '/home/reader')).toBe('/home/reader')
  })
})
