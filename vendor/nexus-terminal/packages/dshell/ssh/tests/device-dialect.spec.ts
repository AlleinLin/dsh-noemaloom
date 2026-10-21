/**
 * The shell a device-bound agent is shown, and the one it is not.
 *
 * The defect this covers is a half-finished swap: dshell sends a bound
 * session's commands to the device, but the MODEL still sees the host's
 * shell tool — a tool named `pwsh`, described in PowerShell, pointed at this
 * machine's directory. The model writes PowerShell, the device answers
 * `command not found`, and the round trip is spent on a dialect that is not
 * there. The agent even says so, in its own reasoning: "the pwsh tool
 * actually runs on Linux VM-0-6-ubuntu — it's bash, not pwsh".
 *
 * So the contract has to move with the execution: the device's agent sees a
 * tool named for the device's shell, described in the device's dialect, and
 * the host's own shell tool is out of that scope. The execution stays the
 * host tool's own body — the same command, run somewhere else.
 *
 * The fixture below is the PRODUCTION shape, not a convenient one:
 *
 *  - the scope key is the AGENT itself, the way the agent loop mints it;
 *  - the host's shell tool lives in a PRESET scope, which parents the
 *    agent's scope, and the deployment layer is EMPTY.
 *
 * A deployment that mounts its model-facing tools that way is the normal one,
 * and a lookup that reads the deployment layer finds nothing there —
 * silently, because "no such tool" and "this deployment has no shell tool"
 * look the same to the code that asks.
 *
 * The runtime context is modelled the way the prompt registry renders it: a
 * scoped contribution SHADOWS the global one of the same name, and the
 * snapshot is rendered from the registry. That is the only place a device
 * session's working directory can be stated, because the stock contribution
 * rewrites its own text inside the assembly waterfall and is re-registered
 * for every agent.
 */

import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { installDeviceDialect } from '../src/device-dialect.js'
import type { SshRouter } from '../src/router.js'

/** A tool definition, as much of it as the module reads or rewrites. */
interface ToolDefinitionShape {
  readonly name: string
  readonly description: string
  readonly parameters: unknown
  readonly [key: string]: unknown
}

/** One runtime-context contribution, as the prompt registry takes it. */
interface ContextContribution {
  readonly name: string
  readonly order: number
  readonly text: string | ((context: unknown) => string)
  readonly interpolate?: boolean
  readonly required?: boolean
}

/** The registry state every scope view shares. */
class RegistryState {
  /** The deployment-level layer; a preset deployment leaves it empty. */
  readonly globals = new Map<string, ToolDefinitionShape>()
  /** One layer per scope, keyed by the scope's key. */
  readonly layers = new Map<object, Map<string, ToolDefinitionShape>>()
  /** The names a scope's own filter removes. */
  readonly restrictions = new Map<object, Set<string>>()
  /** Each scope's parent, the way a preset scope parents an agent's scope. */
  readonly parents = new Map<object, object>()
  /** The deployment-level runtime-context contributions. */
  readonly contexts = new Map<string, ContextContribution>()
  /** The scoped runtime-context contributions, keyed by scope. */
  readonly scopedContexts = new Map<object, Map<string, ContextContribution>>()
}

/**
 * One view of the registry: the deployment's, or one scope's.
 *
 * A scope sees the deployment layer, its ancestors' layers and its own, the
 * nearest winning; its own filter removes the inherited names but not its
 * own registrations.
 */
class FakeRegistry {
  constructor(private readonly state: RegistryState, private readonly scope?: object) {}

  /** The scope's chain, farthest ancestor first. */
  private chain(): object[] {
    const chain: object[] = []
    let cursor = this.scope
    while (cursor !== undefined) {
      chain.unshift(cursor)
      cursor = this.state.parents.get(cursor)
    }
    return chain
  }

  /** What this scope can see, after its own filter. */
  view(): Map<string, ToolDefinitionShape> {
    if (this.scope === undefined) return new Map(this.state.globals)
    const own = this.state.layers.get(this.scope) ?? new Map<string, ToolDefinitionShape>()
    const denied = this.state.restrictions.get(this.scope) ?? new Set<string>()
    const view = new Map(this.state.globals)
    for (const key of this.chain()) {
      for (const [name, definition] of this.state.layers.get(key) ?? []) view.set(name, definition)
    }
    for (const [name, definition] of own) view.set(name, definition)
    for (const name of denied) {
      if (!own.has(name)) view.delete(name)
    }
    return view
  }

