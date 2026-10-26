/**
 * The device detail route: what is running on the machine a session is bound to.
 *
 * Two claims are pinned down here. The first is ROUTING: whose processes are
 * these, and that is decided in exactly one place — whether the router seat
 * claims the session. The second is PARSING: a machine answers with labelled
 * lines over one stdout, and a line that does not parse has to be dropped
 * rather than turned into zeros, because a zero here is indistinguishable
 * from an idle process.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { createDeviceDetailRoute, deviceDetailProbeCommand, parseDeviceDetail, type SshRoutingSeat } from '../src/device-detail.js'
import {
  DSHELL_DEVICE_DETAIL_PATH, type DshellDeviceDetailResponse,
} from '../src/device-detail-protocol.js'

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

/** The stdout the next `execute` answers with. */
let nextStdout = ''

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
): Promise<{ status: number; body: DshellDeviceDetailResponse }> {
  const route = createDeviceDetailRoute(ctx, seat === undefined ? {} : { routing: () => seat })
  const query = sessionId === '' ? '' : `?session=${sessionId}`
  const response = await route.fetch(new Request(`http://host${DSHELL_DEVICE_DETAIL_PATH}${query}`))
  return { status: response.status, body: await response.json() as DshellDeviceDetailResponse }
}

/** A device that reports one of everything. */
const FULL_REPORT = [
  'begin processes',
  'proc 4211|1|root|S|1200|12.5|3.4|node|node server.js --port 8080',
  'proc 4212|4211|root|R|600|0.5|0.2|bash|bash',
  'end processes',
  'begin containers',
  'ctr 9f2ab1|nginx:latest|web|Up 3 hours',
  'end containers',
  'begin ports',
  'port tcp|0.0.0.0:22|sshd|812',
  'port tcp|127.0.0.1:8080|nginx|4242',
  'end ports',
].join('\n')

describe('what a machine says about itself', () => {
  it('is read as three lists', () => {
    const parsed = parseDeviceDetail(FULL_REPORT)

    expect(parsed.processes).toEqual([
      {
        pid: 4211,
        ppid: 1,
        cpu: 12.5,
        memory: 3.4,
        command: 'node',
        user: 'root',
        state: 'S',
        elapsedSeconds: 1200,
        args: 'node server.js --port 8080',
      },
      {
        pid: 4212,
        ppid: 4211,
        cpu: 0.5,
        memory: 0.2,
        command: 'bash',
        user: 'root',
        state: 'R',
        elapsedSeconds: 600,
        args: 'bash',
      },
    ])
    expect(parsed.containers).toEqual([
      { id: '9f2ab1', image: 'nginx:latest', name: 'web', state: 'Up 3 hours' },
    ])
    expect(parsed.ports).toEqual([
      { proto: 'tcp', port: 22, address: '0.0.0.0', processName: 'sshd', processPid: 812 },
      { proto: 'tcp', port: 8080, address: '127.0.0.1', processName: 'nginx', processPid: 4242 },
    ])
    expect(parsed.notes).toEqual([])
  })

  it('says who holds a port, and which process it is', () => {
    // A port with no owner is a port nobody can forward, so the owner belongs
    // in the answer.
    const parsed = parseDeviceDetail('begin ports\nport tcp|0.0.0.0:443|nginx|99\nend ports\n')

    expect(parsed.ports[0]?.processName).toBe('nginx')
    expect(parsed.ports[0]?.processPid).toBe(99)
  })

  it('keeps a port whose owner the platform would not say', () => {
    const parsed = parseDeviceDetail('begin ports\nport udp|127.0.0.1:68||\nend ports\n')

    expect(parsed.ports).toHaveLength(1)
    expect(parsed.ports[0]?.processName).toBeUndefined()
    expect(parsed.ports[0]?.processPid).toBeUndefined()
  })

  it('drops a row it cannot read, rather than reporting zeros', () => {
    const parsed = parseDeviceDetail([
      'begin processes',
      'proc not-a-pid|1|root|S|10|0.5|0.2|node|node',
      'proc 42|1|root|S|10|0.5|0.2|node|node',
      'end processes',
    ].join('\n'))

    expect(parsed.processes).toHaveLength(1)
    expect(parsed.processes[0]?.pid).toBe(42)
  })

  it('says which list it could not read', () => {
    const parsed = parseDeviceDetail([
      'begin processes',
      'note no-ps',
      'end processes',
      'begin containers',
      'note no-container-runtime',
      'end containers',
      'begin ports',
      'note no-socket-tool',
      'end ports',
    ].join('\n'))

    expect(parsed.notes).toEqual(['no-ps', 'no-container-runtime', 'no-socket-tool'])
  })

  it('says a list was never reported, rather than showing it as empty', () => {
    // A machine that answered with half a script: the process section is simply
    // not there, and "no processes" would be a lie about a machine that has
    // plenty of them.
    const parsed = parseDeviceDetail('begin containers\nend containers\n')

    expect(parsed.notes).toEqual(['processes-unreported', 'ports-unreported'])
    expect(parsed.containers).toEqual([])
  })

  it('reads an IPv6 socket, whose address carries colons of its own', () => {
    const parsed = parseDeviceDetail('begin ports\nport tcp|[::]:8080\nend ports\n')

    expect(parsed.ports).toEqual([{ proto: 'tcp', port: 8080, address: '::', processName: undefined, processPid: undefined }])
  })

  it('reads a scoped IPv6 socket, whose interface sits after the bracket', () => {
    // `ss` prints `[fe80::c22:feff:fefe:ad52]%vethc180014:123`: the brackets
    // are notation and the scope is part of the address, so the address is
    // neither "[...]%veth" (unclosed) nor "...]%veth" (a broken address).
    const parsed = parseDeviceDetail('begin ports\nport udp|[fe80::c22:feff:fefe:ad52]%vethc180014:123\nend ports\n')

    expect(parsed.ports).toEqual([
      { proto: 'udp', port: 123, address: 'fe80::c22:feff:fefe:ad52%vethc180014' },
    ])
  })

  it('reads a container whose image name carries a space', () => {
    // The four fields are pipe-separated precisely because an image may be
    // named "my image:1" — a space-separated read would shift every field
    // after the image and report a name that was never printed.
    const parsed = parseDeviceDetail([
      'begin containers',
      'ctr 9f2ab1|my image:1|web|Up 3 hours',
      'end containers',
    ].join('\n'))

    expect(parsed.containers).toEqual([
      { id: '9f2ab1', image: 'my image:1', name: 'web', state: 'Up 3 hours' },
    ])
  })

  it('reads a process whose command name carries a space', () => {
    const parsed = parseDeviceDetail([
      'begin processes',
      'proc 4211|1|root|S|10|12.5|3.4|Web Content|/Applications/Web Content.app/Contents/MacOS/Web Content',
      'end processes',
    ].join('\n'))

    expect(parsed.processes).toEqual([
      {
        pid: 4211,
        ppid: 1,
        cpu: 12.5,
        memory: 3.4,
        command: 'Web Content',
        user: 'root',
        state: 'S',
        elapsedSeconds: 10,
        args: '/Applications/Web Content.app/Contents/MacOS/Web Content',
      },
    ])
  })
})

