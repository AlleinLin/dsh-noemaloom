/**
 * The device resource route: which machine a session's numbers describe, and
 * what happens when that machine cannot be asked.
 *
 * The claims here are about ROUTING, not about arithmetic. Any host can compute
 * a CPU percentage; the question these specs pin down is whose CPU it is, and
 * that is decided in exactly one place — whether the router seat claims the
 * session. So the local path is exercised against the real `/proc` of whatever
 * machine runs the suite (its figures are checked for shape, never for a
 * particular value), and the device path against a shell seam that records what
 * it was asked to run.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { createDeviceMetricsRoute, type SshRoutingSeat } from '../src/device-metrics.js'
import {
  DSHELL_DEVICE_METRICS_PATH, type DshellDeviceMetricsResponse,
} from '../src/device-metrics-protocol.js'
import {
  cpuPercent, deviceMetricsSeat, memoryAmount, memoryPair,
} from '../src/client/device-metrics.js'
import { setDevicePollMs } from '../src/client/device-poll.js'
import { DEVICE_POLL_CHOICES, DEVICE_POLL_DEFAULT } from '../src/settings.js'

/**
 * The initiator boundary, modelled the way the host models it.
 *
 * `withInitiator` is an AsyncLocalStorage scope, and a spawn inside it is what
 * tells the ssh router which session asked. A fake that merely calls the
 * operation cannot see the difference between "the whole run ran inside the
 * boundary" and "only `resolve` did" — and that difference is the whole bug
 * this suite exists to keep out.
 */
const initiators = new AsyncLocalStorage<unknown>()

/** What a fake shell seam recorded, so a spec can assert on the probe itself. */
interface Probe {
  readonly command: string
  readonly workdir: string
  readonly sandboxMode: unknown
}

/** Whether one `execute` ran inside the initiator boundary the route opened. */
interface Run {
  readonly insideBoundary: boolean
}

/**
 * A host context with just the three seams this route reaches.
 *
 * `get('shell')` is the structural read the route uses rather than a declared
 * `ctx.shell`, so a fake only has to answer `get`.
 */
function host(services: Record<string, unknown>, probes: Probe[] = [], runs: Run[] = []): Context {
  const agents = {
    withInitiator: <T,>(agent: unknown, run: () => T): T => initiators.run(agent, run),
  }
  const sessionController = {
    resolveAgent: async (id: string) => ({ agent: { id, session: { header: { cwd: '/home/u' } } } }),
  }
  const all: Record<string, unknown> = {
    ...services,
    shell: {
      resolve: async (request: Record<string, unknown>) => {
        probes.push({
          command: String(request.command),
          workdir: String(request.workdir),
          sandboxMode: (request.sandboxPolicy as { mode: string }).mode,
        })
        return { spec: true }
      },
      execute: async () => {
        // Recorded at execute, not at resolve: the spawn the router sees happens
        // here, one call after the boundary would have closed.
        runs.push({ insideBoundary: initiators.getStore() !== undefined })
        return { result: async () => ({ stdout: { text: nextStdout } }) }
      },
    },
    agents,
    sessionController,
  }
  return {
    get: (name: string) => all[name],
    agents,
    sessionController,
  } as unknown as Context
}

afterEach(() => {
  vi.useRealTimers()
  nextStdout = ''
})

/** The stdout the next `execute` answers with; set by each device case. */
let nextStdout = ''

/** A router seat over one session's answers. */
function routing(over: {
  bound?: boolean
  reachable?: boolean
} = {}): SshRoutingSeat {
  const bound = over.bound ?? true
  const reachable = over.reachable ?? true
  return {
    targetForSession: () => bound && reachable
      ? {
        device: { name: 'build-box', host: '10.0.0.9', port: 22, user: 'dev' },
        remoteRoot: '/srv/work',
        mount: '/mnt/build-box',
      }
      : undefined,
    assignmentForSession: () => (bound ? { sessionId: 's1', deviceId: 'd1' } : undefined),
  }
}

/** One GET through the route, decoded. */
async function call(
  ctx: Context, seat?: SshRoutingSeat, sessionId = 's1',
): Promise<{ status: number; body: DshellDeviceMetricsResponse }> {
  const route = createDeviceMetricsRoute(ctx, seat === undefined ? {} : { routing: () => seat })
  const query = sessionId === '' ? '' : `?session=${sessionId}`
  const response = await route.fetch(new Request(`http://host${DSHELL_DEVICE_METRICS_PATH}${query}`))
  return { status: response.status, body: await response.json() as DshellDeviceMetricsResponse }
}

