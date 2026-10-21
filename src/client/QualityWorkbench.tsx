import * as React from 'react';
import type { Data, ViewContext } from './types.js';
import { rows } from './types.js';
import { Button, DataView, PageHeader, QueryState, SearchField, StateMessage, Status, Tabs, Time, useQuery } from './components.js';
import { EvidenceDisclosure, SaveDefaults, ScopeSource, useScopedDefaults, useWorkbenchOperation } from './workbench.js';
import { qualityRuleSelection } from './quality-rule-model.js';

export const pathLines = (value: string) => [...new Set(value.split(/\r?\n/).map(line => line.trim()).filter(Boolean))];
export function qualityPlanParams(mode: string, paths: string, ruleIds: string[], layers: string[], commandIds: string[]) {
  return { mode, ...(pathLines(paths).length ? { paths: pathLines(paths) } : {}), ruleIds, layers, commandIds };
}
export function reviewPreviewParams(form: Data) {
  const selectedPaths = pathLines(form.paths);
  return { mode: form.mode, vcs: form.vcs, ...(selectedPaths.length ? { selectedPaths } : {}), contextPaths: pathLines(form.contextPaths),
    rulePaths: pathLines(form.rulePaths), rounds: Number(form.rounds), allowNetwork: form.allowNetwork === true,
    businessRequirement: form.businessRequirement, ...(form.oldRef ? { oldRef: form.oldRef } : {}), ...(form.newRef ? { newRef: form.newRef } : {}) };
}
const layerNames: Data = { syntax: '内置语法检查', format: '格式检查', affected_type: '类型检查', semantic: '语义证据', project_test: '项目测试' };
const detectorNames: Data = { syntax: '内置语法检测', 'type-aware': '需要类型检查器', 'manual-semantic': '需要独立语义证据', external: '需要外部工具' };
const listText = (value: any) => Array.isArray(value) ? value.join('\n') : '';
const scopeNames: Data = { global: '全局', workspace: '工作区', session: '当前会话' };
const emptyRule = () => ({ summary: '', message: '', matchMode: 'contains', matchText: '', fileGlobs: '**/*.ts\n**/*.tsx', severityDefault: 'warning', caseSensitive: true });

export function QualityWorkbench({ context, review = false, rulesOnly = false }: { context: ViewContext; review?: boolean; rulesOnly?: boolean }) {
  const key = JSON.stringify(context.scope);
  return review ? <ReviewWorkbench key={key} context={context} /> : <CheckWorkbench key={key} context={context} rulesOnly={rulesOnly} />;
}

