/**
 * The subprocess seam: where a device session's processes actually leave.
 *
 * dshell routes by wrapping one service method rather than by replacing a
 * provider, because a device binding is per *session* while a service provider
 * is per *context* — the reason upstream's ssh family cannot be adopted
 * wholesale. `ctx.subprocess.spawn` is the funnel every local process already
 * passes through, so a bound session's spawn is answered here. It is wrapped on
 * the prototype that owns the method, for the same reason the shell seam is: a
 * prototype method is reached identically through `ctx.subprocess` and
 * `ctx.get('subprocess')`.
 *
 * Three outcomes, in order of preference:
 *
 * 1. **RPC**, when a verified helper connection exists and the caller asked for
 *    a shape it can serve. The command travels as argv; nothing is assembled.
 * 2. **A channel on the device's pooled connection**, otherwise — one channel
 *    per process, running the same `cd … && exec …` line the assembled path
 *    always used. This is what the whole package did before this milestone, and
 *    it is also the tier a device without Node falls back to.
 * 3. **The caller's own spawn**, for a session with no assignment at all.
 *
 * The choice is made per call, so a device whose helper is not up yet — or was
 * never installed — behaves exactly as it did before this milestone rather than
 * failing.
 *
 * Paths in results need no translation: the command runs with the device
 * directory as its working directory, so a tool that prints relative paths
 * prints them relative to the same tree its input named.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type { SubprocessHandle, SubprocessRuntime, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { SshRouter } from './router.js'
import { quote } from './shell-quote.js'
import { mappingFor, remoteDirFor } from './mount.js'
import { DshellSshConnections, localHelperArtifact } from './connection.js'
import type { DshellSshConnection } from './connection.js'
import { HelperTargets } from './helper/target.js'
import { RemoteProcess, supportsStdio } from './remote-process.js'
import { DeviceSubprocessHandle } from './channel-process.js'
import { deviceTransport } from './transport/transport.js'

/**
 * The device's own ripgrep.
 *
 * The search tool resolves an absolute path in the *host's* world, which the
 * device cannot execute, so the program is renamed to a bare `rg` and the
 * device resolves it from its own PATH. Missing it is a setup fact rather than
 * a search error, so say which one it is instead of letting the platform report
 * a bare "no such file".
 */
const MISSING_RG = 'dshell-ssh: the device has no rg (ripgrep) on PATH; glob and grep run there'

/**
 * The one method this module replaces, typed structurally: `spawn` is
 * synchronous and returns a handle, which is what lets a device process be
 * reported to a caller that knows nothing about where it runs.
 */
interface SubprocessShape {
  spawn(this: unknown, spec: SubprocessSpawnSpec): SubprocessHandle
}

/**
 * How the DEVICE should name a program the caller resolved for the host.
 *
 * `undefined` means "not translatable" — an absolute host path whose device
 * equivalent we do not know. Those take the channel lane, where the device
 * reports its own error. Renaming on a guess would silently run a *different*
 * program than the caller named, which is worse than failing.
 *
 * @param program - the caller's `argv[0]`.
 * @returns the device-side program name, or undefined when unknown.
 */
export function deviceProgram(program: string): string | undefined {
  // The last segment, split on BOTH separators and by this module rather than
  // by `node:path`: the device is a POSIX machine whatever the host is, so the
  // name it answers to cannot depend on the host's path rules. `basename` on a
  // POSIX host leaves `C:\…\rg.exe` whole, and the name would then be read
  // differently on the two hosts.
  const name = (program.split(/[/\\]/u).pop() ?? program).replace(/\.exe$/iu, '')
  // The search tool's resolver produces either `rg` (the platform package) or
  // the single-file runtime's `<executable>-rg` sidecar; both mean the device's.
  if (name === 'rg' || name.endsWith('-rg')) return 'rg'
  // A bare name is the device's to resolve from its own PATH. A PATH is not:
  // the device cannot execute a location in the HOST's filesystem, and a
  // location handed over as if it were a name would run whatever happens to
  // carry that name on the device — or nothing at all.
  //
  // BOTH platforms' separators are tested, because a check for '/' alone let
  // a Windows path through as a bare name: `C:\Windows\System32\cmd.exe` has
  // no forward slash, so it was sent to the device verbatim and died there
  // with an ENOENT that named the host's own directory.
  if (program.includes('/') || program.includes('\\')) return undefined
  return program
}

