/**
 * The device-side helper.
 *
 * This is the process the connection launches on the device — `node
 * --disable-sigusr1 <helper>` — and it is the far end of every structured
 * operation dshell will route there. It exists so that a session's file and
 * process work on a device is a *request with arguments* rather than a shell
 * line someone assembled and something else parsed back.
 *
 * Kept separate from `helper-entry.ts` so the behaviour can be exercised over
 * explicit streams without spawning a process, the same split dsh-ssh uses.
 *
 * Ownership: the helper owns nothing but its own lifetime for now. The lease is
 * a reap mechanism, not a nicety — a helper that outlives its client would be a
 * process with filesystem and process powers and no one left to answer to, so a
 * client that stops sending heartbeats makes the helper exit by itself.
 */
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { SshRpcPeer } from '@deepseek-ai/dsh-ssh/protocol'
import { DeviceFileSystem } from './fs.js'
import { RemoteProcesses } from './processes.js'
import {
  DSHELL_HELPER_LEASE_MS,
  DSHELL_HELPER_MAX_FRAME_BYTES,
  DSHELL_HELPER_MAX_PENDING,
  DSHELL_HELPER_MAX_PROCESSES,
  DSHELL_HELPER_PROTOCOL,
  echoReply,
  echoRequest,
  emptyRequest,
  fsCopyIdRequest,
  fsCopyProgressReply,
  fsCopyReply,
  fsCopyRequest,
  fsListReply,
  fsMkdirRequest,
  fsPathRequest,
  fsReadRangeReply,
  fsReadRangeRequest,
  fsRemoveRequest,
  fsRenameReply,
  fsRenameRequest,
  fsResolveReply,
  fsSha256Reply,
  fsSha256Request,
  fsStatReply,
  fsWriteBytesRequest,
  fsWriteReply,
  fsWriteRequest,
  helloReply,
  helloRequest,
  HELPER_OPS,
  processDoneReply,
  processIdRequest,
  processPrepareReply,
  processPrepareRequest,
  processSnapshotReply,
  processSnapshotRequest,
  processWaitReply,
} from './protocol.js'

/** The helper's own streams and identity. */
export interface HelperTransport {
  /** Request bytes, carried by the ssh child's stdout. */
  input: Readable
  /** Reply bytes, carried by the ssh child's stdin. */
  output: Writable
  /**
   * Path of the running entry, hashed and reported in the handshake.
   *
   * Taken from the bundle's own `import.meta.url`, so it names the file that is
   * actually executing rather than whatever a build step believed it would be.
   */
  entryPath: string
  /** Transport loss or process termination, joined by the cleanup path. */
  signal: AbortSignal
}

/**
 * Serve one connection until its channel closes or its lease expires.
 * @param transport - streams, entry identity and cancellation.
 * @returns when the peer has closed and cleanup has finished.
 */
