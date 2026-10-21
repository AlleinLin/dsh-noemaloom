/**
 * The primitives a device filesystem is built from, and how they are reached.
 *
 * `ctx.fs` is a dozen operations with a policy layer over them — version
 * guards, literal-edit rules, line endings, the sandbox fence. Two device lanes
 * can carry that layer: the helper (a request per primitive, structured fields
 * both ways) and the assembled-command path (one `ssh` invocation per
 * primitive, its output parsed back). The layer is written once against this
 * interface, so which lane is in use changes how bytes travel and nothing about
 * what an operation means.
 *
 * The choice is made per call, not per session: a device whose helper is not up
 * keeps working through the assembled lane, and one whose helper appears — the
 * connection is warmed when a session is bound to it — switches lanes from the
 * next call on. Both lanes are always available, because the assembled one is
 * also the tier a device without Node has and nothing else can serve.
 *
 * Paths here are always absolute device paths. Translating a caller's path
 * through the session's mount mapping is the seam class's job, above this
 * interface, so neither lane ever guesses at a relative path.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { FsVersion } from '@deepseek-ai/dsh-fs'
import type { DshellSshConnection } from './connection.js'
import type { DeviceConnection } from './devices.js'
import type { DshellSshTranslate } from './host-locales.js'

/** What a path is, in the seam's vocabulary. */
export type RemoteKind = 'file' | 'directory' | 'symlink' | 'other'

/** One path's metadata; `version` is compared for equality and never parsed. */
export interface RemoteStat {
  readonly kind: RemoteKind
  readonly size: number
  readonly version: FsVersion
}

/** One directory child. `version` is absent when the child could not be inspected. */
export interface RemoteListEntry {
  readonly name: string
  readonly kind: RemoteKind
  readonly size?: number
  readonly version?: FsVersion
}

/** What a lane needs to reach one device. */
export interface RemoteFsDeps {
  /** Host context, for the subprocess seam the assembled lane runs in. */
  readonly ctx: Context
  /** Device the session runs on. */
  readonly device: DeviceConnection
  /** This package's bound host copy, for the assembled lane's error text. */
  readonly t: DshellSshTranslate
  /**
   * The device's verified helper connection.
   *
   * Absent is not a failure: it means no helper has been verified for this
   * device *now* — never installed, not yet handshaked, or gone — and the
   * assembled lane answers instead.
   */
  readonly connection?: DshellSshConnection | undefined
}

/** The device filesystem primitives, as one lane implements them. */
export interface RemoteFsTransport {
  /**
   * Whether this lane can be asked about a path at all.
   *
   * The device's own grammar is POSIX absolute. A path in the HOST's
   * grammar names nothing on the device, and the device refuses it
   * outright — its protocol says "always absolute: the caller translates,
   * the device does not guess". That refusal is a schema error and not an
   * answer, so the seam asks the lane first and never puts a path on the
   * wire that the lane could not open.
   *
   * @param path - a path in the device's namespace.
   * @returns whether the device can be asked about this path.
   */
  canOpen(path: string): boolean

  /**
   * A path's canonical form.
   * @param path - absolute device path, which need not exist.
   * @param signal - cancellation.
   */
  resolve(path: string, signal?: AbortSignal): Promise<string>

  /**
   * Metadata for one path.
   * @param path - absolute device path.
   * @param follow - whether a final symlink is followed.
   * @param signal - cancellation.
   * @returns the record, or undefined when the path is absent.
   */
  stat(path: string, follow: boolean, signal?: AbortSignal): Promise<RemoteStat | undefined>

  /**
   * A directory's direct children, ordered by name.
   * @param path - absolute device path of a directory.
   * @param signal - cancellation.
   */
  list(path: string, signal?: AbortSignal): Promise<RemoteListEntry[]>

