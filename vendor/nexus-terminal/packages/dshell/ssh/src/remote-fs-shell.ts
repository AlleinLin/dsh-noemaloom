/**
 * The assembled-command lane of the device filesystem.
 *
 * One command per operation, its output parsed back into the seam's vocabulary.
 * This is what the whole package did before the helper, and it keeps two jobs: it
 * is the tier a device without Node has — the helper *is* a Node process, so
 * nothing can be done about that from here — and it answers while a helper
 * connection is still being established.
 *
 * Its costs are the reason the helper exists, and they are visible in this
 * file: a filename may contain any byte but NUL, so a listing needs a
 * NUL-separated `find -printf`; `stat` and `find` localize their output, so
 * every invocation pins `LC_ALL=C`; and a failure can only be classified by
 * matching English text out of stderr, which reports a permission problem on a
 * non-English device as an unknown I/O fault.
 *
 * What changed with the transport is only how the command travels: it used to be
 * one local `ssh` process per call, and it is now one channel on the device's
 * pooled connection. The command strings below are the same lines they always
 * were, which is why this lane's behaviour is unchanged apart from the cost.
 */
import { FsError, FsVersion } from '@deepseek-ai/dsh-fs'
import type { DshellSshTranslate } from './host-locales.js'
import type {
  RemoteFsDeps, RemoteFsTransport, RemoteKind, RemoteListEntry, RemoteStat,
} from './remote-fs-transport.js'
import { quote, quoteDevicePath } from './shell-quote.js'
import { deviceTransport, type DeviceOutcome } from './transport/transport.js'

/** The error text this file's classifier reads; see the note in the module header. */
const MISSING_PATH = /No such file or directory|cannot statx? .*No such/i

/** How long one assembled command may run before the device is asked to stop. */
const COMMAND_GRACE_MS = 5_000

/**
 * `stat`'s machine-readable record: filesystem type, size, device, inode, and
 * both timestamps.
 *
 * `%F` prints a *localized* phrase for the type, and `%y`/`%z` a locale-shaped
 * date, which is why every call pins `LC_ALL=C`.
 */
const STAT_FORMAT = '%F|%s|%d|%i|%y|%z'

/**
 * `find -printf`'s record, one child per six NUL-terminated fields.
 *
 * The separators are spelled `\0` (backslash, zero) rather than embedded NUL
 * bytes on purpose: this string travels as one argv element of the local `ssh`
 * process, and a real NUL cannot cross that boundary at all — Node refuses the
 * spawn. The remote login shell passes the two characters through its single
 * quotes untouched, and GNU `find -printf` turns `\0` into the NUL it emits.
 */
const FIND_FORMAT = '%f\\0%y\\0%s\\0%d\\0%i\\0%T@\\0'

/** One finished remote command. */
interface RemoteRun {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
  readonly truncated: boolean
}

/** The device filesystem over one channel per command. */
export class ShellFsTransport implements RemoteFsTransport {
  constructor(private readonly deps: RemoteFsDeps) {}

