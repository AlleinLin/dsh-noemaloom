/**
 * The dshell helper's wire contract.
 *
 * dsh ships its own remote helper and dshell reuses its *framing* — `SshRpcPeer`
 * from `@deepseek-ai/dsh-ssh/protocol`: length-prefixed JSON over one ssh
 * channel — without reusing the helper itself. Two findings decide that:
 * their helper refuses any method it does not know, so it cannot be extended;
 * and it imports eight first-party packages plus node-pty's native prebuilt,
 * so installing it means reproducing a dependency tree on the device, where
 * ours is one self-contained file.
 *
 * Operation names mirror theirs wherever the semantics are identical, which
 * keeps the two vocabularies comparable and a later move onto their client
 * cheap. Everything dshell needs beyond that set is namespaced `dshell.*` —
 * which is the entire point of owning the helper.
 *
 * Every reply is validated before it reaches a caller: the device is not a
 * trusted peer, so a reply is input like any other.
 */
import { z } from 'zod'

/**
 * This contract's revision.
 *
 * Deliberately independent of `SSH_PROTOCOL_VERSION` in dsh-ssh: the framing is
 * theirs, the operation set is ours, so tying our number to their release train
 * would make an alpha wire change look like our incompatibility.
 */
export const DSHELL_HELPER_PROTOCOL = 1

/** Per-message byte ceiling. Matches the value the protocol spike measured. */
export const DSHELL_HELPER_MAX_FRAME_BYTES = 64 * 1024 * 1024

/** Outstanding ordinary requests; heartbeat and cleanup have reserved capacity. */
export const DSHELL_HELPER_MAX_PENDING = 128

/**
 * How long the helper survives without a heartbeat, and the base for how often
 * one is sent (a third of it).
 *
 * Same order as the connection's keepalives (`ServerAliveInterval=10` with
 * `CountMax=3`), on purpose: the transport should notice a dead link at
 * roughly the moment the device is deciding to reap the helper, so the two
 * mechanisms do not disagree about whether the connection is alive.
 */
export const DSHELL_HELPER_LEASE_MS = 30_000

/** Operation names. Mirrored on both ends; never spelled inline at a call site. */
export const HELPER_OPS = {
  /** First call on a connection; carries the protocol revision and the lease. */
  hello: 'hello',
  /** Extends the lease; its absence is what lets the device reap the helper. */
  heartbeat: 'heartbeat',
  /** Ask the helper to release its resources and exit. */
  close: 'close',
  /** Round-trip probe, used by the connection's own check and by tests. */
  echo: 'dshell.echo',
  /** Start one process on the device. */
  processPrepare: 'process.prepare',
  /** Read output produced since a whole-stream offset. */
  processSnapshot: 'process.snapshot',
  /** The process's exit facts and final collected output. */
  processDone: 'process.done',
  /** Terminate the process's managed range. */
  processTerminate: 'process.terminate',
  /** Wait until nothing of that range is left. */
  processWait: 'process.wait',
  /** Canonical device path for a path that need not exist yet. */
  fsResolve: 'fs.resolve',
  /** Metadata, following a final symlink. */
  fsStat: 'fs.stat',
  /** Metadata without following a final symlink. */
  fsLstat: 'fs.lstat',
  /** Direct children of a directory. */
  fsList: 'fs.list',
  /** One byte window of a file. */
  fsReadRange: 'fs.readRange',
  /** Replace a file's contents atomically. */
  fsWrite: 'fs.write',
  /** Replace a file's contents with bytes carried in the request. */
  fsWriteBytes: 'fs.writeBytes',
  /** Create one or more directories, optionally recursive. */
  fsMkdir: 'fs.mkdir',
  /** Remove one path, recursively and tolerating absence. */
  fsRemove: 'fs.remove',
  /** Rename one path, optionally over an existing one. */
  fsRename: 'fs.rename',
  /** Stream one file's SHA-256 digest as hex, computed on the device. */
  fsSha256: 'fs.sha256',
  /** Stream one source file's bytes to a destination path on the device. */
  fsCopy: 'fs.copy',
  /** Read the current progress of an in-flight copy. */
  fsCopyProgress: 'fs.copyProgress',
} as const

/**
 * Live processes one connection will serve at once.
 *
 * A cap rather than a queue: hitting it means a caller is leaking handles, and
 * refusing the next spawn says so where an unbounded table would grow until the
 * device ran out of room.
 */
export const DSHELL_HELPER_MAX_PROCESSES = 64

/** Per-stream ceiling a caller may ask to collect, in bytes. */
export const DSHELL_HELPER_MAX_COLLECT_BYTES = 64 * 1024 * 1024

