/**
 * The port forward tool: what the MODEL can ask for.
 *
 * A reader can open a forward from the panel; this is the other half, the one
 * the model reaches for. The two talk to the same forwarder, so a forward the
 * model opened shows up in the panel and a forward the reader opened is one
 * the model can see and stop.
 *
 * It is registered in the SCOPE of a session that runs on a device, and only
 * there: a forward is a tunnel to a device, and a session on this machine has
 * no device to tunnel to. A tool that was visible everywhere and failed
 * everywhere else would be a tool the model learns to distrust.
 *
 * The tool is structural about the registry, the same way the device dialect
 * is: this package does not depend on the tools package, and it does not need
 * to — it reads a registry and writes a definition, and nothing else.
 */

import type { DshellForwardView } from '@nexus-aethra/dshell-std'
import type { SshRouter } from '../router.js'
import type { ForwardSeat } from './route.js'

/** The tool's name, as the model sees it. */
export const PORT_FORWARD_TOOL = 'port_forward'

/**
 * One tool definition, as much of it as this module reads or writes.
 *
 * Structural on purpose, like the device dialect's: the tools package is not
 * this package's to depend on.
 */
interface ToolDefinitionShape {
  readonly name: string
  readonly description: string
  readonly parameters: unknown
  readonly [key: string]: unknown
}

/** The registry surface this module uses. */
interface ToolRegistryShape {
  get(name: string, scope?: unknown): ToolDefinitionShape | undefined
  register(definition: ToolDefinitionShape): () => void
}

/** The agent surface this module uses: its id and its own scoped context. */
interface AgentShape {
  readonly id: unknown
  readonly ctx: { readonly tools: ToolRegistryShape }
}

/**
 * A listener, typed so that any handler is assignable to it: `never` accepts
 * every argument shape, which is what a structurally-typed event bus needs.
 */
type Listener = (...args: never[]) => unknown

/** The context surface this module uses. */
interface DialectContextShape {
  readonly tools: ToolRegistryShape
  readonly agents: { list(): AgentShape[] }
  on(event: string, listener: Listener, options?: { prepend?: boolean }): () => void
}

/** What the tool was asked to do. */
type ForwardAction =
  | { readonly action: 'list' }
  | { readonly action: 'open'; readonly devicePort: number; readonly localPort?: number }
  | { readonly action: 'stop'; readonly localPort: number }

/** What the tool says. */
interface ForwardToolResult {
  readonly forwards: readonly DshellForwardView[]
  readonly message: string
}

/** What the forwarder is asked to open. */
export interface ForwardToolDeps {
  /** The forwarder the tool drives. */
  readonly forwarder: ForwardSeat
  /** The device router, which says which device a session is on. */
  readonly router: SshRouter
  /** The address on the reader's own machine to listen on. */
  readonly localAddress?: string | undefined
}

/** The address a forward listens on when the tool is not told otherwise. */
const DEFAULT_LOCAL_ADDRESS = '127.0.0.1'

/**
 * The tool's description, as the model reads it.
 *
 * It says what the tool is FOR before it says how to call it, because the
 * model that has to guess which of several tools answers its question will
 * guess wrong.
 */
const TOOL_DESCRIPTION = [
  'Open a port on this session\'s device so it can be reached from this machine,',
  'list the forwards that are open, or stop one.',
  '',
  'A forward is a TCP tunnel: it carries whatever the port speaks, so a web page,',
  'an API, a database or a websocket all travel the same way. The port on the',
  'device is the one the service listens on; the local port is the one to open',  
  'on this machine, and 0 asks the system for a free one.',
].join('\n')

/**
 * The tool's parameters, as a JSON schema.
 *
 * The action is an enum rather than three tools, so the model has one thing to
 * reach for and the answer says which one it did.
 */
const TOOL_PARAMETERS = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['list', 'open', 'stop'],
      description: 'What to do: list the open forwards, open one, or stop one.',
    },
    devicePort: {
      type: 'number',
      description: 'The port on the device to reach. Required to open a forward.',
    },
    localPort: {
      type: 'number',
      description: 'The port to listen on locally. 0 asks for a free one; required to stop a forward.',
    },
  },
  required: ['action'],
} as const

/**
 * The tool's output, as the harness's contract asks for it.
 *
 * The registry refuses a tool that does not declare this, so it is not optional
 * paperwork: a tool without it never reaches a model at all. The value is the
 * lossless record of what happened, and the render is the one line the model
 * reads.
 */
const TOOL_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    // `required` is a LIST of names on an object, never a per-property flag.
    // The registry enforces the subset it accepts and refuses the rest, so a
    // schema written in the looser dialect is refused at registration — which
    // is why this shape is pinned by a test rather than left to a reader.
    required: ['forwards', 'message'],
    properties: {
      forwards: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['sessionId', 'deviceId', 'deviceName', 'devicePort', 'localPort', 'localAddress', 'status'],
          properties: {
            sessionId: { type: 'string' },
            deviceId: { type: 'string' },
            deviceName: { type: 'string' },
            devicePort: { type: 'number' },
            localPort: { type: 'number' },
            localAddress: { type: 'string' },
            status: { type: 'string' },
            error: { type: 'string' },
          },
        },
      },
      message: { type: 'string' },
    },
  },
  render: (_args: unknown, value: unknown): { type: 'text'; text: string }[] => {
    const answer = value as { message?: unknown }
    const text = typeof answer?.message === 'string' ? answer.message : 'the forwarder said nothing'
    return [{ type: 'text', text }]
  },
} as const

