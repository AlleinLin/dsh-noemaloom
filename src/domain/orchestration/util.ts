import { createHash } from 'node:crypto';
import type { ModelRef } from './types.js';

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value as object).sort().filter(key => (value as Record<string, unknown>)[key] !== undefined)
    .map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
}
export function policyHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
/** Includes endpoint/protocol/account/revision: same display name is never identity. */
export function modelKey(ref: ModelRef): string {
  return canonicalJson([ref.providerRouteId, ref.modelId, ref.endpointIdentity, ref.protocol,
    ref.revision ?? null, ref.credentialScopeId ?? null, ref.region ?? null]);
}
export function finiteNumber(value: number | undefined | null, fallback: number): number {
  return value !== undefined && value !== null && Number.isFinite(value) ? value : fallback;
}
export function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.max(minimum, Math.min(maximum, value));
}
export function isExpired(expiresAt: string | undefined, now: string): boolean {
  return expiresAt !== undefined && (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.parse(now));
}
