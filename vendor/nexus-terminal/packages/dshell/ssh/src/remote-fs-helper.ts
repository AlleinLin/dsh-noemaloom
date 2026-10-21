/**
 * The helper lane of the device filesystem.
 *
 * Every operation is one request over the connection the helper is already
 * serving, with fields named on both ends: a path, an offset, a length. Nothing
 * is assembled and nothing is parsed, which is what retires the two habits the
 * assembled lane cannot avoid — pinning `LC_ALL=C` so `stat` prints its fields
 * in English, and reading English out of stderr to decide what went wrong.
 *
 * A failure arrives as a code (`FS_NOT_FOUND`, `FS_PERMISSION_DENIED`, …),
 * decided on the device from an errno. The code places the error in the seam's
 * vocabulary; the device's message travels with it as diagnostics, because it
 * names the path and the errno, and nothing decides anything from it.
 *
 * The device is not a trusted peer, so its codes are checked against the set
 * this build knows before one becomes an `FsError`. An unrecognised code means
 * a helper that is not this build's, and the honest answer there is an I/O
 * fault carrying its message rather than a code we invented a meaning for.
 */
import { FsError, FsVersion, type FsErrorCode } from '@deepseek-ai/dsh-fs'
import { RemoteOperationError } from '@deepseek-ai/dsh-ssh/protocol'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  DSHELL_HELPER_MAX_READ_BYTES,
  DSHELL_HELPER_MAX_WRITE_BYTES,
  HELPER_OPS,
  fsCopyProgressReply,
  fsCopyReply,
  fsListReply,
  fsReadRangeReply,
  fsRenameReply,
  fsResolveReply,
  fsSha256Reply,
  fsStatReply,
  fsWriteReply,
} from './helper/protocol.js'
import type { DshellSshConnection } from './connection.js'
import type {
  RemoteFsTransport, RemoteKind, RemoteListEntry, RemoteStat,
} from './remote-fs-transport.js'

/**
 * The device's codes, as the seam's own.
 *
 * A total map, so a code added on the wire without a home in the seam fails to
 * compile here rather than silently degrading to an I/O fault.
 */
const FS_CODES: Record<string, FsErrorCode> = {
  FS_NOT_FOUND: 'FS_NOT_FOUND',
  FS_NOT_DIRECTORY: 'FS_NOT_DIRECTORY',
  FS_NOT_REGULAR_FILE: 'FS_NOT_REGULAR_FILE',
  FS_PERMISSION_DENIED: 'FS_PERMISSION_DENIED',
  FS_TOO_LARGE: 'FS_TOO_LARGE',
  FS_IO_ERROR: 'FS_IO_ERROR',
}

/** One wire metadata record, as it crosses the seam: kind is required, the rest is optional. */
interface WireStat {
  readonly kind: RemoteKind
  readonly size?: number | undefined
  readonly version?: string | undefined
}

/** One seam-facing metadata record: every field required, defaults filled in for absent values. */
interface SeamStat {
  readonly kind: RemoteKind
  readonly size: number
  readonly version: string
}

/** Make a wire reply's `kind` and `version` non-optional so the seam can pass them on. */
function branded(info: WireStat): SeamStat {
  return { kind: info.kind, size: info.size ?? 0, version: info.version ?? '' }
}

/** The device filesystem over the helper connection. */
export class HelperFsTransport implements RemoteFsTransport {
  constructor(private readonly connection: DshellSshConnection) {}

  /**
   * Send one operation and translate its failure into the seam's.
   * @param method - operation name from the helper protocol.
   * @param params - request fields.
   * @param schema - validation for the reply, applied before it is read.
   * @param signal - cancellation; a completed remote mutation is not undone.
   */
  private async call<T>(
    method: string,
    params: unknown,
    schema: z.ZodType<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    try {
      return await this.connection.request<T>(method, params, schema, signal)
    } catch (error) {
      throw remoteFailure(error, signal)
    }
  }

  /** @inheritDoc */
  canOpen(path: string): boolean {
    // The helper's protocol admits absolute device paths and nothing else:
    // every request field that names a path is validated as one, and a
    // refusal comes back as a schema error rather than as an answer.
    return path.startsWith('/')
  }

  /** @inheritDoc */
  async resolve(path: string, signal?: AbortSignal): Promise<string> {
    const reply = await this.call<{ path: string }>(HELPER_OPS.fsResolve, { path }, fsResolveReply, signal)
    return reply.path
  }

