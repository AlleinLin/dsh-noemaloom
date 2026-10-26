/**
 * The device detail route: what is running on the machine a session is bound to.
 *
 * The metrics route reads the machine's load; this one reads what is ON it —
 * the processes, the containers, the sockets. Both are asked the same way, and
 * the way is the point:
 *
 *  - The SESSION decides the machine, never the other way round. A session
 *    bound to an SSH device runs there, so its processes are the device's, and
 *    asking this process instead would be a confident lie.
 *  - The device is asked with ONE `bash -c` over the shell seam, so the
 *    session's world is chosen by the host's own routing and nothing here has
 *    to know that ssh exists.
 *  - The answer is read from LABELLED records, because the seam returns one
 *    stdout: `proc`, `ctr` and `port` lines, each self-describing, so a
 *    section that could not be read is absent rather than half-parsed.
 *
 * The three lists degrade separately, because each can be missing for its own
 * reason — a machine with no `ps`, one with no container runtime, one with
 * neither `ss` nor `netstat`. A reader is told which, instead of being shown an
 * empty list that reads like "there are none".
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
// Type-only: pulls the agent service merge (`ctx.agents.withInitiator`), which is
// what tells the shell router WHICH session's world to answer for.
import type {} from '@deepseek-ai/dsh-agent'
// Type-only: pulls the session-controller merge (`ctx.sessionController`).
import type {} from '@deepseek-ai/dsh-api-session-controller'
// Type-only: pulls the shell service merge (`ctx.get('shell')`), the seam a device
// is asked through.
import type {} from '@deepseek-ai/dsh-shell'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { DshellDeviceIdentity } from './device-metrics-protocol.js'
import type {
  DshellContainerInfo, DshellDeviceDetail, DshellDeviceNoteCode, DshellPortInfo, DshellProcessInfo,
} from './device-detail-protocol.js'
import { DSHELL_DEVICE_DETAIL_PATH } from './device-detail-protocol.js'

/** How long a probe may take before the panel gives up on this tick. */
const PROBE_TIMEOUT_MS = 8_000

/** Bytes a probe may return: a process list, a container list and a socket list. */
const PROBE_STDOUT_BYTES = 24 * 1024

/**
 * The probe, as one shell word.
 *
 * Each section announces itself before and after, so an empty section is told
 * apart from a section that was never reached: `begin`/`end` around the rows,
 * and a `note` inside when the machine has no tool for that list.
 *
 * The tools are asked by their EXIT STATUS, not by whether they are on the
 * PATH: `command -v docker` is happy on a machine whose daemon is not running,
 * and a runtime that cannot answer is not the same as a runtime with nothing
 * to show. So each list is captured first, the status is read from that
 * capture, and only a failing tool produces a note — an empty list means the
 * machine really has none.
 */
