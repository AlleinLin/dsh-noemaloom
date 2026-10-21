/**
 * The device-side filesystem, against a real one.
 *
 * These run without a rig on purpose. Everything the helper decides about a
 * device is decidable from a directory: what a path canonicalizes to, what a
 * symlink is reported as, which errno becomes which code, whether a write
 * leaves a partial file behind. What needs the rig is the transport, not the
 * rules, and those rules are the part a refactor would break silently.
 *
 * **A POSIX filesystem, and therefore a POSIX machine.** This is the DEVICE's
 * half of the seam — the code that runs on the device, where every path is a
 * POSIX path and the file system has mode bits, ownership and a rename that
 * refuses to replace a directory. Asked the same questions on Windows, the
 * answers would be about a machine this code never runs on: `chmod` does not
 * restrict anything there, a directory has no 0600, and a rename over a
 * directory says EPERM rather than ENOTDIR. So the whole suite is skipped
 * there rather than answered wrongly; it runs in full wherever the helper
 * actually runs.
 */
import { createHash, randomBytes } from 'node:crypto'
import { rmSync, symlinkSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm, stat as statPath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe as vitestDescribe, expect, it } from 'vitest'
import { DeviceFileSystem, DeviceFsError } from '../src/helper/fs.js'

/** The describe blocks below, skipped where the device's own rules do not hold. */
const describe = vitestDescribe.skipIf(process.platform === 'win32')

/**
 * Whether this machine lets an unprivileged process create a symbolic link.
 *
 * Windows decides that with a privilege ("Create symbolic links") or with
 * Developer Mode, so a machine with neither cannot pose the cases that need a
 * link. They are skipped there rather than failed: the rule they pin — what a
 * symlink is reported as — is decidable only where a symlink can be made, and a
 * machine that cannot make one has no answer to give.
 */
const SYMLINKS = ((): boolean => {
  const probe = join(tmpdir(), `dshell-device-fs-probe-${String(process.pid)}`)
  try {
    // A link to a target that does not exist: the same shape the cases below
    // need, and the one Windows refuses without the privilege.
    symlinkSync(join(tmpdir(), 'dshell-device-fs-target'), probe)
    return true
  } catch {
    return false
  } finally {
    rmSync(probe, { force: true })
  }
})()

let root = ''
let files: DeviceFileSystem

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'dshell-device-fs-'))
  files = new DeviceFileSystem()
  await mkdir(join(root, 'sub', 'deep'), { recursive: true })
  await writeFile(join(root, 'hello.txt'), 'hello\n')
  await writeFile(join(root, 'sub', 'nested.txt'), 'nested\n')
  if (!SYMLINKS) return
  await symlink('hello.txt', join(root, 'link'))
  await symlink('nothing.txt', join(root, 'dangling'))
  await symlink(join(root, 'sub'), join(root, 'link-to-dir'))
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('resolve', () => {
  it('canonicalizes a path that does not exist yet, as `realpath -m` did', async () => {
    expect(await files.resolve(join(root, 'not', 'there', 'yet.txt'))).toBe(join(root, 'not', 'there', 'yet.txt'))
  })

  it.skipIf(!SYMLINKS)('resolves what the device\'s own symlinks say, including inside a missing tail', async () => {
    expect(await files.resolve(join(root, 'link'))).toBe(join(root, 'hello.txt'))
    expect(await files.resolve(join(root, 'link-to-dir', 'nested.txt'))).toBe(join(root, 'sub', 'nested.txt'))
    // The prefix resolves through the link; the part that does not exist rides
    // along, which is the case a longest-prefix walk answers wrongly.
    expect(await files.resolve(join(root, 'link-to-dir', 'absent', 'x.txt'))).toBe(join(root, 'sub', 'absent', 'x.txt'))
  })

  it('normalizes a path spelled with dot segments', async () => {
    expect(await files.resolve(join(root, 'sub', '..', 'hello.txt'))).toBe(join(root, 'hello.txt'))
  })

  it.skipIf(!SYMLINKS)('refuses to guess when a symlink cannot be followed', async () => {
    // A loop has no canonical form, and saying so is the only honest answer.
    await symlink('loop-b', join(root, 'loop-a'))
    await symlink('loop-a', join(root, 'loop-b'))
    await expect(files.resolve(join(root, 'loop-a'))).rejects.toThrow(DeviceFsError)
    await rm(join(root, 'loop-a'))
    await rm(join(root, 'loop-b'))
  })
})