  /**
   * Read one byte window of a file; a short answer is the end of the file.
   * @param path - absolute device path of a regular file.
   * @param offset - byte to start at.
   * @param length - how many bytes may be read; this lane may split the work.
   * @param signal - cancellation.
   */
  read(path: string, offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array>

  /**
   * Read a file as it is written, from the beginning.
   *
   * A caller that stops iterating stops the reads: nothing is left running on
   * the device, because nothing was started for it.
   *
   * @param path - absolute device path of a regular file.
   * @param signal - cancellation.
   */
  stream(path: string, signal?: AbortSignal): Promise<AsyncIterable<Uint8Array>>

  /**
   * Replace a file's contents atomically, keeping an existing file's mode.
   *
   * Text, not bytes, because that is all the seam writes: its two entry points
   * are `writeText` and `editText`, and a lane that cannot carry arbitrary bytes
   * faithfully should not be asked to pretend. A byte window is a different
   * operation, and the lane that needs one will name it.
   *
   * @param path - absolute device path to publish.
   * @param content - the file's whole contents, as text.
   * @param signal - cancellation; a published file is not rolled back.
   * @returns the published file's metadata, when this lane can report it in the
   *   same breath, or undefined when the caller must ask afterwards.
   */
  write(path: string, content: string, signal?: AbortSignal): Promise<RemoteStat | undefined>

  /**
   * Replace a file's contents with arbitrary bytes.
   *
   * Distinct from {@link write} because text is a lossy encoding for binary
   * content and a transfer that needs to land a non-text file whole cannot go
   * through the text entry point.
   *
   * @param path - absolute device path to publish.
   * @param bytes - the file's whole contents, exactly as they should land.
   * @param signal - cancellation; a published file is not rolled back.
   * @returns the published file's metadata, or undefined when this lane must
   *   be asked separately for it.
   */
  writeBytes(path: string, bytes: Uint8Array, signal?: AbortSignal): Promise<RemoteStat | undefined>

  /**
   * Create one or more directories.
   *
   * @param paths - absolute device paths to create.
   * @param recursive - whether to create missing parents.
   * @param signal - cancellation.
   */
  mkdir(paths: readonly string[], recursive: boolean, signal?: AbortSignal): Promise<void>

  /**
   * Remove one path, recursively and tolerating absence.
   *
   * @param path - absolute device path to remove.
   * @param force - whether to ignore absence.
   * @param signal - cancellation.
   */
  remove(path: string, force: boolean, signal?: AbortSignal): Promise<void>

  /**
   * Rename one path to another.
   *
   * @param from - absolute device path that exists.
   * @param to - absolute device path that may or may not exist.
   * @param overwrite - whether to replace an existing destination.
   * @param signal - cancellation; a renamed file is not rolled back.
   * @returns the destination's metadata, or undefined when the rename deleted
   *   the source without creating a replacement.
   */
  rename(from: string, to: string, overwrite: boolean, signal?: AbortSignal): Promise<RemoteStat | undefined>

  /**
   * The whole-file SHA-256 of one path, computed on the device.
   *
   * @param path - absolute device path of the source.
   * @param signal - cancellation.
   * @returns the lowercase hex digest.
   */
  sha256(path: string, signal?: AbortSignal): Promise<string>

  /**
   * Copy one file on the device.
   *
   * Starts the copy and reports progress through `onProgress`, which the host
   * uses to advance a view field. The progress callback is fired on the
   * device's chunk boundaries and may run while the request's reply is still
   * outstanding.
   *
   * @param source - absolute device path of the source file.
   * @param destination - absolute device path of the destination file.
   * @param overwrite - whether to replace an existing destination.
   * @param expectedSha256 - optional source digest to verify against.
   * @param onProgress - called as bytes move; the helper layer always supplies one.
   * @param signal - cancellation; the copy stops at its next chunk boundary.
   * @returns the destination's metadata, the source's digest, and the bytes copied.
   */
  copy(
    source: string,
    destination: string,
    overwrite: boolean,
    expectedSha256: string | undefined,
    onProgress: (written: number, totalBytes: number) => void,
    signal: AbortSignal,
  ): Promise<{ destination: RemoteStat; sourceSha256: string; bytes: number }>
}
