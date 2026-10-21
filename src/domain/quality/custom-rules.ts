import { NexusError, type DispatchContext, type JsonRecord, type NexusRequest, type NexusServices } from '../../ports/contracts.js';
import { scopeKeys, scopeLevel } from '../scope.js';
import { RULES, type Diagnostic, type RuleDefinition } from './rules.js';
import { newId, object, sha256 } from './shared.js';

const feature = 'quality-rules';
const maxRules = 100;
export interface CustomRule {
  ruleId: string;
  summary: string;
  message: string;
  severityDefault: 'error' | 'warning';
  matchMode: 'contains' | 'missing';
  matchText: string;
  fileGlobs: string[];
  caseSensitive: boolean;
}
export interface CatalogRule extends RuleDefinition {
  custom?: CustomRule;
  ownerScope?: string;
  editable?: boolean;
}
interface RuleLayer { scope: string; revision: number; config: JsonRecord }
interface RuleSettings { layers: RuleLayer[]; local: RuleLayer }

function boundedText(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) {
    throw new NexusError('INVALID_ARGUMENT', `${label}须为非空文本，最多 ${max} 个字符`);
  }
  return value;
}
export function validateCustomRule(value: unknown): CustomRule {
  const data = object(value);
  const fields = ['ruleId', 'summary', 'message', 'severityDefault', 'matchMode', 'matchText', 'fileGlobs', 'caseSensitive'];
  if (Object.keys(data).some(key => !fields.includes(key))) throw new NexusError('INVALID_ARGUMENT', '自定义规则包含不支持的字段');
  const ruleId = boundedText(data.ruleId, '规则 ID', 120);
  if (!/^custom\.[a-z0-9][a-z0-9._-]{0,111}$/.test(ruleId) || RULES.some(rule => rule.ruleId === ruleId)) {
    throw new NexusError('INVALID_ARGUMENT', '自定义规则 ID 必须使用 custom. 前缀，不能修改内置规则');
  }
  const summary = boundedText(data.summary, '规则名称', 120).trim();
  const message = boundedText(data.message, '诊断说明', 500).trim();
  const matchText = boundedText(data.matchText, '检测文本', 2048);
  if (!['error', 'warning'].includes(String(data.severityDefault))) throw new NexusError('INVALID_ARGUMENT', '严重级别必须为 error 或 warning');
  if (!['contains', 'missing'].includes(String(data.matchMode))) throw new NexusError('INVALID_ARGUMENT', '检测方式仅支持包含文本或缺少文本');
  if (typeof data.caseSensitive !== 'boolean') throw new NexusError('INVALID_ARGUMENT', '大小写选项必须为布尔值');
  if (!Array.isArray(data.fileGlobs) || !data.fileGlobs.length || data.fileGlobs.length > 20) throw new NexusError('INVALID_ARGUMENT', '适用文件须提供 1 至 20 个路径模式');
  const fileGlobs = [...new Set(data.fileGlobs.map(value => {
    const pattern = boundedText(value, '文件模式', 160).trim();
    if (/^[\\/]|[\\:\u0000-\u001f?\[\]{}]/.test(pattern) || pattern.split('/').some(segment =>
      !segment || segment === '.' || segment === '..' || (segment.includes('**') && segment !== '**'))) {
      throw new NexusError('INVALID_ARGUMENT', '文件模式使用相对路径；仅支持 * 与独立路径段 **，不接受反斜杠、父目录或其他通配语法');
    }
    return pattern;
  }))];
  return { ruleId, summary, message, matchText, fileGlobs, severityDefault: data.severityDefault as CustomRule['severityDefault'],
    matchMode: data.matchMode as CustomRule['matchMode'], caseSensitive: data.caseSensitive };
}