  /** What this scope can see, EXCLUDING its own registrations. */
  private inherited(): Map<string, ToolDefinitionShape> {
    if (this.scope === undefined) return new Map(this.state.globals)
    const denied = this.state.restrictions.get(this.scope) ?? new Set<string>()
    const view = new Map(this.state.globals)
    for (const key of this.chain()) {
      for (const [name, definition] of this.state.layers.get(key) ?? []) view.set(name, definition)
    }
    for (const name of denied) view.delete(name)
    return view
  }

  get(name: string, scope?: unknown): ToolDefinitionShape | undefined {
    if (scope === undefined) return new Map(this.state.globals).get(name)
    if (typeof scope === 'object' && scope !== null) {
      return new FakeRegistry(this.state, scope).view().get(name)
    }
    return this.view().get(name)
  }

  register(definition: ToolDefinitionShape): () => void {
    const key = this.scope
    if (key === undefined) {
      this.state.globals.set(definition.name, definition)
      return () => { this.state.globals.delete(definition.name) }
    }
    const layer = this.state.layers.get(key) ?? new Map<string, ToolDefinitionShape>()
    layer.set(definition.name, definition)
    this.state.layers.set(key, layer)
    return () => { layer.delete(definition.name) }
  }

  restrict(filter: { deny?: readonly string[] }): () => void {
    if (this.scope === undefined) throw new Error('restrict() requires a scoped context')
    const key = this.scope
    const layer = this.state.layers.get(key)
    const denied = this.state.restrictions.get(key) ?? new Set<string>()
    const inherited = this.inherited()
    for (const name of filter.deny ?? []) {
      // A scope's own registration is exempt from its own filter, so naming
      // it is a caller error rather than a silent no-op.
      if (layer?.has(name) === true) throw new Error(`unknown global tool "${name}"`)
      if (!inherited.has(name)) throw new Error(`unknown global tool "${name}"`)
      denied.add(name)
    }
    this.state.restrictions.set(key, denied)
    return () => { for (const name of filter.deny ?? []) denied.delete(name) }
  }
}

/** The prompt registry an agent's scope carries. */
class FakeSystemPrompt {
  constructor(private readonly state: RegistryState, private readonly scope: object, private readonly agent: { id: string }) {}

  context(contribution: ContextContribution): () => void {
    const layer = this.state.scopedContexts.get(this.scope) ?? new Map<string, ContextContribution>()
    if (layer.has(contribution.name)) throw new Error(`context "${contribution.name}" is already registered`)
    layer.set(contribution.name, contribution)
    this.state.scopedContexts.set(this.scope, layer)
    return () => { layer.delete(contribution.name) }
  }
}

/** One agent, with the scoped registries its own context carries. */
class FakeAgent {
  readonly ctx: { tools: FakeRegistry; systemPrompt: FakeSystemPrompt }

  constructor(readonly id: string, state: RegistryState) {
    this.ctx = {
      tools: new FakeRegistry(state, this),
      systemPrompt: new FakeSystemPrompt(state, this, this),
    }
  }
}

/** The host context, with the listeners the module installs. */
class FakeContext {
  readonly agents: { list(): FakeAgent[] }
  readonly handlers = new Map<string, ((...args: never[]) => unknown)[]>()

  constructor(private readonly state: RegistryState, private readonly live: FakeAgent[]) {
    this.agents = { list: () => this.live }
  }

  /** The model's view of one scope: the tool names it can see. */
  visible(scope: object): string[] {
    return [...new FakeRegistry(this.state, scope).view().keys()].sort()
  }

  /**
   * The runtime context one scope reads, rendered the way the prompt registry
   * renders it: the scoped contributions shadow the global ones of the same
   * name, and the text providers are resolved against the assembly.
   */
  context(scope: object): { name: string; text: string }[] {
    const providers = new Map(this.state.contexts)
    for (const [name, contribution] of this.state.scopedContexts.get(scope) ?? []) {
      providers.set(name, contribution)
    }
    const agent = this.live.find(candidate => candidate === scope)
    return [...providers.values()]
      .sort((a, b) => a.order - b.order)
      .map(contribution => ({
        name: contribution.name,
        text: typeof contribution.text === 'function' ? contribution.text({ agent }) : contribution.text,
      }))
      .filter(entry => entry.text.length > 0)
  }