/**
 * Largest byte window one `fs.readRange` may carry, before encoding.
 *
 * The frame ceiling bounds every message, and base64 inflates what it carries by
 * a third, so a window has to leave room for both. A caller that wants more
 * reads in windows — the client's own reader does exactly that — because a
 * larger single reply would be a frame the peer must refuse.
 */
export const DSHELL_HELPER_MAX_READ_BYTES = 8 * 1024 * 1024

/**
 * Largest file one `fs.write` may publish, before encoding.
 *
 * Larger than a read window because a write travels once: the whole content is
 * one JSON string, so the ceiling is what still fits a frame with base64
 * headroom. A bulk transfer does not come through here — it writes its own
 * windows.
 */
export const DSHELL_HELPER_MAX_WRITE_BYTES = 32 * 1024 * 1024

/** An absolute path as the device spells it. */
export const remoteAbsolutePath = z.string().startsWith('/')

/** A lowercase SHA-256 digest. */
export const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/)

/** The handshake request. */
export const helloRequest = z.object({
  protocol: z.number().int().positive(),
  leaseMs: z.number().int().min(3_000).max(600_000),
}).strict()

/**
 * The handshake reply.
 *
 * `hash` is the device's helper hashing *itself*: the client compares it with
 * the digest of the artifact this build ships, which is what makes a stale or
 * substituted helper refuse the connection instead of silently serving.
 */
export const helloReply = z.object({
  protocol: z.number().int().positive(),
  hash: sha256Hex,
  platform: z.string(),
  /** Absolute remote Node executable, as the device resolved it. */
  node: z.string(),
  nodeVersion: z.string(),
  /** The device's default working directory for this connection. */
  root: remoteAbsolutePath,
}).strict()

/** A request with no fields. */
export const emptyRequest = z.object({}).strict()

/**
 * The reply of an operation that has nothing to report.
 *
 * `z.null()` rather than an empty object: "succeeded, no value" is not the same
 * statement as "succeeded, and here is an empty record", and a caller that got
 * the second when it expected the first would go looking for a field.
 */
export const nullReply = z.null()

/** The round-trip probe request. */
export const echoRequest = z.object({ label: z.string() }).strict()

/**
 * The probe reply. `pid` and `cwd` are what make it evidence: they can only
 * have been produced by a process on the other machine.
 */
export const echoReply = z.object({
  label: z.string(),
  upper: z.string(),
  pid: z.number().int().positive(),
  cwd: z.string(),
}).strict()

/** One output stream's collection request: a tail cap, optionally a spill file. */
export const collectMode = z.object({
  /** In-memory cap; overflow keeps the TAIL. */
  maxBytes: z.number().int().positive().max(DSHELL_HELPER_MAX_COLLECT_BYTES),
  /** Whole-stream spill file; absent disables spilling, as the seam allows. */
  spill: z.object({
    maxBytes: z.number().int().positive().max(DSHELL_HELPER_MAX_COLLECT_BYTES),
  }).strict().optional(),
}).strict()

/** stdin as the seam spells it: `/dev/null`, or bytes written and then closed. */
export const stdinMode = z.union([z.literal('ignore'), z.object({ data: z.string() }).strict()])

/**
 * Start one process.
 *
 * No `process.start` counterpart: upstream splits prepare from start so its
 * forwarded streams can attach before the payload runs, and there is no such
 * window here — the helper collects output inside itself, so by the time a
 * caller hears about the process it is already producing into a buffer that
 * cannot miss the beginning.
 */
export const processPrepareRequest = z.object({
  argv: z.array(z.string()).min(1),
  cwd: remoteAbsolutePath,
  /** `null` removes an inherited name; absent leaves the helper's own environment. */
  env: z.record(z.string(), z.string().nullable()).optional(),
  stdin: stdinMode,
  stdout: collectMode,
  stderr: collectMode,
  graceMs: z.number().int().positive(),
}).strict()

/**
 * The process's handle: its identity, and the pid when there is one.
 *
 * `pid` is optional because a start can fail in the platform's own time: node
 * reports a missing program on the child's `error` event, after `spawn`
 * returned, so the helper cannot know synchronously. The failure then surfaces
 * on `process.done` carrying the platform's reason — which is the point, since
 * "no such file" is what a caller can act on and "could not start" is not.
 */
export const processPrepareReply = z.object({
  id: z.string(),
  pid: z.number().int().positive().optional(),
}).strict()

/** Read one stream from a whole-stream offset. */
export const processSnapshotRequest = z.object({
  id: z.string(),
  stream: z.enum(['stdout', 'stderr']),
  /** Whole-stream byte offset to resume from; 0 for the first read. */
  fromByte: z.number().int().nonnegative(),
}).strict()

