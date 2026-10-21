import type { ActionDefinition, Data, DomainDefinition, NexusScope, PageId } from './types.js';
import { isRecord } from './types.js';

export const navigation: { id: PageId; title: string; icon: string; group?: string }[] = [
  { id: 'sessions', title: '会话', icon: 'chat' }, { id: 'engineering', title: '工程', icon: 'folder' },
  { id: 'resources', title: '产物与资源', icon: 'file' }, { id: 'orchestration', title: '编排', icon: 'branch' },
  { id: 'tasks', title: '任务', icon: 'check', group: '工作台' }, { id: 'memory', title: '记忆', icon: 'memory' },
  { id: 'knowledge', title: '知识', icon: 'book' }, { id: 'graph', title: '图谱', icon: 'graph' },
  { id: 'context', title: '上下文与压缩', icon: 'layers' }, { id: 'cache', title: '缓存与费用', icon: 'gauge' },
  { id: 'quality', title: '工程质量', icon: 'shield', group: '更多能力' }, { id: 'review', title: '代码审查', icon: 'code' },
  { id: 'recovery', title: '运行与恢复', icon: 'history' }, { id: 'connections', title: '连接与远程', icon: 'link' },
  { id: 'extensions', title: '能力与扩展', icon: 'grid' }, { id: 'usage', title: '用量', icon: 'chart' },
];
/**
 * Original plugins own their full interfaces. This list contains only Nexus
 * additions; it must not turn each scope into another copy of the host.
 */
