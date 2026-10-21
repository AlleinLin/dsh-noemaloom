import { createHash, randomUUID } from 'node:crypto';
import type { DispatchContext, JsonRecord } from '../../ports/contracts.js';
import { NexusError } from '../../ports/contracts.js';

export const digest = (text: string | Buffer): string =>
  `sha256:${createHash('sha256').update(text).digest('hex')}`;
export const memoryId = (prefix = 'mem'): string => `${prefix}_${randomUUID()}`;
export const estimateTokens = (text: string): number => {
  const cjk = text.match(/[\u3400-\u9fff]/gu)?.length ?? 0;
  return Math.ceil(cjk * 0.75 + (text.length - cjk) / 4);
};
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value)
    .filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export const projectId = (root: string): string => `prj_${digest(root).slice(7, 31)}`;

export interface MemoryScope {
  kind: 'user' | 'project' | 'session' | 'team' | 'reusable';
  ownerId: string;
  projectId?: string;
  sessionId?: string;
  branchSelector?: { mode: 'all' | 'include'; refs?: string[] };
  pathSelector?: string[];
  sensitivity: 'public' | 'internal' | 'private' | 'restricted';
  sharing: 'local' | 'team' | 'git' | 'provider';
}
export interface EvidenceRef extends JsonRecord {
  id?: string;
  type: string;
  uri?: string;
  hash?: string;
  excerpt?: string;
  locator?: unknown;
}
export interface MemoryRecord {
  schemaVersion: number;
  id: string;
  revision: number;
  title: string;
  body: string;
  summary: string;
  contentHash: string;
  track: 'profile' | 'facts' | 'key' | 'project_log' | 'daily_log';
  layer: 'anchor' | 'structural' | 'knowledge' | 'contextual' | 'self';
  kind: string;
  scope: MemoryScope;
  lifecycle: string;
  validation: string;
  authority: 'candidate' | 'derived' | 'canonical';
  confidence: string;
  importance: string;
  createdAt: string;
  updatedAt: string;
  tags: string[];
  evidence: EvidenceRef[];
  origin: JsonRecord;
  conditions?: JsonRecord;
  validFrom?: string;
  validUntil?: string;
  observedAt?: string;
  relations: string[];
  protection: { kind: string; reason?: string; actor?: string; at?: string };
  sourceRefs: JsonRecord[];
  [key: string]: unknown;
}
export function assertNoSecret(value: unknown): void {
  const text = typeof value === 'string' ? value : stableJson(value);
  if (/-----BEGIN (?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----|(?:sk-(?:proj-)?[a-zA-Z0-9_-]{20,})|(?:gh[pousr]_[A-Za-z0-9]{30,})|(?:AKIA[0-9A-Z]{16})|(?:Bearer\s+[A-Za-z0-9._-]{24,})/u.test(text)) {
    throw new NexusError('SECRET_REJECTED', '内容包含高确定性的凭据形态，已拒绝保存；请删除凭据并使用 credentialRef');
  }
}
export function redactSecrets(text: string): { text: string; quarantined: boolean } {
  try { assertNoSecret(text); return { text, quarantined: false }; }
  catch { return { text: '[该段含疑似凭据，已隔离]', quarantined: true }; }
}
export function scopeFor(root: string, ctx?: DispatchContext): MemoryScope {
  if (ctx?.scopeLevel === 'global') return { kind: 'user', ownerId: ctx.actorId ?? 'local-user', sensitivity: 'private', sharing: 'local' };
  if (ctx?.scopeLevel === 'session') return { kind: 'session', ownerId: ctx.actorId ?? 'local-user', projectId: projectId(root), sessionId: ctx.sessionId, sensitivity: 'private', sharing: 'local' };
  return { kind: 'project', ownerId: ctx?.actorId ?? 'local-user', projectId: projectId(root), sensitivity: 'private', sharing: 'local', branchSelector: { mode: 'all' } };
}
export function canRead(record: MemoryRecord, root: string, ctx?: DispatchContext, filter?: JsonRecord): boolean {
  const scope = record.scope;
  if (ctx?.scopeLevel === 'global' && (scope.projectId || !['user', 'reusable'].includes(scope.kind))) return false;
  if (scope.kind === 'team' && !ctx?.permissions?.has(`memory.team:${scope.ownerId}`)) return false;
  if (scope.kind === 'session' && scope.sessionId !== ctx?.sessionId) return false;
  if (scope.kind === 'user' && scope.ownerId !== (ctx?.actorId ?? 'local-user')) return false;
  if ((scope.kind === 'project' || scope.projectId) && scope.projectId !== projectId(root)) return false;
  if (filter?.projectId && scope.projectId !== filter.projectId) return false;
  return true;
}
export function trustProjection(record: MemoryRecord, options: JsonRecord = {}): JsonRecord {
  const reasons: string[] = [];
  let trust = 'insufficient_evidence';
  if (record.validation === 'invalid' || record.validation === 'doubted' || record.lifecycle === 'superseded') {
    trust = 'contradicted'; reasons.push('记录已被证伪、质疑或替代');
  } else if (record.validation === 'stale' || record.validation === 'expired' ||
    (record.validUntil && Date.parse(record.validUntil) < Date.now()) ||
    (record.validFrom && Date.parse(record.validFrom) > Date.now())) {
    trust = 'stale'; reasons.push('记录不在当前有效时间或已标记过期');
  } else if (record.authority === 'candidate' || record.validation === 'unverified') {
    trust = 'review_required'; reasons.push('候选或尚未独立验证');
  } else if (record.evidence.length && ['verified', 'reviewed'].includes(record.validation)) {
    trust = 'trusted';
  } else { reasons.push('缺少可检查依据'); }
  if (options.currentHash && record.evidence.some(e => e.type === 'file_range' && e.hash && e.hash !== options.currentHash)) {
    trust = 'stale'; reasons.push('引用文件内容已变更');
  }
  return { trust, reasons, authority: record.authority, validation: record.validation, evaluationVersion: 1, qualification: trust === 'trusted' ? 'accepted' : 'deferred' };
}
