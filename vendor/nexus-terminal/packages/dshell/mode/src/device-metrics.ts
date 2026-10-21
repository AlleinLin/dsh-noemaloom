/**
 * The device resource route: what machine a session runs on, and how loaded it
 * is right now.
 *
 * The session decides the machine, never the other way round. A session bound
 * to an SSH device runs there, so its numbers are the device's — asking this
 * process instead is the failure the router already documents at length
 * ("treating the second as the first is how a device session's file operations
 * end up on this machine"), and the same rule applies here. So the router seat
 * is asked first, and a session that is bound to a device we cannot reach
 * reports *no reading* rather than falling back to the local one.
 *
 * How each machine is read differs, and the difference is the whole reason the
 * two paths share a parser instead of a transport:
 *
 *  - This machine is read in process, from `/proc` where it exists and from
 *    `node:os` where it does not. No subprocess, no poll tax — the reader is
 *    looking at a header, and a header must not cost a fork per second.
 *  - A device is asked with ONE `bash -c` over the shell seam, which is the
 *    same seam the completion oracle and the PATH probe use, so the session's
 *    world is chosen by the host's own routing and nothing here has to know
 *    that ssh exists.
 *
 * Both emit the same three records — cumulative CPU counters, core count,
 * memory in kilobytes — and are parsed by {@link parseCounters}. CPU is a
 * DELTA between two readings of those cumulative counters, so the route keeps
 * the previous one per session; that is also what makes a cached answer
 * honest, since a delta against a stale sample would report an interval the
 * reader never waited through.
 */

import { readFileSync } from 'node:fs'
import { cpus, loadavg, freemem, totalmem } from 'node:os'
import type { Agent } from '@deepseek-ai/dsh-agent'
// Type-only: pulls the agent service merge (`ctx.agents.withInitiator`), which is
// what tells the shell router WHICH session's world to answer for.
import type {} from '@deepseek-ai/dsh-agent'
// Type-only: pulls the session-controller merge (`ctx.sessionController`).
import type {} from '@deepseek-ai/dsh-api-session-controller'
// Type-only: pulls the shell service merge (`ctx.get('shell')`), the seam a
// device is asked through.
import type {} from '@deepseek-ai/dsh-shell'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  DshellCpuReading, DshellDeviceIdentity, DshellDeviceMetrics, DshellDeviceMetricsResponse,
} from './device-metrics-protocol.js'
import { DSHELL_DEVICE_METRICS_PATH } from './device-metrics-protocol.js'

/**
 * How long one answer is reused.
 *
 * Long enough that two readers of the same session (the chip re-rendering, a
 * second window) share one probe — on a device that is one ssh round trip —
 * and short enough that it is never more than one poll interval stale.
 */
const ANSWER_TTL_MS = 2_000

/** How long a probe may take before the row gives up on this tick. */
const PROBE_TIMEOUT_MS = 4_000

/** Bytes a probe may return: three short records, not a file listing. */
const PROBE_STDOUT_BYTES = 8 * 1024

/** Sessions whose state is kept; past this the oldest is dropped on access. */
const MAX_TRACKED_SESSIONS = 200

/** Cumulative counters, as one machine reported them. */
interface MachineCounters {
  /** Busy + idle jiffies since boot; the pair a delta is taken from. */
  readonly cpuTotal: number
  readonly cpuIdle: number
  readonly cores: number
  /** `MemTotal` and `MemAvailable`, in kilobytes. */
  readonly memTotalKb: number
  readonly memAvailableKb: number
  readonly load1: number | undefined
}