  on(event: string, listener: (...args: never[]) => unknown): () => void {
    const list = this.handlers.get(event) ?? []
    list.push(listener)
    this.handlers.set(event, list)
    return () => {
      const index = list.indexOf(listener)
      if (index >= 0) list.splice(index, 1)
    }
  }

  /** Deliver one event to every listener, as cordis would. */
  emit(event: string, payload: unknown): unknown[] {
    return (this.handlers.get(event) ?? []).map(listener => listener(payload as never))
  }
}

/** The router, with one device and the sessions bound to it. */
class FakeRouter {
  onAssignmentChanged: ((sessionId: string, deviceId: string | null) => void) | undefined
  private readonly targets = new Map<string, { name: string; remoteRoot: string }>()
  private readonly ready = Promise.resolve()

  bind(sessionId: string, name: string, remoteRoot: string): void {
    this.targets.set(sessionId, { name, remoteRoot })
  }

  unbind(sessionId: string): void {
    this.targets.delete(sessionId)
  }

  whenReady(): Promise<void> {
    return this.ready
  }

  targetForSession(sessionId: string): { device: { name: string }; remoteRoot: string; mount: string | undefined } | undefined {
    const target = this.targets.get(sessionId)
    return target === undefined
      ? undefined
      : { device: { name: target.name }, remoteRoot: target.remoteRoot, mount: undefined }
  }

  assignmentForSession(sessionId: string): { sessionId: string; deviceId: string; remoteRoot?: string } | undefined {
    const target = this.targets.get(sessionId)
    return target === undefined
      ? undefined
      : { sessionId, deviceId: target.name, remoteRoot: target.remoteRoot }
  }
}

/** The host's own shell tool: a PowerShell one, as a Windows host has. */
function hostPwsh(): ToolDefinitionShape {
  return {
    name: 'pwsh',
    description: 'Execute a PowerShell command (`pwsh -Command`). Paths use native Windows form (`C:\\...`).',
    parameters: {
      type: 'object',
      properties: {
        description: { type: 'string', required: true, description: 'What the command does.' },
        command: { type: 'string', required: true, description: 'The PowerShell command to execute.' },
        workdir: { type: 'string', description: 'Working directory for this command.' },
      },
      required: ['description', 'command'],
    },
    output: { schema: { type: 'string' }, render: () => [{ type: 'text', text: 'done' }] },
    execute: async () => 'host-body',
  }
}

/** The world one test runs in: a Windows host, a preset, one device, one agent. */
function world(): {
  ctx: FakeContext
  router: FakeRouter
  agent: FakeAgent
  local: FakeAgent
  state: RegistryState
} {
  const state = new RegistryState()
  const preset = { name: 'standard preset' }
  const agent = new FakeAgent('session-on-device', state)
  const local = new FakeAgent('session-on-this-machine', state)
  // The production shape: the host's shell tool belongs to the PRESET scope,
  // which parents the agent's scope. The deployment layer is empty.
  state.parents.set(agent, preset)
  state.parents.set(local, preset)
  state.layers.set(preset, new Map([['pwsh', hostPwsh()]]))
  // The stock runtime context, at the deployment level.
  state.contexts.set('working-directory:current', {
    name: 'working-directory:current',
    order: 100,
    required: true,
    interpolate: false,
    text: 'Current working directory: "C:\\Users\\reader".',
  })
  const ctx = new FakeContext(state, [agent, local])
  const router = new FakeRouter()
  router.bind('session-on-device', 'tencent', '/root')
  return { ctx, router, agent, local, state }
}

