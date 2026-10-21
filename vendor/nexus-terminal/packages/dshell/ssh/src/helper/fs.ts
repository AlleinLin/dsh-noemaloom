/**
 * The device's filesystem, as the helper serves it.
 *
 * Every operation here is a request with arguments and a reply with fields,
 * which is the point of the helper: the alternative — a POSIX command assembled
 * on the host and its output parsed back — decides things by reading text. That
 * cost was concrete. Listing a directory needed `find -printf` with a
 * NUL-separated format because a filename may contain any byte but NUL, and
 * `LC_ALL=C` because `stat` and `find` localize their output — `%F` prints
 * "regular file" in whatever language the device is set to — and a failure was
 * classified by matching English error text, so a device with a non-English
 * userland reported every permission problem as an unknown I/O fault.
 *
 * Here a failure is a code derived from an errno, the message is only ever read
 * by a human, and a filename is a JSON string: no separator can be forged, no
 * locale can change what a field means.
 *
 * What this module does NOT own is policy. Whether a write is allowed, whether
 * a version is stale, how line endings are treated, and what a literal edit
 * means are all decided on the host, where the same answers apply to a local
 * session. This is the device's half of the seam and nothing more.
 */
import { createHash, randomBytes } from 'node:crypto'
import type { BigIntStats } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, rename, rm, stat, unlink } from 'node:fs/promises'
import { basename, dirname, posix } from 'node:path'
import type { z } from 'zod'
import type { remoteFsKind } from './protocol.js'

/** The seam's names for the failures a device can originate. */
export type DeviceFsCode = DeviceFsErrorCode

/** What a path is, in the seam's vocabulary. */
export type DeviceFsKind = z.infer<typeof remoteFsKind>

/** One path's metadata, as the helper reports it. */
export interface DeviceStat {
  readonly kind: DeviceFsKind
  readonly size: number
  /** Opaque change token; the host only ever compares two of them. */
  readonly version: string
  /** POSIX permission bits, kept for the write path's mode preservation. */
  readonly mode: number
}

/** One directory child, as the helper reports it. */
export interface DeviceListEntry {
  readonly name: string
  readonly kind: DeviceFsKind
  readonly size?: number
  readonly version?: string
}

/**
 * A filesystem failure a client can act on without reading a message.
 *
 * The code is the contract — it is what decides which `FsError` the host
 * raises, in the host's own language — while the message is diagnostics: the
 * platform's own text, naming the path and the errno.
 */
export class DeviceFsError extends Error {
  constructor(message: string, readonly code: DeviceFsErrorCode) {
    super(message)
    this.name = 'DeviceFsError'
  }
}

/** The seam's names for the failures a device can originate. */
export type DeviceFsErrorCode = 'FS_NOT_FOUND' | 'FS_NOT_DIRECTORY' | 'FS_NOT_REGULAR_FILE' | 'FS_PERMISSION_DENIED' | 'FS_TOO_LARGE' | 'FS_IO_ERROR' | 'FS_ABORTED' | 'FS_NOT_OBSERVED'

/** Whether an error means "nothing is there" rather than "something went wrong". */
function isAbsent(error: unknown): boolean {
  const code = errorCode(error)
  // A parent segment being a file makes the target as absent as a missing
  // directory does, which is the same reading the local backend takes.
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** The errno of a failure node's fs operations raise. */
function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : undefined
}

/**
 * The seam's code for a platform failure.
 *
 * Every branch is an errno, never a message: `EACCES` is `EACCES` whatever the
 * device's `LANG` says, and a client can therefore distinguish "you may not"
 * from "it is not there" on a machine whose errors it cannot read.
 */
function codeFor(error: unknown): DeviceFsCode {
  switch (errorCode(error)) {
    case 'ENOENT': return 'FS_NOT_FOUND'
    case 'ENOTDIR': return 'FS_NOT_DIRECTORY'
    case 'EACCES': case 'EPERM': case 'EROFS': return 'FS_PERMISSION_DENIED'
    case 'EISDIR': return 'FS_NOT_REGULAR_FILE'
    default: return 'FS_IO_ERROR'
  }
}

/** Present a failure as this seam's error, passing one through unchanged. */
function failure(error: unknown): DeviceFsError {
  if (error instanceof DeviceFsError) return error
  return new DeviceFsError(error instanceof Error ? error.message : String(error), codeFor(error))
}

/** Run one filesystem operation, translating whatever it throws. */
async function attempt<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    throw failure(error)
  }
}

