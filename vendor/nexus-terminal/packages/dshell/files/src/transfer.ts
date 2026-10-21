/**
 * The file-transfer engine: two execution worlds, a walk over one, and the
 * copies that land entries in the other.
 *
 * ## Why the transport is mostly seams, with one relay
 *
 * A transfer moves bytes between THIS machine and the device a session is bound
 * to, and the two existing seams already reach both:
 *
 *  - **reads** go through `ctx.fs`, called inside the source side's own
 *    initiator boundary. For the device that is the session's world (dshell-ssh
 *    replaced the stock backend, so a device-bound call reads over SSH); for
 *    this machine it is the agentless boundary, which resolves locally.
 *  - **writes** go through `ctx.shell`, the seam that ALSO routes per
 *    initiator. `ctx.fs` has no byte write — both of its mutations take text —
 *    so the payload rides stdin as base64 and the destination world's own
 *    `base64 -d` decodes it. This is the same byte transport dshell-buffer
 *    uses for its cross-session copies.
 *
 * One payload per file stops scaling at tens of MiB, so files above the inline
 * ceiling go through the same chunked relay dshell-buffer runs: the source is
 * sliced (in process for this machine, `split` on the device), chunks cross one
 * 16 MiB base64 round trip at a time, the destination reassembles, and
 * whole-file sha256 digests pin both ends. See {@link TransferEngine.copyChunked}.
 *
 * The local side passes `danger-full-access` explicitly. The alternative — the
 * sandbox policy of the *device* session — describes what the MODEL may do on
 * this machine (and defaults to confining it to the session's mount directory),
 * while this feature is a user gesture: the route sits behind dsh's
 * authenticated fence, the model has no tool that reaches it, and the same user
 * can already write both places through their own terminal. So the policy here
 * states who the actor is rather than pretending the model is asking.
 *
 * ## Why the copies are jobs
 *
 * A directory copy is a walk plus one write per file, which can outlast any
 * sensible request. `copy` therefore starts a job and answers immediately; the
 * view polls it, sees the walk's totals before the first byte moves, and can
 * cancel by aborting the run. A job is memory-only state: it belongs to the
 * boot that started it, and a restart forgets it rather than resuming
 * something nobody is watching.
 */