/**
 * Install the subprocess seam.
 *
 * Also owns the helper's lifetime: the connection pool and the target cache are
 * created here because this is the only place that uses them, and the router is
 * told about device changes so a saved, deleted or newly bound device does not
 * keep a stale answer — or a connection nobody will close.
 *
 * @param ctx - host context holding the subprocess service.
 * @param router - device assignments.
 * @returns disposer restoring the original method and closing the pool.
 */
export function installSpawnRouting(ctx: Context, router: SshRouter): () => void {
  const subprocess: SubprocessRuntime | undefined = ctx.get('subprocess')
  if (subprocess === undefined) return () => {}
  const connections = new DshellSshConnections()
  const targets = new HelperTargets(localHelperArtifact)
  // The filesystem provider reaches the helper through the router, because the
  // pool's lifetime belongs to this seam: a second pool would mean a second
  // helper process on the device.
  router.helperConnection = deviceId => connections.peek(deviceId)
  // A device that changed, or one a session was just bound to. Saving or
  // deleting drops both cached answers and any live connection, because that
  // connection was verified against a target which no longer applies.
  router.onDeviceChanged = (deviceId, event) => {
    targets.drop(deviceId)
    void connections.release(deviceId)
    if (event !== 'bound') return
    // Warm on bind so the first tool call usually finds a helper already there.
    // Nothing depends on it — the seam falls back on its own — so a failure is
    // only logged.
    void (async () => {
      const device = router.deviceFor(deviceId)
      if (device === undefined) return
      // Where the device's home is, remembered by the router: a `~`-spelled
      // session root has to become an absolute device path, and the device is
      // the only party that knows what its own `~` means. Asked before the
      // target, because the home is an answer even for a device with no Node.
      router.noteDeviceRoot(deviceId, await targets.home(device))
      const target = await targets.resolve(device)
      if (target === undefined) return
      await connections.forDevice(device, target)
    })().catch((error: unknown) => {
      ctx.logger.info(`dshell-ssh: no helper on "${deviceId}" yet (${error instanceof Error ? error.message : String(error)})`)
    })
  }
  let owner = Object.getPrototypeOf(subprocess) as Record<string, unknown> | null
  while (owner !== null && !Object.prototype.hasOwnProperty.call(owner, 'spawn')) {
    owner = Object.getPrototypeOf(owner) as Record<string, unknown> | null
  }
  if (owner === null) return () => {}
  const target = owner as unknown as SubprocessShape
  const original = target.spawn
  target.spawn = function spawn(this: unknown, spec: SubprocessSpawnSpec): SubprocessHandle {
    const agent = ctx.agents.currentInitiator()
    const assignment = agent === undefined ? undefined : router.targetForSession(String(agent.id))
    if (assignment === undefined) {
      // A session bound to a device that cannot be served has no local half:
      // spawning here would run a device session's process on this machine,
      // which is the same refusal the shell seam raises (see
      // `installShellRouting`), at the seam where the process actually leaves.
      const bound = agent === undefined ? undefined : router.assignmentForSession(String(agent.id))
      if (bound !== undefined) throw new Error(router.unservableMessage(bound.deviceId))
      return original.call(this, spec)
    }
    // The channel lane: the same remote line the assembled path used, over a
    // channel on the device's pooled connection instead of over a local `ssh`
    // process. There is no recursion guard to write here any more — nothing in
    // this package spawns a local ssh client, so no argv can name one.
    const directory = remoteDirectory(assignment, spec.cwd, agent?.session.header.cwd)
    const program = deviceProgram(spec.argv[0] ?? '')
    const connection: DshellSshConnection | undefined = connections.peek(assignment.device.id)
    if (connection !== undefined && program !== undefined && supportsStdio(spec)) {
      return new RemoteProcess(connection, { ...spec, cwd: directory }, {
        program,
        // Preserve the diagnostic the channel lane produces: the same cause
        // arrives here as a platform error object instead of a message.
        describeStartFailure: (name, error) => name === 'rg' && /ENOENT/u.test(error.message)
          ? new Error(MISSING_RG, { cause: error })
          : error,
      })
    }
    // The line uses the DEVICE's name for the program where we know it. Running
    // the caller's absolute host path would fail on the device, which is what
    // the rg-only special case existed to avoid; generalizing it here keeps the
    // no-helper tier behaving the way it did before this milestone.
    const legacyArgv = program === undefined ? spec.argv : [program, ...spec.argv.slice(1)]
    const line = `cd ${shellDir(directory)} && exec ${legacyArgv.map(quote).join(' ')}`
    return new DeviceSubprocessHandle(deviceTransport().open(assignment.device, line, {
      graceMs: spec.graceMs,
      ...spec.signal === undefined ? {} : { signal: spec.signal },
      // The transport closes stdin for a command that asked for no input, writes
      // and closes it for a batch payload, and leaves it open for a pipe.
      ...typeof spec.stdio.stdin === 'object' ? { stdin: spec.stdio.stdin.data } : {},
      ...spec.stdio.stdin === 'pipe' ? { openStdin: true } : {},
    }), spec)
  }
  return () => {
    target.spawn = original
    router.onDeviceChanged = undefined
    router.helperConnection = undefined
    void connections.disposeAll()
    deviceTransport().releaseAll()
  }
}

