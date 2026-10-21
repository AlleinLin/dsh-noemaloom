import { scopeOf } from '@deepseek-ai/dsh-scope';
import type { Capability, ModelRequest } from '../ports/contracts.js';
import type { HostContext } from './types.js';

export type ExecutionPolicy = Pick<ModelRequest, 'readOnly' | 'allowChildren' | 'maxDepth' | 'actorRole' | 'allowedCapabilityIds'>;
const readTools = new Set(['read', 'read_file', 'read_files', 'ls', 'list', 'list_directory', 'glob', 'grep', 'search', 'search_files', 'web_search', 'web_fetch']);
const childTools = /(?:^|_)(?:subagent|spawn|delegate|team_create|team_spawn)(?:$|_)/i;
export function installExecutionPolicy(
  ctx: HostContext,
  policies: Map<string, ExecutionPolicy>,
  capabilities: (domain: string) => Capability[],
): () => void {
  const policyOf = (agent: any): ExecutionPolicy | undefined => agent && (policies.get(agent.id) ?? agent.ctx?.get?.('nexusExecutionPolicy'));
  const guard = ctx.get('tools')?.guard?.((exec: any) => {
    const policy = policyOf(exec.agent);
    if (!policy) return;
    const args = exec.arguments as any;
    const domain = exec.name.startsWith('nexus_') ? exec.name.slice(6) : undefined;
    const action = typeof args?.action === 'string' ? args.action : '';
    if (policy.allowChildren === false && (childTools.test(exec.name)
      || domain && ['agents', 'workflow', 'graph'].includes(domain) && /(?:spawn|fork|delegate|team|run|generate|start|execute)/i.test(action))) {
      return 'Nexus execution policy forbids child delegation';
    }
    if (policy.allowedCapabilityIds?.length && !policy.allowedCapabilityIds.includes(domain ? `${domain}.${action}` : exec.name)) {
      return 'Capability is outside this activation grant';
    }
    if (policy.readOnly) {
      if (domain) {
        const capability = capabilities(domain).find(item => item.action === action);
        if (!capability || capability.mutating || domain === 'runtime' && /(?:shell|exec|run)/i.test(action)) return 'Nexus reviewer is read-only';
      } else if (!readTools.has(exec.name)) return 'Unclassified host tool is unavailable to a read-only activation';
    }
  });
  const created = ctx.on('agent/created', ({ agent }: any) => {
    const inherited = agent.session?.header?.parentSession ? policies.get(agent.session.header.parentSession) : undefined;
    if (!policies.has(agent.id) && inherited) policies.set(agent.id, { ...inherited });
    const policy = policyOf(agent);
    if (!policy?.readOnly) return;
    const tools = agent.ctx?.get?.('tools');
    if (!tools?.restrict || !tools?.schemas) return;
    const visible = tools.schemas(scopeOf(agent.ctx)).map((item: any) => item.name);
    const denied = visible.filter((name: string) => !name.startsWith('nexus_') && !readTools.has(name));
    if (denied.length) {
      const dispose = tools.restrict({ deny: denied });
      agent.ctx.effect(() => dispose, 'Nexus read-only activation tool mask');
    }
  });
  return () => { guard?.(); if (typeof created === 'function') created(); };
}