describe('a session bound to a device', () => {
  it('is asked for its processes, containers and sockets', async () => {
    nextStdout = FULL_REPORT
    const probes: Probe[] = []
    const { status, body } = await call(host({}, probes), routing())

    expect(status).toBe(200)
    expect(body.detail?.device.kind).toBe('device')
    expect(body.detail?.device.name).toBe('build-box')
    expect(body.detail?.processes).toHaveLength(2)
    expect(body.detail?.containers).toHaveLength(1)
    expect(body.detail?.ports).toHaveLength(2)
  })

  it('is asked with ONE read-only command, in the device\'s own mount', async () => {
    nextStdout = FULL_REPORT
    const probes: Probe[] = []
    await call(host({}, probes), routing())

    expect(probes).toHaveLength(1)
    expect(probes[0]?.command.startsWith('bash -c ')).toBe(true)
    // The workdir is a directory on THIS machine: the seam speaks the local
    // path space and translates what it is given through the mount mapping.
    expect(probes[0]?.workdir).toBe('/mnt/build-box')
    expect(probes[0]?.sandboxMode).toBe('read-only')
  })

  it('is asked with the production probe itself, quoted as one shell word', async () => {
    nextStdout = FULL_REPORT
    const probes: Probe[] = []
    await call(host({}, probes), routing())

    expect(probes[0]?.command).toBe(deviceDetailProbeCommand())
    // The probe carries awk programs in single quotes, so the quoting has to
    // survive the trip as an escaped quote — a lost one turns the script into
    // a syntax error on the far machine.
    expect(probes[0]?.command).toContain('\'\\\'\'')
  })

  it('is asked INSIDE the initiator boundary, or the spawn sees no session', async () => {
    nextStdout = FULL_REPORT
    const runs: Run[] = []
    await call(host({}, [], runs), routing())

    expect(runs).toHaveLength(1)
    expect(runs[0]?.insideBoundary).toBe(true)
  })

  it('refuses rather than report this machine\'s processes', async () => {
    const { status, body } = await call(host({}), routing({ reachable: false }))

    expect(status).toBe(400)
    expect(body.error).toContain('不可达')
    expect(body.detail).toBeUndefined()
  })
})

describe('a session that runs on this machine', () => {
  it('is answered with this machine, and no probe at all', async () => {
    const probes: Probe[] = []
    const { status, body } = await call(host({}, probes), routing({ bound: false }))

    expect(status).toBe(200)
    expect(body.detail?.device.kind).toBe('local')
    expect(probes).toEqual([])
  })

  it('is the answer in a composition with no router at all', async () => {
    const { body } = await call(host({}))

    expect(body.detail?.device.kind).toBe('local')
  })
})

describe('a request that names no session', () => {
  it('is refused', async () => {
    const { status, body } = await call(host({}), routing(), '')

    expect(status).toBe(400)
    expect(body.error).toContain('缺少会话 id')
  })
})
