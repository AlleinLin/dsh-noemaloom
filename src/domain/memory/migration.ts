import { NexusError, type DispatchContext, type JsonRecord, type NexusServices } from '../../ports/contracts.js';
import { digest, stableJson } from './types.js';

const sources = ['A', 'L', 'E', 'M', 'O', 'S', 'H', 'V'] as const;
export function normalizeLegacyMemory(source: string, value: unknown): { records: JsonRecord[]; warnings: JsonRecord[]; externalRefs: JsonRecord[] } {
  if (!sources.includes(source as never)) throw new NexusError('UNKNOWN_SOURCE_FORMAT', '旧记忆格式需明确 A/L/E/M/O/S/H/V');
  const warnings: JsonRecord[] = [], records: JsonRecord[] = [], externalRefs: JsonRecord[] = [];
  let entries: unknown[];
  if (Array.isArray(value)) entries = value;
  else if (value && typeof value === 'object') {
    const object = value as JsonRecord;
    entries = (object.records ?? object.memories ?? object.facts ?? object.nodes ?? object.entries ?? object.items ?? []) as unknown[];
    if (!Array.isArray(entries)) throw new NexusError('INVALID_IMPORT', '旧源记录集合不是数组');
  } else if (typeof value === 'string' && source === 'E') {
    entries = value.split(/^§\s*/mu).filter(Boolean).map((body, index) => ({ title: body.split(/\r?\n/u)[0] || `Hermes ${index + 1}`, body, entryId: `hermes-${index}` }));
  } else throw new NexusError('INVALID_IMPORT', '旧源需为导出对象/数组；E可接受Hermes §文本');
  for (const [index, raw] of entries.entries()) {
    if (!raw || typeof raw !== 'object') { warnings.push({ index, code: 'RECORD_NOT_OBJECT' }); continue; }
    const item = raw as JsonRecord;
    if (Number(item.schemaVersion ?? item.schema_version ?? 1) > 1 && source !== 'V') {
      warnings.push({ index, code: 'HIGH_SCHEMA_READONLY', sourceId: item.id }); continue;
    }
    const body = String(item.body ?? item.content ?? item.text ?? item.memory ?? item.statement ?? '');
    if (!body) { warnings.push({ index, code: 'EMPTY_BODY', sourceId: item.id }); continue; }
    if ((source === 'O' || source === 'H') && item.exported !== true) {
      externalRefs.push({ source, providerId: source === 'O' ? 'openviking' : 'hindsight', externalId: item.id ?? item.fact_id ?? item.page_id, namespace: item.namespace ?? item.bank_id, state: 'external_source', metadata: { kind: item.kind ?? item.type } });
      continue;
    }
    const sourceKind = String(item.kind ?? item.type ?? item.category ?? 'fact');
    const kind = ['preference', 'decision', 'fact', 'lesson', 'document', 'evidence', 'observation', 'negative', 'unresolved', 'initiative', 'state'].includes(sourceKind) ? sourceKind : sourceKind === 'rejected' ? 'negative' : 'fact';
    const sourceLayer = String(item.layer ?? item.level ?? 'knowledge');
    const layer = ['anchor', 'structural', 'knowledge', 'contextual', 'self'].includes(sourceLayer) ? sourceLayer : sourceLayer === 'rejected' || sourceLayer === 'unresolved' ? 'knowledge' : 'contextual';
    const trackValue = String(item.track ?? item.section ?? 'facts').toLocaleLowerCase();
    const track = ({ user: 'profile', memory: 'facts', key: 'key', project: 'project_log', daily: 'daily_log', user_log: 'daily_log' } as Record<string, string>)[trackValue] ?? (['profile', 'facts', 'key', 'project_log', 'daily_log'].includes(trackValue) ? trackValue : 'facts');
    records.push({
      title: String(item.title ?? item.name ?? body.split(/\r?\n/u)[0]).slice(0, 160),
      body, summary: String(item.summary ?? '').slice(0, 500), kind, layer, track,
      lifecycle: item.archived || item.is_archived ? 'archived' : item.invalidated ? 'superseded' : String(item.lifecycle ?? 'current'),
      validation: ['verified', 'reviewed', 'stale', 'invalid'].includes(String(item.validation)) ? item.validation : 'unverified',
      authority: 'candidate', confidence: item.confidence ?? 'unknown', importance: item.importance ?? 'normal',
      tags: Array.isArray(item.tags) ? item.tags : [], conditions: item.conditions ?? {}, evidence: item.evidence ?? item.evidenceRefs ?? [],
      observedAt: item.observedAt ?? item.observed_at, validFrom: item.validFrom ?? item.valid_from, validUntil: item.validUntil ?? item.valid_until,
      relations: item.relations ?? item.depends_on ?? [], protection: item.protection ?? { kind: item.protected ? 'user_pinned' : 'none' },
      sourceRefs: [{ sourceFormat: source, sourceId: item.id ?? item.entryId ?? item.fact_id ?? `${index}`, sourceHash: digest(stableJson(raw)), sourceKind, sourceLayer, legacyMetadata: item }],
    });
  }
  return { records, warnings, externalRefs };
}