describe('a session that runs on this machine', () => {
  it('answers with this machine, and no probe at all', async () => {
    const probes: Probe[] = []
    const { status, body } = await call(host({}, probes), routing({ bound: false }))

    expect(status).toBe(200)
    expect(body.metrics?.device.kind).toBe('local')
    // Nothing was spawned: the whole point of reading in process.
    expect(probes).toEqual([])
    expect(body.metrics?.cpu.cores).toBeGreaterThan(0)
    expect(body.metrics?.memory.total).toBeGreaterThan(0)
    expect(body.metrics?.memory.used).toBeLessThanOrEqual(body.metrics?.memory.total ?? 0)
  })

  it('has no share to report on a first reading, and replays inside the TTL', async () => {
    // One route across both polls: the previous counters live in its closure,
    // and a first reading has no interval to divide by. The delta itself is
    // pinned by the device cases below, where the counters can be chosen — real
    // `/proc` jiffies do not move under a mocked clock, so a local delta can
    // only ever be asserted for shape, not for a value.
    const seat = routing({ bound: false })
    const route = createDeviceMetricsRoute(host({}), { routing: () => seat })
    const poll = async (): Promise<DshellDeviceMetricsResponse> => await route
      .fetch(new Request(`http://host${DSHELL_DEVICE_METRICS_PATH}?session=s1`))
      .then(async response => await response.json() as DshellDeviceMetricsResponse)

    const first = await poll()
    expect(first.metrics?.cpu.used).toBeUndefined()

    // A second reader inside the TTL is answered from the first reading, which
    // is what keeps two chips on one session to one probe.
    const replayed = await poll()
    expect(replayed.metrics?.at).toBe(first.metrics?.at)
  })

  it('is the answer in a composition with no router at all', async () => {
    const { body } = await call(host({}))
    expect(body.metrics?.device.kind).toBe('local')
  })
})

