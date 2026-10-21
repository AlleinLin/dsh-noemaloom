/**
 * The contract a device-bound agent sees: the DEVICE's shell, not the host's.
 *
 * dshell replaces the EXECUTION of a bound session's shell commands — the
 * seam sends them to the device and runs them with the device's own `bash` —
 * but the MODEL still sees the host's shell tool: a tool named `pwsh`, whose
 * description promises PowerShell, native `C:\...` paths and `$env:NAME`, and
 * whose working directory is this machine's. The model writes PowerShell, the
 * device answers `command not found`, and the round trip is spent on a dialect
 * the device has never heard of. The agent even says so, out loud: "the pwsh
 * tool actually runs on Linux VM-0-6-ubuntu — it's bash, not pwsh".
 *
 * The two halves have to move together. A tool that RUNS on the device but
 * SPEAKS for the host is the same defect as one that runs on the host, seen
 * from the other side: the model is told a lie, and every answer it gets back
 * looks like a broken tool rather than a wrong dialect.
 *
 * So a bound session's agent gets its own shell tool, in its own scope:
 *
 *  - the NAME is the device's (`bash`), because a name is the strongest prior
 *    a model has, and `pwsh` is a prior about a shell that is not there;
 *  - the DESCRIPTION says where the command runs, in which dialect, and with
 *    which paths;
 *  - the HOST's shell tool is hidden from that scope, so there is exactly one
 *    shell and it is the device's;
 *  - the RUNTIME CONTEXT names the device's working directory instead of this
 *    machine's.
 *
 * The execution is untouched: the variant reuses the host tool's own body, so
 * jobs, background calls, sandbox escalation and result rendering behave
 * exactly as they do for a local session. Only the contract changes.
 *
 * The scope is the agent's own (`agent.ctx`), which is the mechanism dsh
 * provides for exactly this: a scoped registration shadows the global one, and
 * a scoped restriction hides a global tool from that agent alone.
 *
 * @module @nexus-aethra/dshell-ssh/device-dialect
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the host agent service merge (ctx.agents).
import type {} from '@deepseek-ai/dsh-agent'
import type { SshRouter } from './router.js'

/**
 * The tool name a device-bound session's shell carries: the device's own.
 *
 * `bash` rather than a neutral word, because the name is what the model
 * reaches for when it decides how to write a command, and a POSIX name is the
 * truth here — the seam runs `bash -c` on the device whatever the host is. It
 * is also the name the client renders as a terminal card, so the device's
 * commands keep the card they had.
 */
export const DEVICE_SHELL_TOOL = 'bash'

/**
 * The host shell tools this package knows how to replace.
 *
 * `pwsh` first: a Windows host is the case that produced this, and a
 * composition that mounts both still wants the PowerShell one replaced.
 */
const HOST_SHELL_TOOLS = ['pwsh', 'bash'] as const

/**
 * Where the device's own working directory sits in the runtime context.
 *
 * The same slot the stock working-directory contribution occupies, so the
 * shadowed entry keeps its place in the snapshot.
 */
const WORKING_DIRECTORY_ORDER = 100

/**
 * Where the device section sits: right after the working directory, before
 * the file policy.
 */
const DEVICE_CONTEXT_ORDER = 105

/**
 * One tool definition, as much of it as this module reads or rewrites.
 *
 * Structural on purpose: the ssh package does not depend on the tools
 * package, and it does not need to — it reads a definition, writes a
 * derivative of it, and registers that. The same reasoning the router uses
 * for the shell executor.
 */
interface ToolDefinitionShape {
  readonly name: string
  readonly description: string
  readonly parameters: unknown
  readonly [key: string]: unknown
}

/**
 * The registry surface this module uses.
 *
 * `get` with a scope reads that scope's view — the global view when the scope
 * is omitted — and a registration made through an agent's own registry lands
 * in that agent's layer.
 */
interface ToolRegistryShape {
  get(name: string, scope?: unknown): ToolDefinitionShape | undefined
  register(definition: ToolDefinitionShape): () => void
  restrict(filter: { deny?: readonly string[] }): () => void
}

/** One runtime-context contribution, as the prompt registry takes it. */
interface ContextContribution {
  readonly name: string
  readonly order: number
  readonly text: string | ((context: unknown) => string)
  readonly interpolate?: boolean
  readonly required?: boolean
}

