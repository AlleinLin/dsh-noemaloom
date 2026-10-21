/**
 * The pre-flight a delegation runs before it is admitted.
 *
 * The user's rule for this feature: do not guess whether a session is "open" —
 * check the things that actually decide whether the work can happen, and refuse
 * with the real reason when they are not true. Two checks, in order:
 *
 *  1. **The target agent resolves.** `ctx.sessionController.resolveAgent` is
 *     dsh's own path — it returns the live agent, resuming it from persistence
 *     when it is not loaded, and deduplicates concurrent resumes. Its failure
 *     union (`not-found`, `agent-busy`, `internal`) is already the honest
 *     vocabulary for "this session cannot take a request right now".
 *  2. **A device-bound target is reachable.** If the target session runs its
 *     shell and files on a device, the work will execute there; a delegation
 *     into a dead sshd would just time out later. Probing now turns that into
 *     an immediate refusal the requester can act on.
 *
 * The device probe is optional by construction: a composition without
 * dshell-ssh has no routing service, and then there is no device to check. This
 * module never imports the SSH package — it reads the provided service
 * structurally, the same way dshell-mode reads `dshellSsh`.
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the session-controller service merge (`ctx.sessionController`).
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { SessionId } from '@deepseek-ai/dsh-session/types'

/**
 * The slice of dshell-ssh's router this module needs. Structural on purpose:
 * the buffer must not depend on the SSH bundle, and a composition without it
 * simply has no device to probe.
 */
export interface DeviceRoutingSeat {
  /**
   * The device a session is assigned to, when it is bound at all. `name` and
   * `remoteRoot` are optional because this package reads the seat structurally:
   * the real router provides them, and a composition whose router does not
   * simply gets the device id and no directory.
   */
  targetForSession(sessionId: string): {
    readonly device: { readonly id: string; readonly name?: string | undefined }
    readonly remoteRoot?: string | undefined
  } | undefined
  /** Open one connection and report what answered; throws when it cannot. */
  test(deviceId: string, ctx: Context, remoteRoot?: string | null): Promise<string>
  /**
   * The stored assignment, even for a device that cannot be served right now:
   * a label has to name the world a session stands in whether or not the
   * device answers at this moment. Absent in a seat that only probes.
   */
  assignmentForSession?(sessionId: string): {
    readonly deviceId: string
    readonly remoteRoot?: string | undefined
  } | undefined
  /** The device's own record, for the directory it runs its sessions in. */
  deviceFor?(deviceId: string): { readonly remoteRoot?: string | undefined } | undefined
}

/** How long a successful or failed device probe is trusted. */
const PROBE_TTL_MS = 10_000

/** One cached probe result. */
interface ProbeEntry {
  readonly at: number
  readonly ok: boolean
  readonly reason: string | undefined
}

/**
 * Answers "can this session take this delegation right now, and if not, why".
 *
 * The device probe result is cached briefly so a burst of delegations to the
 * same device costs one connection rather than one per call.
 */
export class Feasibility {
  private readonly probes = new Map<string, ProbeEntry>()

  /**
   * @param ctx - host context carrying the agent registry and session controller.
   * @param device - dshell-ssh's routing face, when that package is present.
   */
  constructor(
    private readonly ctx: Context,
    private readonly device: DeviceRoutingSeat | undefined,
  ) {}

  /**
   * Resolve the target agent, or explain why it cannot work.
   *
   * @param sessionId - the session the request is addressed to.
   * @param probeCtx - a context that has `subprocess` injected, for the device
   *   probe: the router spawns `ssh` through that seam, and reaching for a
   *   service its context did not inject throws in cordis. Omitted when the
   *   composition provides none, which only matters for a device-bound target.
   * @returns the live agent plus a one-word status, or a refusal reason.
   */
  async resolveTarget(sessionId: string, probeCtx?: Context): Promise<FeasibilityResult> {
    let agent: Agent
    try {
      const resolved = await this.ctx.sessionController.resolveAgent(SessionId(sessionId))
      if ('error' in resolved) {
        return { ok: false, reason: `目标会话无法接管请求：${resolved.error.code}` }
      }
      agent = resolved.agent
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      return { ok: false, reason: `目标会话解析失败：${detail}` }
    }
    const deviceFailure = await this.checkDevice(sessionId, probeCtx)
    if (deviceFailure !== undefined) return { ok: false, reason: deviceFailure }
    return { ok: true, agent, status: agent.status }
  }

  /**
   * Probe the device a session is bound to, when it is bound to one.
   *
   * @param sessionId - the session whose device should answer.
   * @param probeCtx - the injection-carrying context the router spawns from.
   * @returns a refusal reason, or undefined when there is nothing to check or
   *   the device answered.
   */
  private async checkDevice(sessionId: string, probeCtx?: Context): Promise<string | undefined> {
    const device = this.device
    if (device === undefined) return undefined
    let target: { device: { id: string } } | undefined
    try {
      target = device.targetForSession(sessionId)
    } catch {
      // A routing failure is not this module's to report; treat it as unbound.
      return undefined
    }
    if (target === undefined) return undefined
    if (probeCtx === undefined) {
      return '目标会话运行在设备上，但本组合没有 subprocess 服务，无法探测设备可达性'
    }
    const deviceId = target.device.id
    const cached = this.probes.get(deviceId)
    if (cached !== undefined && Date.now() - cached.at < PROBE_TTL_MS) {
      return cached.ok ? undefined : cached.reason
    }
    try {
      await device.test(deviceId, probeCtx)
      this.probes.set(deviceId, { at: Date.now(), ok: true, reason: undefined })
      return undefined
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      const reason = `目标会话所在的设备不可达：${detail}`
      this.probes.set(deviceId, { at: Date.now(), ok: false, reason })
      return reason
    }
  }
}

/** Either a usable target, or the reason there is none. */
export type FeasibilityResult =
  | { readonly ok: true; readonly agent: Agent; readonly status: Agent['status'] }
  | { readonly ok: false; readonly reason: string }