const DEVICE_DETAIL_PROBE = [
  "echo 'begin processes'",
  // Nine fields, and the last one takes the rest of the line: the whole command
  // line is the one field that may hold spaces, and a fixed field count would
  // cut it in half.
  "rows=$(ps -eo pid=,ppid=,user=,stat=,etimes=,pcpu=,pmem=,comm=,args= 2>/dev/null); rc=$?",
  "if [ $rc -ne 0 ] || [ -z \"$rows\" ]; then echo 'note no-ps'; else printf '%s\\n' \"$rows\" | head -n 200 | awk '{a=\"\"; for(i=9;i<=NF;i++) a=a (i>9?\" \":\"\") $i; printf \"proc %s|%s|%s|%s|%s|%s|%s|%s|%s\\n\", $1, $2, $3, $4, $5, $6, $7, $8, a}'; fi",
  "echo 'end processes'",
  "echo 'begin containers'",
  "rows=$(docker ps --format '{{.ID}}|{{.Image}}|{{.Names}}|{{.Status}}' 2>/dev/null); rc=$?",
  "if [ $rc -ne 0 ]; then rows=$(podman ps --format '{{.ID}}|{{.Image}}|{{.Names}}|{{.Status}}' 2>/dev/null); rc=$?; fi",
  "if [ $rc -ne 0 ]; then echo 'note no-container-runtime'; else printf '%s\\n' \"$rows\" | head -n 40 | awk -F'|' '{printf \"ctr %s|%s|%s|%s\\n\", $1, $2, $3, $4}'; fi",
  "echo 'end containers'",
  "echo 'begin ports'",
  // `-p` is what says WHO holds a socket: a port with no owner is a port
  // nobody can forward, so the owner belongs in the answer.
  "rows=$(ss -tulnpH 2>/dev/null); rc=$?; tool=ss",
  "if [ $rc -ne 0 ]; then rows=$(netstat -tulnp 2>/dev/null); rc=$?; tool=netstat; fi",
  "if [ $rc -ne 0 ]; then rows=$(netstat -tuln 2>/dev/null); rc=$?; tool=netstat; fi",
  // `ss` and `netstat` put the local address in different columns and the owner
  // in a different shape, so each tool gets its own reading of its own line.
  "if [ $rc -ne 0 ]; then echo 'note no-socket-tool'; elif [ \"$tool\" = ss ]; then printf '%s\\n' \"$rows\" | head -n 200 | awk '{n=\"\"; p=\"\"; if (match($7, /\\(\"[^\"]+\"/)) n=substr($7, RSTART+2, RLENGTH-3); if (match($7, /pid=[0-9]+/)) p=substr($7, RSTART+4, RLENGTH-4); printf \"port %s|%s|%s|%s\\n\", $1, $5, n, p}'; else printf '%s\\n' \"$rows\" | head -n 200 | awk 'NR>2 {n=\"\"; p=\"\"; if (NF>=7) { split($7, a, \"/\"); p=a[1]; n=(a[2]!=\"\"?a[2]:\"\") } printf \"port %s|%s|%s|%s\\n\", $1, $4, n, p}'; fi",
  "echo 'end ports'",
].join('; ')

/**
 * Quote one word for `sh`.
 *
 * The device probe is a script, so it has to reach the far shell as ONE word.
 * The seam has no argv form to pass it in, which is why every script-shaped
 * command in dshell quotes its own body the same way.
 */