import { randomUUID, createHash } from 'node:crypto'
import { chmod, mkdir, open, rename, rm, stat as statPath, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
// Type-only: pulls the session-controller service merge (`ctx.sessionController`).
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { DeviceFsSeat } from '@nexus-aethra/dshell-std'
import {
  type TransferEntry, type TransferJobState, type TransferJobView, type TransferListing,
  type TransferSetup, type TransferSide,
} from './transfer-protocol.js'

/**
 * Entries one listing returns before it is reported truncated.
 *
 * The same cap the navigator's route uses, for the same reason: a directory of
 * this size is already unusable as a list.
 */
const MAX_ENTRIES = 1000

/**
 * Bytes one file may ride the inline path.
 *
 * A ceiling rather than a choice: the payload rides the shell seam's stdin as
 * base64, which is one string in memory on this side and one command on the
 * other, and dshell-buffer's cross-session copy settled on the same number for
 * the same transport. Above it a file goes through the chunked relay instead —
 * refused only past {@link MAX_BIG_BYTES}.
 */
const MAX_FILE_BYTES = 32 * 1024 * 1024

/**
 * One relay chunk: the slice a chunked copy moves per round trip.
 *
 * The same 16 MiB dshell-buffer's relay uses — small enough that one base64
 * payload stays a comfortable string on both sides, large enough that a
 * multi-gigabyte file is tens of trips, not thousands.
 */
const CHUNK_BYTES = 16 * 1024 * 1024

/**
 * Bytes one FILE may be at all, inline or chunked.
 *
 * The chunked relay has no structural ceiling, only patience; 4 GiB is the
 * same hard cap dshell-buffer settled on for the same transport.
 */
const MAX_BIG_BYTES = 4 * 1024 * 1024 * 1024

/** Entries one copy's walk may visit before the copy is refused. */
const MAX_PLAN_ENTRIES = 20_000

/** Total bytes one copy's walk may plan before the copy is refused. */
const MAX_PLAN_BYTES = 4 * 1024 * 1024 * 1024

/**
 * How long a settled job stays readable before the registry drops it.
 */
const JOB_TTL_MS = 5 * 60_000

/** One world as this module uses it. */
interface World {
  readonly side: TransferSide
  /** The session whose world this is; undefined means this machine. */
  readonly agent: Agent | undefined
  /** Absolute directory this world's relative paths resolve against. */
  readonly root: string
  /** The session id carried in the write policy, when there is one. */
  readonly sessionId: SessionId | undefined
}

/**
 * The slice of dshell-ssh's router this module needs.
 *
 * Structural on purpose, exactly as dshell-buffer reads it: this package must
 * not depend on the SSH bundle, and a composition without it simply has no
 * device to transfer to.
 */
export interface TransferRoutingSeat {
  /** The device a session is assigned to, with the directory it runs in. */
  targetForSession(sessionId: string): {
    readonly device: { readonly id: string; readonly name: string }
    readonly remoteRoot: string
    readonly mount?: string | undefined
  } | undefined
}

/** A job view whose fields the run advances in place. */
type MutableJob = { -readonly [K in keyof TransferJobView]: TransferJobView[K] }

/** One live job: its view, its cancellation, and its cleanup timer. */
interface JobRecord {
  readonly view: MutableJob
  readonly controller: AbortController
  timer: NodeJS.Timeout | undefined
}

/** What `copy` is asked to do. */
export interface CopyInput {
  readonly sessionId: string
  readonly from: TransferSide
  readonly to: TransferSide
  readonly fromPath: string
  readonly toDir: string
  readonly overwrite: boolean
}

/** POSIX basename; both worlds are POSIX, and node's `path` speaks the host's. */
function baseName(path: string): string {
  const trimmed = path.replace(/\/+$/u, '')
  const cut = trimmed.lastIndexOf('/')
  return cut < 0 ? trimmed : trimmed.slice(cut + 1)
}

/** POSIX join, used only to compose a destination path inside its directory. */
function joinPath(dir: string, name: string): string {
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`
}

/** The part of `path` under `root`, or undefined when it is not under it. */
function relativeUnder(root: string, path: string): string | undefined {
  const base = root.endsWith('/') ? root : `${root}/`
  return path.startsWith(base) ? path.slice(base.length) : undefined
}

/** The message of a thrown value, for a job's `error`. */
function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The transfer engine: setup for one session, listings for either side, and the
 * job registry the copies run in.
 */
export class TransferEngine {
  private readonly jobs = new Map<string, JobRecord>()

  /**
   * @param ctx - host context carrying `agents`, `sessionController`, `fs` and
   *   `shell` (the route's injection scope).
   * @param routing - dshell-ssh's routing face when that package is composed;
   *   read through a getter so a later load or unload stays honest.
   * @param deviceFs - the seat the byte-level device ops are read from. The
   *   engine only uses this on the device side; an unbound session gets
   *   `undefined` from `forInitiator` and the engine falls through to its
   *   in-process paths.
   */
  constructor(
    private readonly ctx: Context,
    private readonly routing: () => TransferRoutingSeat | undefined,
    private readonly deviceFs: () => DeviceFsSeat | undefined,
  ) {}

  /** What the view can draw: both roots, the device, and whether a transfer is possible. */
  async setup(sessionId: string): Promise<TransferSetup> {
    const agent = await this.resolveAgent(sessionId)
    const localRoot = homedir()
    const seat = this.routing()
    if (seat === undefined) {
      return { localRoot, canTransfer: false, reason: '本次组合没有设备支持（dshell-ssh 未挂载）。' }
    }
    const target = seat.targetForSession(String(agent.id))
    if (target === undefined) {
      return { localRoot, canTransfer: false, reason: '这个会话运行在本机，没有可传输的设备。' }
    }
    if (target.mount === undefined) {
      return {
        localRoot,
        canTransfer: false,
        reason: '这个会话的设备绑定没有挂载目录，文件操作仍在两台机器之间混淆，因此不能传输。',
      }
    }
    return {
      localRoot,
      remoteRoot: target.remoteRoot,
      device: { id: target.device.id, name: target.device.name },
      canTransfer: true,
    }
  }

  /** One directory of one side, in that side's own namespace. */
  async list(sessionId: string, side: TransferSide, path: string): Promise<TransferListing> {
    const world = await this.world(sessionId, side)
    const start = path.trim().length === 0 ? world.root : path.trim()
    const target = await this.in(world, () => this.ctx.fs.resolve(start, { cwd: world.root }))
    const info = await this.in(world, () => this.ctx.fs.stat(target))
    if (info === undefined) throw new Error(`目录不存在：${String(target.targetKey)}`)
    if (info.type !== 'directory') throw new Error(`不是目录：${String(target.targetKey)}`)
    const children = await this.in(world, () => this.ctx.fs.listDir(target))
    const entries: TransferEntry[] = children.slice(0, MAX_ENTRIES).map(child => ({
      name: child.name,
      kind: child.type,
      ...child.size === undefined ? {} : { size: child.size },
    }))
    return { path: String(target.targetKey), entries, truncated: children.length > MAX_ENTRIES }
  }

  /**
   * Start one copy and answer with its job.
   *
   * The worlds are resolved inside the run, not here, so a copy that names an
   * unavailable session or side fails its job rather than the request — the
   * view then shows the reason on the item the user dragged.
   */
  start(input: CopyInput): TransferJobView {
    const view: MutableJob = {
      id: randomUUID(),
      from: input.from,
      to: input.to,
      fromPath: input.fromPath,
      toDir: input.toDir,
      state: 'walking',
      files: 0,
      bytes: 0,
      skipped: 0,
      createdAt: Date.now(),
    }
    const record: JobRecord = { view, controller: new AbortController(), timer: undefined }
    this.jobs.set(view.id, record)
    void this.run(record, input).catch((error: unknown) => {
      // The run classifies its own failures; this is the last net, for a bug in
      // that classification rather than for an expected refusal.
      if (view.settledAt === undefined) this.settle(record, 'failed', reason(error))
    })
    return this.read(record)
  }

  /** One job's current view. */
  get(jobId: string): TransferJobView | undefined {
    const record = this.jobs.get(jobId)
    return record === undefined ? undefined : this.read(record)
  }

  /** Stop one job; the run reports itself cancelled as it unwinds. */
  cancel(jobId: string): TransferJobView | undefined {
    const record = this.jobs.get(jobId)
    if (record === undefined) return undefined
    record.controller.abort()
    return this.read(record)
  }

  /** The snapshot the response carries, so a caller cannot mutate the registry. */
  private read(record: JobRecord): TransferJobView {
    return { ...record.view }
  }

  /** One session's live agent. */
  private async resolveAgent(sessionId: string): Promise<Agent> {
    const resolved = await this.ctx.sessionController.resolveAgent(SessionId(sessionId))
    if ('error' in resolved) throw new Error(`会话不可用：${resolved.error.code}`)
    return resolved.agent
  }

  /** One side's world for one session. */
  private async world(sessionId: string, side: TransferSide): Promise<World> {
    if (side === 'local') {
      return { side, agent: undefined, root: homedir(), sessionId: undefined }
    }
    const agent = await this.resolveAgent(sessionId)
    const target = this.routing()?.targetForSession(String(agent.id))
    if (target === undefined) throw new Error('这个会话没有绑定设备，无法作为远端一侧。')
    if (target.mount === undefined) throw new Error('这个会话的设备绑定没有挂载目录。')
    return { side, agent, root: target.remoteRoot, sessionId: agent.id }
  }

  /**
   * Call the filesystem as one world.
   *
   * The agentless boundary is stated rather than assumed: a device session's
   * `ctx.fs` routes by the AMBIENT initiator, so "this machine" has to be an
   * explicit absence of one, or a request that happened to inherit a session
   * would read the device behind the local side's back.
   */
  private in<T>(world: World, operation: () => T): T {
    return world.agent === undefined
      ? this.ctx.agents.withoutInitiator(operation)
      : this.ctx.agents.withInitiator(world.agent, operation)
  }

  /**
   * The byte-level device ops for one world, scoped to that world's initiator.
   *
   * The seat reads the ambient initiator on every call, so wrapping the lookup
   * in `this.in(world, ...)` is what makes the right device answer. Returns
   * `undefined` for a local world or for a session whose device has no helper
   * verified right now; the caller decides what to fall back to.
   */
  private deviceOps(world: World): import('@nexus-aethra/dshell-std').DeviceFsOps | undefined {
    if (world.agent === undefined) return undefined
    const seat = this.deviceFs()
    if (seat === undefined) return undefined
    return this.in(world, () => seat.forInitiator()) ?? undefined
  }

  /** The copy itself: plan, then write. */
  private async run(record: JobRecord, input: CopyInput): Promise<void> {
    const signal = record.controller.signal
    try {
      const source = await this.world(input.sessionId, input.from)
      const destination = await this.world(input.sessionId, input.to)
      const sourceTarget = await this.in(source, () => this.ctx.fs.resolve(input.fromPath, { cwd: source.root }))
      const info = await this.in(source, () => this.ctx.fs.stat(sourceTarget))
      if (info === undefined) throw new Error(`源不存在：${String(sourceTarget.targetKey)}`)
      const rootPath = String(sourceTarget.targetKey)
      const name = baseName(rootPath)
      if (info.type === 'file') {
        const size = info.size ?? 0
        if (size > MAX_BIG_BYTES) throw new Error(this.tooLarge(name, size))
        record.view.totalFiles = 1
        record.view.totalBytes = size
        record.view.state = 'copying'
        await this.copyOne(record, source, sourceTarget, destination, joinPath(input.toDir, name), input.overwrite, size)
        this.settle(record, 'done')
        return
      }
      if (info.type !== 'directory') {
        throw new Error(`只支持文件和目录，${name} 是其它类型。`)
      }
      if (name === '') throw new Error('不能复制文件系统的根目录。')
      // A directory is copied AS ITSELF into the destination directory — the
      // folder the reader dragged appears there by name — so every entry in the
      // plan is rooted one level below it.
      const root = joinPath(input.toDir, name)
      // The totals stay undefined until the walk has counted them: a `0/0 项`
      // line during the walk would say the copy is empty, which it is not yet
      // known to be.
      const plan = await this.walk(record, source, sourceTarget, signal)
      record.view.totalFiles = plan.files.length
      record.view.totalBytes = plan.bytes
      record.view.state = 'copying'
      if (plan.dirs.length > 0) await this.makeDirs(destination, root, plan.dirs)
      for (const file of plan.files) {
        if (signal.aborted) throw new Error('已取消')
        record.view.current = file.relative
        await this.copyOne(
          record, source, file.target, destination, joinPath(root, file.relative), input.overwrite, file.size,
        )
      }
      this.settle(record, 'done')
    } catch (error) {
      if (signal.aborted) {
        this.settle(record, 'cancelled')
        return
      }
      const message = reason(error)
      // A collision is a question the view can answer, so it is marked rather
      // than folded into the failure text.
      const conflict = message.startsWith(CONFLICT)
      this.settle(record, 'failed', conflict ? message.slice(CONFLICT.length) : message, conflict)
    }
  }

  /** `tooLarge`'s sentence, kept in one place so the plan and the single-file path agree. */
  private tooLarge(name: string, size: number): string {
    return `${name} 有 ${String(size)} 字节，超过分块传输上限 ${String(MAX_BIG_BYTES)} 字节。`
  }

  /**
   * Read one directory level, recursively, as the source world.
   *
   * Directories and files come back as absolute paths in that world plus the
   * part under the copied root, because that relative part is the ONLY thing the
   * destination needs: the two sides spell the same structure differently, so
   * joining names is what carries the shape across.
   */
  private async walk(
    record: JobRecord,
    world: World,
    root: FsTarget,
    signal: AbortSignal,
  ): Promise<{ dirs: readonly string[]; files: readonly { relative: string; size: number; target: FsTarget }[]; bytes: number }> {
    const rootPath = String(root.targetKey)
    const dirs: string[] = []
    const files: { relative: string; size: number; target: FsTarget }[] = []
    let bytes = 0
    const queue: FsTarget[] = [root]
    while (queue.length > 0) {
      if (signal.aborted) throw new Error('已取消')
      const level = queue.shift() as FsTarget
      const children = await this.in(world, () => this.ctx.fs.listDir(level))
      for (const child of children) {
        const childPath = String(child.target.targetKey)
        const relative = relativeUnder(rootPath, childPath)
        if (relative === undefined) continue
        if (child.type === 'directory') {
          dirs.push(relative)
          queue.push(child.target)
        } else if (child.type === 'file') {
          const size = child.size ?? 0
          if (size > MAX_BIG_BYTES) throw new Error(this.tooLarge(child.name, size))
          bytes += size
          files.push({ relative, size, target: child.target })
        } else {
          record.view.skipped += 1
        }
        if (dirs.length + files.length + record.view.skipped > MAX_PLAN_ENTRIES) {
          throw new Error(`这次复制超过 ${String(MAX_PLAN_ENTRIES)} 个条目，需要分几次传。`)
        }
        if (bytes > MAX_PLAN_BYTES) {
          throw new Error(`这次复制超过 ${String(MAX_PLAN_BYTES)} 字节，需要分几次传。`)
        }
      }
    }
    return { dirs, files, bytes }
  }

  /**
   * Create the copied tree's directories, empty ones included.
   *
   * A local destination is created in process, one `mkdir -p` per directory; a
   * device destination asks `ctx.deviceFs` for the batched mkdir, which is one
   * round trip per batch instead of one per directory.
   */
  private async makeDirs(world: World, toDir: string, dirs: readonly string[]): Promise<void> {
    if (world.agent === undefined) {
      for (const relative of dirs) await mkdir(joinPath(toDir, relative), { recursive: true })
      return
    }
    const ops = this.deviceOps(world)
    if (ops === undefined) throw new Error('这个会话没有绑定设备的字节级操作入口。')
    const batch = 100
    for (let index = 0; index < dirs.length; index += batch) {
      const paths = dirs.slice(index, index + batch).map(relative => joinPath(toDir, relative))
      await ops.mkdir(paths, true)
    }
  }

  /**
   * Write one file into the destination world.
   *
   * The two worlds need different writers, and for a stated reason rather than
   * for convenience: the filesystem seam has no byte write (both of its
   * mutations take text), so a local destination is written by this process —
   * which IS that world, the same assumption the local pane's root already makes
   * by asking `os.homedir()` — while a device destination gets one `ssh`-borne
   * shell command that decodes the payload its stdin carries.
   *
   * The device command is deliberately ONE command per file, and one round trip
   * with it: the destination path is composed as a string (both sides are POSIX
   * and the drop directory came from a listing in that world's own namespace),
   * and creating the parent, deciding whether the target may be replaced, and
   * publishing the bytes are all steps of it. Asking `ctx.fs` for the resolve and
   * the stat first would be two more round trips per file — measurable on a
   * device, where each one is a process — for answers this command already has.
   *
   * Both writers publish through a temporary file in the destination directory
   * and a rename, so a transfer that dies halfway cannot destroy the file it was
   * replacing. The refusal travels as an exit code on the device (a shell cannot
   * report anything finer without being trusted to quote for us) and as a
   * `stat` in process locally; both produce the same two refusals.
   */
  private async copyOne(
    record: JobRecord,
    source: World,
    sourceTarget: FsTarget,
    destination: World,
    toPath: string,
    overwrite: boolean,
    size?: number,
  ): Promise<void> {
    const signal = record.controller.signal
    if (size !== undefined && size > MAX_FILE_BYTES) {
      await this.copyChunked(record, source, sourceTarget, destination, toPath, size, overwrite)
      record.view.files += 1
      return
    }
    const bytes = await this.in(source, () => this.ctx.fs.readBytes(sourceTarget, signal, MAX_FILE_BYTES))
    if (destination.agent === undefined) await this.writeLocal(toPath, bytes, overwrite, signal)
    else await this.writeRemote(destination, toPath, bytes, overwrite, signal)
    record.view.files += 1
    record.view.bytes += bytes.byteLength
  }

  /**
   * Move one file too big for a single `ctx.fs.readBytes` payload.
   *
   * Three shapes, chosen once per copy:
   *
   *  - **device → device** is one device op: `deviceFs.copy(source, dest, …)`
   *    does the staging, hashing, and atomic rename internally.
   *  - **host → device / device → host** streams chunks one at a time via
   *    `ctx.fs.readByteRange` on the source side, accumulates them in process,
   *    and writes the file in one `deviceFs.writeBytes` at the end (which the
   *    helper stages atomically on the destination). Memory cost is the file
   *    size, capped at `MAX_BIG_BYTES`.
   *  - **host → host** is `node:fs` — handled by the inline path before this
   *    method is reached.
   *
   * The destination digest is verified against the source digest on a device
   * destination; the helper's `copy` op does its own verification, and a
   * mismatch is reported back through the wire. A mismatch fails the copy
   * loudly and KEEPS the destination's staging for inspection (the error names
   * where); any other failure, cancellation included, cleans up best-effort.
   */
private async copyChunked(
    record: JobRecord,
    source: World,
    sourceTarget: FsTarget,
    destination: World,
    toPath: string,
    size: number,
    overwrite: boolean,
  ): Promise<void> {
    const signal = record.controller.signal
    const chunksTotal = Math.max(1, Math.ceil(size / CHUNK_BYTES))
    record.view.chunksTotal = chunksTotal
    const stamp = randomUUID().slice(0, 8)
    // A local destination appends through one handle, opened after the conflict
    // check and closed on every exit path.
    let localHandle: Awaited<ReturnType<typeof open>> | undefined
    const localTemp = `${toPath}.dshell-xfer-${stamp}`

    const cleanup = async (): Promise<void> => {
      await localHandle?.close().catch(() => {})
      localHandle = undefined
      await rm(localTemp, { force: true }).catch(() => {})
    }

    try {
      // The destination refuses the copy before a byte moves, with the same two
      // refusals the inline writers produce.
      if (destination.agent === undefined) {
        const existing = await statPath(toPath).catch(() => undefined)
        if (existing?.isDirectory()) throw new Error(`${toPath} 已经是一个目录，不能覆盖。`)
        if (existing !== undefined && !overwrite) throw new Error(`${CONFLICT}${toPath} 已存在，要覆盖它请确认。`)
        localHandle = await open(localTemp, 'w')
      } else {
        await this.precheckRemoteDestination(destination, toPath, overwrite)
      }

      // Same-direction device→device is a single device op; the helper handles
      // staging, hashing, and the rename.
      if (source.agent !== undefined && destination.agent !== undefined) {
        const ops = this.deviceOps(destination)
        if (ops === undefined) throw new Error('这个会话没有绑定设备的字节级操作入口。')
        const sourcePath = String(sourceTarget.targetKey)
        await ops.copy(sourcePath, toPath, overwrite, undefined, (written) => {
          record.view.bytes = written
          record.view.chunksDone = Math.min(chunksTotal, Math.floor(written / CHUNK_BYTES))
        }, signal)
        record.view.bytes = size
        record.view.chunksDone = chunksTotal
        return
      }

      // Cross-host (local↔device): chunks cross the wire one at a time.
      // The destination accumulates them in process for a single writeBytes,
      // which the helper stages atomically. Wire cost: one read per chunk,
      // one write at the end — better than the staged "cat p* > toPath"
      // dance, which read each part twice.
      const readDigest = createHash('sha256')
      let sourceSha = ''
      const buffers: Buffer[] = []
      let total = 0
      for (let index = 0; index < chunksTotal; index += 1) {
        signal.throwIfAborted()
        const length = Math.min(CHUNK_BYTES, size - index * CHUNK_BYTES)
        const chunk = await this.in(source, () => this.ctx.fs.readByteRange(
          sourceTarget,
          { offset: index * CHUNK_BYTES, length },
          signal,
        ))
        readDigest.update(chunk)
        record.view.bytes += chunk.byteLength
        record.view.chunksDone = index + 1
        if (destination.agent === undefined) {
          await localHandle!.write(chunk)
        } else {
          buffers.push(Buffer.from(chunk))
          total += chunk.byteLength
        }
      }
      sourceSha = readDigest.digest('hex')

      // Publish: a remote destination gets one writeBytes; a local destination
      // closes its temp file and renames. Either way no staging parts.
      if (destination.agent === undefined) {
        await localHandle?.close()
        localHandle = undefined
        const existing = await statPath(toPath).catch(() => undefined)
        await chmod(localTemp, existing === undefined ? 0o644 : existing.mode & 0o7777).catch(() => {})
        await rename(localTemp, toPath)
      } else {
        const ops = this.deviceOps(destination)
        if (ops === undefined) throw new Error('这个会话没有绑定设备的字节级操作入口。')
        const assembled = Buffer.concat(buffers, total)
        if (assembled.byteLength !== size) {
          throw new Error(`分块重组字节数 ${String(assembled.byteLength)} 与期望 ${String(size)} 不一致。`)
        }
        await ops.mkdir([dirname(toPath)], true)
        await ops.writeBytes(toPath, assembled, signal)
        const destinationSha = await ops.sha256(toPath, signal)
        if (destinationSha === '') {
          throw new Error(`重组 ${toPath} 后没有取得校验和，传输结果不可信。`)
        }
        if (destinationSha !== sourceSha) {
          throw new Error(
            `分块传输校验不一致：源 ${sourceSha || '未知'}，目标 ${destinationSha}。`,
          )
        }
      }
    } catch (error) {
      await cleanup()
      throw error
    } finally {
      await localHandle?.close().catch(() => {})
      localHandle = undefined
    }
  }

  /** The destination's refusal, checked on the device before any byte moves. */
  private async precheckRemoteDestination(
    destination: World,
    toPath: string,
    overwrite: boolean,
  ): Promise<void> {
    const target = await this.in(destination, () => this.ctx.fs.resolve(toPath, { cwd: destination.root }))
    const existing = await this.in(destination, () => this.ctx.fs.stat(target))
    if (existing?.type === 'directory') throw new Error(`${toPath} 已经是一个目录，不能覆盖。`)
    if (existing !== undefined && !overwrite) {
      throw new Error(`${CONFLICT}${toPath} 已存在，要覆盖它请确认。`)
    }
  }

  /** Write bytes onto this machine, in process: temp file, mode, rename. */
  private async writeLocal(path: string, bytes: Uint8Array, overwrite: boolean, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new Error('已取消')
    await mkdir(dirname(path), { recursive: true })
    const existing = await statPath(path).catch(() => undefined)
    if (existing !== undefined) {
      if (existing.isDirectory()) throw new Error(`${path} 已经是一个目录，不能覆盖。`)
      if (!overwrite) throw new Error(`${CONFLICT}${path} 已存在，要覆盖它请确认。`)
    }
    const temporary = `${path}.dshell-xfer-${randomUUID().slice(0, 8)}`
    await writeFile(temporary, bytes, { signal })
    try {
      // The bytes are the transfer's subject, the permissions are the target's:
      // an overwrite keeps what the file had, a new file gets the ordinary 0644
      // (a temp file's own 0600 would make everything arrive private).
      await chmod(temporary, existing === undefined ? 0o644 : existing.mode & 0o7777).catch(() => {})
      await rename(temporary, path)
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {})
      throw error
    }
  }

  /** Write bytes into a device world. */
  private async writeRemote(
    destination: World,
    toPath: string,
    bytes: Uint8Array,
    overwrite: boolean,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) throw new Error('已取消')
    const ops = this.deviceOps(destination)
    if (ops === undefined) throw new Error('这个会话没有绑定设备的字节级操作入口。')
    await ops.mkdir([dirname(toPath)], true)
    const target = await this.in(destination, () => this.ctx.fs.resolve(toPath, { cwd: destination.root }))
    const existing = await this.in(destination, () => this.ctx.fs.stat(target))
    if (existing?.type === 'directory') throw new Error(`${toPath} 已经是一个目录，不能覆盖。`)
    if (existing !== undefined && !overwrite) {
      throw new Error(`${CONFLICT}${toPath} 已存在，要覆盖它请确认。`)
    }
    await ops.writeBytes(toPath, bytes, signal)
  }

  /** Record a final state and schedule the job's removal. */
  private settle(record: JobRecord, state: TransferJobState, error?: string, conflict?: boolean): void {
    if (record.view.settledAt !== undefined) return
    record.view.state = state
    record.view.current = undefined
    record.view.settledAt = Date.now()
    if (error !== undefined) record.view.error = error
    if (conflict !== undefined) record.view.conflict = conflict
    if (record.timer !== undefined) clearTimeout(record.timer)
    record.timer = setTimeout(() => { this.jobs.delete(record.view.id) }, JOB_TTL_MS)
    // A timer must not hold the process open while the harness shuts down.
    record.timer.unref?.()
  }
}

/** Prefix that marks a refusal as "the destination exists", which the view can answer. */
const CONFLICT = 'CONFLICT:'
