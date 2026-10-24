import { randomUUID } from 'node:crypto';
import type { NexusStore } from '../../ports/contracts.js';
import type { HostContext } from '../types.js';
import { AgentMailbox } from './broker.js';
import { CrossSessionMailbox } from './cross-session.js';
import { communicationError } from './directory.js';
import { communicationTools, COMMUNICATION_GUIDANCE } from './tools.js';
import { COMMUNICATION_TOOLS } from '../../shared/communications.js';
import { isHumanInputMessage } from '../../shared/step-pause.js';
import { symbols } from '@deepseek-ai/cordis';

interface Patch { target: object; originals: Map<string, PropertyDescriptor | undefined>; replacements: Map<string, unknown> }
const PATCH_FIELDS = ['description', 'parameters', 'output', 'execute', 'presentCall', 'presentResult', 'finalizeContent', 'projectContent', 'isConcurrencySafe', 'timeoutMs'];
const CALL_CAPACITY = 512, PATCH_CAPACITY = 16384, LIVE_CAPACITY = 4096;

/**
 * Reviewed native hook. Uses public tools/get + tools/change and replaces
 * each exact definition in its existing owner's layer. No new shadow layer,
 * private registry access, policy bypass, or "try legacy then fallback".
 *
 * Definitions stay in place, so preset/Team disposers and explicit capability
 * restrictions retain authority. Unsupported immutable definitions fail closed.
 */