export const scopeNavigationPages: Record<NonNullable<NexusScope['level']>, { id: PageId; title: string; icon: string }[]> = {
  global: [
    { id: 'orchestration', title: '执行蓝图', icon: 'branch' },
    { id: 'resources', title: '资源库', icon: 'file' },
    { id: 'extensions', title: '扩展', icon: 'grid' },
    { id: 'connections', title: '连接配置', icon: 'link' },
    { id: 'quality', title: '质量记录', icon: 'shield' },
    { id: 'review', title: '审查记录', icon: 'code' },
    { id: 'recovery', title: '恢复记录', icon: 'history' },
    { id: 'search', title: '搜索', icon: 'search' },
  ],
  workspace: [
    { id: 'orchestration', title: '执行计划', icon: 'branch' },
    { id: 'quality', title: '质量检查', icon: 'shield' },
    { id: 'review', title: '代码审查', icon: 'code' },
    { id: 'recovery', title: '恢复点', icon: 'history' },
    { id: 'resources', title: '工程产物', icon: 'file' },
    { id: 'connections', title: '工程连接', icon: 'link' },
    { id: 'search', title: '工程搜索', icon: 'search' },
  ],
  session: [
    { id: 'orchestration', title: '执行计划', icon: 'branch' },
    { id: 'cache', title: '压缩与恢复', icon: 'layers' },
    { id: 'quality', title: '质量检查', icon: 'shield' },
    { id: 'review', title: '代码审查', icon: 'code' },
    { id: 'recovery', title: '恢复点', icon: 'history' },
    { id: 'resources', title: '会话产物', icon: 'file' },
    { id: 'search', title: '会话搜索', icon: 'search' },
  ],
};
export function pagesForScope(level: NonNullable<NexusScope['level']>) { return scopeNavigationPages[level]; }
export function defaultPageForScope(level: NonNullable<NexusScope['level']>): PageId {
  return level === 'global' ? 'resources' : 'orchestration';
}
export function isAuxiliaryPage(page: PageId, level: NonNullable<NexusScope['level']>): boolean {
  return page === 'settings' && level === 'global' || pagesForScope(level).some(item => item.id === page);
}
export const pageDomains: Record<PageId, string[]> = {
  home: ['workflow', 'memory', 'context'], sessions: ['runtime', 'agents'], tasks: ['workflow'],
  orchestration: ['workflow', 'agents'], engineering: ['files', 'runtime'], memory: ['memory'],
  knowledge: ['artifact', 'memory'], graph: ['graph'], context: ['context'], cache: ['context', 'usage'],
  quality: ['quality'], review: ['review'], recovery: ['recovery'], resources: ['resources', 'files', 'artifact'],
  extensions: ['extensions', 'resources', 'agents'], connections: ['connections'], usage: ['usage'], search: ['search'], settings: ['resources', 'runtime', 'connections', 'usage'],
};
export function normalizeCatalog(snapshot: Data): DomainDefinition[] {
  const source = snapshot?.domains ?? snapshot?.capabilities?.domains ?? snapshot?.modules ?? snapshot?.capabilities ?? snapshot?.catalog ?? [];
  if (Array.isArray(source)) return source.map((item: any) => ({
    id: String(item.id ?? item.domain ?? item.name ?? ''),
    capabilities: normalizeActions(item.capabilities ?? item.actions ?? []),
  })).filter(item => item.id);
  if (isRecord(source)) return Object.entries(source).map(([id, value]: [string, any]) => ({ id, capabilities: normalizeActions(value.capabilities ?? value.actions ?? value) }));
  return [];
}
function normalizeActions(value: any): ActionDefinition[] {
  if (Array.isArray(value)) return value.map(item => typeof item === 'string' ? { action: item, description: item } : item);
  if (isRecord(value)) return Object.entries(value).map(([action, data]: [string, any]) => ({ action, description: data?.description ?? action, ...data }));
  return [];
}
export function capability(catalog: DomainDefinition[], domain: string, action: string): ActionDefinition | undefined {
  return catalog.find(item => item.id === domain)?.capabilities.find(item => item.action === action);
}
export function findAction(catalog: DomainDefinition[], domain: string, choices: string[], fallback?: string): string {
  const available = catalog.find(item => item.id === domain)?.capabilities ?? [];
  return choices.find(action => available.some(item => item.action === action)) ?? fallback ?? choices[0] ?? 'list';
}
export const fieldLabels: Record<string, string> = {
  id: '身份 ID', title: '标题', name: '名称', content: '内容', text: '正文', query: '查询', path: '工作区相对路径', destination: '目标路径',
  goal: '目标', prompt: '执行指令', description: '说明', scope: '作用范围', type: '类型', model: '模型', provider: '提供方',
  sessionId: '会话 ID', runId: '运行 ID', planId: '计划 ID', expertId: '代理 ID', canvasId: '画布 ID', nodeId: '节点 ID',
  branch: '分支', tags: '标签', command: '命令', args: '参数', timeoutMs: '超时（毫秒）', credentialRef: '凭据引用',
  expectedHash: '基础内容 Hash', expectedRevision: '基础修订号', mode: '模式', limit: '加载上限', dryRun: '先预演', enabled: '启用',
  nodes: '执行节点', edges: '依赖连线', checks: '独立验证器', role: '角色', dependsOn: '依赖节点', blueprintId: '蓝图 ID',
  message: '提交说明', body: '正文', url: '地址', filename: '文件名', format: '格式', source: '来源', target: '目标',
};
export const actionLabels: Record<string, string> = {
  list: '浏览记录', status: '查看状态', overview: '概览', get: '读取详情', create: '新建', update: '保存修改', remove: '移除',
  delete: '删除', search: '搜索', query: '检索', read: '读取', write: '保存文件', import: '导入', export: '导出',
  plan: '建立执行计划', run: '开始真实执行', cancel: '取消运行', pause: '暂停', resume: '继续', retry: '重试',
  'plans/list': '执行计划', 'plan/get': '计划详情', 'todo/create': '新建任务', 'todo/list': '任务清单',
  'blueprints/list': '编排蓝图', 'blueprints/compile': '编译蓝图', 'models/list': '可用模型', 'models.list': '可用模型',
  'git.status': '仓库状态', 'git.diff': '查看差异', 'git.log': '提交历史', 'git.commit': '提交已暂存修改',
  'terminal.run': '执行命令', 'terminal.open': '打开宿主终端', 'jobs.list': '后台作业',
  compress: '压缩选中范围', decompress: '恢复压缩内容', decide: '自治压缩决策', prepare: '编译上下文',
  'epochs/get': '配置 epoch', 'cache/report': '缓存证据', 'wire/diff': '前缀差异', 'policy/get': '压缩策略',
};
export const labelAction = (action: string) => actionLabels[action] ?? action.replace(/[./]/g, ' · ');
export function seedParams(domain: string, action: string): Data {
  const seeds: Record<string, Data> = {
    'workflow:plan': { goal: '', nodes: [{ id: 'implement', kind: 'agent', role: 'implementer', prompt: '', dependsOn: [], checks: [] }], budgets: { maxCost: 5 } },
    'workflow:run': { planId: '', idempotencyKey: `run-${Date.now().toString(36)}` },
    'workflow:todo/create': { content: '', scope: 'project', status: 'pending', quadrant: 4 },
    'workflow:blueprints/compile': { id: '', goal: '' },
    'agents:create': { name: '', description: '', persona: '', category: 'custom', locale: 'zh', enabled: true },
    'agents:room/create': { name: '', participants: [] },
    'files:write': { path: '', content: '', createOnly: true },
    'files:mkdir': { path: '' }, 'files:rename': { path: '', destination: '' },
    'files:search': { query: '', mode: 'content', path: '' },
    'runtime:terminal.run': { command: '', args: [], timeoutMs: 60000 },
    'runtime:git.commit': { message: '' },
    'memory:save': { record: { title: '', body: '', track: 'facts', kind: 'note', layer: 'knowledge', tags: [], evidence: [] } },
    'context:compress': { sessionId: '', ranges: [{ startRef: '', endRef: '', summary: '', topic: '' }] },
    'context:decompress': { blockId: '', mode: 'peek', full: true },
    'context:search': { query: '' },
    'graph:create': { title: '' },
    'graph:node/create': { canvasId: '', type: 'material', title: '', content: '' },
    'connections:save': { name: '', type: 'ssh', hostname: '', port: 22, username: '', credentialRef: '', forwardAgent: false },
    'connections:ssh.exec': { id: '', command: '', args: [], timeoutMs: 60000 },
    'connections:remote.pair': { type: 'native' },
    'resources:import': { path: '', dryRun: true },
    'quality:plan': { mode: 'changed', paths: ['.'], layers: ['syntax', 'format', 'affected_type', 'semantic', 'project_test'] },
    'review:preview': { mode: 'worktree', selectedPaths: [], contextPaths: [], rulePaths: [], rounds: 1 },
    'search:query': { query: '', mode: 'local' },
  };
  return seeds[`${domain}:${action}`] ?? {};
}