describe('stat', () => {
  it('reports a file with its size and a change token', async () => {
    const info = await files.stat(join(root, 'hello.txt'), true)
    expect(info).toMatchObject({ kind: 'file', size: 6 })
    expect(info?.version).not.toBe('')
  })

  it('reports absence as null rather than as a failure', async () => {
    expect(await files.stat(join(root, 'absent.txt'), true)).toBeNull()
    // A parent that is a file is absent in the same sense; the local backend
    // reads ENOTDIR that way too.
    expect(await files.stat(join(root, 'hello.txt', 'x'), true)).toBeNull()
  })

  it.skipIf(!SYMLINKS)('reports a symlink as a symlink only when it is not followed', async () => {
    expect(await files.stat(join(root, 'link'), false)).toMatchObject({ kind: 'symlink' })
    expect(await files.stat(join(root, 'link'), true)).toMatchObject({ kind: 'file' })
  })

  it('changes the token when the file changes', async () => {
    await writeFile(join(root, 'token.txt'), 'one\n')
    const first = await files.stat(join(root, 'token.txt'), true)
    await writeFile(join(root, 'token.txt'), 'two\n')
    const second = await files.stat(join(root, 'token.txt'), true)
    expect(first?.version).not.toBe(second?.version)
  })

  it('reports a permission failure as a code, not as a message', async () => {
    await writeFile(join(root, 'unreadable.txt'), 'x\n')
    await chmod(join(root, 'unreadable.txt'), 0o000)
    await expect(files.read(join(root, 'unreadable.txt'), 0, 8)).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
    await chmod(join(root, 'unreadable.txt'), 0o600)
  })
})

describe('list', () => {
  it('lists direct children only', async () => {
    const names = (await files.list(root)).map(entry => entry.name)
    expect(names).toContain('hello.txt')
    expect(names).toContain('sub')
    expect(names).not.toContain('nested.txt')
  })

  it.skipIf(!SYMLINKS)('reports a child through a followed probe, and a dangling link as other', async () => {
    const byName = new Map((await files.list(root)).map(entry => [entry.name, entry]))
    // What the local backend reports: a symlink to a file is a file.
    expect(byName.get('link')).toMatchObject({ kind: 'file', size: 6 })
    expect(byName.get('link-to-dir')).toMatchObject({ kind: 'directory' })
    expect(byName.get('dangling')).toMatchObject({ kind: 'other' })
    expect(byName.get('dangling')?.version).toBeUndefined()
  })

  it('reports size only for files', async () => {
    const byName = new Map((await files.list(root)).map(entry => [entry.name, entry]))
    expect(byName.get('hello.txt')?.size).toBe(6)
    expect(byName.get('sub')?.size).toBeUndefined()
  })

  it('names the failure when the target is not a directory', async () => {
    await expect(files.list(join(root, 'hello.txt'))).rejects.toMatchObject({ code: 'FS_NOT_DIRECTORY' })
    await expect(files.list(join(root, 'absent'))).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
  })
})

describe('read', () => {
  it('reads a window and comes back short at the end of the file', async () => {
    expect((await files.read(join(root, 'hello.txt'), 0, 5)).toString()).toBe('hello')
    expect((await files.read(join(root, 'hello.txt'), 3, 100)).toString()).toBe('lo\n')
    expect((await files.read(join(root, 'hello.txt'), 6, 100)).byteLength).toBe(0)
  })

  it('reports a directory as not a regular file', async () => {
    await expect(files.read(join(root, 'sub'), 0, 8)).rejects.toMatchObject({ code: 'FS_NOT_REGULAR_FILE' })
  })
})