/** Wildcard matching uses bounded string operations, never user regex or code. */
function segmentMatches(pattern: string, value: string): boolean {
  let p = 0, v = 0, star = -1, retry = 0;
  while (v < value.length) {
    if (p < pattern.length && pattern[p] === value[v]) { p++; v++; }
    else if (pattern[p] === '*') { star = p++; retry = v; }
    else if (star >= 0) { p = star + 1; v = ++retry; }
    else return false;
  }
  while (pattern[p] === '*') p++;
  return p === pattern.length;
}
export function customRuleApplies(rule: CustomRule, filename: string): boolean {
  const segments = filename.replaceAll('\\', '/').split('/');
  return rule.fileGlobs.some(pattern => {
    let positions = new Set([0]);
    for (const segment of pattern.split('/')) {
      const next = new Set<number>();
      for (const position of positions) {
        if (segment === '**') for (let end = position; end <= segments.length; end++) next.add(end);
        else if (position < segments.length && segmentMatches(segment, segments[position]!)) next.add(position + 1);
      }
      positions = next;
    }
    return positions.has(segments.length);
  });
}
const asciiFold = (value: string) => value.replace(/[A-Z]/g, letter => letter.toLowerCase());
export function scanCustomRules(filename: string, text: string, rules: CustomRule[]): { diagnostics: Diagnostic[]; unknown: string[] } {
  const diagnostics: Diagnostic[] = [], unknown: string[] = [];
  const sourceHash = sha256(Buffer.from(text));
  const lineStarts = [0];
  for (let index = 0; index < text.length; index++) if (text[index] === '\n') lineStarts.push(index + 1);
  const location = (offset: number) => {
    let low = 0, high = lineStarts.length;
    while (low + 1 < high) { const mid = (low + high) >>> 1; if (lineStarts[mid]! <= offset) low = mid; else high = mid; }
    return { line: low + 1, column: offset - lineStarts[low]! + 1 };
  };
  for (const rule of rules.filter(item => customRuleApplies(item, filename))) {
    if (diagnostics.length >= 1000) { unknown.push('自定义文本检测达到单文件 1000 条诊断上限，结果不完整'); break; }
    const haystack = rule.caseSensitive ? text : asciiFold(text), needle = rule.caseSensitive ? rule.matchText : asciiFold(rule.matchText);
    const first = haystack.indexOf(needle);
    const add = (offset: number, occurrence: number, missing = false) => {
      const endOffset = missing ? 0 : offset + rule.matchText.length;
      const start = location(offset), end = location(endOffset), anchor = missing ? '<file>' : text.slice(offset, endOffset);
      const logical = sha256({ rule: rule.ruleId, path: filename, anchor });
      diagnostics.push({
        occurrenceId: sha256({ logical, occurrence, sourceHash, offset }), fingerprint: sha256({ logical, occurrence }),
        ruleId: rule.ruleId, detectorRef: 'nexus-literal/v1', severity: rule.severityDefault, messageCode: rule.ruleId,
        message: rule.message, path: filename, range: { startLine: start.line, startColumn: start.column,
          endLine: end.line, endColumn: end.column, unit: 'utf16' }, sourceHash, anchor, state: 'confirmed', fixability: 'none',
      });
    };
    if (rule.matchMode === 'missing') { if (first < 0) add(0, 0, true); continue; }
    let offset = first, occurrence = 0;
    while (offset >= 0 && diagnostics.length < 1000) {
      add(offset, occurrence++);
      offset = haystack.indexOf(needle, offset + needle.length);
    }
    if (offset >= 0) unknown.push(`${rule.ruleId}: 单文件达到 1000 条诊断上限，结果不完整`);
  }
  return { diagnostics, unknown };
}