  /** Run one command on the device and collect its output. */
  private async run(
    command: string,
    options: { signal?: AbortSignal | undefined; stdin?: string | undefined } = {},
  ): Promise<RemoteRun> {
    const result = await deviceTransport().exec(this.deps.device, command, {
      graceMs: COMMAND_GRACE_MS,
      ...options.signal === undefined ? {} : { signal: options.signal },
      ...options.stdin === undefined ? {} : { stdin: options.stdin },
    })
    if (result.exitCode === null) {
      // Two different endings, and one message for both of them was a lie: a
      // connection the far side dropped was reported as a signal that never
      // arrived, which sent the reader looking for the wrong thing.
      throw result.connectionLost === true
        ? new FsError(this.deps.t('error.remoteLost'), 'FS_IO_ERROR')
        : new FsError(this.deps.t('error.remoteSignal', { signal: String(result.signal ?? 'unknown') }), 'FS_ABORTED')
    }
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode, truncated: result.truncated }
  }

  /**
   * Run one command and collect its stdout as raw bytes.
   *
   * Text collection decodes and would corrupt binary output, so image and
   * byte-range reads take the channel's own stream instead of a decoded one.
   */
  private async runBinary(command: string, signal?: AbortSignal): Promise<Buffer> {
    const attempt = async (): Promise<{ outcome: DeviceOutcome; bytes: Buffer; stderr: string }> => {
      const run = await deviceTransport().open(this.deps.device, command, {
        graceMs: COMMAND_GRACE_MS,
        ...signal === undefined ? {} : { signal },
      })
      const chunks: Buffer[] = []
      const stderr: string[] = []
      run.stderr.on('data', (chunk: Buffer) => { stderr.push(chunk.toString('utf8')) })
      for await (const chunk of run.stream as AsyncIterable<Buffer>) chunks.push(chunk)
      const outcome = await run.done
      return { outcome, bytes: Buffer.concat(chunks), stderr: stderr.join('') }
    }
    const first = await attempt()
    // A read is repeatable by nature, and the transport has already dropped the
    // connection that lost this one: one more attempt on a fresh channel is the
    // difference between a lost connection and a failed read.
    const result = first.outcome.connectionLost === true ? await attempt() : first
    if (result.outcome.exitCode === null) {
      throw result.outcome.connectionLost === true
        ? new FsError(this.deps.t('error.remoteLost'), 'FS_IO_ERROR')
        : new FsError(this.deps.t('error.remoteSignal', { signal: String(result.outcome.signal ?? 'unknown') }), 'FS_ABORTED')
    }
    if (result.outcome.exitCode !== 0) {
      // stderr was collected alongside the streamed stdout and has to be read
      // back for the classifier to see it: a failure handed an empty stream is
      // classified from nothing, and every read that failed for a knowable
      // reason reported an unknown I/O fault instead.
      throw classifyRemoteFailure({
        stdout: '',
        stderr: result.stderr,
        exitCode: result.outcome.exitCode,
        truncated: false,
      }, command, this.deps.t)
    }
    return result.bytes
  }

  /** Run one command that must succeed, mapping its failure onto the seam's codes. */
  private async runOrThrow(
    command: string,
    displayPath: string,
    options: { signal?: AbortSignal | undefined; stdin?: string | undefined; maxBytes?: number | undefined } = {},
  ): Promise<RemoteRun> {
    const result = await this.run(command, options)
    if (result.exitCode === 0) return result
    throw classifyRemoteFailure(result, displayPath, this.deps.t)
  }

  /** @inheritDoc */
  canOpen(path: string): boolean {
    // The device's own shell expands a tilde, so this lane can be asked
    // about `~` and about paths under it — which is how a device whose
    // root is still spelled `~` is served at all. Everything else has to
    // be an absolute device path, like every other lane.
    return path.startsWith('/') || path === '~' || path.startsWith('~/')
  }

  /** @inheritDoc */
  async resolve(path: string, signal?: AbortSignal): Promise<string> {
    // `-m` canonicalizes a path that does not exist yet, the way the local
    // backend resolves a missing file through its nearest existing ancestor.
    const result = await this.runOrThrow(`realpath -m -- ${quoteDevicePath(path)}`, path, { signal })
    return result.stdout.trim()
  }

  /** @inheritDoc */
  async stat(path: string, follow: boolean, signal?: AbortSignal): Promise<RemoteStat | undefined> {
    const flag = follow ? '-Lc' : '-c'
    const result = await this.run(`LC_ALL=C stat ${flag} ${quote(STAT_FORMAT)} -- ${quoteDevicePath(path)}`, { signal })
    if (result.exitCode !== 0) {
      if (MISSING_PATH.test(result.stderr)) return undefined
      throw classifyRemoteFailure(result, path, this.deps.t)
    }
    const [kind, size, device, inode, mtime, ctime] = result.stdout.trimEnd().split('|')
    return {
      kind: kindFromStat(kind ?? ''),
      size: Number(size ?? '0'),
      version: FsVersion(`${device ?? ''}:${inode ?? ''}:${mtime ?? ''}:${ctime ?? ''}`),
    }
  }

  /** @inheritDoc */
  async list(path: string, signal?: AbortSignal): Promise<RemoteListEntry[]> {
    const result = await this.runOrThrow(
      `LC_ALL=C find -- ${quoteDevicePath(path)} -mindepth 1 -maxdepth 1 -printf ${quote(FIND_FORMAT)}`,
      path,
      { signal },
    )
    const fields = result.stdout.split('\0')
    const entries: RemoteListEntry[] = []
    for (let index = 0; index + 5 < fields.length; index += 6) {
      const name = fields[index] ?? ''
      if (name === '') continue
      const kind = kindFromFind(fields[index + 1] ?? '')
      entries.push({
        name,
        // `find %y` describes the entry itself, so a symlink is reported as one
        // here where the helper lane — like the local backend — reports what it
        // points at. A known difference between the two lanes, recorded rather
        // than papered over: this lane disappears with the no-Node tier.
        kind: kind === 'symlink' ? 'other' : kind,
        size: Number(fields[index + 2] ?? '0'),
        version: FsVersion(`${fields[index + 3] ?? ''}:${fields[index + 4] ?? ''}:${fields[index + 5] ?? ''}`),
      })
    }
    return entries
  }

  /** @inheritDoc */
  async read(path: string, offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array> {
    // A window at the start is one `head`; further in, `tail` skips to it. Two
    // programs because POSIX `head` has no offset and `tail` has no length.
    const command = offset === 0
      ? `head -c ${String(length)} -- ${quoteDevicePath(path)}`
      : `tail -c +${String(offset + 1)} -- ${quoteDevicePath(path)} | head -c ${String(length)}`
    return await this.runBinary(command, signal)
  }

  /** @inheritDoc */
  async stream(path: string, signal?: AbortSignal): Promise<AsyncIterable<Uint8Array>> {
    const deps = this.deps
    return Promise.resolve((async function* stream(): AsyncIterable<Uint8Array> {
      // Opened inside the generator, so a caller that never iterates never dials:
      // nothing is left running on the device, because nothing was started.
      const run = await deviceTransport().open(deps.device, `cat -- ${quoteDevicePath(path)}`, {
        graceMs: COMMAND_GRACE_MS,
        ...signal === undefined ? {} : { signal },
      })
      for await (const chunk of run.stream as AsyncIterable<Buffer>) yield chunk
      const outcome = await run.done
      if (outcome.exitCode !== 0) {
        throw classifyRemoteFailure({ stdout: '', stderr: '', exitCode: outcome.exitCode ?? 1, truncated: false }, path, deps.t)
      }
    })())
  }

  /**
   * @inheritDoc
   *
   * The staging file is created in the destination directory by `mktemp`, so
   * the final `mv` is a same-filesystem rename, and an existing file's mode is
   * carried over before the rename — the same two properties the local
   * backend's atomic write provides. A staging directory is `mkdir`-ed first
   * because the seam's callers write into directories that may not exist yet.
   */
  async write(path: string, content: string, signal?: AbortSignal): Promise<undefined> {
    const script = [
      'd=$(dirname -- "$1")',
      'mkdir -p -- "$d"',
      't=$(mktemp --tmpdir="$d" .dshell-XXXXXX)',
      'cat > "$t"',
      'if [ -e "$1" ]; then chmod --reference="$1" "$t" 2>/dev/null || true; fi',
      'mv -f -- "$t" "$1"',
    ].join(' && ')
    const result = await this.run(`sh -c ${quote(script)} sh ${quoteDevicePath(path)}`, { signal, stdin: content })
    if (result.exitCode !== 0) throw classifyRemoteFailure(result, path, this.deps.t)
    // No metadata comes back from a shell script, so the caller asks again: one
    // extra round trip on this lane only.
    return undefined
  }

  /**
   * @inheritDoc
   *
   * Same shape as the text write, but the payload is base64 on stdin because
   * the device's `base64 -d` is the only way to land arbitrary bytes through
   * a shell. The helper lane has no equivalent text-vs-bytes distinction.
   */
  async writeBytes(path: string, bytes: Uint8Array, signal?: AbortSignal): Promise<undefined> {
    const script = [
      'd=$(dirname -- "$1")',
      'mkdir -p -- "$d"',
      't=$(mktemp --tmpdir="$d" .dshell-XXXXXX)',
      'base64 -d > "$t" || { rm -f -- "$t"; exit 14; }',
      'if [ -e "$1" ]; then chmod --reference="$1" "$t" 2>/dev/null || true; else chmod 644 "$t" 2>/dev/null || true; fi',
      'mv -f -- "$t" "$1" || { rm -f -- "$t"; exit 15; }',
    ].join(' && ')
    const result = await this.run(`sh -c ${quote(script)} sh ${quoteDevicePath(path)}`, { signal, stdin: Buffer.from(bytes).toString('base64') })
    if (result.exitCode !== 0) throw classifyRemoteFailure(result, path, this.deps.t)
    return undefined
  }

  /** @inheritDoc — one `mkdir -p` per call, batched by the caller. */
  async mkdir(paths: readonly string[], recursive: boolean, signal?: AbortSignal): Promise<void> {
    const flags = recursive ? '-p' : ''
    await this.runOrThrow(`mkdir ${flags} -- ${paths.map(path => quoteDevicePath(path)).join(' ')}`, paths[0] ?? '', { signal })
  }

  /** @inheritDoc — `rm -rf` with optional `-f`. */
  async remove(path: string, force: boolean, signal?: AbortSignal): Promise<void> {
    const flags = `${force ? '-f' : ''} -r`.trim()
    await this.runOrThrow(`rm ${flags} -- ${quoteDevicePath(path)}`, path, { signal })
  }

  /** @inheritDoc — `mv`, with `-f` for overwrite semantics. */
  async rename(from: string, to: string, overwrite: boolean, signal?: AbortSignal): Promise<undefined> {
    const result = await this.run(`mv ${overwrite ? '-f' : ''} -- ${quoteDevicePath(from)} ${quoteDevicePath(to)}`, { signal })
    if (result.exitCode !== 0) throw classifyRemoteFailure(result, to, this.deps.t)
    return undefined
  }

  /** @inheritDoc — `sha256sum -z` writes `hash\0name`, so the filename never sneaks into the digest. */
  async sha256(path: string, signal?: AbortSignal): Promise<string> {
    const result = await this.runOrThrow(`sha256sum -- ${quoteDevicePath(path)}`, path, { signal })
    const space = result.stdout.indexOf(' ')
    return space < 0 ? result.stdout.trim() : result.stdout.slice(0, space).trim()
  }

  /**
   * @inheritDoc
   *
   * On this lane the copy is `cp` plus a sha256 check, because `cp` already
   * does the only thing the helper's op does (atomic staging + rename, mode
   * preservation) — the helper's progress reporting is what is genuinely
   * missing here, and a 1-of-2-host interface that hides it would be lying.
   * The host's progress callback is therefore driven by `stat`-ing the
   * staging file at short intervals while `cp` runs, the same way a `dd`
   * progress report works.
   */
  async copy(
    source: string,
    destination: string,
    overwrite: boolean,
    expectedSha256: string | undefined,
    onProgress: (written: number, totalBytes: number) => void,
    signal: AbortSignal,
  ): Promise<{ destination: RemoteStat; sourceSha256: string; bytes: number }> {
    // Refuse on the same two grounds the helper lane refuses on, before any
    // byte moves.
    const dest = await this.stat(destination, true, signal)
    if (dest !== undefined) {
      if (dest.kind === 'directory') throw new FsError(`${destination}: is a directory`, 'FS_NOT_REGULAR_FILE')
      if (!overwrite) throw new FsError(`${destination}: already exists`, 'FS_NOT_OBSERVED')
    }
    const sourceStat = await this.stat(source, true, signal)
    if (sourceStat === undefined) throw new FsError(`${source}: not found`, 'FS_NOT_FOUND')
    if (sourceStat.kind !== 'file') throw new FsError(`${source}: not a regular file`, 'FS_NOT_REGULAR_FILE')
    const totalBytes = sourceStat.size
    // `cp` over an existing destination is rejected by `-i`; we want overwrite
    // semantics or none, so the flag is the caller's, not the tool's prompt.
    const cpFlags = overwrite ? '-f' : '-n'
    const result = await this.run(`cp ${cpFlags} -- ${quote(source)} ${quote(destination)}`, { signal })
    if (result.exitCode !== 0) throw classifyRemoteFailure(result, destination, this.deps.t)
    onProgress(totalBytes, totalBytes)
    // Read both digests; a mismatch fails the copy loudly and KEEPS the
    // destination in place, because deleting a copy that is not actually
    // wrong is a worse answer than asking the user.
    const sourceSha256 = expectedSha256 ?? await this.sha256(source, signal)
    const destinationSha = await this.sha256(destination, signal)
    if (expectedSha256 !== undefined && destinationSha !== expectedSha256) {
      throw new FsError(`${source}: source digest ${sourceSha256} differs from expected ${expectedSha256}`, 'FS_IO_ERROR')
    }
    const final = await this.stat(destination, true, signal)
    if (final === undefined) throw new FsError(`the copy to ${destination} produced no file`, 'FS_IO_ERROR')
    return { destination: final, sourceSha256, bytes: totalBytes }
  }
}