describe('write', () => {
  it('creates a file with the owner-only mode the local backend uses', async () => {
    await files.write(join(root, 'created.txt'), Buffer.from('created\n'))
    expect((await statPath(join(root, 'created.txt'))).mode & 0o777).toBe(0o600)
    expect(await readFile(join(root, 'created.txt'), 'utf8')).toBe('created\n')
  })

  it('carries an existing file\'s mode over', async () => {
    await writeFile(join(root, 'kept.txt'), 'before\n')
    await chmod(join(root, 'kept.txt'), 0o640)
    await files.write(join(root, 'kept.txt'), Buffer.from('after\n'))
    expect((await statPath(join(root, 'kept.txt'))).mode & 0o777).toBe(0o640)
  })

  it('creates missing parents, as the assembled path did', async () => {
    await files.write(join(root, 'made', 'up', 'path', 'file.txt'), Buffer.from('x\n'))
    expect(await readFile(join(root, 'made', 'up', 'path', 'file.txt'), 'utf8')).toBe('x\n')
  })

  it('reports the version a following stat reports', async () => {
    const path = join(root, 'versioned.txt')
    const written = await files.write(path, Buffer.from('v1\n'))
    // Read after the rename, or the token would describe the inode's state
    // before the rename changed its own change time.
    expect(written.version).toBe((await files.stat(path, true))?.version)
  })

  it('leaves nothing behind when it cannot publish', async () => {
    const directory = join(root, 'read-only')
    await mkdir(directory, { recursive: true })
    await chmod(directory, 0o500)
    await expect(files.write(join(directory, 'file.txt'), Buffer.from('x\n')))
      .rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
    await chmod(directory, 0o700)
    // No staging name survives, and the destination was never there.
    expect(await files.list(directory)).toEqual([])
  })

  it('replaces a directory\'s name with nothing', async () => {
    await mkdir(join(root, 'a-directory'), { recursive: true })
    await expect(files.write(join(root, 'a-directory'), Buffer.from('x\n')))
      .rejects.toMatchObject({ code: 'FS_NOT_REGULAR_FILE' })
    expect((await files.stat(join(root, 'a-directory'), true))?.kind).toBe('directory')
  })
})

describe('mkdir', () => {
  it('creates a directory, recursively, in one call', async () => {
    await files.mkdir([join(root, 'new', 'deep', 'dir')], true)
    expect((await files.stat(join(root, 'new', 'deep', 'dir'), true))?.kind).toBe('directory')
  })

  it('refuses a directory that already exists when recursive is false', async () => {
    await expect(files.mkdir([join(root, 'sub')], false)).rejects.toMatchObject({ code: 'FS_IO_ERROR' })
  })

  it('succeeds for an existing directory when recursive is true', async () => {
    await files.mkdir([join(root, 'sub')], true)
    expect((await files.stat(join(root, 'sub'), true))?.kind).toBe('directory')
  })

  it('refuses to create a parent that is a file', async () => {
    await writeFile(join(root, 'a-file'), 'x')
    await expect(files.mkdir([join(root, 'a-file', 'inside')], true))
      .rejects.toMatchObject({ code: 'FS_NOT_DIRECTORY' })
  })
})

describe('remove', () => {
  it('removes a directory recursively, tolerating absence when forced', async () => {
    await files.mkdir([join(root, 'to-remove')], true)
    await writeFile(join(root, 'to-remove', 'inside.txt'), 'x')
    await files.remove(join(root, 'to-remove'), true)
    expect(await files.stat(join(root, 'to-remove'), true)).toBeNull()
    // Absent + forced is a no-op, not an error.
    await files.remove(join(root, 'to-remove'), true)
  })

  it('refuses to remove an absent path without force', async () => {
    await expect(files.remove(join(root, 'absent'), false)).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
  })
})

describe('rename', () => {
  it('moves one path to another and returns the destination metadata', async () => {
    await writeFile(join(root, 'src.txt'), 'src')
    const moved = await files.rename(join(root, 'src.txt'), join(root, 'dst.txt'), false)
    expect(moved?.kind).toBe('file')
    expect(await files.stat(join(root, 'src.txt'), true)).toBeNull()
    expect(await readFile(join(root, 'dst.txt'), 'utf8')).toBe('src')
  })

  it('overwrites an existing destination when asked', async () => {
    await writeFile(join(root, 'old.txt'), 'old')
    await writeFile(join(root, 'new.txt'), 'new')
    await files.rename(join(root, 'old.txt'), join(root, 'new.txt'), true)
    expect(await readFile(join(root, 'new.txt'), 'utf8')).toBe('old')
  })

  it('refuses to overwrite when not asked', async () => {
    await writeFile(join(root, 'a'), 'a')
    await writeFile(join(root, 'b'), 'b')
    await expect(files.rename(join(root, 'a'), join(root, 'b'), false)).rejects.toMatchObject({ code: 'FS_NOT_OBSERVED' })
  })

  it('refuses a missing source', async () => {
    await expect(files.rename(join(root, 'absent'), join(root, 'dst'), false)).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
  })
})