/** What one session's route remembers between two polls. */
interface SessionSample {
  /** The last counters read, for the next delta; absent until the second poll. */
  readonly previous: MachineCounters | undefined
  /** The last answer, within {@link ANSWER_TTL_MS}. */
  readonly answer: DshellDeviceMetrics | undefined
  readonly answeredAt: number
  /** The last refusal, so a device that stays unreachable is not re-asked. */
  readonly failure: string | undefined
  readonly failedAt: number
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

/** Read a whole file, or undefined when it is absent or unreadable. */
function slurp(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * The three records, as `awk` emits them on a device.
 *
 * Printed rather than read piecewise because the seam returns one stdout: three
 * labelled lines are the smallest thing that survives a round trip without the
 * reader having to guess where one file ended.
 */
const DEVICE_PROBE = [
  "awk '/^cpu[0-9]/{n++} /^cpu /{t=0; for(i=2;i<=NF;i++) t+=$i; printf \"cpu %d %d\\n\", t, $5+$6} END{printf \"cores %d\\n\", n+0}' /proc/stat",
  "awk '/^MemTotal:/{t=$2} /^MemAvailable:/{a=$2} END{printf \"mem %d %d\\n\", t+0, a+0}' /proc/meminfo",
  "awk 'NR==1{printf \"load %s\\n\", $1}' /proc/loadavg",
].join('; ')

/**
 * Parse the records both paths produce.
 *
 * Strict about what it accepts: a counter that does not parse is dropped
 * rather than turned into a zero, because a zero here is indistinguishable
 * from an idle machine and would be reported as one.
 */
function parseCounters(text: string): MachineCounters | undefined {
  let cpuTotal: number | undefined
  let cpuIdle: number | undefined
  let cores: number | undefined
  let memTotalKb: number | undefined
  let memAvailableKb: number | undefined
  let load1: number | undefined
  for (const raw of text.split('\n')) {
    const parts = raw.trim().split(/\s+/)
    if (parts.length < 2) continue
    switch (parts[0]) {
      case 'cpu':
        cpuTotal = Number(parts[1])
        cpuIdle = Number(parts[2])
        break
      case 'cores':
        cores = Number(parts[1])
        break
      case 'mem':
        memTotalKb = Number(parts[1])
        memAvailableKb = Number(parts[2])
        break
      case 'load':
        load1 = Number(parts[1])
        break
      default:
        break
    }
  }
  if (cpuTotal === undefined || cpuIdle === undefined) return undefined
  if (!Number.isFinite(cpuTotal) || !Number.isFinite(cpuIdle)) return undefined
  return {
    cpuTotal,
    cpuIdle,
    cores: cores !== undefined && Number.isFinite(cores) ? cores : cpus().length,
    memTotalKb: memTotalKb ?? Math.round(totalmem() / 1024),
    memAvailableKb: memAvailableKb ?? Math.round(freemem() / 1024),
    load1: load1 !== undefined && Number.isFinite(load1) ? load1 : loadavg()[0],
  }
}

/** Memory, preferring the kernel's reclaimable figure over a bare free count. */
function memCounters(): { memTotalKb: number; memAvailableKb: number } {
  const mem = slurp('/proc/meminfo')
  const total = mem === undefined ? undefined : /^MemTotal:\s+(\d+)/m.exec(mem)
  const available = mem === undefined ? undefined : /^MemAvailable:\s+(\d+)/m.exec(mem)
  return {
    memTotalKb: total === null || total === undefined ? Math.round(totalmem() / 1024) : Number(total[1]),
    memAvailableKb: available === null || available === undefined
      ? Math.round(freemem() / 1024)
      : Number(available[1]),
  }
}

/** The one-minute load average, which every platform publishes in some form. */
function loadCounter(): { load1: number } {
  const load = slurp('/proc/loadavg')
  const first = load === undefined ? undefined : Number(load.split(/\s+/)[0])
  return { load1: first !== undefined && Number.isFinite(first) ? first : loadavg()[0] }
}

/**
 * This machine's counters, in process, with no subprocess to pay for.
 *
 * The aggregate `cpu` line is summed here rather than handed to
 * {@link parseCounters}: that line's fields are the per-state jiffies
 * (user, nice, system, idle, iowait, …), so its first two numbers are not the
 * total and the idle share, and a parser expecting the labelled device records
 * would read them as if they were.
 */
function localCounters(): MachineCounters {
  const stat = slurp('/proc/stat')
  const fields = stat === undefined ? undefined : /^cpu\s+(.*)$/m.exec(stat)?.[1]
  if (fields !== undefined) {
    const states = fields.trim().split(/\s+/).map(Number)
    const total = states.reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0)
    const idle = (states[3] ?? 0) + (states[4] ?? 0)
    if (total > 0) {
      const perCore = (stat?.match(/^cpu\d+/gm) ?? []).length
      return {
        cpuTotal: total,
        cpuIdle: idle,
        cores: perCore > 0 ? perCore : cpus().length,
        ...memCounters(),
        ...loadCounter(),
      }
    }
  }
  // No `/proc` (Windows, or a container without it mounted): memory and cores
  // still come from the platform, and CPU usage stays undefined rather than
  // being guessed from a load average that reads zero there anyway.
  return {
    cpuTotal: 0, cpuIdle: 0, cores: cpus().length,
    ...memCounters(),
    ...loadCounter(),
  }
}

/**
 * One device's counters, asked through the shell seam.
 *
 * The command runs as the session, so the host's own routing decides whether
 * that means this machine or an `ssh` line — which is why nothing here reads
 * the device table or builds a command line. Read-only, because a header
 * reading has no business writing anything on a machine the reader may not
 * even be logged into.
 *
 * `workdir` is a directory on THIS machine, never the device's own root: the
 * shell seam speaks the local path space and translates what it is given
 * through the session's mount mapping, so the device's root handed to it is
 * read as a local path — `~` against this process's cwd, then re-based through
 * the session's directory — and lands on a directory that exists on neither
 * machine. The mount is the local stand-in the mapping translates straight
 * back to the device's root; a binding without one has nothing to translate
 * and the seam answers with the root whatever is asked.
 */
async function deviceCounters(
  ctx: Context,
  agent: Agent,
  workdir: string | undefined,
): Promise<MachineCounters | string> {
  // `ctx.get('shell')` and NOT `ctx.shell`: the property accessor is gated by
  // an `inject` declaration this package does not make, and the failure would
  // be invisible here — the catch below would turn it into "the device said
  // nothing". `dshell-files` reads the same seam the same way.
  const shell = ctx.get('shell')
  if (shell === undefined) return '这台组合没有 shell 服务，问不到设备'
  try {
    // The WHOLE run lives inside the initiator boundary, `execute` included.
    // The boundary is an AsyncLocalStorage scope, and the spawn happens in
    // `execute` — one call later and outside the scope the router sees no
    // session at all, answers with a local `bash` whose workdir is the device's
    // root, and the probe dies on a directory that exists only there.
    return await ctx.agents.withInitiator(agent, async () => {
      const spec = await shell.resolve({
        command: `bash -c ${shq(DEVICE_PROBE)} dshell-metrics`,
        workdir,
        timeoutMs: PROBE_TIMEOUT_MS,
        stdoutMaxBytes: PROBE_STDOUT_BYTES,
        sandboxPolicy: { mode: 'read-only', workspaceRoot: workdir ?? process.cwd() },
      })
      const result = await (await shell.execute(spec)).result()
      return parseCounters(result.stdout.text) ?? '设备没有返回可解析的读数'
    })
  } catch (reason) {
    return reason instanceof Error ? reason.message : String(reason)
  }
}

/**
 * Busy share between two readings of the same machine's counters.
 *
 * Returns undefined on the FIRST reading of a machine and whenever the interval
 * carried no elapsed jiffies — a counter that went backwards (a device that
 * rebooted between two polls) is not a delta, and dividing by it would report
 * a wild number that looks like a real reading.
 */
function busyShare(previous: MachineCounters | undefined, now: MachineCounters): number | undefined {
  if (previous === undefined) return undefined
  const elapsed = now.cpuTotal - previous.cpuTotal
  if (!Number.isFinite(elapsed) || elapsed <= 0) return undefined
  const idle = now.cpuIdle - previous.cpuIdle
  if (!Number.isFinite(idle) || idle < 0) return undefined
  return Math.min(1, Math.max(0, (elapsed - idle) / elapsed))
}

/** Turn counters plus the machine's name into the answer the chip draws. */
function toMetrics(
  device: DshellDeviceIdentity,
  counters: MachineCounters,
  used: number | undefined,
  at: number,
): DshellDeviceMetrics {
  const cpu: DshellCpuReading = { used, cores: counters.cores, load1: counters.load1 }
  return {
    device,
    cpu,
    memory: {
      total: Math.max(0, counters.memTotalKb) * 1024,
      used: Math.max(0, counters.memTotalKb - counters.memAvailableKb) * 1024,
    },
    at,
  }
}

/** What one session's route needs from the host. */
export interface DeviceMetricsRouteDeps {
  /** The device router, when the composition has one. */
  readonly routing?: (() => SshRoutingSeat | undefined) | undefined
}

/**
 * Bind the route to one host context.
 *
 * The per-session sample table lives here rather than in a service because the
 * route is its only reader: the delta has to survive between two polls of the
 * same session and nothing else has a reason to hold a machine's counters.
 */
export function createDeviceMetricsRoute(ctx: Context, deps: DeviceMetricsRouteDeps = {}): ConnectionFetchRoute {
  const samples = new Map<string, SessionSample>()

  function sampleFor(sessionId: string): SessionSample {
    const existing = samples.get(sessionId)
    if (existing !== undefined) return existing
    // Bounded, because a session id is a uuid and a long-lived host will
    // outlive enough of them to matter. Oldest first, by the same rule the
    // command list uses.
    while (samples.size >= MAX_TRACKED_SESSIONS) {
      const oldest = samples.keys().next()
      if (oldest.done === true) break
      samples.delete(oldest.value)
    }
    const created: SessionSample = {
      previous: undefined, answer: undefined, answeredAt: 0, failure: undefined, failedAt: 0,
    }
    samples.set(sessionId, created)
    return created
  }

  async function read(sessionId: string, now: number): Promise<DshellDeviceMetricsResponse> {
    const sample = sampleFor(sessionId)
    if (sample.answer !== undefined && now - sample.answeredAt < ANSWER_TTL_MS) {
      return { metrics: sample.answer }
    }
    if (sample.failure !== undefined && now - sample.failedAt < ANSWER_TTL_MS) {
      return { error: sample.failure }
    }

    const routing = deps.routing?.()
    const target = routing?.targetForSession(sessionId)
    if (target === undefined) {
      // Bound to a device that cannot be served is NOT the same as bound to
      // nothing: the second means "this machine", the first means "we would
      // report the wrong machine's numbers". Refuse rather than guess.
      if (routing?.assignmentForSession(sessionId) !== undefined) {
        const error = '会话绑定的设备当前不可达'
        samples.set(sessionId, { ...sample, failure: error, failedAt: now })
        return { error }
      }
      const counters = localCounters()
      const answer = toMetrics({ kind: 'local' }, counters, busyShare(sample.previous, counters), now)
      samples.set(sessionId, { ...sample, previous: counters, answer, answeredAt: now, failure: undefined, failedAt: 0 })
      return { metrics: answer }
    }

    const identity: DshellDeviceIdentity = {
      kind: 'device',
      name: target.device.name,
      endpoint: `${target.device.user}@${target.device.host}:${String(target.device.port)}`,
    }
    const resolved = await ctx.sessionController.resolveAgent(SessionId(sessionId))
    if ('error' in resolved) return { error: `会话不可用：${resolved.error.code}` }
    const probed = await deviceCounters(ctx, resolved.agent, target.mount)
    if (typeof probed === 'string') {
      samples.set(sessionId, { ...sample, failure: probed, failedAt: now })
      return { error: probed }
    }
    const answer = toMetrics(identity, probed, busyShare(sample.previous, probed), now)
    samples.set(sessionId, { ...sample, previous: probed, answer, answeredAt: now, failure: undefined, failedAt: 0 })
    return { metrics: answer }
  }

  return {
    path: DSHELL_DEVICE_METRICS_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const sessionId = new URL(request.url).searchParams.get('session') ?? ''
        const body = sessionId.length === 0
          ? { error: '缺少会话 id' } satisfies DshellDeviceMetricsResponse
          : await read(sessionId, Date.now())
        return new Response(JSON.stringify(body), {
          status: body.error === undefined ? 200 : 400,
          headers: { 'content-type': 'application/json' },
        })
      } catch (reason) {
        const error = reason instanceof Error ? reason.message : String(reason)
        return new Response(JSON.stringify({ error } satisfies DshellDeviceMetricsResponse), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        })
      }
    },
  }
}
