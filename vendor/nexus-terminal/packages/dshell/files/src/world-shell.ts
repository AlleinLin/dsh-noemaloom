import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the shell service merge (`ctx.get('shell')`) and its result.
import type { ShellRunResult } from '@deepseek-ai/dsh-shell'

/**
 * One command, run in a session's own world.
 *
 * Two features in this package need to run something in the world a session
 * lives in rather than in this process: the command list asks a device for its
 * `PATH`, and the completion oracle asks its shell what completes a line. Both
 * go through the same seam — `ctx.shell.resolve` (which the ssh router rewrites
 * to an `ssh` line when the session is bound to a device) inside
 * `agents.withInitiator` (which is what tells that router WHICH session) — and
 * both want the same thing when the world will not answer: nothing, so the
 * caller can fall back.
 *
 * @param ctx - host context holding the shell service.
 * @param agent - the session's agent, naming the world to run in.
 * @param request - the command, where to run it, and the two budgets.
 * @returns the finished run, or undefined when no world answered.
 */
export async function runInWorld(
  ctx: Context,
  agent: Agent,
  request: {
    readonly command: string
    readonly workdir: string
    readonly root: string
    readonly timeoutMs: number
    readonly stdoutMaxBytes: number
  },
): Promise<ShellRunResult | undefined> {
  // `ctx.get('shell')` and NOT `ctx.shell`. The property accessor is gated by the
  // plugin's `inject` declaration, and this route declares no shell service, so
  // reading it as a property throws `cannot get property "shell" without inject`.
  // That failure is invisible at the call site — the catch below turns it into
  // "this world did not answer" — which is exactly how a device session's PATH
  // went unread while a fallback directory list quietly took its place. Reading
  // the service structurally is what dshell-ssh's own router does, for the same
  // reason: the seam goes on the prototype, and every access path reaches it.
  const shell = ctx.get('shell')
  if (shell === undefined) return undefined
  try {
    const spec = await ctx.agents.withInitiator(agent, () => shell.resolve({
      command: request.command,
      workdir: request.workdir,
      timeoutMs: request.timeoutMs,
      stdoutMaxBytes: request.stdoutMaxBytes,
      // Read-only on THIS machine. A device session's command runs on the device
      // under the device's own policy (the ssh router rewrites this mode, because
      // the only process running here is the `ssh` client), so this fence is
      // honest for a local session and decorative for a device.
      sandboxPolicy: { mode: 'read-only', workspaceRoot: request.root },
    }))
    return await (await shell.execute(spec)).result()
  } catch {
    // A world that will not answer, a policy that refuses, a timeout: the caller
    // falls back to what it already knew.
    return undefined
  }
}