/**
 * Run one call.
 *
 * @param deps - the forwarder and the router.
 * @param sessionId - the session the call was made in.
 * @param action - what was asked for.
 * @returns what the tool says.
 */
async function runForward(
  deps: ForwardToolDeps,
  sessionId: string,
  action: ForwardAction,
): Promise<ForwardToolResult> {
  switch (action.action) {
    case 'list': {
      const forwards = deps.forwarder.listSession(sessionId)
      return {
        forwards,
        message: forwards.length === 0
          ? 'no forwards are open'
          : forwards.map(forward =>
              `device port ${String(forward.devicePort)} is open on ${forward.localAddress}:${String(forward.localPort)} (${forward.status})`,
            ).join('\n'),
      }
    }
    case 'open': {
      const target = deps.router.targetForSession(sessionId)
      if (target === undefined) {
        return { forwards: deps.forwarder.listSession(sessionId), message: 'this session does not run on a device' }
      }
      const opened = await deps.forwarder.open({
        sessionId,
        device: target.device,
        devicePort: action.devicePort,
        localPort: action.localPort ?? 0,
        localAddress: deps.localAddress ?? DEFAULT_LOCAL_ADDRESS,
      })
      const forwards = deps.forwarder.listSession(sessionId)
      if (opened.view.status === 'failed') {
        return { forwards, message: 'the forward could not be opened: ' + (opened.view.error ?? 'unknown reason') }
      }
      return {
        forwards,
        message: `device port ${String(opened.view.devicePort)} is now open on ${opened.view.localAddress}:${String(opened.view.localPort)}`,
      }
    }
    case 'stop': {
      const stopped = deps.forwarder.stop(sessionId, action.localPort)
      const forwards = deps.forwarder.listSession(sessionId)
      return {
        forwards,
        message: stopped
          ? `the forward on port ${String(action.localPort)} is closed`
          : 'no such forward',
      }
    }
  }
}

/**
 * Install the forward tool in every session that runs on a device.
 *
 * The tool follows the SESSION, not the agent: it is added when the session is
 * bound to a device and taken away when it is not, because a forward is a tunnel
 * to a device and a local session has none. That is why the binding is watched
 * as well as the agent's life — a session bound after its agent was created
 * still gets the tool.
 *
 * @param ctx - host context.
 * @param deps - the forwarder and the router.
 * @returns a disposer removing the tool from every scope it was added to.
 */
export function installForwardTool(ctx: unknown, deps: ForwardToolDeps): () => void {
  const host = ctx as DialectContextShape
  const applied = new Map<string, () => void>()

  /** Put the tool in one agent's scope, or take it back out. */
  const apply = (sessionId: string, agent: AgentShape): void => {
    const bound = deps.router.targetForSession(sessionId) !== undefined
    const current = applied.get(sessionId)
    if (!bound) {
      current?.()
      applied.delete(sessionId)
      return
    }
    if (current !== undefined) return
    const definition: ToolDefinitionShape = {
      name: PORT_FORWARD_TOOL,
      description: TOOL_DESCRIPTION,
      parameters: TOOL_PARAMETERS,
      output: TOOL_OUTPUT,
      execute: async (input: unknown): Promise<unknown> => {
        const action = parseAction(input)
        if (action === undefined) {
          return {
            forwards: deps.forwarder.listSession(sessionId),
            message: 'the action was not understood',
          }
        }
        return await runForward(deps, sessionId, action)
      },
    }
    applied.set(sessionId, agent.ctx.tools.register(definition))
  }

  host.on('agent/created', (payload: { agent: AgentShape }) => {
    apply(String(payload.agent.id), payload.agent)
  })
  host.on('agent/disposed', (payload: { agent: AgentShape }) => {
    const sessionId = String(payload.agent.id)
    applied.get(sessionId)?.()
    applied.delete(sessionId)
  })
  const unlistenAssignment = deps.router.onAssignment((sessionId: string): void => {
    const agent = host.agents.list().find(candidate => String(candidate.id) === sessionId)
    if (agent === undefined) return
    apply(sessionId, agent)
  })

  // Put the tool in every live agent's scope that is bound to a device.
  for (const agent of host.agents.list()) apply(String(agent.id), agent)

  return () => {
    for (const dispose of applied.values()) dispose()
    applied.clear()
    unlistenAssignment()
  }
}

/**
 * Read the tool's arguments.
 *
 * @param input - what the model passed.
 * @returns the action, or undefined when it was not understood.
 */
function parseAction(input: unknown): ForwardAction | undefined {
  const raw = input as Record<string, unknown> | null | undefined
  if (raw === null || raw === undefined) return undefined
  const action = raw.action
  if (action === 'list') return { action: 'list' }
  if (action === 'open') {
    const devicePort = Number(raw.devicePort)
    if (!Number.isInteger(devicePort) || devicePort < 1 || devicePort > 65535) return undefined
    const localPort = raw.localPort === undefined ? undefined : Number(raw.localPort)
    return {
      action: 'open',
      devicePort,
      ...localPort === undefined ? {} : { localPort },
    }
  }
  if (action === 'stop') {
    const localPort = Number(raw.localPort)
    if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) return undefined
    return { action: 'stop', localPort }
  }
  return undefined
}