describe('a session bound to a device', () => {
  it('reads the DEVICE, through the shell seam, as the session', async () => {
    const probes: Probe[] = []
    nextStdout = 'cpu 900 300\ncores 8\nmem 16316360 8000000\nload 1.75\n'
    const seat = routing()
    const { status, body } = await call(host({}, probes), seat)

    expect(status).toBe(200)
    expect(body.metrics?.device).toEqual({
      kind: 'device', name: 'build-box', endpoint: 'dev@10.0.0.9:22',
    })
    expect(body.metrics?.cpu.cores).toBe(8)
    expect(body.metrics?.cpu.load1).toBe(1.75)
    expect(body.metrics?.memory.total).toBe(16_316_360 * 1024)
    expect(body.metrics?.memory.used).toBe((16_316_360 - 8_000_000) * 1024)

    expect(probes).toHaveLength(1)
    // Read-only: a header reading has no business writing on a machine the
    // reader may not even be logged into.
    expect(probes[0]?.sandboxMode).toBe('read-only')
    // The LOCAL stand-in, not the device's root: the seam translates this
    // through the session's mapping, and a device path handed to it is read as
    // a local one — `~` against this process's cwd, re-based through the
    // session's directory — landing on a directory that exists nowhere.
    expect(probes[0]?.workdir).toBe('/mnt/build-box')
  })

  it('runs the probe as the session, with the boundary still open at the spawn', async () => {
    // The boundary is an AsyncLocalStorage scope and the spawn happens in
    // `execute`, one call after `resolve`. Closing it around `resolve` alone
    // leaves the router blind at the spawn: it answers with a local `bash`
    // whose workdir is the device's root, and the probe dies on a directory
    // that exists only there. The reading that comes back looks like a device
    // that said nothing, which is how this stayed invisible for so long.
    const runs: Run[] = []
    nextStdout = 'cpu 900 300\ncores 8\nmem 16316360 8000000\nload 1.75\n'
    const { status } = await call(host({}, [], runs), routing())

    expect(status).toBe(200)
    expect(runs).toEqual([{ insideBoundary: true }])
  })

  it('refuses to answer with this machine when the device cannot be reached', async () => {
    const probes: Probe[] = []
    const { status, body } = await call(host({}, probes), routing({ reachable: false }))

    // The distinction that matters: "bound to nothing" means this machine, and
    // "bound to something out of reach" must never be reported as this machine.
    expect(status).toBe(400)
    expect(body.metrics).toBeUndefined()
    expect(body.error).toContain('不可达')
    expect(probes).toEqual([])
  })

  it('reports a probe that said nothing as no reading, not as an idle machine', async () => {
    nextStdout = 'bash: awk: command not found\n'
    const { status, body } = await call(host({}), routing())

    expect(status).toBe(400)
    expect(body.metrics).toBeUndefined()
    expect(body.error).toBeTruthy()
  })

  it('reports the share between two readings, not a share of one', async () => {
    const seat = routing()
    const route = createDeviceMetricsRoute(host({}), { routing: () => seat })
    const poll = async (): Promise<DshellDeviceMetricsResponse> => await route
      .fetch(new Request(`http://host${DSHELL_DEVICE_METRICS_PATH}?session=s1`))
      .then(async response => await response.json() as DshellDeviceMetricsResponse)

    nextStdout = 'cpu 100 60\ncores 4\nmem 1000 400\nload 0.50\n'
    vi.useFakeTimers()
    expect((await poll()).metrics?.cpu.used).toBeUndefined()

    // 200-100 = 100 jiffies elapsed, of which 40 were idle: 60% busy. Divided
    // by the running total instead, the same pair would read as 50%.
    vi.advanceTimersByTime(5_000)
    nextStdout = 'cpu 200 100\ncores 4\nmem 1000 400\nload 0.50\n'
    expect((await poll()).metrics?.cpu.used).toBeCloseTo(0.6, 5)
  })

  it('reports no share when the counters went backwards', async () => {
    // A device that rebooted between two polls reports a delta that is not an
    // interval, and dividing by it would produce a number that looks real.
    const seat = routing()
    const route = createDeviceMetricsRoute(host({}), { routing: () => seat })
    const poll = async (): Promise<DshellDeviceMetricsResponse> => await route
      .fetch(new Request(`http://host${DSHELL_DEVICE_METRICS_PATH}?session=s1`))
      .then(async response => await response.json() as DshellDeviceMetricsResponse)

    nextStdout = 'cpu 900 400\ncores 4\nmem 1000 400\nload 0.50\n'
    vi.useFakeTimers()
    await poll()
    vi.advanceTimersByTime(5_000)
    nextStdout = 'cpu 12 6\ncores 4\nmem 1000 400\nload 0.10\n'
    expect((await poll()).metrics?.cpu.used).toBeUndefined()
  })

  it('reads memory off the kernel rather than off the free-page count', async () => {
    nextStdout = 'cpu 100 50\ncores 2\nmem 1000 400\nload 0.10\n'
    const { body } = await call(host({}), routing())
    // 400 of 1000 available means 600 used, not the 0 a bare MemFree would give.
    expect(body.metrics?.memory.used).toBe(600 * 1024)
  })
})

describe('the route itself', () => {
  it('refuses a request that names no session', async () => {
    const { status, body } = await call(host({}), routing({ bound: false }), '')
    expect(status).toBe(400)
    expect(body.error).toContain('会话')
  })
})

describe('the interval setting', () => {
  it('offers a ladder, and a value off it reads as the default', () => {
    expect(DEVICE_POLL_CHOICES).toContain(DEVICE_POLL_DEFAULT)
    // The card cannot spell an interval the poller has no branch for, and a
    // document that names one must not leave the poller on a cadence nothing
    // else can read back.
    expect(new Set(DEVICE_POLL_CHOICES).size).toBe(DEVICE_POLL_CHOICES.length)
    expect([...DEVICE_POLL_CHOICES].every(ms => ms >= 1000)).toBe(true)
  })

})