/** The prompt registry surface this module uses. */
interface SystemPromptShape {
  context(contribution: ContextContribution): () => void
}

/** The agent surface this module uses: its id and its own scoped context. */
interface AgentShape {
  readonly id: unknown
  readonly ctx: {
    readonly tools: ToolRegistryShape
    readonly systemPrompt: SystemPromptShape
  }
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

/** What the model is told about the device a session runs on. */
interface DeviceFacts {
  /** The device's display name, as the reader named it. */
  readonly name: string
  /** The device's working directory, in the device's own spelling. */
  readonly root: string
}

/** What one agent's scope currently carries, and how to take it back. */
interface Applied {
  readonly facts: DeviceFacts
  readonly dispose: () => void
}

/**
 * The facts about the device a session runs on, or undefined when it runs here.
 *
 * A session that IS bound but whose device cannot be served right now — a
 * locked group, most likely — still runs THERE, so the contract still has to
 * be the device's: the commands fail with a refusal that names the way out
 * (unlock this group), not with a dialect error the model would try to fix by
 * writing different commands.
 *
 * @param router - the device assignments.
 * @param sessionId - the session to describe.
 * @returns the device's facts, or undefined for a local session.
 */
export function deviceFacts(router: SshRouter, sessionId: string): DeviceFacts | undefined {
  const target = router.targetForSession(sessionId)
  if (target !== undefined) {
    return { name: target.device.name, root: displayRoot(target.remoteRoot) }
  }
  const assignment = router.assignmentForSession(sessionId)
  if (assignment === undefined) return undefined
  return { name: assignment.deviceId, root: displayRoot(assignment.remoteRoot ?? '') }
}

/**
 * The device's directory as it should be shown.
 *
 * An absolute path is the device's own. A `~`-spelled root is the reader's
 * shorthand for the device's home, and the helper's protocol refuses it — so
 * it is shown as the shorthand it is rather than as a path the device would
 * reject.
 *
 * @param root - the resolved or stored root.
 * @returns the directory as the model should see it.
 */
function displayRoot(root: string): string {
  if (root.length === 0) return 'the device\'s default directory'
  if (root.startsWith('/')) return root
  return root === '~' ? '~' : root
}

/**
 * The host's own shell tool, read from the AGENT's view.
 *
 * The agent's view, not the global one, and that is not a detail. A deployment
 * that mounts its model-facing tools into a preset scope has NO global row for
 * them: the agent's scope chain is what resolves them, and the global view is
 * empty. Reading the global view here is how a whole feature can do nothing at
 * all without a word of complaint — the lookup answers "no such tool", the
 * code takes that as "this deployment has no shell tool", and the agent keeps
 * the host's contract.
 *
 * The scope key is the agent itself: the agent loop mints the agent's scope
 * with the agent as its key, and the preset's scope is its parent.
 *
 * @param registry - the registry, reached through the agent's own context.
 * @param agent - the agent whose view decides what the model sees.
 * @returns the definition to derive from, or undefined when the agent sees no
 *   shell tool to derive from.
 */
function baseDefinition(registry: ToolRegistryShape, agent: AgentShape): ToolDefinitionShape | undefined {
  for (const name of HOST_SHELL_TOOLS) {
    const definition = registry.get(name, agent)
    if (definition !== undefined) return definition
  }
  return undefined
}

/**
 * The device's shell tool, derived from the host's.
 *
 * The description is a GETTER, so it is written when the model reads the
 * schema rather than when the tool was registered. That matters: the device's
 * root is only resolved once the helper has shaken hands, so a description
 * captured at registration time says the device's home is still the `~` the
 * reader typed.
 *
 * @param base - the host's shell tool definition.
 * @param facts - the device the commands run on, read at schema time.
 * @returns the definition to register in the agent's scope.
 */
function deviceShellDefinition(base: ToolDefinitionShape, facts: () => DeviceFacts | undefined): ToolDefinitionShape {
  return {
    ...base,
    name: DEVICE_SHELL_TOOL,
    get description() {
      const live = facts()
      return live === undefined ? base.description : deviceShellDescription(live)
    },
    parameters: deviceParameters(base.parameters),
  }
}

/**
 * What the model is told about the shell it is holding.
 *
 * @param facts - the device the commands run on.
 * @returns the tool description.
 */
function deviceShellDescription(facts: DeviceFacts): string {
  return `Execute a command on the SSH device ${JSON.stringify(facts.name)} and return its stdout/stderr. `
    + 'This session runs on that remote machine, NOT on the local one: every command runs there, '
    + 'and the local machine\'s files, programs, environment and paths are not there to be used. '
    + 'The device\'s shell is bash, so write POSIX shell syntax — `ls -la`, `cat notes.txt`, '
    + '`grep -r pattern .`, `env | grep NAME`, `ps aux` — not PowerShell cmdlets '
    + '(`Get-ChildItem`, `Get-Process`) and not Windows paths (`C:\\...`). '
    + `Paths are the device's own absolute POSIX paths (for example \`/etc/nginx\`); the working directory is ${JSON.stringify(facts.root)}. `
    + 'Each call runs in a fresh shell; pass `workdir` instead of using `cd`. '
    + 'Long output is truncated to its tail; the full output is saved to a file whose path is reported when available. '
    + 'Provide `description` before `command` in the arguments. '
    + 'Before any delete or move, verify that the resolved absolute target path is the intended one; '
    + 'never run it against a computed path you have not checked.'
}

/**
 * The parameter descriptions, rewritten for the device.
 *
 * Only the TEXT changes: the argument contract is the host tool's own, so the
 * validation the host tool does still applies and a call that was valid
 * before is valid now.
 *
 * @param parameters - the host tool's parameter schema.
 * @returns the schema the model sees.
 */
function deviceParameters(parameters: unknown): unknown {
  if (typeof parameters !== 'object' || parameters === null) return parameters
  const schema = parameters as { properties?: Record<string, unknown> }
  const properties = schema.properties
  if (properties === undefined) return parameters
  const patched: Record<string, unknown> = { ...properties }
  const describe = (name: string, text: string): void => {
    const property = patched[name]
    if (typeof property !== 'object' || property === null) return
    patched[name] = { ...(property as Record<string, unknown>), description: text }
  }
  describe('command', 'The command to execute on the device, in POSIX shell (bash) syntax.')
  describe('workdir', 'Absolute directory on the device to run in, in POSIX form (for example `/var/log`). '
    + 'Defaults to the device session directory.')
  describe('description', 'Clear, concise description of what this command does in active voice, '
    + '5-10 words (shown in the UI). Examples: "ls" → "List files in current directory"; '
    + '"git status" → "Show working tree status"; "ps aux" → "List running processes".')
  return { ...schema, properties: patched }
}

/**
 * What the runtime context says about where the session is.
 *
 * The stock context names THIS machine's directory, which is a local stand-in
 * for the device's tree and means nothing to a command that runs on the
 * device. The context is REPLACED rather than added to: two "current working
 * directory" lines, one of them wrong, are worse than one right one.
 *
 * @param facts - the device the session runs on.
 * @returns the working-directory line.
 */
function workingDirectoryText(facts: DeviceFacts): string {
  return `Current working directory: ${JSON.stringify(facts.root)} (on the SSH device ${JSON.stringify(facts.name)}).`
}

/**
 * The device section of the runtime context.
 *
 * @param facts - the device the session runs on.
 * @returns the section text.
 */
function deviceContextText(facts: DeviceFacts): string {
  return `This session runs on the SSH device ${JSON.stringify(facts.name)}. `
    + 'Its shell is bash, and the working directory named above is the one on that device: '
    + 'shell commands, file reads and file writes all happen there, not on the local machine. '
    + 'Use the device\'s own absolute POSIX paths (for example `/etc/nginx`); '
    + 'the local machine\'s paths and programs are not there.'
}

/**
 * Install the device dialect.
 *
 * Four registrations, all of them per agent and all of them reversible:
 *
 *  - the device's shell tool, in the agent's own scope;
 *  - the host's shell tool, hidden from that scope;
 *  - the device's working directory, shadowing the stock contribution;
 *  - the device section, next to it.
 *
 * The two context registrations are scoped CONTRIBUTIONS rather than a
 * waterfall listener, and that is the point: the snapshot the model reads is
 * rendered from the registry, and a scoped contribution shadows the global one
 * of the same name. The stock working-directory contribution rewrites its own
 * text inside the assembly waterfall, and it is re-registered for every agent
 * — so a listener there is a race the listener cannot win, whatever its
 * position.
 *
 * @param ctx - the host context.
 * @param router - the device assignments.
 * @returns a disposer removing every registration this made.
 */
export function installDeviceDialect(ctx: Context, router: SshRouter): () => void {
  const host = ctx as unknown as DialectContextShape
  const applied = new Map<string, Applied>()

  /** Put the device's contract in one agent's scope, or take it back out. */
  const apply = (sessionId: string, agent: AgentShape): void => {
    const facts = deviceFacts(router, sessionId)
    const current = applied.get(sessionId)
    if (facts === undefined) {
      current?.dispose()
      applied.delete(sessionId)
      return
    }
    if (current !== undefined && current.facts.name === facts.name && current.facts.root === facts.root) return
    current?.dispose()
    applied.set(sessionId, installFor(agent, facts))
  }

  /** Register the device's shell tool and context in one agent's scope. */
  const installFor = (agent: AgentShape, facts: DeviceFacts): Applied => {
    const scoped = agent.ctx.tools
    const base = baseDefinition(scoped, agent)
    if (base === undefined) return { facts, dispose: () => {} }
    const definition = deviceShellDefinition(base, () => deviceFacts(router, String(agent.id)))
    const unregister = scoped.register(definition)
    // The host's own shell tool, when it has a different name, must not stay
    // visible: two shells in one scope is a choice the model cannot make
    // reliably, and it keeps choosing the one it knows.
    const denied = HOST_SHELL_TOOLS.filter(name => name !== definition.name && scoped.get(name, agent) !== undefined)
    const unrestrict = denied.length > 0 ? scoped.restrict({ deny: denied }) : undefined
    // The runtime context, in the agent's own scope: a scoped contribution
    // SHADOWS the global one of the same name, and the snapshot the model
    // reads is rendered from the registry, so the device's directory is what
    // it says.
    //
    // NOT done through the assembly waterfall: the stock working-directory
    // contribution rewrites its own text there, and it is re-registered for
    // every agent, so no listener order can have the last word there.
    const prompt = agent.ctx.systemPrompt
    const unregisterWorking = prompt.context({
      name: 'working-directory:current',
      order: WORKING_DIRECTORY_ORDER,
      required: true,
      interpolate: false,
      text: (context: unknown) => {
        const live = factsFor(context)
        return live === undefined ? '' : workingDirectoryText(live)
      },
    })
    const unregisterDevice = prompt.context({
      name: 'dshell:device',
      order: DEVICE_CONTEXT_ORDER,
      interpolate: false,
      text: (context: unknown) => {
        const live = factsFor(context)
        return live === undefined ? '' : deviceContextText(live)
      },
    })
    return {
      facts,
      dispose: () => {
        unrestrict?.()
        unregister()
        unregisterWorking()
        unregisterDevice()
      },
    }
  }

  /** The device facts for the agent an assembly is for, read live. */
  const factsFor = (context: unknown): DeviceFacts | undefined => {
    const agent = (context as { agent?: AgentShape } | undefined)?.agent
    if (agent === undefined) return undefined
    return deviceFacts(router, String(agent.id))
  }

  host.on('agent/created', (payload: { agent: AgentShape }) => {
    const agent = payload.agent
    apply(String(agent.id), agent)
  })
  host.on('agent/disposed', (payload: { agent: AgentShape }) => {
    const sessionId = String(payload.agent.id)
    applied.get(sessionId)?.dispose()
    applied.delete(sessionId)
  })
  router.onAssignmentChanged = (sessionId: string): void => {
    const agent = host.agents.list().find(candidate => String(candidate.id) === sessionId)
    if (agent === undefined) return
    apply(sessionId, agent)
  }

  /**
   * Put the device's contract in every live agent's scope.
   *
   * The listener above only sees agents created after it was installed, and
   * this package settles its data root asynchronously: a session can be
   * resumed — and its agent created — before the device routing is in place.
   * The sweep is what covers those, and it runs AFTER the listener is
   * installed, so no agent can slip through the gap between the two.
   */
  const sweep = (): void => {
    for (const agent of host.agents.list()) {
      apply(String(agent.id), agent)
    }
  }
  sweep()
  // The router's caches fill asynchronously too, and an agent that was
  // resumed before they were filled has no assignment to read yet. Sweeping
  // again when they are is what gives that agent its device contract.
  void router.whenReady().then(sweep).catch(() => {})

  return () => {
    for (const entry of applied.values()) entry.dispose()
    applied.clear()
    router.onAssignmentChanged = undefined
  }
}