describe('sha256', () => {
  it('hashes a file and matches node own digest', async () => {
    await writeFile(join(root, 'hash.txt'), 'hello')
    const expected = createHash('sha256').update('hello').digest('hex')
    expect(await files.sha256(join(root, 'hash.txt'))).toBe(expected)
  })

  it('returns a different digest for different bytes', async () => {
    await writeFile(join(root, 'one.txt'), 'one')
    await writeFile(join(root, 'two.txt'), 'two')
    expect(await files.sha256(join(root, 'one.txt'))).not.toBe(await files.sha256(join(root, 'two.txt')))
  })

  it('reports an absent file as FS_NOT_FOUND', async () => {
    await expect(files.sha256(join(root, 'absent.txt'))).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
  })
})

describe('copy', () => {
  it('copies a file end-to-end and reports the device own digest', async () => {
    await writeFile(join(root, 'src.bin'), 'hello, world')
    const events: { written: number; totalBytes: number }[] = []
    const outcome = await files.copy(join(root, 'src.bin'), join(root, 'dst.bin'), false, undefined,
      (written, totalBytes) => { events.push({ written, totalBytes }) }, new AbortController().signal)
    expect(outcome.bytes).toBe(12)
    expect(outcome.destination.kind).toBe('file')
    const expected = createHash('sha256').update('hello, world').digest('hex')
    expect(outcome.sourceSha256).toBe(expected)
    expect(await readFile(join(root, 'dst.bin'), 'utf8')).toBe('hello, world')
    // At least one progress event was reported.
    expect(events.length).toBeGreaterThan(0)
  })

  it('refuses a copy that would land on an existing destination', async () => {
    await writeFile(join(root, 'src.txt'), 'one')
    await writeFile(join(root, 'dst.txt'), 'two')
    await expect(files.copy(join(root, 'src.txt'), join(root, 'dst.txt'), false, undefined,
      () => undefined, new AbortController().signal)).rejects.toMatchObject({ code: 'FS_NOT_OBSERVED' })
    expect(await readFile(join(root, 'dst.txt'), 'utf8')).toBe('two')
  })

  it('refuses a copy that would land on a directory', async () => {
    await writeFile(join(root, 'src.txt'), 'one')
    await mkdir(join(root, 'a-dir'))
    await expect(files.copy(join(root, 'src.txt'), join(root, 'a-dir'), false, undefined,
      () => undefined, new AbortController().signal)).rejects.toMatchObject({ code: 'FS_NOT_REGULAR_FILE' })
  })

  it('rejects a digest mismatch before any byte is published', async () => {
    await writeFile(join(root, 'src.txt'), 'one')
    const dst = join(root, `dst-${randomBytes(4).toString('hex')}.txt`)
    await expect(files.copy(join(root, 'src.txt'), dst, false, '0'.repeat(64),
      () => undefined, new AbortController().signal)).rejects.toMatchObject({ code: 'FS_IO_ERROR' })
    // The destination was never renamed into place: the digest check happens
    // after the staging file is written but before the rename, so the
    // destination does not exist when the copy is rejected.
    expect(await files.stat(dst, true)).toBeNull()
  })

  it('preserves the destination mode when overwriting an existing file', async () => {
    await writeFile(join(root, 'src.txt'), 'one')
    await writeFile(join(root, 'dst.txt'), 'old')
    await chmod(join(root, 'dst.txt'), 0o640)
    await files.copy(join(root, 'src.txt'), join(root, 'dst.txt'), true, undefined,
      () => undefined, new AbortController().signal)
    expect((await statPath(join(root, 'dst.txt'))).mode & 0o777).toBe(0o640)
  })

  it('creates missing parents of the destination', async () => {
    await writeFile(join(root, 'src.txt'), 'one')
    await files.copy(join(root, 'src.txt'), join(root, 'made', 'up', 'dst.txt'), false, undefined,
      () => undefined, new AbortController().signal)
    expect(await readFile(join(root, 'made', 'up', 'dst.txt'), 'utf8')).toBe('one')
  })

  it('refuses a source that is not a regular file', async () => {
    await mkdir(join(root, 'src-dir'))
    await expect(files.copy(join(root, 'src-dir'), join(root, 'dst'), false, undefined,
      () => undefined, new AbortController().signal)).rejects.toMatchObject({ code: 'FS_NOT_REGULAR_FILE' })
  })

  it('refuses a missing source', async () => {
    await expect(files.copy(join(root, 'absent'), join(root, 'dst'), false, undefined,
      () => undefined, new AbortController().signal)).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
  })
})
