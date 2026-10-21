import { realpath } from 'node:fs/promises';
import { HarnessError } from '@deepseek-ai/dsh-llm';
import type { HostContext } from '../types.js';
import type { AgentAddress, AgentDirectory } from '../../shared/communications.js';

export function communicationError(code: string, message: string): HarnessError {
  return new HarnessError(`[${code}] ${message}`, code);
}
export const pathIdentity = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path;

/** Never treats fork ancestry as runtime delegation authority. */
export async function agentDirectory(ctx: HostContext, caller: any, signal: AbortSignal): Promise<AgentDirectory> {
  signal.throwIfAborted();
  const registry = ctx.get('agents'), subagents = ctx.get('subagents');
  if (!caller || registry?.get?.(caller.id) !== caller) throw communicationError('NX_MAIL_SENDER_STALE', 'Exact live calling agent is required.');
  if (typeof registry.isOwnedBy !== 'function' || typeof registry.roots !== 'function' || typeof subagents?.listDescendants !== 'function') {
    throw communicationError('NX_MAIL_CAPABILITY_UNAVAILABLE', 'Host runtime ownership and durable child catalog are required; no agent was created.');
  }
  const live = registry.list(), roots = registry.roots(), seen = new Set<any>();
  if (live.length > 4096) throw communicationError('NX_MAIL_DIRECTORY_LIMIT', 'Live agent directory exceeds 4096 entries.');
  const identities = new Map<string, any>([[caller.id, caller]]);
  let root = caller;
  while (!roots.includes(root)) {
    if (seen.has(root) || seen.size > 64) throw communicationError('NX_MAIL_LINEAGE_INVALID', 'Runtime ownership is cyclic or exceeds the supported depth.');
    seen.add(root);
    const parents = live.filter((candidate: any) => candidate !== root && registry.isOwnedBy(root.id, candidate));
    if (parents.length !== 1) throw communicationError('NX_MAIL_PARENT_UNAVAILABLE', 'An exact live runtime owner is unavailable; do not spawn a replacement.');
    root = parents[0];
    identities.set(root.id, root);
  }
  const workspaceRoot = await realpath(root.session.header.cwd);
  if (pathIdentity(await realpath(caller.session.header.cwd)) !== pathIdentity(workspaceRoot)) {
    throw communicationError('NX_MAIL_SCOPE_DENIED', 'Caller and task root belong to different workspaces.');
  }
  const rows: AgentAddress[] = [{
    id: root.id, target: root.id, aliases: ['lead'], role: 'lead', mode: 'root',
    status: root.status === 'running' ? 'running' : 'inactive', label: 'lead', addressable: true,
  }];
  const diagnostics: AgentDirectory['diagnostics'] = [];
  const descendants = await subagents.listDescendants(root.id, signal);
  if (descendants.length > 2048) throw communicationError('NX_MAIL_DIRECTORY_LIMIT', 'Task catalog exceeds 2048 entries; narrow the task before messaging.');
  const ids = new Set<string>([root.id]);
  for (const item of descendants) {
    signal.throwIfAborted();
    if (typeof item.id !== 'string' || !item.id || item.id.length > 512) throw communicationError('NX_MAIL_LINEAGE_INVALID', 'Durable catalog has an invalid agent identity.');
    if (item.kind !== 'child') { diagnostics.push({ id: item.id, reason: String(item.reason ?? 'unavailable').slice(0, 1024) }); continue; }
    if (ids.has(item.id) || !ids.has(item.parentId)) throw communicationError('NX_MAIL_LINEAGE_INVALID', 'Durable catalog contains duplicate or disconnected identities.');
    ids.add(item.id);
    const resident = registry.get(item.id);
    if (resident) identities.set(item.id, resident);
    // Catalog ownership and runtime ownership must agree while both are live.
    const parent = registry.get(item.parentId);
    const owned = !resident || Boolean(parent && registry.isOwnedBy(item.id, parent));
    let sameWorkspace = true;
    if (resident) sameWorkspace = pathIdentity(await realpath(resident.session.header.cwd)) === pathIdentity(workspaceRoot);
    rows.push({
      id: item.id, target: item.id, parentId: item.parentId, aliases: [], role: 'subagent',
      mode: ['continuable', 'one-shot', 'external'].includes(item.mode) ? item.mode : 'unknown',
      status: !owned || !sameWorkspace ? 'unavailable' : resident?.status === 'running' ? 'running' : 'inactive',
      label: typeof item.label === 'string' && item.label.length <= 512 ? item.label : item.id,
      addressable: item.mode === 'continuable' && owned && sameWorkspace,
    });
  }
  if (!ids.has(caller.id)) throw communicationError('NX_MAIL_SCOPE_DENIED', 'Caller is not in the root-owned durable child catalog.');
  const teams = ctx.get('agentTeams');
  try {
    if (teams?.tryMembership?.(root)?.role === 'lead') {
      const members = teams.listMembers(root);
      if (members.length > 2049) throw communicationError('NX_MAIL_DIRECTORY_LIMIT', 'Team alias directory exceeds its budget.');
      for (const member of members) {
        const row = rows.find(candidate => candidate.id === member.id);
        if (row && typeof member.name === 'string' && member.name.length <= 512) {
          row.aliases.push(member.name); row.role = member.id === root.id ? 'lead' : 'teammate';
        }
      }
    }
  } catch { diagnostics.push({ id: root.id, reason: 'team-aliases-unavailable; durable ids remain usable' }); }
  for (const row of rows) {
    if (row.label && row.label !== row.id && row.id !== root.id) row.aliases.push(row.label);
    row.aliases = [...new Set(row.aliases)];
  }
  const self = rows.find(row => row.id === caller.id)!;
  if (self.parentId) rows.find(row => row.id === self.parentId)?.aliases.push('parent');
  signal.throwIfAborted();
  if ([...identities].some(([id, agent]) => registry.get(id) !== agent) || !registry.roots().includes(root)) {
    throw communicationError('NX_MAIL_SENDER_STALE', 'Live task identities changed during directory lookup; retry with the current caller.');
  }
  for (const row of rows) if (identities.has(row.id) && row.parentId && !registry.isOwnedBy(row.id, registry.get(row.parentId))) {
    throw communicationError('NX_MAIL_LINEAGE_INVALID', 'Live runtime ownership changed during directory lookup.');
  }
  return { rootId: root.id, workspaceRoot, selfId: caller.id, agents: rows, diagnostics };
}

export function resolveAgent(directory: AgentDirectory, target: unknown): AgentAddress {
  if (typeof target !== 'string' || !target.trim() || target.length > 512) throw communicationError('NX_MAIL_INVALID_TARGET', 'Provide a nonempty exact agent id or task-local alias.');
  const value = target.trim();
  const exact = directory.agents.find(row => row.id === value);
  const matches = exact ? [exact] : directory.agents.filter(row => row.aliases.includes(value));
  if (!matches.length) throw communicationError('NX_MAIL_TARGET_NOT_FOUND', `No target ${JSON.stringify(value)} in this task. Use list_agents; do not recreate an existing agent.`);
  if (matches.length !== 1) throw communicationError('NX_MAIL_TARGET_AMBIGUOUS', `Alias is ambiguous; choose an exact id: ${JSON.stringify(matches.map(row => ({ id: row.id, label: row.label })))}`);
  return matches[0];
}