function shq(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`
}

/**
 * The command the probe runs as.
 *
 * Exported because the probe is a thing worth running on its own: the script
 * it carries is a shell script, and a shell script is only proven by a shell.
 * The one that runs here is the one the route runs.
 */
export function deviceDetailProbeCommand(): string {
  return `bash -c ${shq(DEVICE_DETAIL_PROBE)} dshell-device-detail`
}

/** What one probe's output says. */
export interface DshellDeviceDetailSections {
  readonly processes: readonly DshellProcessInfo[]
  readonly containers: readonly DshellContainerInfo[]
  readonly ports: readonly DshellPortInfo[]
  readonly notes: readonly DshellDeviceNoteCode[]
}

/** A number, or undefined when the field is not one. */
function num(text: string | undefined): number | undefined {
  // An EMPTY field is not a zero: `Number('')` is 0, and a port with no owner
  // would be reported as owned by process 0.
  if (text === undefined || text.trim() === '') return undefined
  const value = Number(text)
  return Number.isFinite(value) ? value : undefined
}

/**
 * The address part of a listening socket, without the brackets around it.
 *
 * `ss` brackets an address that carries colons of its own, and a scoped one
 * puts the interface AFTER the bracket: `[fe80::c22:feff:fefe:ad52]%veth0`.
 * The brackets are notation, not part of the address, and the scope id is part
 * of it — so the bracket pair goes and the rest stays.
 */
function parseAddress(raw: string): string {
  if (!raw.startsWith('[')) return raw
  const close = raw.indexOf(']')
  if (close === -1) return raw.slice(1)
  return raw.slice(1, close) + raw.slice(close + 1)
}

/**
 * One listening socket, from the `address:port` the tools print.
 *
 * The address may itself contain colons — IPv6 prints `[::]:22` — so the split
 * is at the LAST colon, and the brackets are dropped afterwards.
 */
function parsePort(proto: string, local: string): DshellPortInfo | undefined {
  const cut = local.lastIndexOf(':')
  if (cut <= 0) return undefined
  const port = num(local.slice(cut + 1))
  if (port === undefined) return undefined
  if (proto !== 'tcp' && proto !== 'udp') return undefined
  return { proto, port, address: parseAddress(local.slice(0, cut)) }
}

/**
 * The probe's output, as the three lists and the notes.
 *
 * Strict about what it accepts: a row that does not parse is dropped rather
 * than turned into zeros, because a zero here is indistinguishable from an
 * idle process and would be reported as one.
 */
export function parseDeviceDetail(text: string): DshellDeviceDetailSections {
  const processes: DshellProcessInfo[] = []
  const containers: DshellContainerInfo[] = []
  const ports: DshellPortInfo[] = []
  const notes: DshellDeviceNoteCode[] = []
  const seen = new Set<string>()
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line.length === 0) continue
    const space = line.indexOf(' ')
    if (space === -1) continue
    const kind = line.slice(0, space)
    const rest = line.slice(space + 1).trim()
    switch (kind) {
      case 'begin':
        seen.add(rest)
        break
      case 'proc': {
        // Nine fields, the last of which is the whole command line: it may
        // hold a separator of its own, so it takes the rest of the record.
        const parts = rest.split('|')
        if (parts.length < 9) break
        const pid = num(parts[0])
        const ppid = num(parts[1])
        const cpu = num(parts[5])
        const memory = num(parts[6])
        if (pid === undefined || ppid === undefined || cpu === undefined || memory === undefined) break
        const elapsed = num(parts[4])
        processes.push({
          pid,
          ppid,
          cpu,
          memory,
          command: parts[7] ?? '',
          user: parts[2] === '' ? undefined : parts[2],
          state: parts[3] === '' ? undefined : parts[3],
          elapsedSeconds: elapsed,
          args: parts.slice(8).join('|'),
        })
        break
      }
      case 'ctr': {
        // The four fields are separated by a PIPE, not by spaces: an image may
        // be named "my image:1", and a space-separated read would shift every
        // field after it.
        const parts = rest.split('|')
        if (parts.length < 4) break
        containers.push({
          id: parts[0] ?? '',
          image: parts[1] ?? '',
          name: parts[2] ?? '',
          state: parts.slice(3).join('|'),
        })
        break
      }
      case 'port': {
        // proto | address | owner-name | owner-pid
        const parts = rest.split('|')
        if (parts.length < 2) break
        const parsed = parsePort(parts[0] ?? '', parts[1] ?? '')
        if (parsed === undefined) break
        const ownerPid = num(parts[3])
        ports.push({
          ...parsed,
          processName: parts[2] === undefined || parts[2] === '' ? undefined : parts[2],
          processPid: ownerPid,
        })
        break
      }
      case 'note': {
        // The note names the section it stands for, and it is printed INSIDE
        // that section — so the section is reported, and this says why it is
        // empty.
        if (rest === 'no-ps') notes.push('no-ps')
        else if (rest === 'no-container-runtime') notes.push('no-container-runtime')
        else if (rest === 'no-socket-tool') notes.push('no-socket-tool')
        break
      }
      default:
        break
    }
  }
  // A section the machine never mentioned is not an empty section.
  if (!seen.has('processes')) notes.push('processes-unreported')
  if (!seen.has('containers')) notes.push('containers-unreported')
  if (!seen.has('ports')) notes.push('ports-unreported')
  return { processes, containers, ports, notes }
}

/**
 * The router seat, read structurally.
 *
 * dshell-ssh is optional and this package must not depend on its bundle: a
 * composition without it simply has no seat, which is indistinguishable from
 * "every session runs here" — the correct reading. This is the same structural
 * read `dshell-files` makes for the same reason.
 */
export interface SshRoutingSeat {
  targetForSession(sessionId: string):
  | {
      device: { name: string; host: string; port: number; user: string }
      remoteRoot: string
      /** The local stand-in for the device tree, when the binding has one. */
      mount?: string | undefined
    }
  | undefined
  /** The stored binding, whether or not the device can be served. */
  assignmentForSession(sessionId: string): unknown | undefined
}

/** What one session's route needs from the host. */
export interface DeviceDetailRouteDeps {
  /** The device router, when the composition has one. */
  readonly routing?: (() => SshRoutingSeat | undefined) | undefined
}

/**
 * One device's snapshot, asked through the shell seam.
 *
 * The command runs as the session, so the host's own routing decides whether
 * that means this machine or an `ssh` line — which is why nothing here reads
 * the device table or builds a command line. Read-only, because a panel
 * reading has no business writing anything on a machine the reader may not
 * even be logged into.
 *
 * `workdir` is a directory on THIS machine, never the device's own root: the
 * shell seam speaks the local path space and translates what it is given
 * through the session's mount mapping.
 */
async function deviceDetail(
  ctx: Context,
  agent: Agent,
  workdir: string | undefined,
): Promise<DshellDeviceDetailSections | string> {
  // `ctx.get('shell')` and NOT `ctx.shell`: the property accessor is gated by an
  // `inject` declaration this package does not make, and the failure would be
  // invisible here — the catch below would turn it into "the device said
  // nothing".
  const shell = ctx.get('shell')
  if (shell === undefined) return '这台组合没有 shell 服务，问不到设备'
  try {
    // The WHOLE run lives inside the initiator boundary, `execute` included.
    // The boundary is an AsyncLocalStorage scope, and the spawn happens in
    // `execute` — one call later and outside the scope the router sees no
    // session at all and answers with a local shell.
    return await ctx.agents.withInitiator(agent, async () => {
      const spec = await shell.resolve({
        command: deviceDetailProbeCommand(),
        workdir,
        timeoutMs: PROBE_TIMEOUT_MS,
        stdoutMaxBytes: PROBE_STDOUT_BYTES,
        sandboxPolicy: { mode: 'read-only', workspaceRoot: workdir ?? process.cwd() },
      })
      const result = await (await shell.execute(spec)).result()
      return parseDeviceDetail(result.stdout.text)
    })
  } catch (reason) {
    return reason instanceof Error ? reason.message : String(reason)
  }
}

/**
 * Bind the route to one host context.
 *
 * The route is per session because the machine is: a request names a session
 * and the answer describes that session's machine.
 */
export function createDeviceDetailRoute(ctx: Context, deps: DeviceDetailRouteDeps = {}): ConnectionFetchRoute {
  async function read(sessionId: string): Promise<{ detail?: DshellDeviceDetail; error?: string }> {
    const routing = deps.routing?.()
    const target = routing?.targetForSession(sessionId)
    if (target === undefined) {
      // Bound to a device that cannot be served is NOT the same as bound to
      // nothing: the second means "this machine", the first means "we would
      // report the wrong machine's processes". Refuse rather than guess.
      if (routing?.assignmentForSession(sessionId) !== undefined) {
        return { error: '会话绑定的设备当前不可达' }
      }
      const identity: DshellDeviceIdentity = { kind: 'local' }
      return {
        detail: {
          device: identity,
          processes: [],
          containers: [],
          ports: [],
          notes: ['processes-unreported', 'containers-unreported', 'ports-unreported'],
          at: Date.now(),
        },
      }
    }

    const identity: DshellDeviceIdentity = {
      kind: 'device',
      name: target.device.name,
      endpoint: `${target.device.user}@${target.device.host}:${String(target.device.port)}`,
    }
    const resolved = await ctx.sessionController.resolveAgent(SessionId(sessionId))
    if ('error' in resolved) return { error: `会话不可用：${resolved.error.code}` }
    const probed = await deviceDetail(ctx, resolved.agent, target.mount)
    if (typeof probed === 'string') return { error: probed }
    return {
      detail: {
        device: identity,
        processes: probed.processes,
        containers: probed.containers,
        ports: probed.ports,
        notes: probed.notes,
        at: Date.now(),
      },
    }
  }

  return {
    path: DSHELL_DEVICE_DETAIL_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const sessionId = new URL(request.url).searchParams.get('session') ?? ''
        const body = sessionId.length === 0
          ? { error: '缺少会话 id' }
          : await read(sessionId)
        return new Response(JSON.stringify(body), {
          status: 'error' in body ? 400 : 200,
          headers: { 'content-type': 'application/json' },
        })
      } catch (reason) {
        const error = reason instanceof Error ? reason.message : String(reason)
        return new Response(JSON.stringify({ error }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        })
      }
    },
  }
}
