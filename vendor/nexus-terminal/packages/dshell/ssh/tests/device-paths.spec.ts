/**
 * The two path namespaces, and what happens when they are confused.
 *
 * A dshell session that runs on a device has TWO spellings of every directory:
 * the mount and the session's own directory live on THIS machine, and the
 * device's tree is spelled the way the DEVICE spells it — POSIX, on every
 * device dshell talks to.
 *
 * The two are easy to confuse, and the confusion is not cosmetic. A device
 * path built with the host's rules is `\root\notes.md` on Windows: the
 * device's own helper refuses it outright (its protocol says "always
 * absolute: the caller translates, the device does not guess"), and no POSIX
 * program on the device can open it either. So the device side of every
 * translation is built with POSIX rules, whatever the host is.
 *
 * The host paths below are built with `join`, so each platform spells them its
 * own way — and the assertions are about the DEVICE side, which is the same
 * everywhere.
 */

import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import {
  absoluteRemoteRoot, isUnderRemote, mappingFor, toMountPath, toRemotePath,
} from '../src/mount.js'

/** A mount directory on this machine, spelled the way this machine spells it. */
const MOUNT = join('home', 'reader', '.dsh', 'mnt', 'dev', 'root')
/** The session's own directory, which is not the mount. */
const HOME = join('home', 'reader')
/** The device's own directory. */
const REMOTE_ROOT = '/root'

/** One session's mapping: the mount, the device root, and the session's alias. */
const mapping = { mount: MOUNT, remoteRoot: REMOTE_ROOT, alias: HOME }

describe('a host path that names the device tree', () => {
  it('becomes a device path, spelled the way the device spells it', () => {
    const remote = toRemotePath(mapping, join(HOME, 'notes.md'))
    expect(remote).toBe('/root/notes.md')
    expect(remote.includes('\\')).toBe(false)
  })

  it('keeps the nested segments apart', () => {
    expect(toRemotePath(mapping, join(HOME, 'src', 'app.ts'))).toBe('/root/src/app.ts')
  })

  it('is always absolute, which is what the device protocol demands', () => {
    // The helper's protocol: "Always absolute: the caller translates, the
    // device does not guess." A device path that does not start with a slash
    // is refused by the device before it is read.
    const remote = toRemotePath(mapping, join(HOME, 'notes.md'))
    expect(remote.startsWith('/')).toBe(true)
  })

  it('maps the session directory onto the device root', () => {
    expect(toRemotePath(mapping, HOME)).toBe(REMOTE_ROOT)
  })

  it('leaves a path that is not the session directory alone', () => {
    // On a device session the model may address the device directly, and
    // `/var/log` means the device's `/var/log` — that is the point of the
    // session, so it travels unchanged.
    expect(toRemotePath(mapping, '/var/log/syslog')).toBe('/var/log/syslog')
  })
})

describe('a device path that names this machine', () => {
  it('is shown as the mount path, in this machine spelling', () => {
    // The mount is a path on THIS machine, so it is spelled with this
    // machine's rules: the same directory is `\home\reader\...` on Windows.
    expect(toMountPath(mapping, '/root/notes.md')).toBe(join(MOUNT, 'notes.md'))
    expect(toMountPath(mapping, REMOTE_ROOT)).toBe(MOUNT)
  })

  it('is left alone when it is outside the device tree', () => {
    expect(toMountPath(mapping, '/etc/x')).toBe('/etc/x')
  })
})

describe('a device root spelled with a tilde', () => {
  it('expands into a device path', () => {
    expect(absoluteRemoteRoot('~/app', '/root')).toBe('/root/app')
    expect(absoluteRemoteRoot('~', '/root')).toBe('/root')
  })
})

describe('containment on the device', () => {
  it('reads the device path in the device grammar', () => {
    expect(isUnderRemote('/root', '/root')).toBe(true)
    expect(isUnderRemote('/root', '/root/app')).toBe(true)
    expect(isUnderRemote('/root', '/rootless/app')).toBe(false)
    expect(isUnderRemote('/root', '/etc/x')).toBe(false)
  })
})

describe('the mapping a session gets', () => {
  it('aliases the session directory when it is not the mount', () => {
    expect(mappingFor({ remoteRoot: REMOTE_ROOT, mount: MOUNT }, HOME)).toEqual({
      mount: MOUNT, remoteRoot: REMOTE_ROOT, alias: HOME,
    })
  })

  it('needs no alias for a session created in the mount', () => {
    expect(mappingFor({ remoteRoot: REMOTE_ROOT, mount: MOUNT }, MOUNT)).toEqual({
      mount: MOUNT, remoteRoot: REMOTE_ROOT,
    })
  })
})