export async function runDshellHelper(transport: HelperTransport): Promise<void> {
  if (process.platform !== 'linux' && process.platform !== 'darwin') {
    throw new Error('the dshell SSH helper requires a POSIX device')
  }
  transport.signal.throwIfAborted()

  // Assigned below, but the handlers reach it: cancellation and the lease can
  // both fire before the constructor returns.
  let peer: SshRpcPeer | undefined
  let initialized = false
  let leaseMs = DSHELL_HELPER_LEASE_MS
  let lease: NodeJS.Timeout | undefined
  const done = Promise.withResolvers<void>()
  // Spills and nothing else go here: it is a private working directory, not a
  // place a caller is told about beyond the files it asks for.
  const root = await mkdtemp(join(tmpdir(), 'dshell-helper-'))
  const processes = new RemoteProcesses(() => root, DSHELL_HELPER_MAX_PROCESSES)
  const files = new DeviceFileSystem()

  /**
   * Release the lease and stop the peer. Idempotent because several paths race
   * to it: the client's `close` op, a closed channel, a process signal, and the
   * lease itself. `SshRpcPeer.close` is already once-only, so the only state to
   * guard here is our own timer.
   */
  const close = (reason: string): void => {
    if (lease !== undefined) { clearTimeout(lease); lease = undefined }
    peer?.close(new Error(reason))
    // The children go with the connection. A helper that exited while its
    // processes kept running would leave work on the device that nothing knows
    // about any more — including, on lease expiry, after the client is gone.
    void processes.close().finally(() => rm(root, { recursive: true, force: true })).catch(() => undefined)
  }

  const touchLease = (): void => {
    if (lease !== undefined) clearTimeout(lease)
    // Its firing is the reap: nothing else tells the client its helper is gone,
    // and nothing else tells the helper its client is.
    lease = setTimeout(() => { close('the dshell SSH helper client stopped sending heartbeats') }, leaseMs)
    lease.unref()
  }

  peer = new SshRpcPeer(
    transport.input,
    transport.output,
    DSHELL_HELPER_MAX_FRAME_BYTES,
    DSHELL_HELPER_MAX_PENDING,
    async (method, raw) => {
      if (method === HELPER_OPS.hello) {
        // Exactly once: a second handshake would let a peer re-declare itself
        // after the connection was already being trusted.
        if (initialized) throw new Error('the dshell SSH helper handshake already completed')
        const input = helloRequest.parse(raw)
        if (input.protocol !== DSHELL_HELPER_PROTOCOL) {
          throw new Error(
            `dshell SSH helper protocol mismatch: client speaks ${String(input.protocol)}, helper speaks ${String(DSHELL_HELPER_PROTOCOL)}`,
          )
        }
        leaseMs = input.leaseMs
        initialized = true
        touchLease()
        // Computed here, over the file that is running, rather than baked in at
        // build time: a build-time constant would travel with the client and so
        // could not detect a replaced artifact, which is the whole point of
        // reporting it.
        const hash = createHash('sha256').update(readFileSync(transport.entryPath)).digest('hex')
        return helloReply.parse({
          protocol: DSHELL_HELPER_PROTOCOL,
          hash,
          platform: process.platform,
          node: process.execPath,
          nodeVersion: process.version,
          root: process.cwd(),
        })
      }
      if (!initialized) throw new Error('the dshell SSH helper has not completed its handshake')
      if (method === HELPER_OPS.heartbeat) {
        emptyRequest.parse(raw)
        touchLease()
        return null
      }
      if (method === HELPER_OPS.close) {
        emptyRequest.parse(raw)
        close('the dshell SSH helper was asked to close')
        return null
      }
      if (method === HELPER_OPS.echo) {
        const input = echoRequest.parse(raw)
        return echoReply.parse({
          label: input.label,
          upper: input.label.toUpperCase(),
          pid: process.pid,
          cwd: process.cwd(),
        })
      }
      if (method === HELPER_OPS.processPrepare) {
        const input = processPrepareRequest.parse(raw)
        const started = processes.prepare(input)
        return processPrepareReply.parse(started)
      }
      if (method === HELPER_OPS.processSnapshot) {
        const input = processSnapshotRequest.parse(raw)
        const read = processes.snapshot(input.id, input.stream, input.fromByte)
        return processSnapshotReply.parse({
          chunk: read.chunk.toString('base64'),
          from: read.from,
          totalBytes: read.totalBytes,
        })
      }
      if (method === HELPER_OPS.processDone) {
        const input = processIdRequest.parse(raw)
        const finished = await processes.done(input.id)
        return processDoneReply.parse({
          outcome: finished.outcome,
          collected: {
            stdout: { tail: finished.collected.stdout.tail.toString('base64'), totalBytes: finished.collected.stdout.totalBytes },
            stderr: { tail: finished.collected.stderr.tail.toString('base64'), totalBytes: finished.collected.stderr.totalBytes },
          },
          spills: finished.spills,
        })
      }
      if (method === HELPER_OPS.processTerminate) {
        processes.terminate(processIdRequest.parse(raw).id)
        return null
      }
      if (method === HELPER_OPS.processWait) {
        return processWaitReply.parse(await processes.wait(processIdRequest.parse(raw).id))
      }
      if (method === HELPER_OPS.fsResolve) {
        return fsResolveReply.parse({ path: await files.resolve(fsPathRequest.parse(raw).path) })
      }
      if (method === HELPER_OPS.fsStat || method === HELPER_OPS.fsLstat) {
        const { path } = fsPathRequest.parse(raw)
        const info = await files.stat(path, method === HELPER_OPS.fsStat)
        // The mode is the write path's business and stays here: it is not part
        // of what the seam reports, so it never travels.
        return fsStatReply.parse(info === null ? null : { kind: info.kind, size: info.size, version: info.version })
      }
      if (method === HELPER_OPS.fsList) {
        const { path } = fsPathRequest.parse(raw)
        return fsListReply.parse({ entries: await files.list(path) })
      }
      if (method === HELPER_OPS.fsReadRange) {
        const input = fsReadRangeRequest.parse(raw)
        const bytes = await files.read(input.path, input.offset, input.length)
        return fsReadRangeReply.parse({ data: bytes.toString('base64') })
      }
      if (method === HELPER_OPS.fsWrite) {
        const input = fsWriteRequest.parse(raw)
        const written = await files.write(input.path, Buffer.from(input.data, 'base64'))
        return fsWriteReply.parse({ kind: written.kind, size: written.size, version: written.version })
      }
      if (method === HELPER_OPS.fsWriteBytes) {
        const input = fsWriteBytesRequest.parse(raw)
        const written = await files.write(input.path, Buffer.from(input.data, 'base64'))
        return fsWriteReply.parse({ kind: written.kind, size: written.size, version: written.version })
      }
      if (method === HELPER_OPS.fsMkdir) {
        const input = fsMkdirRequest.parse(raw)
        await files.mkdir(input.paths, input.recursive)
        return null
      }
      if (method === HELPER_OPS.fsRemove) {
        const input = fsRemoveRequest.parse(raw)
        await files.remove(input.path, input.force)
        return null
      }
      if (method === HELPER_OPS.fsRename) {
        const input = fsRenameRequest.parse(raw)
        const moved = await files.rename(input.from, input.to, input.overwrite)
        // The destination is null when the rename deleted the source without
        // creating a replacement (a path whose destination was an empty
        // directory on some platforms, say). The seam reports it as null.
        return fsRenameReply.parse(moved === null ? null : { kind: moved.kind, size: moved.size, version: moved.version })
      }
      if (method === HELPER_OPS.fsSha256) {
        const input = fsSha256Request.parse(raw)
        const hex = await files.sha256(input.path)
        return fsSha256Reply.parse({ hex })
      }
      if (method === HELPER_OPS.fsCopy) {
        // fsCopy is the long-running op: a single request whose reply is the
        // copy's outcome. The host polls `fs.copyProgress` on a separate
        // request to learn the bytes-moved; the helper tracks the in-flight
        // copy by the host-allocated id carried in the request.
        const input = fsCopyRequest.parse(raw)
        const outcome = await files.startCopy(
          input.source, input.destination, input.copyId, input.overwrite, input.expectedSha256, transport.signal,
        )
        return fsCopyReply.parse({
          destination: { kind: outcome.destination.kind, size: outcome.destination.size, version: outcome.destination.version },
          sourceSha256: outcome.sourceSha256,
          bytes: outcome.bytes,
        })
      }
      if (method === HELPER_OPS.fsCopyProgress) {
        const input = fsCopyIdRequest.parse(raw)
        const progress = files.readCopyProgress(input.id)
        return fsCopyProgressReply.parse(progress)
      }
      // Deliberately the same boundary upstream drew: an unrecognised method is
      // a hard failure, never a guess. A helper that answered optimistically
      // would be one whose behaviour depends on which client called it.
      throw new Error(`Unknown dshell SSH helper operation: ${method}`)
    },
  )

  peer.once('closed', () => { close('the dshell SSH helper channel closed'); done.resolve() })
  transport.signal.addEventListener('abort', () => { close('the dshell SSH helper process is terminating') }, { once: true })
  await done.promise
  if (lease !== undefined) { clearTimeout(lease); lease = undefined }
}