  /** @inheritDoc */
  async stat(path: string, follow: boolean, signal?: AbortSignal): Promise<RemoteStat | undefined> {
    const reply = await this.call<WireStat | null>(
      follow ? HELPER_OPS.fsStat : HELPER_OPS.fsLstat,
      { path },
      fsStatReply,
      signal,
    )
    if (reply === null) return undefined
    const seam = branded(reply)
    return { kind: seam.kind, size: seam.size, version: FsVersion(seam.version) }
  }

  /** @inheritDoc */
  async list(path: string, signal?: AbortSignal): Promise<RemoteListEntry[]> {
    const reply = await this.call<{ entries: (WireStat & { name: string })[] }>(
      HELPER_OPS.fsList,
      { path },
      fsListReply,
      signal,
    )
    return reply.entries.map(entry => ({
      name: entry.name,
      kind: entry.kind,
      ...entry.size === undefined ? {} : { size: entry.size },
      ...entry.version === undefined ? {} : { version: FsVersion(entry.version) },
    }))
  }

  /** @inheritDoc */
  async read(path: string, offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array> {
    // One reply per window, because one frame has a ceiling and base64 spends a
    // third of it. The cap is shared with the device rather than guessed here.
    const chunks: Buffer[] = []
    let read = 0
    while (read < length) {
      const requested = Math.min(length - read, DSHELL_HELPER_MAX_READ_BYTES)
      const reply = await this.call<{ data: string }>(
        HELPER_OPS.fsReadRange,
        { path, offset: offset + read, length: requested },
        fsReadRangeReply,
        signal,
      )
      const chunk = Buffer.from(reply.data, 'base64')
      chunks.push(chunk)
      read += chunk.byteLength
      // A short window is the end of the file: asking again would only return
      // nothing, and looping on it would never end.
      if (chunk.byteLength < requested) break
    }
    return Buffer.concat(chunks)
  }

  /** @inheritDoc */
  async stream(path: string, signal?: AbortSignal): Promise<AsyncIterable<Uint8Array>> {
    const transport = this
    return Promise.resolve((async function* stream(): AsyncIterable<Uint8Array> {
      let offset = 0
      for (;;) {
        const reply = await transport.call<{ data: string }>(
          HELPER_OPS.fsReadRange,
          { path, offset, length: DSHELL_HELPER_MAX_READ_BYTES },
          fsReadRangeReply,
          signal,
        )
        const chunk = Buffer.from(reply.data, 'base64')
        if (chunk.byteLength === 0) return
        yield chunk
        offset += chunk.byteLength
        if (chunk.byteLength < DSHELL_HELPER_MAX_READ_BYTES) return
      }
    })())
  }

  /** @inheritDoc */
  async write(path: string, content: string, signal?: AbortSignal): Promise<RemoteStat | undefined> {
    const data = Buffer.from(content, 'utf8')
    if (data.byteLength > DSHELL_HELPER_MAX_WRITE_BYTES) {
      // Refused here, with the caller's own number, rather than by a frame the
      // peer would reject for a reason that has nothing to do with the file.
      throw new FsError(
        `cannot write "${path}": ${String(data.byteLength)} bytes exceeds the ${String(DSHELL_HELPER_MAX_WRITE_BYTES)} byte limit of a single write`,
        'FS_TOO_LARGE',
      )
    }
    // The published file's metadata comes back with the write, taken after the
    // rename: asking again would be a second round trip, and reading it from
    // before the rename would name a state the rename itself changed.
    const written = await this.call<WireStat>(HELPER_OPS.fsWrite, { path, data: data.toString('base64') }, fsWriteReply, signal)
    const seam = branded(written)
    return { kind: seam.kind, size: seam.size, version: FsVersion(seam.version) }
  }

  /** @inheritDoc */
  async writeBytes(path: string, bytes: Uint8Array, signal?: AbortSignal): Promise<RemoteStat | undefined> {
    if (bytes.byteLength > DSHELL_HELPER_MAX_WRITE_BYTES) {
      throw new FsError(
        `cannot write "${path}": ${String(bytes.byteLength)} bytes exceeds the ${String(DSHELL_HELPER_MAX_WRITE_BYTES)} byte limit of a single write`,
        'FS_TOO_LARGE',
      )
    }
    const written = await this.call<WireStat>(
      HELPER_OPS.fsWriteBytes,
      { path, data: Buffer.from(bytes).toString('base64') },
      fsWriteReply,
      signal,
    )
    const seam = branded(written)
    return { kind: seam.kind, size: seam.size, version: FsVersion(seam.version) }
  }

  /** @inheritDoc */
  async mkdir(paths: readonly string[], recursive: boolean, signal?: AbortSignal): Promise<void> {
    await this.call(HELPER_OPS.fsMkdir, { paths: [...paths], recursive }, z.null(), signal)
  }

  /** @inheritDoc */
  async remove(path: string, force: boolean, signal?: AbortSignal): Promise<void> {
    await this.call(HELPER_OPS.fsRemove, { path, force }, z.null(), signal)
  }

  /** @inheritDoc */
  async rename(from: string, to: string, overwrite: boolean, signal?: AbortSignal): Promise<RemoteStat | undefined> {
    const reply = await this.call<WireStat | null>(HELPER_OPS.fsRename, { from, to, overwrite }, fsRenameReply, signal)
    if (reply === null) return undefined
    const seam = branded(reply)
    return { kind: seam.kind, size: seam.size, version: FsVersion(seam.version) }
  }

  /** @inheritDoc */
  async sha256(path: string, signal?: AbortSignal): Promise<string> {
    const reply = await this.call<{ hex: string }>(HELPER_OPS.fsSha256, { path }, fsSha256Reply, signal)
    return reply.hex
  }

  /** @inheritDoc */
  async copy(
    source: string,
    destination: string,
    overwrite: boolean,
    expectedSha256: string | undefined,
    onProgress: (written: number, totalBytes: number) => void,
    signal: AbortSignal,
  ): Promise<{ destination: RemoteStat; sourceSha256: string; bytes: number }> {
    // The id is allocated here, on the host, so the progress poll can fire on
    // the very next tick. The helper registers the in-flight copy under this
    // same id; an id that is already in flight is refused.
    const copyId = randomUUID()
    // The progress loop is a 50 ms poll on a separate request. The helper's
    // progress op is one map read, so this stays cheap; a busy host cannot
    // stall the copy because the loop awaits each tick before firing the
    // next.
    let last = 0
    const poll = (async () => {
      while (!signal.aborted) {
        await new Promise<void>(resolve => { setTimeout(resolve, 50).unref?.() })
        const progress = await this.call<{ totalBytes: number; written: number; running: boolean }>(
          HELPER_OPS.fsCopyProgress,
          { id: copyId },
          fsCopyProgressReply,
          signal,
        )
        if (progress.written !== last) {
          last = progress.written
          onProgress(progress.written, progress.totalBytes)
        }
        if (!progress.running) return
      }
    })().catch(() => undefined)
    try {
      const reply = await this.call<{ destination: WireStat; sourceSha256: string; bytes: number }>(
        HELPER_OPS.fsCopy,
        {
          copyId,
          source,
          destination,
          overwrite,
          ...expectedSha256 === undefined ? {} : { expectedSha256 },
        },
        fsCopyReply,
        signal,
      )
      const seam = branded(reply.destination)
      return {
        destination: { kind: seam.kind, size: seam.size, version: FsVersion(seam.version) },
        sourceSha256: reply.sourceSha256,
        bytes: reply.bytes,
      }
    } finally {
      await poll
    }
  }
}

/** A short id, host-allocated; collision-free enough for one helper process. */
function randomUUID(): string {
  return createHash('sha256').update(`${String(process.pid)}-${String(Date.now())}-${String(Math.random())}`)
    .digest('hex').slice(0, 16)
}

/**
 * The seam's error for a failed device operation.
 * @param error - what the request rejected with.
 * @param signal - the caller's cancellation, if any.
 */
function remoteFailure(error: unknown, signal?: AbortSignal): FsError {
  // A cancelled request leaves the device's work to finish or not; what the
  // caller needs to know is that it asked to stop, not what the peer said.
  if (signal?.aborted === true) return new FsError('file operation aborted', 'FS_ABORTED', { cause: error })
  if (error instanceof RemoteOperationError) {
    const code = error.code === undefined ? undefined : FS_CODES[error.code]
    return new FsError(error.message, code ?? 'FS_IO_ERROR', { cause: error })
  }
  // A transport failure: the helper died, or the channel closed. The peer's
  // message says which, and it is the honest one to report — the operation's
  // outcome is exactly what is unknown at that point.
  return new FsError(error instanceof Error ? error.message : String(error), 'FS_IO_ERROR', { cause: error })
}
