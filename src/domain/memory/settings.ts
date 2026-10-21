import { createHash } from 'node:crypto';
import type { DispatchContext, JsonRecord, NexusServices } from '../../ports/contracts.js';
import { projectId } from './types.js';
export function memorySettingsKeys(root: string, ctx?: DispatchContext) {
  const keys = ['global'];
  if (ctx?.scopeLevel !== 'global') keys.push(projectId(root));
  if (ctx?.sessionId && ctx?.scopeLevel !== 'workspace') keys.push(`${projectId(root)}/${ctx.sessionId}`);
  return keys;
}
export function memoryEngineScope(root: string, ctx?: DispatchContext) {
  return ctx?.scopeLevel === 'global' ? 'global' : ctx?.sessionId && ctx.scopeLevel === 'session'
    ? `${projectId(root)}_${createHash('sha256').update(ctx.sessionId).digest('hex').slice(0, 24)}` : projectId(root);
}
export async function memorySettings(services: NexusServices, root: string, ctx?: DispatchContext): Promise<JsonRecord> {
  const config: JsonRecord = { cognitionEnabled: false, captureEnabled: false, autoInject: false, syncEnabled: false, strategy: 'default-three-tier' };
  for (const key of memorySettingsKeys(root, ctx)) Object.assign(config, (await services.store.get<JsonRecord>('memory-settings', key))?.value);
  return config;
}