/**
 * The change token for one metadata record.
 *
 * Device, inode, size and both timestamps, in nanoseconds — the same five
 * fields the local backend's token is built from, so a token means the same
 * thing on either side of the seam. Nanosecond timestamps rather than
 * milliseconds: a guard that could not tell a rewrite from the state it already
 * read would be a guard that permits the overwrite it exists to refuse.
 */
function versionOf(info: BigIntStats): string {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`
}

/** Name what a followed metadata record describes. */
function kindOf(info: BigIntStats): DeviceFsKind {
  if (info.isFile()) return 'file'
  if (info.isDirectory()) return 'directory'
  return 'other'
}

/** The metadata fields this seam reports. */
function describe(info: BigIntStats): DeviceStat {
  return {
    kind: kindOf(info),
    size: Number(info.size),
    version: versionOf(info),
    mode: Number(info.mode & 0o777n),
  }
}

/** The device's filesystem, for one helper process. */
export class DeviceFileSystem {
  /**
   * A path's canonical form, whether or not it exists.
   *
   * The semantics of `realpath -m`, which is what the assembled-command path
   * ran: every existing prefix is canonicalized — so the device's own symlinks
   * decide the answer, which is why this is a request rather than a computation
   * — and the part that does not exist yet is appended as spelled.
   *
   * One component at a time, rather than canonicalizing the longest existing
   * prefix in one recursive call: only this order answers a path that walks
   * through a symlink into a directory that does not exist, where the prefix
   * resolves but an intermediate one does not.
   *
   * A `..` is resolved textually by `resolve` first, so `link/..` names the
   * link's parent directory rather than the target's. The host resolves relative
   * paths the same way before asking, so both agree on what the caller meant;
   * only a caller that spells `..` across a symlink could tell.
   *
   * @param path - absolute device path, which need not exist.
   * @returns the canonical path.
   */
  async resolve(path: string): Promise<string> {
    // POSIX rules, always: every path in here is a DEVICE path, and the device
    // is a POSIX machine whatever the host is. The host's own `node:path` would
    // spell this differently on Windows — and a path the device cannot read is
    // not a path at all.
    const parts = posix.resolve(path).split('/').filter(part => part !== '')
    let current = '/'
    for (const part of parts) {
      const candidate = posix.join(current, part)
      try {
        current = await realpath(candidate)
      } catch (error) {
        if (!isAbsent(error)) throw failure(error)
        // Not there yet: keep the name as given and carry on, so the answer
        // covers the whole path rather than only its existing head.
        current = candidate
      }
    }
    return current
  }

  /**
   * One path's metadata.
   * @param path - absolute device path.
   * @param follow - whether a final symlink is followed, as `stat`/`lstat` differ.
   * @returns the record, or null when the path is absent.
   */
  async stat(path: string, follow: boolean): Promise<DeviceStat | null> {
    try {
      const info = await (follow ? stat : lstat)(path, { bigint: true })
      const described = describe(info)
      // A symlink is only ever reported by the non-following call: a followed
      // stat describes what it points at, which is the distinction the local
      // backend draws too.
      return !follow && info.isSymbolicLink() ? { ...described, kind: 'symlink' } : described
    } catch (error) {
      if (isAbsent(error)) return null
      throw failure(error)
    }
  }

  /**
   * A directory's direct children.
   *
   * Each child is reported as the local backend reports one: what a *followed*
   * probe finds, so a symlink to a file is a file. A child that cannot be
   * probed at all — a dangling symlink — is `other` with no version, which is
   * how a caller tells "there but unusable" from "not there".
   *
   * @param path - absolute device path of a directory.
   * @returns one entry per child, in the order the device enumerated them.
   */
  async list(path: string): Promise<DeviceListEntry[]> {
    const entries = await attempt(() => readdir(path, { withFileTypes: true }))
    // Directory order, and deliberately not a sorted one: the order a caller
    // sees is the host's decision, made once for both lanes in the seam above,
    // so that neither this device's enumeration nor the locale it runs under
    // can change what a listing looks like.
    const listed: DeviceListEntry[] = []
    for (const entry of entries) {
      const info = await this.stat(posix.join(path, entry.name), true)
      listed.push({
        name: entry.name,
        kind: info?.kind ?? 'other',
        ...info === null ? {} : { version: info.version },
        ...info?.kind === 'file' ? { size: info.size } : {},
      })
    }
    return listed
  }

  /**
   * One byte window of a file.
   *
   * A window that comes back short is the end of the file — that is the whole
   * end-of-file protocol, and why the reply carries no flag.
   *
   * @param path - absolute device path of a regular file.
   * @param offset - byte to start at; past the end reads nothing.
   * @param length - how many bytes may be read, already bounded by the caller.
   * @returns the bytes read, at most `length`.
   */
  async read(path: string, offset: number, length: number): Promise<Buffer> {
    const handle = await attempt(() => open(path, 'r'))
    try {
      const buffer = Buffer.allocUnsafe(length)
      const { bytesRead } = await attempt(() => handle.read(buffer, 0, length, offset))
      return buffer.subarray(0, bytesRead)
    } finally {
      await handle.close().catch(() => undefined)
    }
  }

  /**
   * Publish a file's bytes, atomically.
   *
   * A staging file beside the destination, then a rename, which is the same two
   * steps the local backend takes and for the same reason: a reader either sees
   * the whole previous file or the whole new one, never a half-written mixture.
   * The staging name is short and random rather than derived from the
   * destination's, so a filename already at the platform's length limit does not
   * push the staging name past it.
   *
   * The mode is carried over from an existing destination, and a new file gets
   * the owner-only mode the local backend gives one — `fchmod` after creation
   * rather than a mode at `open`, which the umask would mask.
   *
   * @param path - absolute device path to publish.
   * @param data - the file's whole contents.
   * @returns the published file's metadata, read after the rename.
   */
  async write(path: string, data: Buffer): Promise<DeviceStat> {
    const directory = dirname(path)
    // Missing parents are created, as `mkdir -p` did on the assembled-command
    // path and as the local backend does: a write names the file it wants to
    // exist, not the directory it assumes.
    await attempt(() => mkdir(directory, { recursive: true }))
    const existing = await this.stat(path, true)
    const mode = existing === null ? 0o600 : existing.mode
    const staging = posix.join(directory, `.dshell-${String(process.pid)}-${randomBytes(6).toString('hex')}.tmp`)
    let staged = false
    try {
      const handle = await attempt(() => open(staging, 'wx', 0o600))
      staged = true
      try {
        await attempt(() => handle.writeFile(data))
        await attempt(() => handle.chmod(mode))
      } finally {
        await handle.close().catch(() => undefined)
      }
      await attempt(() => rename(staging, path))
      staged = false
    } finally {
      // A staging file that was never renamed is nobody's: the destination is
      // untouched, so the only trace of the failed write is this name.
      if (staged) await unlink(staging).catch(() => undefined)
    }
    const written = await this.stat(path, true)
    if (written === null) throw new DeviceFsError(`the write to ${basename(path)} produced no file`, 'FS_IO_ERROR')
    return written
  }

  /**
   * Create one or more directories.
   *
   * Each path is created independently; a failure on the third path leaves the
   * first two made. The recursive flag turns each path into `mkdir -p`
   * semantics, the same wording the local backend uses.
   *
   * @param paths - absolute device paths to create.
   * @param recursive - whether to create missing parents.
   */
  async mkdir(paths: readonly string[], recursive: boolean): Promise<void> {
    for (const path of paths) {
      try {
        await mkdir(path, { recursive })
      } catch (error) {
        if (!recursive && errorCode(error) === 'EEXIST') {
          // Without `-p`, asking to create something that already exists is
          // `EEXIST`. With `-p` it is the success case; a directory is itself
          // a fine result for `mkdir -p`.
          throw new DeviceFsError(`${path}: file exists`, 'FS_IO_ERROR')
        }
        throw failure(error)
      }
    }
  }

  /**
   * Remove one path. Recursive and tolerate absence.
   *
   * `force: true` swallows `ENOENT`, which is the only difference from `rm`.
   * Anything else (a directory a user does not own, a busy mount) is a real
   * failure and is reported as one.
   */
  async remove(path: string, force: boolean): Promise<void> {
    try {
      await rm(path, { recursive: true, force })
    } catch (error) {
      // `force: true` already turns ENOENT into a no-op; an error here is
      // either a real fault or a misuse of `force: false`, both worth raising.
      if (force && errorCode(error) === 'ENOENT') return
      throw failure(error)
    }
  }

  /**
   * Rename one path to another.
   *
   * `rename(2)` on POSIX overwrites an existing destination atomically — there
   * is no `EEXIST` to trap. The "refuse when not asked" rule is enforced here,
   * before the platform rename, because the platform is happy either way and
   * a caller that said "no overwrite" deserves a typed refusal rather than a
   * silent replace.
   *
   * @param from - absolute source path; must exist.
   * @param to - absolute destination path; may exist if `overwrite` is true.
   */
  async rename(from: string, to: string, overwrite: boolean): Promise<DeviceStat | null> {
    const existing = await this.stat(to, true)
    if (existing !== null && !overwrite) {
      throw new DeviceFsError(`${to}: already exists`, 'FS_NOT_OBSERVED')
    }
    try {
      await rename(from, to)
    } catch (error) {
      throw failure(error)
    }
    return await this.stat(to, true)
  }

  /**
   * The whole-file SHA-256 of one path, computed on the device.
   *
   * Streams the file so a multi-gigabyte source is not read into memory in one
   * go. The hash is whatever the bytes are: a caller that wants a verified
   * digest over text should pass UTF-8 bytes in and let the helper hash them.
   */
  async sha256(path: string): Promise<string> {
    const handle = await attempt(() => open(path, 'r'))
    try {
      const hash = createHash('sha256')
      const buffer = Buffer.allocUnsafe(64 * 1024)
      for (;;) {
        const { bytesRead } = await attempt(() => handle.read(buffer, 0, buffer.length, null))
        if (bytesRead === 0) break
        hash.update(buffer.subarray(0, bytesRead))
      }
      return hash.digest('hex')
    } finally {
      await handle.close().catch(() => undefined)
    }
  }

  /**
   * Copy one file on the device, internally.
   *
   * Streams source → staging while computing SHA-256, then renames into place.
   * The destination refusal (target is a directory, or already exists with
   * `overwrite: false`) is decided up front and reported as a typed code so
   * the host does not have to translate one.
   *
   * The copy is started by `startCopy`, which returns an id the host uses to
   * poll progress on a separate request. Running the copy in a separate
   * Promise keeps the request/reply shape of the wire intact while letting
   * the UI see the bytes move.
   *
   * @param source - absolute device path of the source file.
   * @param destination - absolute device path of the destination file.
   * @param id - host-allocated id used to look up progress; rejected if it is already in flight.
   * @param overwrite - whether to replace an existing destination.
   * @param expectedSha256 - source digest to verify against; absent means skip the read-side check.
   * @param signal - cancellation; the helper stops at the next chunk boundary.
   * @returns the copy's completion promise.
   */
  startCopy(
    source: string,
    destination: string,
    id: string,
    overwrite: boolean,
    expectedSha256: string | undefined,
    signal: AbortSignal,
  ): Promise<{ destination: DeviceStat; sourceSha256: string; bytes: number }> {
    if (this.copies.has(id)) throw new DeviceFsError(`the dshell SSH helper already has a copy in flight for id ${id}`, 'FS_IO_ERROR')
    const tracker: CopyTracker = { written: 0, totalBytes: 0, running: true }
    this.copies.set(id, tracker)
    return this.runCopy(id, source, destination, overwrite, expectedSha256, tracker, signal)
      .finally(() => { tracker.running = false })
  }

  /**
   * The end-to-end copy primitive, exposed for tests and for callers (the
   * host's transport) that don't need progress polling. Allocates a fresh
   * id each time and returns when the copy is done.
   *
   * The wire's `fs.copy` op uses `startCopy` directly with a host-allocated
   * id, so progress events can be polled on `fs.copyProgress` while the copy
   * runs; this convenience method is the no-progress variant.
   */
  async copy(
    source: string,
    destination: string,
    overwrite: boolean,
    expectedSha256: string | undefined,
    onProgress: (written: number, totalBytes: number) => void,
    signal: AbortSignal,
  ): Promise<{ destination: DeviceStat; sourceSha256: string; bytes: number }> {
    const id = randomBytes(8).toString('hex')
    let lastWritten = 0
    let lastTotal = 0
    const progressTimer = setInterval(() => {
      const t = this.copies.get(id)
      if (t !== undefined) {
        lastTotal = t.totalBytes
        if (t.written !== lastWritten) {
          lastWritten = t.written
          onProgress(t.written, t.totalBytes)
        }
      }
    }, 20).unref()
    try {
      const outcome = await this.startCopy(source, destination, id, overwrite, expectedSha256, signal)
      // The copy is done: emit a final tick at the totals so callers (and
      // tests) that only ever see the final state still observe at least
      // one event, regardless of how quickly the bytes moved.
      if (lastWritten !== outcome.bytes || lastTotal !== outcome.destination.size) {
        onProgress(outcome.bytes, outcome.bytes)
      }
      return outcome
    } finally {
      clearInterval(progressTimer)
    }
  }

  /**
   * Read one in-flight copy's progress, by id.
   *
   * The id is unique per helper process and per request; a host that asks
   * about an unknown id has nothing to learn, and gets zero bytes back
   * (rather than an error, since a finished copy's id may legitimately not
   * be in the table any more).
   */
  readCopyProgress(id: string): { totalBytes: number; written: number; running: boolean } {
    const tracker = this.copies.get(id)
    if (tracker === undefined) return { totalBytes: 0, written: 0, running: false }
    return { totalBytes: tracker.totalBytes, written: tracker.written, running: tracker.running }
  }

  /** The in-flight copy table, looked up by id from {@link startCopy}. */
  private readonly copies = new Map<string, CopyTracker>()

  /** The actual copy loop, with the tracker it updates as it goes. */
  private async runCopy(
    id: string,
    source: string,
    destination: string,
    overwrite: boolean,
    expectedSha256: string | undefined,
    tracker: CopyTracker,
    signal: AbortSignal,
  ): Promise<{ destination: DeviceStat; sourceSha256: string; bytes: number }> {
    const sourceInfo = await this.stat(source, true)
    if (sourceInfo === null) throw new DeviceFsError(`${source}: not found`, 'FS_NOT_FOUND')
    if (sourceInfo.kind !== 'file') throw new DeviceFsError(`${source}: not a regular file`, 'FS_NOT_REGULAR_FILE')
    tracker.totalBytes = sourceInfo.size
    // Refuse the destination up front, with the typed code the host speaks.
    const destInfo = await this.stat(destination, true)
    if (destInfo !== null) {
      if (destInfo.kind === 'directory') throw new DeviceFsError(`${destination}: is a directory`, 'FS_NOT_REGULAR_FILE')
      if (!overwrite) throw new DeviceFsError(`${destination}: already exists`, 'FS_NOT_OBSERVED')
    }
    const sourceHandle = await attempt(() => open(source, 'r'))
    const directory = dirname(destination)
    await attempt(() => mkdir(directory, { recursive: true }))
    const staging = `${destination}.dshell-xfer-${randomBytes(6).toString('hex')}.tmp`
    let staged = false
    try {
      const stagingHandle = await attempt(() => open(staging, 'wx', 0o600))
      staged = true
      let sourceSha256 = ''
      try {
        const hash = createHash('sha256')
        const buffer = Buffer.allocUnsafe(64 * 1024)
        let written = 0
        let offset = 0
        try {
          for (;;) {
            if (signal.aborted) throw new DeviceFsError(`the copy to ${destination} was cancelled`, 'FS_ABORTED')
            const { bytesRead } = await attempt(() => sourceHandle.read(buffer, 0, buffer.length, offset))
            if (bytesRead === 0) break
            const chunk = buffer.subarray(0, bytesRead)
            await attempt(() => stagingHandle.write(chunk, 0, chunk.length))
            hash.update(chunk)
            written += bytesRead
            offset += bytesRead
            tracker.written = written
          }
        } finally {
          await sourceHandle.close().catch(() => undefined)
        }
        sourceSha256 = hash.digest('hex')
        if (expectedSha256 !== undefined && expectedSha256 !== sourceSha256) {
          throw new DeviceFsError(
            `${source}: source digest ${sourceSha256} differs from expected ${expectedSha256}`,
            'FS_IO_ERROR',
          )
        }
        // Preserve the destination's mode if there is one; a new file gets
        // 0o600, the same default the single-file write path uses.
        const mode = destInfo === null ? 0o600 : destInfo.mode
        await attempt(() => stagingHandle.chmod(mode))
      } finally {
        await stagingHandle.close().catch(() => undefined)
      }
      await attempt(() => rename(staging, destination))
      staged = false
      const written = await this.stat(destination, true)
      if (written === null) throw new DeviceFsError(`the copy to ${destination} produced no file`, 'FS_IO_ERROR')
      return { destination: written, sourceSha256, bytes: sourceInfo.size }
    } finally {
      this.copies.delete(id)
      if (staged) await unlink(staging).catch(() => undefined)
    }
  }
}

/** The fields a running copy exposes to the helper's progress op. */
interface CopyTracker {
  /** Bytes the device has written to the staging file so far. */
  written: number
  /** Whole-file size of the source as the device saw it. */
  totalBytes: number
  /** Whether the copy is still running. */
  running: boolean
}