/**
 * Incremental output.
 *
 * `from` is the whole-stream offset of the first byte in `chunk`, which is what
 * lets a reader detect that it asked below what the device still retains: a
 * `from` greater than the requested offset means the bytes in between are gone
 * from the in-memory window (and only a spill file could hold them).
 */
export const processSnapshotReply = z.object({
  chunk: z.string(),
  from: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
}).strict()

/** One stream's final in-memory tail plus its whole-stream size. */
export const collectedTail = z.object({
  tail: z.string(),
  totalBytes: z.number().int().nonnegative(),
}).strict()

/** Exit facts, in the seam's vocabulary: a code, or the signal that ended it. */
export const processOutcome = z.object({
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
}).strict()

/**
 * The process's end state: exit facts, final tails, and any spill files.
 *
 * Both tails are required rather than optional because this provider serves
 * collect mode only — `supportsStdio` refuses the piped and inherited shapes —
 * so a reply missing one would be a protocol error, not a disposition.
 */
export const processDoneReply = z.object({
  outcome: processOutcome,
  collected: z.object({
    stdout: collectedTail,
    stderr: collectedTail,
  }).strict(),
  /** Device paths; a stream that did not spill is absent. */
  spills: z.object({
    stdout: z.string().optional(),
    stderr: z.string().optional(),
  }).strict(),
}).strict()

/** Address one process. */
export const processIdRequest = z.object({ id: z.string() }).strict()

/** Whether the process's managed range is empty. */
export const processWaitReply = z.boolean()

/**
 * What a device may find at a path, in the seam's vocabulary.
 *
 * `symlink` can only be reported by `fs.lstat`: a followed stat describes what
 * the link points at, which is the same distinction the local backend draws
 * between its `pathType` and `pathLinkType`.
 */
export const remoteFsKind = z.enum(['file', 'directory', 'symlink', 'other'])

/**
 * Metadata for one device path.
 *
 * `version` is an opaque change token, compared for equality and never parsed:
 * a caller uses it to say "the file I read is still the file I am writing".
 * Its spelling is the device's business, and a token is only ever compared with
 * a token from the same transport.
 */
export const remoteFsStat = z.object({
  kind: remoteFsKind,
  /** Bytes for a file, and for a symlink the length of its target; otherwise the device's own answer. */
  size: z.number().int().nonnegative(),
  version: z.string().min(1),
}).strict()

/**
 * The filesystem failures a device can originate, named exactly as the seam
 * names them.
 *
 * Deliberately codes and not text: classifying a failure by reading an error
 * message is a bet on the device's language and on `stat`'s wording, and both
 * change without notice. The message still travels — it names the path and the
 * errno, which is what a log wants — but nothing decides anything from it.
 */
/** Address one device path. Always absolute: the caller translates, the device does not guess. */
export const fsPathRequest = z.object({ path: remoteAbsolutePath }).strict()

/**
 * The canonical form of a path, whether or not it exists.
 *
 * The reply carries a path rather than a stat record because the caller already
 * holds a display path of its own; what it cannot compute here is how the
 * device's symlinks resolve, and that is the whole content of this answer.
 */
export const fsResolveReply = z.object({ path: remoteAbsolutePath }).strict()

/** A stat whose subject does not exist is `null`, not an error. */
export const fsStatReply = remoteFsStat.nullable()

/** One directory child as the device reports it. */
export const fsListEntry = z.object({
  name: z.string().min(1),
  kind: remoteFsKind,
  /** Present for a file. */
  size: z.number().int().nonnegative().optional(),
  /** Absent when the child could not be inspected at all — a dangling symlink, typically. */
  version: z.string().min(1).optional(),
}).strict()

/** @see fsListEntry */
export const fsListReply = z.object({ entries: z.array(fsListEntry) }).strict()

/** One byte window: `offset` is where the window starts, `length` how many bytes may be read. */
export const fsReadRangeRequest = z.object({
  path: remoteAbsolutePath,
  offset: z.number().int().nonnegative(),
  length: z.number().int().positive().max(DSHELL_HELPER_MAX_READ_BYTES),
}).strict()

/**
 * The bytes read, base64 as every binary field on this wire is.
 *
 * A short window is how a reader learns it reached the end of the file, so the
 * reply carries no end flag: the length of the answer *is* the answer.
 */
export const fsReadRangeReply = z.object({ data: z.string() }).strict()

/**
 * Publish a whole file's bytes.
 *
 * `data` is base64 where upstream's `fs.write` carries text, because this
 * provider writes bytes and the seam's own text entry point encodes on the host
 * side. The device keeps an existing file's mode and gives a new one the
 * owner-only mode the local backend gives a new file.
 */