export function qualityRuleScope(root: string, context?: DispatchContext): string {
  return sha256(scopeKeys(root, context));
}
export function createCustomRules(services: NexusServices) {
  async function settings(context?: DispatchContext): Promise<RuleSettings> {
    return services.invoke('scope', { action: 'settings', params: { feature } }, context) as Promise<RuleSettings>;
  }
  async function catalog(context?: DispatchContext) {
    const state = await settings(context), level = scopeLevel(context);
    const rules: CatalogRule[] = RULES.map(rule => ({ ...rule, ownerScope: 'builtin', editable: false }));
    const seen = new Set(rules.map(rule => rule.ruleId));
    for (const layer of state.layers) {
      const stored = object(layer.config.defaults).rules;
      if (stored === undefined) continue;
      if (!Array.isArray(stored) || stored.length > maxRules) throw new NexusError('INVALID_ARGUMENT', '本层自定义规则超过上限或格式无效');
      for (const item of stored) {
        const custom = validateCustomRule(item);
        if (seen.has(custom.ruleId)) throw new NexusError('INVALID_ARGUMENT', '规则 ID 重复；不能覆盖继承或内置定义', { ruleId: custom.ruleId });
        seen.add(custom.ruleId);
        rules.push({ ruleId: custom.ruleId, summary: custom.summary, severityDefault: custom.severityDefault,
          language: 'text', topic: 'custom-literal', detector: 'syntax', fixSafety: 'none', exceptions: [],
          knownGaps: ['按原始 UTF-8 文件进行字面文本检测，包含注释和字符串；不推断语义，不执行模型描述',
            '大小写不敏感选项仅折叠英文字母 A–Z；自定义文本检测每文件合计最多 1000 条诊断'],
          sourceRef: `${layer.scope} 自定义规则`, custom, ownerScope: layer.scope, editable: layer.scope === level });
      }
    }
    return { rules, localRevision: state.local.revision, scope: level, revision: sha256(rules), state };
  }
  async function mutate(request: NexusRequest, context?: DispatchContext) {
    const params = object(request.params), state = await settings(context);
    const revision = request.expectedRevision;
    if (!Number.isSafeInteger(revision) || revision !== state.local.revision) throw new NexusError('REVISION_CONFLICT', '规则已更新，请刷新后重试');
    const available = await catalog(context);
    const defaults = object(state.local.config.defaults), localRules = (defaults.rules as CustomRule[] | undefined) ?? [];
    if (params.ruleId !== undefined && typeof params.ruleId !== 'string') throw new NexusError('INVALID_ARGUMENT', '规则 ID 必须为字符串');
    const id = typeof params.ruleId === 'string' ? params.ruleId : undefined;
    const current = available.rules.find(rule => rule.ruleId === id);
    if (id && (!current?.custom || !current.editable)) throw new NexusError('PERMISSION_DENIED', '仅可编辑或删除本层拥有的自定义规则；继承和内置规则保留');
    let next: CustomRule[], ruleId: string;
    if (request.action === 'rules/delete') {
      if (!id) throw new NexusError('INVALID_ARGUMENT', '请选择本层自定义规则');
      ruleId = id; next = localRules.filter(rule => rule.ruleId !== id);
    } else {
      if (object(params.rule).ruleId !== undefined) throw new NexusError('INVALID_ARGUMENT', '规则 ID 由系统分配；编辑时使用 ruleId 引用已有规则');
      ruleId = id ?? `custom.${newId('rule')}`;
      const custom = validateCustomRule({ ...object(params.rule), ruleId });
      next = id ? localRules.map(rule => rule.ruleId === id ? custom : rule) : [...localRules, custom];
      if (next.length > maxRules) throw new NexusError('BUDGET_EXHAUSTED', `每层最多保存 ${maxRules} 条自定义规则`);
    }
    const nextDefaults = { ...defaults };
    if (next.length) nextDefaults.rules = next; else delete nextDefaults.rules;
    const config = { ...state.local.config };
    if (Object.keys(nextDefaults).length) config.defaults = nextDefaults; else delete config.defaults;
    const action = Object.keys(config).length ? 'configure' : 'reset';
    // The public quality mutation authorizes this fixed, validated settings write.
    const permissions = new Set(context?.permissions); permissions.add(`scope.${action}`);
    await services.invoke('scope', { action, expectedRevision: revision,
      params: { feature, ...(Object.keys(config).length ? { config } : {}) } }, { ...context, permissions });
    return { ruleId, scope: scopeLevel(context), operation: request.action === 'rules/delete' ? 'deleted' : id ? 'updated' : 'created' };
  }
  return { catalog, mutate };
}