describe('a session bound to a device', () => {
  it('shows the agent the device shell, not the host one', () => {
    const { ctx, router } = world()
    installDeviceDialect(ctx as unknown as Context, router as unknown as SshRouter)

    expect(ctx.visible(ctx.agents.list()[0]!)).toEqual(['bash'])
  })

  it('describes the device, its dialect and its paths', () => {
    const { ctx, router, agent } = world()
    installDeviceDialect(ctx as unknown as Context, router as unknown as SshRouter)

    const description = agent.ctx.tools.get('bash', agent)?.description ?? ''
    expect(description).toContain('"tencent"')
    expect(description).toContain('bash')
    expect(description).toContain('/root')
    expect(description).toContain('POSIX')
    expect(description).not.toContain('pwsh -Command')
  })

  it('writes the description when the model reads it, not when it was registered', () => {
    const { ctx, router, agent } = world()
    installDeviceDialect(ctx as unknown as Context, router as unknown as SshRouter)

    // The device's root is only resolved once the helper has shaken hands, so
    // a description frozen at registration time would still name the `~` the
    // reader typed.
    router.bind('session-on-device', 'tencent', '/srv/app')
    expect(agent.ctx.tools.get('bash', agent)?.description).toContain('/srv/app')
  })

  it('rewrites the command and workdir parameters for the device', () => {
    const { ctx, router, agent } = world()
    installDeviceDialect(ctx as unknown as Context, router as unknown as SshRouter)

    const parameters = agent.ctx.tools.get('bash', agent)?.parameters as {
      properties: Record<string, { description: string }>
    }
    expect(parameters.properties.command.description).toContain('POSIX shell (bash) syntax')
    expect(parameters.properties.workdir.description).toContain('on the device')
    expect(parameters.properties.description.description).not.toContain('Get-Process')
  })

  it('keeps the host tool own execution, so jobs and rendering are unchanged', () => {
    const { ctx, router, agent, state } = world()
    installDeviceDialect(ctx as unknown as Context, router as unknown as SshRouter)

    const base = state.layers.get(state.parents.get(agent)!)?.get('pwsh')
    const variant = agent.ctx.tools.get('bash', agent)
    expect(variant?.execute).toBe(base?.execute)
    expect(variant?.output).toBe(base?.output)
  })

  it('hides the host shell tool from the device agent only', () => {
    const { ctx, router, agent, local, state } = world()
    installDeviceDialect(ctx as unknown as Context, router as unknown as SshRouter)

    expect(ctx.visible(agent)).not.toContain('pwsh')
    // Every other agent still has the host shell.
    expect(ctx.visible(local)).toEqual(['pwsh'])
    // The preset's own layer is untouched.
    expect([...(state.layers.get(state.parents.get(agent)!)?.keys() ?? [])]).toEqual(['pwsh'])
  })

  it('leaves a local session alone', () => {
    const { ctx, router, local } = world()
    installDeviceDialect(ctx as unknown as Context, router as unknown as SshRouter)

    expect(ctx.visible(local)).toEqual(['pwsh'])
  })
})

describe('the runtime context of a device session', () => {
  it('names the device directory instead of this machine one', () => {
    const { ctx, router, agent } = world()
    installDeviceDialect(ctx as unknown as Context, router as unknown as SshRouter)

    const working = ctx.context(agent).find(entry => entry.name === 'working-directory:current')
    expect(working?.text).toContain('/root')
    expect(working?.text).toContain('tencent')
    expect(working?.text).not.toContain('C:\\\\Users')
  })

  it('says which machine the session runs on', () => {
    const { ctx, router, agent } = world()
    installDeviceDialect(ctx as unknown as Context, router as unknown as SshRouter)

    const device = ctx.context(agent).find(entry => entry.name === 'dshell:device')
    expect(device?.text).toContain('bash')
    expect(device?.text).toContain('tencent')
  })

  it('leaves a local session context alone', () => {
    const { ctx, router, local } = world()
    installDeviceDialect(ctx as unknown as Context, router as unknown as SshRouter)

    const working = ctx.context(local).find(entry => entry.name === 'working-directory:current')
    expect(working?.text).toContain('C:')
    expect(ctx.context(local).some(entry => entry.name === 'dshell:device')).toBe(false)
  })
})

describe('a binding that arrives after the agent', () => {
  it('gives the agent the device shell when the session is bound', () => {
    const { ctx, agent } = world()
    const target = new FakeRouter()
    installDeviceDialect(ctx as unknown as Context, target as unknown as SshRouter)

    expect(ctx.visible(agent)).toEqual(['pwsh'])

    target.bind('session-on-device', 'tencent', '/root')
    target.onAssignmentChanged?.('session-on-device', 'tencent')

    expect(ctx.visible(agent)).toEqual(['bash'])
  })

  it('takes the device shell back when the session is unbound', () => {
    const { ctx, agent } = world()
    const target = new FakeRouter()
    installDeviceDialect(ctx as unknown as Context, target as unknown as SshRouter)

    target.bind('session-on-device', 'tencent', '/root')
    target.onAssignmentChanged?.('session-on-device', 'tencent')
    expect(ctx.visible(agent)).toEqual(['bash'])

    target.unbind('session-on-device')
    target.onAssignmentChanged?.('session-on-device', null)

    expect(ctx.visible(agent)).toEqual(['pwsh'])
  })
})