export const fsWriteRequest = z.object({
  path: remoteAbsolutePath,
  data: z.string().max(Math.ceil(DSHELL_HELPER_MAX_WRITE_BYTES / 3) * 4),
}).strict()

/**
 * The written file, as it stands after publication.
 *
 * Taken after the rename rather than from the staging file's descriptor: a
 * rename updates the inode's change time, so a version read before it would
 * name a state that no longer exists and every later guard would call the file
 * changed.
 */
export const fsWriteReply = remoteFsStat

/**
 * Bytes carried as base64, the wire shape every binary field on this protocol
 * takes. Shared by the write-bytes, write, read-range and copy ops.
 *
 * Sized like {@link fsWriteRequest}: the frame ceiling bounds every message,
 * base64 inflates by a third, and a write that asks to publish bytes has the
 * same one-message constraint.
 */
export const fsWriteBytesRequest = z.object({
  path: remoteAbsolutePath,
  data: z.string().max(Math.ceil(DSHELL_HELPER_MAX_WRITE_BYTES / 3) * 4),
}).strict()

/**
 * Create one or more directories.
 *
 * `paths` rather than one: a chunked copy makes its scratch directory along
 * with every nested one inside it, and a per-path request would be one round
 * trip per directory. The recursive flag covers both: a true value turns each
 * path into `mkdir -p` semantics, the same wording the local backend uses.
 */
export const fsMkdirRequest = z.object({
  paths: z.array(remoteAbsolutePath).min(1),
  recursive: z.boolean(),
}).strict()

/** Remove one path, recursively and tolerating absence. */
export const fsRemoveRequest = z.object({
  path: remoteAbsolutePath,
  force: z.boolean(),
}).strict()

/** Rename one path to another, optionally over an existing one. */
export const fsRenameRequest = z.object({
  from: remoteAbsolutePath,
  to: remoteAbsolutePath,
  overwrite: z.boolean(),
}).strict()

/**
 * The whole-file SHA-256 of one path, requested as an op rather than as a
 * side-effect of `fs.copy` so a caller that already has the bytes can verify
 * against the device's own digest without going through a copy.
 */
export const fsSha256Request = z.object({
  path: remoteAbsolutePath,
}).strict()

/** The hex digest, the same shape the local `sha256sum -z` produces. */
export const fsSha256Reply = z.object({ hex: z.string().regex(/^[0-9a-f]{64}$/) }).strict()

/**
 * The whole-shape, two-realm call that replaces `split` + base64 relay +
 * `cat` + `sha256sum` + `rm -rf` on the chunked path.
 *
 * Both source and destination are device paths; this op is what makes the
 * device do the copy internally, so a multi-gigabyte transfer is one request
 * whose reply is the outcome. Progress is reported on a separate
 * `fs.copyProgress` op, keyed by the `copyId` the host allocates here.
 *
 * `expectedSha256` is optional: a caller that has the source bytes already
 * (an in-process local file, an earlier read) can pin the copy; a caller that
 * does not lets the device compute the source's digest itself and report it
 * back.
 */
export const fsCopyRequest = z.object({
  /** A host-allocated id used to query progress on a separate request. */
  copyId: z.string().min(1),
  source: remoteAbsolutePath,
  destination: remoteAbsolutePath,
  /** Refuse when the destination exists unless this is true. */
  overwrite: z.boolean(),
  /** Hex digest to compare the source against before copying; absent means skip the read-side check. */
  expectedSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
}).strict()

/**
 * Progress on a `fs.copy`. The frame carries one increment; the host advances
 * the job's `bytes` and `chunksDone` from it.
 */
export const fsCopyProgress = z.object({
  /** Bytes the device has written to the staging file so far. */
  written: z.number().int().nonnegative(),
  /** Whole-file size of the source as the device saw it. */
  totalBytes: z.number().int().nonnegative(),
}).strict()

/**
 * The reply of `fs.copy`: the destination's metadata after the rename, plus
 * the digest the device computed for the source so a caller without
 * `expectedSha256` can verify on its own side too.
 */
export const fsCopyReply = z.object({
  destination: remoteFsStat,
  sourceSha256: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: z.number().int().nonnegative(),
}).strict()

/** The rename reply: the destination's metadata after publication. */
export const fsRenameReply = remoteFsStat.nullable()


/** Address one in-flight copy. */
export const fsCopyIdRequest = z.object({ id: z.string().min(1) }).strict()

/** Progress of an in-flight copy: total, written so far, and whether it is still running. */
export const fsCopyProgressReply = z.object({
  totalBytes: z.number().int().nonnegative(),
  written: z.number().int().nonnegative(),
  running: z.boolean(),
}).strict()