describe('how the row prints a reading', () => {
  it('rounds a share to whole percent, and dashes one it does not have', () => {
    expect(cpuPercent({ used: 0.134, cores: 8, load1: 1 })).toBe('13%')
    expect(cpuPercent({ used: 0, cores: 8, load1: 0 })).toBe('0%')
    expect(cpuPercent({ used: 1, cores: 2, load1: 3 })).toBe('100%')
    expect(cpuPercent({ used: undefined, cores: 8, load1: 0 })).toBe('—')
  })

  it('switches from megabytes to gigabytes at the boundary that matters', () => {
    expect(memoryAmount(512 * 1024 ** 2)).toBe('512 MB')
    expect(memoryAmount(1024 ** 3)).toBe('1.0 GB')
    expect(memoryAmount(15.5 * 1024 ** 3)).toBe('15.5 GB')
  })

  it('prints memory as used of total', () => {
    expect(memoryPair({ used: 3.5 * 1024 ** 3, total: 16 * 1024 ** 3 })).toBe('3.5 GB / 16.0 GB')
  })
})

describe('the shared seat', () => {
  /** One answer per call, so a spec can count how many requests it caused. */
  function stubHost(reply: () => DshellDeviceMetricsResponse): { calls: string[] } {
    const calls: string[] = []
    vi.stubGlobal('fetch', (url: string) => {
      calls.push(String(url))
      return Promise.resolve(new Response(JSON.stringify(reply()), {
        headers: { 'content-type': 'application/json' },
      }))
    })
    return { calls }
  }

  /** One machine's reading, as the host would answer for it. */
  function reading(kind: 'local' | 'device'): DshellDeviceMetricsResponse {
    return {
      metrics: {
        device: kind === 'device'
          ? { kind, name: 'build-box', endpoint: 'dev@10.0.0.9:22' }
          : { kind },
        cpu: { used: 0.25, cores: 8, load1: 1 },
        memory: { total: 16 * 1024 ** 3, used: 4 * 1024 ** 3 },
        at: 1000,
      },
    }
  }

  it('costs one request per session however many chips are watching it', async () => {
    vi.useFakeTimers()
    const { calls } = stubHost(() => reading('local'))
    const first = deviceMetricsSeat.watch('s-shared')
    const second = deviceMetricsSeat.watch('s-shared')
    // The watch reads on the way in, so both callers have a number immediately.
    await vi.advanceTimersByTimeAsync(0)
    expect(deviceMetricsSeat.getSnapshot().has('s-shared')).toBe(true)
    expect(calls).toHaveLength(1)
    first()
    second()
  })

  it('keeps polling while one reader is left, and stops when the last one goes', async () => {
    vi.useFakeTimers()
    const { calls } = stubHost(() => reading('local'))
    const first = deviceMetricsSeat.watch('s-refcount')
    const second = deviceMetricsSeat.watch('s-refcount')
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toHaveLength(1)

    first()
    await vi.advanceTimersByTimeAsync(DEVICE_POLL_DEFAULT)
    expect(calls.length).toBeGreaterThan(1)
    const whileRead = calls.length

    second()
    await vi.advanceTimersByTimeAsync(10_000)
    // Nothing is watching any more, so the tick has nothing to ask about.
    expect(calls).toHaveLength(whileRead)
  })

  it('paces both worlds by the chosen interval, not by what the world costs', async () => {
    // One setting, one cadence. The two-tier scheme this replaced hid a cost
    // the reader cannot see — a device tick is an ssh round trip, and picking a
    // slower interval for it was the poller making that decision alone.
    vi.useFakeTimers()
    const { calls } = stubHost(() => reading('device'))
    const stop = deviceMetricsSeat.watch('s-paced')
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(DEVICE_POLL_DEFAULT - 1000)
    expect(calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(calls.length).toBeGreaterThan(1)
    stop()
  })

  it('re-arms at the new interval the moment the setting changes', async () => {
    vi.useFakeTimers()
    const { calls } = stubHost(() => reading('local'))
    const stop = deviceMetricsSeat.watch('s-rearm')
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toHaveLength(1)

    // 60s would never arrive inside this test's clock; the old 5s timer would
    // have polled twice by now. Re-arming is what makes the choice live.
    setDevicePollMs(60_000)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(calls).toHaveLength(1)

    setDevicePollMs(2000)
    await vi.advanceTimersByTimeAsync(2000)
    expect(calls.length).toBeGreaterThan(1)
    stop()
  })

  it('publishes a refusal as the row content, not as a blank', async () => {
    vi.useFakeTimers()
    stubHost(() => ({}))
    const stop = deviceMetricsSeat.watch('s-blank')
    await vi.advanceTimersByTimeAsync(0)
    expect(deviceMetricsSeat.getSnapshot().get('s-blank')?.error).toBeTruthy()
    stop()
  })
})