export function registerAgentCommunications(ctx: HostContext, store: NexusStore) {
  const mailbox = new AgentMailbox(ctx, store), crossSession = new CrossSessionMailbox(ctx, store), tools = ctx.get('tools');
  for (const name of ['get_message_status', 'read_agent_messages']) {
    if (tools.get(name)) throw communicationError('NX_MAIL_HOOK_CONFLICT', `${name} is already registered by another owner.`);
  }
  const definitions = communicationTools(mailbox), patches: Patch[] = [], patched = new WeakMap<object, Patch>();
  const removers: Array<() => void> = [];
  removers.push(ctx.provide('nexusCrossSessionMailbox', crossSession));
  const readNames = ['get_message_status', 'read_agent_messages'];
  const communicationNames = [...COMMUNICATION_TOOLS, ...readNames];
  // Cordis returns a fresh traced view on service access; public original identity is stable.
  const raw = (value: any): any => value?.[symbols.original] ?? value;
  const owns = (value: any) => {
    const target = raw(value), entry = target && patched.get(target);
    return Boolean(entry && [...entry.replacements].every(([field, replacement]) => Object.getOwnPropertyDescriptor(target, field)?.value === replacement));
  };
  const active = new Set<Promise<unknown>>();
  let closing = false, scanning = false;
  let serviceFailure: unknown, disposing: Promise<void> | undefined;
  const warn = (code: string) => { try { ctx.logger?.warn('Unified agent communication hook', code); } catch {} };
  const listen = (name: string, handler: (...args: any[]) => any, options?: unknown) => {
    const remove = ctx.on(name, handler, options); if (typeof remove === 'function') removers.push(remove);
  };
  const tracked = <T>(start: () => Promise<T>) => {
    if (active.size >= CALL_CAPACITY) return Promise.reject(communicationError('NX_MAIL_RESOURCE_LIMIT', 'Communication call budget reached; wait for existing calls to settle.'));
    const work = Promise.resolve().then(start);
    active.add(work); void work.finally(() => active.delete(work)).catch(() => {}); return work;
  };
  const patch = (target: any, values: Record<string, unknown>, fields = Object.keys(values)) => {
    target = raw(target);
    if (owns(target)) return;
    if (patches.length >= PATCH_CAPACITY) throw communicationError('NX_MAIL_HOOK_UNSUPPORTED', 'Communication hook restoration budget reached; reload the plugin before adding more definitions.');
    const originals = new Map<string, PropertyDescriptor | undefined>(), replacements = new Map<string, unknown>();
    // Inspect every field before making any mutation.
    for (const field of fields) {
      const descriptor = Object.getOwnPropertyDescriptor(target, field);
      if (descriptor && !descriptor.configurable && !('value' in descriptor && descriptor.writable)
        || !descriptor && !Object.isExtensible(target)) {
        throw communicationError('NX_MAIL_HOOK_UNSUPPORTED', `Host communication definition ${String(target.name ?? '')}.${field} is immutable; unified installation is unsupported.`);
      }
      originals.set(field, descriptor); replacements.set(field, values[field]);
    }
    const applied: string[] = [];
    try {
      for (const field of fields) {
        const original = originals.get(field);
        Object.defineProperty(target, field, original && !original.configurable
          ? { ...original, value: values[field] }
          : { value: values[field], configurable: true, writable: true, enumerable: true });
        applied.push(field);
      }
    } catch {
      for (const field of applied.reverse()) {
        const original = originals.get(field);
        if (original) Object.defineProperty(target, field, original); else Reflect.deleteProperty(target, field);
      }
      throw communicationError('NX_MAIL_HOOK_UNSUPPORTED', 'Host communication properties could not be installed atomically.');
    }
    const entry = { target, originals, replacements };
    patches.push(entry); patched.set(target, entry);
  };
  const hookServices = () => {
    for (const [name, kind] of [['subagents', 'subagent'], ['agentTeams', 'team']] as const) {
      const service = raw(ctx.get(name));
      if (!service?.sendMessage) continue;
      // The concrete own-property check is stable across Cordis traced views.
      if ((service.sendMessage as any)?.nexusMailbox === mailbox) continue;
      const send = kind === 'subagent'
        ? async (sender: any, id: string, content: any[], options: { signal: AbortSignal }) => {
          const receipt = await mailbox.send(sender, { target: id, content, requestId: `service:${randomUUID()}` }, options.signal);
          if (!receipt.messageId) throw communicationError('NX_MAIL_DELIVERY_PENDING', `Inspect ${receipt.message_id}; recipient delivery is ${receipt.state}. Do not duplicate.`);
          return receipt.messageId;
        }
        : async (sender: any, request: { target: string; content: any[]; signal: AbortSignal }) => {
          const receipt = await mailbox.send(sender, { target: request.target, content: request.content, requestId: `service:${randomUUID()}` }, request.signal);
          if (!receipt.messageId) throw communicationError('NX_MAIL_DELIVERY_PENDING', `Inspect ${receipt.message_id}; recipient delivery is ${receipt.state}. Do not duplicate.`);
          return { messageId: receipt.messageId };
        };
      const wrapper = (...args: any[]) => {
        if (closing || serviceFailure) return Promise.reject(communicationError('NX_MAIL_HOOK_UNSUPPORTED', 'Unified communication hook is unavailable.'));
        return tracked(() => (send as any)(...args));
      };
      Object.defineProperty(wrapper, 'nexusMailbox', { value: mailbox });
      patch(service, { sendMessage: wrapper });
    }
  };
  const scan = (strict = false) => {
    if (closing || scanning) return;
    scanning = true;
    try {
      hookServices(); serviceFailure = undefined;
      const live = ctx.get('agents')?.list?.() ?? [];
      if (live.length > LIVE_CAPACITY) throw communicationError('NX_MAIL_HOOK_UNSUPPORTED', 'Live agent hook budget exceeded.');
      const scopes = [undefined, ...live];
      for (const agent of scopes.slice(1)) {
        if (owns(agent) || typeof agent.cancel !== 'function') continue;
        const original = agent.cancel;
        patch(agent, { cancel: (cause: any, ...args: any[]) => {
          if (cause?.kind === 'user') { mailbox.pausedByUser(agent.id); crossSession.mailbox.pausedByUser(agent.id); }
          return original.call(agent, cause, ...args);
        } });
      }
      for (const scope of scopes) for (const name of COMMUNICATION_TOOLS) {
        const definition = tools.get(name, scope);
        if (!definition || owns(definition)) continue;
        const replacement = definitions.get(name)!;
        try {
          patch(definition, {
            ...replacement,
            execute: (...args: any[]) => {
              if (closing || serviceFailure) return Promise.reject(communicationError('NX_MAIL_HOOK_UNSUPPORTED', 'Unified communication hook is unavailable.'));
              return tracked(() => (replacement.execute as any)(...args));
            },
          }, PATCH_FIELDS);
        } catch (error) { if (strict) throw error; warn((error as any)?.code ?? 'NX_MAIL_HOOK_UNSUPPORTED'); }
      }
    } catch (error) {
      serviceFailure = error;
      if (strict) throw error;
      warn((error as any)?.code ?? 'NX_MAIL_HOOK_UNSUPPORTED');
    }
    finally { scanning = false; }
  };
  const restore = () => {
    for (const entry of [...patches].reverse()) for (const [field, original] of entry.originals) {
      // Never overwrite a later owner's replacement.
      if (Object.getOwnPropertyDescriptor(entry.target, field)?.value !== entry.replacements.get(field)) continue;
      try { if (original) Object.defineProperty(entry.target, field, original); else Reflect.deleteProperty(entry.target, field); }
      catch { warn('NX_MAIL_HOOK_RESTORE_FAILED'); }
    }
  };
  const unregister = () => {
    for (const remove of removers.splice(0).reverse()) { try { remove(); } catch { warn('NX_MAIL_HOOK_UNREGISTER_FAILED'); } }
  };
  const registeredReads = new Map(readNames.map(name => {
    const definition = definitions.get(name)!;
    return [name, { ...definition, execute: (args: any, exec: any) => {
      if (closing || serviceFailure) return Promise.reject(communicationError('NX_MAIL_HOOK_UNSUPPORTED', 'Unified communication hook is unavailable.'));
      return tracked(async () => {
        if (name === 'get_message_status') {
          try { return await (definition.execute as any)(args, exec); }
          catch (error: any) {
            if (error?.code !== 'NX_MAIL_RECEIPT_NOT_FOUND') throw error;
            return crossSession.mailbox.status(exec.agent, args.message_id, exec.signal);
          }
        }
        const own = await (definition.execute as any)(args, exec);
        // Same receipt protocol, separate explicit scope. Cross-root traffic
        // never joins the native task directory or claims runtime parentage.
        const cross = await crossSession.mailbox.read(exec.agent, exec.signal, args.offset ?? 0, args.limit ?? 30)
          .catch((error: any) => {
            if (error?.code === 'NX_MAIL_SCOPE_DENIED' || error?.code === 'NX_MAIL_SENDER_STALE') return undefined;
            throw error;
          });
        return cross ? { ...own, cross_session_messages: cross.messages,
          cross_session_next_offset: cross.next_offset } : own;
      });
    } }] as const;
  }));
  try {
    // Fail synchronously before a partially installed hook can escape to its caller.
    scan(true);
    listen('tools/change', () => scan());
    listen('internal/service', (name: string) => { if (name === 'subagents' || name === 'agentTeams') scan(); });
    listen('agent/created', ({ agent }: any) => { scan(); mailbox.activity(agent); crossSession.mailbox.activity(agent); });
    listen('agent/disposed', ({ agent }: any) => { mailbox.observed(agent, 'disposed'); crossSession.mailbox.observed(agent, 'disposed'); });
    listen('agent/status', ({ agent }: any) => { mailbox.activity(agent); crossSession.mailbox.activity(agent); });
    listen('agent/inbox/inserted', ({ agent, message }: any) => {
      if (isHumanInputMessage(message)) { mailbox.humanResumed(agent); crossSession.mailbox.humanResumed(agent); }
      mailbox.observed(agent, 'accepted', message);
      crossSession.mailbox.observed(agent, 'accepted', message);
    });
    listen('agent/inbox/claimed', ({ agent, message }: any) => { mailbox.observed(agent, 'consumed', message); crossSession.mailbox.observed(agent, 'consumed', message); });
    listen('agent/inbox/discarded', ({ agent, message }: any) => { mailbox.observed(agent, 'discarded', message); crossSession.mailbox.observed(agent, 'discarded', message); });
    listen('session/event', (session: any, event: any) => {
      if (event.type === 'turn/end' && event.data?.reason?.kind === 'aborted' && event.data.reason.reason?.kind === 'user') {
        mailbox.pausedByUser(session.id, event.seq); crossSession.mailbox.pausedByUser(session.id, event.seq);
      }
    });
    // This guard executes inside the ordinary monotonic admission pipeline.
    const unguard = tools.guard((exec: any) => {
      if (!communicationNames.includes(exec.name)) return;
      scan();
      const definition = tools.get(exec.name, exec.agent);
      const installed = readNames.includes(exec.name) ? raw(definition) === registeredReads.get(exec.name) : owns(definition);
      if (closing || serviceFailure || !definition || !installed) return '[NX_MAIL_HOOK_UNSUPPORTED] Unified communication hook unavailable; legacy active-teammate routing is blocked.';
    });
    removers.push(unguard);
    // Missing *global* capability remains missing; never restore a denied child capability.
    // These two read tools are distinct and still subject to ordinary inherited filters.
    for (const name of ['get_message_status', 'read_agent_messages']) {
      removers.push(tools.register(registeredReads.get(name)!));
    }
    listen('system-prompt/assemble', async (_assembly: any, context: any, next: () => Promise<any>) => {
      const assembly = await next();
      if (closing) return assembly;
      scan();
      if (!tools.get('send_message', context.scope)) return assembly;
      return {
        ...assembly,
        tools: assembly.tools.map((schema: any) => {
          const current = tools.get(schema.name, context.scope);
          return communicationNames.includes(schema.name) && current && (owns(current) || raw(current) === registeredReads.get(schema.name))
            ? { ...schema, description: current.description, parameters: structuredClone(current.parameters) } : schema;
        }),
        sections: assembly.sections.map((section: any) => section.name === 'team:policy' ? {
          ...section, text: 'Team members share the workspace. Coordinate disjoint writes; respect filesystem version guards and review the final diff. '
            + 'Shared tasks retain list/get/claim/complete and revision checks. Task readiness does not start an owner. '
            + 'Use Team names for Team task ownership; use the unified mailbox for every agent message. Wait for required results before completing the parent task.',
        } : section),
        contexts: [
          ...assembly.contexts.filter((section: any) => section.name !== 'team:identity' && section.name !== 'nexus:agent-communication'),
          { name: 'nexus:agent-communication', text: COMMUNICATION_GUIDANCE, interpolate: false },
        ],
      };
    }, { prepend: true });
    scan(true);
  } catch (error) {
    closing = true; restore(); unregister();
    void mailbox.dispose().catch(() => warn('NX_MAIL_HOOK_ROLLBACK_FAILED'));
    void crossSession.dispose().catch(() => warn('NX_MAIL_HOOK_ROLLBACK_FAILED'));
    throw (error as any)?.code === 'NX_MAIL_HOOK_UNSUPPORTED' ? error
      : communicationError('NX_MAIL_HOOK_UNSUPPORTED', 'Unified communication installation failed and was rolled back.');
  }
  return {
    mailbox,
    dispose() {
      return disposing ??= (async () => {
        closing = true;
        await mailbox.dispose();
        await crossSession.dispose();
        await Promise.allSettled([...active]);
        restore(); unregister();
      })();
    },
  };
}