/**
 * Render a device directory as the remote shell should read it.
 *
 * A `~`-spelled root is deliberately kept as a spelling (see
 * `absoluteRemoteRoot`): the far shell expands it, wherever the command runs.
 * Quoting the whole word defeats exactly that — `cd '~'` asks for a directory
 * literally named `~`, which no machine has, and every command on a
 * `~`-rooted device without a helper died on it. So the tilde stays OUTSIDE
 * the quotes and only the rest is quoted, which the shell still expands:
 * `cd ~/'my app'` is the home directory's `my app`.
 *
 * @param directory - the device directory, as `remoteDirectory` produced it.
 * @returns the word to put after `cd` in the assembled line.
 */
export function shellDir(directory: string): string {
  if (directory === '~') return '~'
  if (!directory.startsWith('~/')) return quote(directory)
  return `~/${quote(directory.slice(2))}`
}

/**
 * The caller's directory in the device's path space.
 *
 * A tool resolves a relative path against the session's own directory, which is
 * the local mount standing in for the device tree — or, for a session pointed at
 * a device after its creation, a local directory that stands for nothing there
 * and is translated as the session's root instead (see `mappingFor`). An
 * absolute path the model gave is already a device path. A binding without a
 * mount (written before mounts existed) has nothing to translate and uses the
 * device's root.
 *
 * @param assignment - the session's device, remote root and mount.
 * @param workdir - the caller's directory.
 * @param sessionCwd - the directory the harness recorded for the session.
 * @returns the directory the process should run in, on the device.
 */
function remoteDirectory(
  assignment: { remoteRoot: string; mount: string | undefined },
  workdir: string,
  sessionCwd: string | undefined,
): string {
  // `targetForSession` has already resolved the root against the device, so
  // this only has to decide whether the caller's directory can be translated.
  const mapping = mappingFor(assignment, sessionCwd)
  return mapping === undefined ? assignment.remoteRoot : remoteDirFor(mapping, workdir)
}
