import { ESCALATION_TARGETS, approveEscalation, validateEscalationArgs,
  sandboxDenialMarker, escalationHintMarker } from '@deepseek-ai/dsh-sandbox';
import { FsError } from '@deepseek-ai/dsh-fs';

const modes = ['read-only', ...ESCALATION_TARGETS];
const standingPolicy = (ctx, exec) => ctx.sandboxPolicy.resolve(
  exec.agent ? { session: exec.agent.session } : {});

// Schemas are registry-global; authority is resolved for each individual call.
export function escalationFields(confined) {
  return confined ? {
    sandbox_permissions: { type: 'string', enum: [...ESCALATION_TARGETS],
      description: 'Normally OMIT: use the current session permissions automatically. Only after a sandbox denial, request the narrowest wider mode for this exact operation; genuine widening requires user approval. This field requests escalation, not a stricter sandbox.' },
    justification: { type: 'string', description: 'Normally OMIT. Only for genuine permission escalation: a nonempty explanation of why this exact operation needs wider access, in the user’s language.' },
  } : {};
}
export async function resolvePolicy(ctx, name, args, exec, confined = true) {
  exec.signal?.throwIfAborted();
  // Copy the authoritative policy: approval services must not be able to mutate
  // a shared resolver object and thereby rewrite our before/after comparison.
  const resolved = await standingPolicy(ctx, exec);
  exec.signal?.throwIfAborted();
  const policy = { ...resolved };
  if (!modes.includes(policy.mode)) throw new Error('Unknown current sandbox policy; no operation executed.');
  const requested = args.sandbox_permissions;
  if (args.justification !== undefined && typeof args.justification !== 'string')
    throw new Error('Invalid justification: expected a string; no operation executed.');
  if (requested === undefined) return policy;
  if (!ESCALATION_TARGETS.includes(requested))
    throw new Error('Invalid sandbox_permissions: expected workspace-write or danger-full-access; no operation executed.');
  if (!confined) throw new Error('This provider does not expose sandbox escalation');
  // This is an escalation-only field. A stale equal/lower request grants no
  // authority, so discard it (including obsolete/blank reason boilerplate).
  // Never mutate args: the native runtime freezes the original arguments.
  if (modes.indexOf(requested) <= modes.indexOf(policy.mode)) return policy;
  try {
    validateEscalationArgs(requested, args.justification);
  } catch (error) {
    throw new Error(`Permission escalation requires a nonempty justification: current mode=${policy.mode}, requested=${requested}. No operation executed. Supply a reason for this exact operation to request user approval, or omit both permission fields to use the current session policy.`, { cause: error });
  }
  const mode = await approveEscalation({
    requestedMode: requested, justification: args.justification,
    effectiveMode: policy.mode, subject: 'operation',
  }, { approver: ctx.get('approval'), agent: exec.agent, callId: exec.callId, toolName: name, signal: exec.signal });
  exec.signal?.throwIfAborted();
  const current = await standingPolicy(ctx, exec);
  exec.signal?.throwIfAborted();
  if (current.mode !== policy.mode || current.workspaceRoot !== policy.workspaceRoot)
    throw new Error('Session sandbox policy changed while approval was pending; no operation executed. Recheck the current session permissions before another request.');
  return { ...policy, mode };
}
export function mapFsError(error, policy) {
  if (!(error instanceof FsError) || error.code !== 'FS_SANDBOX_DENIED') return error;
  return new FsError(`${sandboxDenialMarker(policy.mode)}\n${escalationHintMarker('operation')}`, 'FS_SANDBOX_DENIED', { cause: error });
}
