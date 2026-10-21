import type { Config } from '../../adapters/upstream/billion/index.js';
import { jsonClone } from '../storage/canonical.js';

const POLICY_FIELDS = [
  'tiers', 'nudge', 'promotionThreshold', 'truncate', 'compress', 'protectedTools',
  'protectedLatestTools', 'neverPreserveRecentTools', 'preserveRecentTools',
  'preserveRecentMessages', 'preserveRecentTokens', 'modelContextLimit',
  'absorb', 'rules', 'crush', 'ccr', 'messageFilters',
] as const satisfies readonly (keyof Config)[];

export type ContextPolicyDto = Partial<Pick<Config, typeof POLICY_FIELDS[number]>>;

/** Executable host predicates stay in the kernel; RPC exposes declared policy data. */
export function contextPolicyDto(config: Partial<Config> | undefined): ContextPolicyDto | null {
  if (!config) return null;
  const data: Record<string, unknown> = {};
  for (const field of POLICY_FIELDS) if (config[field] !== undefined) data[field] = config[field];
  return jsonClone(data) as ContextPolicyDto;
}
