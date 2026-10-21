/**
 * The alias root: a session's own directory, when it is not the mount.
 *
 * dsh's file tools resolve a relative path against `session.header.cwd`, and a
 * session that was created first and pointed at a device later has a cwd on THIS
 * machine — the sidebar's terminal sessions are created in the reader's home.
 * Without an alias that path travels to the device unchanged, so `read notes.md`
 * asks the device for `/home/reader/notes.md`, a directory it may really have.
 * With one, the directory the harness picked is read as the stand-in it is and
 * the model never learns the difference.
 *
 * The precedence case is the one that would silently corrupt every mount path:
 * dshell's mount tree lives UNDER the reader's home, so the same path is inside
 * both roots and the more specific one has to win.
 */

import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { mappingFor, toMountPath, toRemotePath } from '../src/mount.js'

const MOUNT = '/home/reader/.dsh/dshell/mnt/dev-a/root'
const HOME = '/home/reader'

describe('mappingFor', () => {
  it('has no mapping at all without a mount', () => {
    expect(mappingFor({ remoteRoot: '/root' }, HOME)).toBeUndefined()
  })

  it('aliases the session directory when it is not the mount', () => {
    expect(mappingFor({ remoteRoot: '/root', mount: MOUNT }, HOME)).toEqual({
      mount: MOUNT, remoteRoot: '/root', alias: HOME,
    })
  })

  it('needs no alias for a session created in the mount', () => {
    // The device dialog's own shape: the harness made this directory, so it is
    // already the stand-in and translating it twice would be a no-op at best.
    expect(mappingFor({ remoteRoot: '/root', mount: MOUNT }, MOUNT)).toEqual({ mount: MOUNT, remoteRoot: '/root' })
    expect(mappingFor({ remoteRoot: '/root', mount: MOUNT }, `${MOUNT}/app`)).toEqual({ mount: MOUNT, remoteRoot: '/root' })
  })

  it('needs no alias when the session directory is unknown', () => {
    expect(mappingFor({ remoteRoot: '/root', mount: MOUNT }, undefined)).toEqual({ mount: MOUNT, remoteRoot: '/root' })
    expect(mappingFor({ remoteRoot: '/root', mount: MOUNT }, '')).toEqual({ mount: MOUNT, remoteRoot: '/root' })
  })
})

describe('toRemotePath with an alias', () => {
  const mapping = { mount: MOUNT, remoteRoot: '/root', alias: HOME }

  it('re-bases the session directory onto the device root', () => {
    expect(toRemotePath(mapping, HOME)).toBe('/root')
    expect(toRemotePath(mapping, `${HOME}/notes.md`)).toBe('/root/notes.md')
    expect(toRemotePath(mapping, `${HOME}/src/app.ts`)).toBe('/root/src/app.ts')
  })

  it('lets the mount win where the two roots overlap', () => {
    // The mount is under the home, so every mount path is also a home path;
    // the specific root has to answer or the tree would be re-based wrongly.
    expect(toRemotePath(mapping, MOUNT)).toBe('/root')
    expect(toRemotePath(mapping, `${MOUNT}/app`)).toBe('/root/app')
  })

  it('passes any other absolute path through', () => {
    // Addressing the device directly is the point of the session.
    expect(toRemotePath(mapping, '/var/log/syslog')).toBe('/var/log/syslog')
    expect(toRemotePath(mapping, '/home/other')).toBe('/home/other')
  })

  it('maps a home root onto itself', () => {
    expect(toRemotePath({ mount: '/mnt/dev/root', remoteRoot: '/home/deploy', alias: '/home/reader' }, '/home/reader/x'))
      .toBe('/home/deploy/x')
  })

  it('leaves the inverse untouched: the mount is the one local stand-in', () => {
    // A remote path is shown as the mount path, never as the alias — the alias
    // is a spelling the harness owns, not a second directory to display.
    // The mount is a path on THIS machine, so it is spelled with this
    // machine's rules: the same directory is `\\host\\...` on Windows.
    expect(toMountPath(mapping, '/root/app')).toBe(join(MOUNT, 'app'))
    expect(toMountPath(mapping, '/root')).toBe(MOUNT)
  })
})