function CheckWorkbench({ context, rulesOnly = false }: { context: ViewContext; rulesOnly?: boolean }) {
  const [tab, setTab] = React.useState(rulesOnly ? 'rules' : 'setup');
  const [mode, setMode] = React.useState('changed'), [paths, setPaths] = React.useState('');
  const [selected, setSelected] = React.useState<string[]>();
  const [layers, setLayers] = React.useState(['syntax']), [commands, setCommands] = React.useState<string[]>([]);
  const [search, setSearch] = React.useState(''), [plan, setPlan] = React.useState<Data>();
  const [runId, setRunId] = React.useState('');
  const [ruleForm, setRuleForm] = React.useState<Data>(), [editingId, setEditingId] = React.useState<string>();
  const [deletingId, setDeletingId] = React.useState(''), [ruleMessage, setRuleMessage] = React.useState('');
  const [draftRevision, setDraftRevision] = React.useState(0), [deletingRevision, setDeletingRevision] = React.useState(0);
  const settings = useScopedDefaults(context, 'quality', 'plan');
  const catalog = useQuery(context.api, 'quality', 'catalog', { complete: true }, { scope: context.scope, refresh: context.refreshToken });
  const adopted = useQuery(context.api, 'quality', 'rules/settings', {}, { scope: context.scope, refresh: context.refreshToken });
  const profile = useQuery(context.api, 'quality', 'discover', {}, { scope: context.scope, refresh: context.refreshToken, enabled: tab === 'setup' });
  const history = useQuery(context.api, 'quality', 'status', {}, { scope: context.scope, refresh: context.refreshToken, enabled: !rulesOnly });
  const report = useQuery(context.api, 'quality', 'report', { runId, limit: 100 }, { scope: context.scope, enabled: Boolean(runId), refresh: context.refreshToken });
  const workflow = useQuery(context.api, 'quality', 'lifecycle/status', {}, { scope: context.scope, enabled: tab === 'workflow', refresh: context.refreshToken });
  const operation = useWorkbenchOperation(context, () => { history.reload(); report.reload(); });
  const ruleOperation = useWorkbenchOperation(context);
  const rawRuleIds: string[] = selected ?? settings.effective.ruleIds ?? adopted.data?.ruleIds ?? [];
  const rules = rows(catalog.data);
  const selection = qualityRuleSelection(rawRuleIds, rules as Array<Data & { ruleId: string }>);
  const ruleIds = selection.valid;
  const discovered = profile.data?.value ?? profile.data;
  const availableCommands = rows(discovered?.commands);
  const configured = selected === undefined;
  React.useEffect(() => {
    if (selected && JSON.stringify(selected) === JSON.stringify(settings.effective.ruleIds ?? adopted.data?.ruleIds)) setSelected(undefined);
  }, [settings.effective.ruleIds, adopted.data?.ruleIds, selected]);
  const invalidate = () => setPlan(undefined);
  const choose = (id: string, checked: boolean) => { setSelected(checked ? [...new Set([...rawRuleIds, id])] : rawRuleIds.filter(value => value !== id)); invalidate(); };
  const refreshRules = () => { catalog.reload(); adopted.reload(); invalidate(); };
  const editRule = (rule?: Data) => {
    setEditingId(rule?.ruleId); setRuleForm(rule?.custom ? { ...rule.custom, fileGlobs: listText(rule.custom.fileGlobs) } : emptyRule());
    setDraftRevision(catalog.data?.localRevision ?? 0);
    setDeletingId(''); setRuleMessage('');
  };
  async function saveRule() {
    if (!ruleForm) return;
    const result = await ruleOperation.run(editingId ? '保存规则修改' : '新建自定义规则', 'quality', 'rules/save', {
      ...(editingId ? { ruleId: editingId } : {}),
      rule: { summary: ruleForm.summary, message: ruleForm.message.trim() || ruleForm.summary,
        matchMode: ruleForm.matchMode, matchText: ruleForm.matchText, fileGlobs: pathLines(ruleForm.fileGlobs),
        severityDefault: ruleForm.severityDefault, caseSensitive: ruleForm.caseSensitive },
    }, { mutating: true, revision: draftRevision });
    if (result) {
      setRuleForm(undefined); setEditingId(undefined); refreshRules();
      setRuleMessage(`规则已保存到${scopeNames[context.scope.level ?? 'workspace']}。${editingId ? '后续计划使用修改后的定义；已有计划需重新生成。' : '可在下方调整并保存规则选择，后续计划按有效选择执行。'}`);
    }
  }
  async function deleteRule(id: string) {
    const result = await ruleOperation.run('删除自定义规则', 'quality', 'rules/delete', { ruleId: id },
      { mutating: true, revision: deletingRevision });
    if (result) {
      setSelected(rawRuleIds.filter(value => value !== id)); setDeletingId(''); setRuleForm(undefined); refreshRules();
      setRuleMessage('规则已删除，历史报告保留。请保存当前选择，清除已保存选择中的该规则。');
    }
  }
  async function createPlan() {
    const result = await operation.run('生成检查计划', 'quality', 'plan', qualityPlanParams(mode, paths, ruleIds, layers, commands), { mutating: true });
    if (result) setPlan(result);
  }
  async function execute() {
    if (!plan) return;
    const result = await operation.run('执行检查', 'quality', 'run', { planId: plan.id, planHash: plan.planHash, idempotencyKey: `quality:${plan.id}` }, { mutating: true });
    if (result?.id) { setRunId(result.id); setTab('runs'); }
  }
  const prerequisites = Boolean(catalog.data && !catalog.error && !catalog.loading && settings.query.data && adopted.data && !adopted.error && !settings.query.error);
  const totalRules = catalog.data?.total ?? rules.length;
  const ruleBusy = Boolean(ruleOperation.busy);
  return <div className="nexus-page nexus-workbench">
    {!rulesOnly && <><PageHeader title="质量检查"><Button icon="refresh" onClick={() => { refreshRules(); profile.reload(); history.reload(); report.reload(); settings.query.reload(); }}>刷新</Button></PageHeader>
    <Tabs value={tab} onChange={setTab} tabs={[{ id: 'setup', label: '配置与检查' }, { id: 'rules', label: '规则选择' }, { id: 'runs', label: '运行记录' }, { id: 'workflow', label: '工程关卡' }]} /></>}
    {operation.feedback}{settings.operation.feedback}{ruleOperation.feedback}
    {ruleMessage && <p className="nexus-workbench-feedback" role="status">{ruleMessage}</p>}
    {(tab === 'setup' || tab === 'rules') && <>
      <QueryState query={settings.query}><ScopeSource context={context} settings={settings} field="plan/ruleIds" fallback={adopted.data?.source?.kind === 'project-file' ? '.nexus/quality.json' : '内置规则集'} /></QueryState>
      <QueryState query={adopted}><p className="nexus-workbench-source">{context.scope.level === 'global' ? '规则将由工作区与会话继承' : adopted.data?.source?.path ? `项目规则文件：${adopted.data.source.path}` : '项目尚未采纳规则文件'} · 已选择 {catalog.data ? ruleIds.length : '…'} / {catalog.data ? totalRules : '…'} 条{!configured ? ' · 有未保存的选择' : ''}</p></QueryState>
      {catalog.data && selection.unknown.length > 0 && <div className="nexus-quality-rule-warning" role="status"><p>另有 {selection.unknown.length} 个已失效或不属于当前范围的规则 ID，未计入选择数：{selection.unknown.join('、')}</p><Button onClick={() => { setSelected(ruleIds); invalidate(); }}>移除失效选择</Button></div>}
    </>}
    {tab === 'setup' && <>
      <section className="nexus-workbench-section"><h2>检查范围</h2><div className="nexus-workbench-form">
        <label className="nexus-field"><span>默认范围</span><select value={mode} onChange={e => { setMode(e.target.value); invalidate(); }}><option value="changed">当前变更</option><option value="full">全部源码</option></select></label>
        <label className="nexus-field"><span>指定文件（可选，每行一个）</span><textarea rows={3} placeholder="留空使用上述范围" value={paths} onChange={e => { setPaths(e.target.value); invalidate(); }} /></label>
      </div><div className="nexus-workbench-checks">{Object.entries(layerNames).map(([id, name]) => <label key={id}><input type="checkbox" checked={layers.includes(id)} onChange={e => { setLayers(e.target.checked ? [...layers, id] : layers.filter(value => value !== id)); invalidate(); }} />{name}</label>)}</div>
      <p className="nexus-workbench-hint">内置扫描仅覆盖支持的语法规则；其他检测器需要实际工具或独立审查。缺少证据会记录为覆盖限制。</p>
      <QueryState query={profile}>{availableCommands.length > 0 && <details className="nexus-workbench-evidence"><summary>选择已发现的项目工具或脚本（{availableCommands.length}）</summary><div className="nexus-workbench-command-list">{availableCommands.map(command => <label key={command.id}><input type="checkbox" checked={commands.includes(command.id)} onChange={e => { setCommands(e.target.checked ? [...commands, command.id] : commands.filter(id => id !== command.id)); invalidate(); }} /><span><strong>{command.id}</strong><small>{command.command} {(command.args ?? []).join(' ')} · 来源 {command.source?.path}</small><small>{command.sideEffects}</small></span></label>)}</div></details>}</QueryState>
      <div className="nexus-actions"><Button onClick={() => setTab('rules')}>调整 {ruleIds.length} 条规则</Button><Button primary busy={Boolean(operation.busy)} disabled={!prerequisites || selection.unknown.length > 0 || !layers.length || !profile.data || profile.loading || Boolean(profile.error)} onClick={() => void createPlan()}>生成检查计划</Button></div></section>
      {plan && <section className="nexus-workbench-section nexus-workbench-preview"><h2>待执行的检查计划</h2><p>{plan.files?.length ?? 0} 个文件 · {plan.ruleIds?.length ?? 0} 条规则 · {plan.commands?.length ?? 0} 个外部命令 · 尚未执行</p>{plan.unknown?.length > 0 && <ul className="nexus-workbench-limitations">{plan.unknown.map((item: string, index: number) => <li key={index}>{item}</li>)}</ul>}<EvidenceDisclosure title="文件、工具与快照证据" value={plan} /><Button primary busy={Boolean(operation.busy)} onClick={() => void execute()}>执行此计划</Button></section>}
    </>}
    {tab === 'rules' && <QueryState query={catalog}><div className="nexus-toolbar"><SearchField value={search} onChange={setSearch} placeholder="搜索规则名称或 ID…" /><Button onClick={() => { setSelected(rules.map(rule => rule.ruleId)); invalidate(); }}>全选</Button><Button onClick={() => { setSelected([]); invalidate(); }}>清空</Button><Button primary icon="plus" disabled={ruleBusy || catalog.loading} onClick={() => editRule()}>新建自定义规则</Button></div>
      <p className="nexus-workbench-hint">自定义规则按全局 → 工作区 → 会话继承，只能在所属层编辑或删除。当前可用 {totalRules} 条{search ? `，搜索显示 ${rules.filter(rule => `${rule.ruleId} ${rule.summary}`.toLowerCase().includes(search.toLowerCase())).length} 条` : ''}。</p>
      {ruleForm && <form className="nexus-quality-rule-editor" onSubmit={event => { event.preventDefault(); void saveRule(); }}>
        <h2>{editingId ? '编辑自定义规则' : '新建自定义规则'} · {scopeNames[context.scope.level ?? 'workspace']}</h2>
        <p className="nexus-workbench-hint">检测按文件原始文本执行，包含注释和字符串。说明文字用于诊断展示；检测条件由下方字段决定。无需模型，不执行代码或正则。</p>
        <div className="nexus-workbench-form">
          <label className="nexus-field"><span>规则名称</span><input required maxLength={120} autoFocus value={ruleForm.summary} onChange={e => setRuleForm({ ...ruleForm, summary: e.target.value })} placeholder="例如：禁止遗留 TODO" /></label>
          <label className="nexus-field"><span>严重级别</span><select value={ruleForm.severityDefault} onChange={e => setRuleForm({ ...ruleForm, severityDefault: e.target.value })}><option value="warning">警告</option><option value="error">错误</option></select></label>
          <label className="nexus-field"><span>检测方式</span><select value={ruleForm.matchMode} onChange={e => setRuleForm({ ...ruleForm, matchMode: e.target.value })}><option value="contains">包含指定文本时报告</option><option value="missing">缺少指定文本时报告</option></select></label>
          <label className="nexus-field"><span>适用文件（相对路径，每行一个）</span><textarea required rows={3} maxLength={3300} value={ruleForm.fileGlobs} onChange={e => setRuleForm({ ...ruleForm, fileGlobs: e.target.value })} /><small>* 匹配同级文件名，** 匹配任意层目录；例如 **/*.ts、src/**、README.md。最多 20 行。</small></label>
          <label className="nexus-field nexus-workbench-wide"><span>检测文本（原样匹配，支持多行）</span><textarea required rows={3} maxLength={2048} value={ruleForm.matchText} onChange={e => setRuleForm({ ...ruleForm, matchText: e.target.value })} placeholder="TODO" /></label>
          <label className="nexus-field nexus-workbench-wide"><span>诊断说明（可选）</span><textarea rows={2} maxLength={500} value={ruleForm.message} onChange={e => setRuleForm({ ...ruleForm, message: e.target.value })} placeholder="留空使用规则名称" /></label>
        </div>
        <label className="nexus-workbench-check"><input type="checkbox" checked={ruleForm.caseSensitive} onChange={e => setRuleForm({ ...ruleForm, caseSensitive: e.target.checked })} />区分英文字母大小写</label>
        <p className="nexus-workbench-hint">在“内置语法检查”层运行；只读取可验证的 UTF-8 文本文件。缺少文本时每文件报告一次；空白检测文本不接受。</p>
        <div className="nexus-actions"><Button primary type="submit" busy={ruleBusy} disabled={catalog.loading || !ruleForm.summary.trim() || !ruleForm.matchText.trim() || !pathLines(ruleForm.fileGlobs).length}>保存规则</Button><Button type="button" disabled={ruleBusy} onClick={() => { setRuleForm(undefined); setEditingId(undefined); }}>取消</Button></div>
      </form>}
      <div className="nexus-workbench-rule-list">{rules.filter(rule => `${rule.ruleId} ${rule.summary}`.toLowerCase().includes(search.toLowerCase())).map(rule => <article key={rule.ruleId}><label><input type="checkbox" checked={ruleIds.includes(rule.ruleId)} onChange={e => choose(rule.ruleId, e.target.checked)} /><span><strong>{rule.summary}</strong><code>{rule.ruleId}</code></span></label><div className="nexus-workbench-rule-meta"><span>{(adopted.data?.ruleSeverities?.[rule.ruleId] ?? rule.severityDefault) === 'error' ? '错误' : '警告'}</span><span>{rule.custom ? `字面文本 · ${rule.custom.matchMode === 'missing' ? '缺少时报告' : '包含时报告'}` : detectorNames[rule.detector] ?? rule.detector}</span></div><small>来源：{rule.custom ? `${scopeNames[rule.ownerScope]}自定义规则 · ${rule.editable ? '本层可编辑' : '继承，只读'}` : rule.sourceRef}{rule.custom && ` · 文件：${rule.custom.fileGlobs.join('、')}`}</small><div className="nexus-actions"><Button disabled={Boolean(operation.busy)} onClick={() => void operation.run('读取规则来源', 'quality', 'explain', { ruleIds: [rule.ruleId] }).then(result => { if (result) context.inspect({ title: rule.summary, kind: '规则定义与原始来源', data: result }); })}>原文与检测边界</Button>{rule.custom && rule.editable && <><Button disabled={ruleBusy || catalog.loading} onClick={() => editRule(rule)}>编辑</Button><Button disabled={ruleBusy || catalog.loading} onClick={() => { setDeletingId(rule.ruleId); setDeletingRevision(catalog.data?.localRevision ?? 0); }}>删除</Button></>}</div>
        {deletingId === rule.ruleId && <div className="nexus-quality-rule-delete" role="alert"><span>删除“{rule.summary}”？此层以下会立即失去该规则，历史报告保留。</span><Button disabled={ruleBusy} onClick={() => void deleteRule(rule.ruleId)}>确认删除</Button><Button disabled={ruleBusy} onClick={() => setDeletingId('')}>取消</Button></div>}
      </article>)}</div>
      <div className="nexus-workbench-save"><p>保存选择后用于后续检查计划。“恢复继承”仅清除本层的选择覆盖；规则定义使用各自的编辑与删除操作，内置和继承定义保留。</p><SaveDefaults context={context} settings={settings} values={{ ruleIds }} fields={['ruleIds']} disabled={!prerequisites || ruleBusy || selection.unknown.length > 0} onApplied={result => { setSelected(result.effective?.defaults?.plan?.ruleIds ?? adopted.data?.ruleIds ?? []); invalidate(); }} /><Button onClick={() => { setSelected(undefined); invalidate(); }}>重新载入已保存选择</Button></div>
    </QueryState>}
    {tab === 'runs' && <RunRecords context={context} review={false} history={history} report={report} runId={runId} select={setRunId} />}
    {tab === 'workflow' && <QueryState query={workflow}><DataView value={workflow.data} /></QueryState>}
  </div>;
}

const reviewDefaults: Data = { mode: 'worktree', vcs: 'git', paths: '', contextPaths: '', rulePaths: '', oldRef: '', newRef: '', rounds: 1, allowNetwork: false, businessRequirement: '' };
function ReviewWorkbench({ context }: { context: ViewContext }) {
  const [tab, setTab] = React.useState('setup'), [form, setForm] = React.useState<Data>();
  const [preview, setPreview] = React.useState<Data>(), [runId, setRunId] = React.useState('');
  const settings = useScopedDefaults(context, 'review', 'preview');
  const saved = settings.effective;
  const effectiveForm: Data = { ...reviewDefaults, ...saved, paths: listText(saved.selectedPaths), contextPaths: listText(saved.contextPaths), rulePaths: listText(saved.rulePaths) };
  const value: Data = form ?? effectiveForm;
  const history = useQuery(context.api, 'review', 'status', {}, { scope: context.scope, refresh: context.refreshToken });
  const report = useQuery(context.api, 'review', 'report', { runId, limit: 100 }, { scope: context.scope, enabled: Boolean(runId), refresh: context.refreshToken });
  const operation = useWorkbenchOperation(context, () => { history.reload(); report.reload(); });
  const set = (key: string, next: any) => { setForm({ ...value, [key]: next }); setPreview(undefined); };
  const params = reviewPreviewParams(value);
  async function capture() {
    const result = await operation.run('捕获审查预览', 'review', 'preview', params, { mutating: true });
    if (result) setPreview(result);
  }
  async function execute() {
    if (!preview) return;
    const result = await operation.run('执行独立审查', 'review', 'execute', { previewId: preview.id, previewHash: preview.previewHash, idempotencyKey: `review:${preview.id}` }, { mutating: true });
    if (result?.id) { setRunId(result.id); setTab('runs'); }
  }
  return <div className="nexus-page nexus-workbench">
    <PageHeader title="代码审查"><Button icon="refresh" onClick={() => { history.reload(); report.reload(); settings.query.reload(); setPreview(undefined); }}>刷新</Button></PageHeader>
    <Tabs value={tab} onChange={setTab} tabs={[{ id: 'setup', label: '范围与预览' }, { id: 'rules', label: '审查规则' }, { id: 'runs', label: '运行与发现' }]} />
    {operation.feedback}{settings.operation.feedback}
    {tab !== 'runs' && <QueryState query={settings.query}><ScopeSource context={context} settings={settings} field="preview/rulePaths" fallback="未配置审查规则文档" /></QueryState>}
    {tab === 'setup' && <section className="nexus-workbench-section"><h2>审查范围</h2><div className="nexus-workbench-form">
      <label className="nexus-field"><span>版本控制</span><select value={value.vcs} onChange={e => { const next = e.target.value; setForm({ ...value, vcs: next, mode: next === 'svn' && ['staged', 'unstaged', 'project'].includes(value.mode) ? 'worktree' : value.mode }); setPreview(undefined); }}><option value="git">Git</option><option value="svn">SVN</option></select></label>
      <label className="nexus-field"><span>审查模式</span><select value={value.mode} onChange={e => set('mode', e.target.value)}><option value="worktree">当前工作树</option>{value.vcs === 'git' && <><option value="staged">已暂存</option><option value="unstaged">未暂存</option></>}<option value="commit">单个提交</option><option value="range">历史范围</option>{value.vcs === 'git' && <option value="project">全项目当前态</option>}</select></label>
      {['commit', 'range'].includes(value.mode) && <><label className="nexus-field"><span>旧端点（范围模式）</span><input value={value.oldRef} onChange={e => set('oldRef', e.target.value)} /></label><label className="nexus-field"><span>新端点 / 提交</span><input value={value.newRef} onChange={e => set('newRef', e.target.value)} /></label></>}
      <label className="nexus-field"><span>主审文件（可选，每行一个）</span><textarea rows={3} value={value.paths} placeholder="留空由审查模式确定范围" onChange={e => set('paths', e.target.value)} /></label>
      <label className="nexus-field"><span>补充上下文文件（每行一个）</span><textarea rows={3} value={value.contextPaths} onChange={e => set('contextPaths', e.target.value)} /></label>
      <label className="nexus-field"><span>独立审查轮次</span><input type="number" min={1} max={3} value={value.rounds} onChange={e => set('rounds', e.target.value)} /></label>
      {value.vcs === 'svn' && ['commit', 'range'].includes(value.mode) && <label className="nexus-workbench-check"><input type="checkbox" checked={value.allowNetwork === true} onChange={e => set('allowNetwork', e.target.checked)} />允许读取 SVN 远程历史端点</label>}
      <label className="nexus-field nexus-workbench-wide"><span>业务要求（可选）</span><textarea rows={3} value={value.businessRequirement} onChange={e => set('businessRequirement', e.target.value)} /></label>
    </div><p className="nexus-workbench-hint">已选 {params.rulePaths.length} 个规则文档。静态审查的来源读取与模型调用会留证；测试执行情况需要独立证据。</p><div className="nexus-actions"><Button onClick={() => setTab('rules')}>编辑审查规则</Button><Button primary busy={Boolean(operation.busy)} disabled={!settings.query.data || Boolean(settings.query.error)} onClick={() => void capture()}>捕获并预览</Button></div></section>}
    {tab === 'rules' && <section className="nexus-workbench-section"><h2>项目审查规则文档</h2><p className="nexus-workbench-hint">工作区相对路径，每行一个。预览会读取并固定文档内容。</p><label className="nexus-field"><span>规则文档路径</span><textarea rows={7} value={value.rulePaths} placeholder={'AGENTS.md\n.nexus/review-guidelines.md'} onChange={e => set('rulePaths', e.target.value)} /></label><SaveDefaults context={context} settings={settings} values={{ rulePaths: params.rulePaths }} fields={['rulePaths']} onApplied={result => { setForm({ ...value, rulePaths: listText(result.effective?.defaults?.preview?.rulePaths) }); setPreview(undefined); }} /><div className="nexus-actions"><Button onClick={() => { setForm(undefined); setPreview(undefined); }}>重新载入已保存配置</Button><Button primary busy={Boolean(operation.busy)} disabled={!settings.query.data || Boolean(settings.query.error)} onClick={() => void capture()}>预览规则与源码</Button></div></section>}
    {preview && tab !== 'runs' && <section className="nexus-workbench-section nexus-workbench-preview"><h2>待执行的审查预览</h2><p>{preview.snapshot?.files?.filter((file: Data) => file.primary).length ?? 0} 个主审文件 · {preview.snapshot?.files?.filter((file: Data) => !file.primary).length ?? 0} 个补充来源 · {preview.rounds} 轮</p><div className="nexus-workbench-source-list">{(preview.snapshot?.files ?? []).map((file: Data) => <details key={file.path}><summary><strong>{file.path}</strong><span>{file.primary ? '主审源码' : params.rulePaths.includes(file.path) ? '审查规则' : '补充上下文'} · {file.state}</span></summary>{file.reason && <p>{file.reason}</p>}<pre data-nexus-verbatim="">{file.right?.text ?? file.left?.text ?? '没有已捕获正文'}</pre><small>SHA-256：{file.right?.hash ?? file.left?.hash ?? '未捕获'}</small></details>)}</div><EvidenceDisclosure title="发送范围、预算与快照证据" value={{ disclosure: preview.disclosure, budget: preview.budget, snapshotId: preview.snapshot?.id, hash: preview.previewHash, limitations: preview.snapshot?.limitations }} /><Button primary busy={Boolean(operation.busy)} onClick={() => void execute()}>执行此预览的独立审查</Button></section>}
    {tab === 'runs' && <RunRecords context={context} review history={history} report={report} runId={runId} select={setRunId} />}
  </div>;
}

function RunRecords({ context, review, history, report, runId, select }: { context: ViewContext; review: boolean; history: ReturnType<typeof useQuery>; report: ReturnType<typeof useQuery>; runId: string; select(id: string): void }) {
  const items = rows(history.data), data = report.data ?? {}, findings = rows(review ? data.findings : data.diagnostics);
  const operation = useWorkbenchOperation(context);
  return <div className="nexus-workbench-runs"><QueryState query={history}>
    {items.length ? <label className="nexus-field"><span>选择运行记录</span><select value={runId} onChange={e => select(e.target.value)}><option value="">选择一次实际运行…</option>{items.map(item => <option key={item.id} value={item.id}>{item.id} · {item.state ?? item.status} · {item.reportStatus ?? item.verification}</option>)}</select></label> : <StateMessage title="尚无运行记录">生成计划或捕获预览后，执行一次检查以获取证据。</StateMessage>}
  </QueryState>{runId && <QueryState query={report}><section className="nexus-workbench-section"><div className="nexus-section-heading"><h2>{review ? '审查发现' : '检查诊断'}</h2><Status value={data.state ?? data.status} /><span>{data.reportStatus ?? data.verification}</span></div><p className="nexus-workbench-source">{data.id} · <Time value={data.completedAt ?? data.createdAt} /></p>{data.summary && <DataView value={data.summary} />}{findings.length ? <div className="nexus-workbench-findings">{findings.map((item, index) => <article key={item.id ?? item.occurrenceId ?? index}><span>{item.severity}</span><button onClick={() => context.inspect({ title: item.title ?? item.message, kind: review ? '已定位的审查发现' : '检查诊断', data: item })}><strong>{item.title ?? item.message}</strong><small>{item.path}:{item.startLine ?? item.range?.startLine} · {item.ruleId ?? item.evidenceValidation}</small></button></article>)}</div> : <p>本次返回没有发现条目。完成程度与覆盖限制见下方证据。</p>}<EvidenceDisclosure title="实际覆盖、限制与执行回执" value={{ coverage: data.coverage, limitations: data.limitations, stale: data.stale, receipts: data.receipts, attempts: data.attempts }} />{review && <Button busy={Boolean(operation.busy)} onClick={() => void operation.run('读取审查证据', 'review', 'evidence', { runId }).then(result => { if (result) context.inspect({ title: '本次审查来源与模型请求证据', data: result }); })}>查看来源哈希与请求记录</Button>}{operation.feedback}</section></QueryState>}</div>;
}