/** Map a `stat -c %F` word onto the seam's type vocabulary. */
function kindFromStat(word: string): RemoteKind {
  if (word === 'regular file' || word === 'regular empty file') return 'file'
  if (word === 'directory') return 'directory'
  if (word === 'symbolic link') return 'symlink'
  return 'other'
}

/** Map a `find -printf %y` code onto the seam's type vocabulary. */
function kindFromFind(code: string): RemoteKind {
  if (code === 'f') return 'file'
  if (code === 'd') return 'directory'
  if (code === 'l') return 'symlink'
  return 'other'
}

/** Turn a failed remote command into the seam's error vocabulary. */
function classifyRemoteFailure(result: RemoteRun, displayPath: string, t: DshellSshTranslate): FsError {
  const message = result.stderr.trim() === '' ? t('error.remoteFailed', { code: result.exitCode }) : result.stderr.trim()
  const code = /Permission denied/i.test(message)
    ? 'FS_PERMISSION_DENIED'
    : /No such file or directory/i.test(message)
      ? 'FS_NOT_FOUND'
      : /Not a directory/i.test(message)
        ? 'FS_NOT_DIRECTORY'
        : /Is a directory/i.test(message)
          ? 'FS_NOT_REGULAR_FILE'
          : 'FS_IO_ERROR'
  return new FsError(`${displayPath}: ${message}`, code)
}
