import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { NexusError, recordParams, requiredString, type DispatchContext, type JsonRecord, type NexusModule, type NexusRequest, type NexusServices } from '../../ports/contracts.js';
import { createVcsAdapter } from '../../adapters/vcs/index.js';
import { findAssetsRoot } from '../../adapters/upstream/archify/index.js';
import { createLifecycleDispatcher } from './lifecycle.js';
import { RULES, scanTypeScript, applyEdits, type Diagnostic, type TextEdit } from './rules.js';
import { createCustomRules, customRuleApplies, qualityRuleScope, scanCustomRules, type CustomRule, type CatalogRule } from './custom-rules.js';
import { atomicWrite, capabilities, checkAbort, newId, now, number, object, page, projectRoot, scopedPath, sha256, stored, strings, textFile, walk } from './shared.js';

interface Source { path: string; hash: string; key?: string; method: string }
interface Command { id: string; layer: string; command: string; args: string[]; source: Source; sideEffects: string; parser: string; implementation?: string }
interface Profile {
  id: string; root: string; observedAt: string; languages: string[]; frameworks: string[];
  packageManager: string | null; locks: Source[]; configs: Source[]; commands: Command[];
  conflicts: Array<{ subject: string; sources: string[]; impact: string }>; missing: string[];
  files: string[]; configHash: string; formatterOwners: Record<string, string>;
}
interface ScanPlan {
  id: string; planHash: string; profileId: string; profileRevision: number; root: string; snapshotId: string;
  files: Array<{ path: string; hash: string }>; direct: string[]; affected: string[];
  expanded: Array<{ path: string; reason: string }>; excluded: string[]; unknown: string[];
  layers: string[]; commands: Command[]; configHash: string; ruleIds: string[]; epoch: string;
  ruleSeverities?: Record<string, 'error' | 'warning'>;
  ruleSelectionSource?: JsonRecord;
  customRules?: CustomRule[]; ruleScope?: string;
  budget: { deadlineMs: number; maxOutputBytes: number }; createdAt: string;
}
interface LayerResult { layer: string; status: string; commandId?: string; exitCode?: number | null; stdout?: string; stderr?: string; limitations?: string[]; durationMs?: number }
interface Report {
  id: string; planId: string; snapshotId: string; root: string; status: string;
  verification: string; execution: string; coverage: { files: string[]; excluded: string[]; unknown: string[]; layers: LayerResult[] };
  diagnostics: Diagnostic[]; digest: string; epoch: string; createdAt: string; completedAt?: string;
  stale: { value: boolean; reasons: string[] }; receipts: JsonRecord[]; summary: JsonRecord;
}
interface FixFile { path: string; beforeHash: string | null; afterHash: string; edits: TextEdit[]; inverse: TextEdit[]; mode?: number; content?: string }
interface FixPreview { id: string; root: string; reportRef?: string; snapshotId?: string; previewHash: string; expiresAt: string; files: FixFile[]; diagnosticIds: string[]; conflicts: string[]; state: string; createdAt: string; kind: string }
const sourceExtensions = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.py', '.go']);
const configPattern = /(^|\/)(package\.json|.*lock.*|tsconfig[^/]*\.json|jsconfig\.json|eslint\.config\.[^.]+|\.eslintrc(?:\.[^.]+)?|pyproject\.toml|mypy\.ini|go\.(?:mod|sum)|go\.work|nuxt\.config\.[^.]+|vite\.config\.[^.]+|\.nexus\/quality\.json|.*prettier.*|.*oxfmt.*)$/;
const supportedLayers = ['format', 'syntax', 'affected_type', 'semantic', 'project_test'];
const collections = { profiles: 'quality.profiles', plans: 'quality.plans', runs: 'quality.runs', reports: 'quality.reports', previews: 'quality.previews', cache: 'quality.cache', journal: 'quality.journals', baselines: 'quality.baselines', gates: 'quality.gates' };
function unverifiedRuleLimits(ruleIds: string[], files: string[], layers: string[]): string[] {
  const applicable = RULES.filter(rule => ruleIds.includes(rule.ruleId) && files.some(filename =>
    rule.language === 'py' ? filename.endsWith('.py') : rule.language === 'go' ? filename.endsWith('.go')
      : rule.language === 'vue' ? filename.endsWith('.vue') : /\.[cm]?[jt]sx?$/.test(filename)));
  const limitations: string[] = [];
  if (!layers.includes('syntax') && applicable.some(rule => rule.detector === 'syntax')) {
    limitations.push('所选内置语法规则未执行：本计划未启用 syntax 层');
  }
  for (const [detector, label] of [['type-aware', '规则级类型检测'], ['manual-semantic', '独立语义验证'], ['external', '外部规则检测']]) {
    const pending = applicable.filter(rule => rule.detector === detector);
    if (pending.length) limitations.push(`${label}未获得规则级覆盖证据：${pending.map(rule => rule.ruleId).join('、')}。外部命令的退出状态不等于这些规则已验证`);
  }
  return limitations;
}
const json = (text: string, filename: string): JsonRecord => {
  const parsed = ts.parseConfigFileTextToJson(filename, text);
  if (parsed.error) throw new NexusError('INVALID_ARGUMENT', '配置无法静态解析', { path: filename, code: parsed.error.code });
  const value = object(parsed.config);
  const reject = (entry: unknown): void => { if (entry && typeof entry === 'object') for (const [key, item] of Object.entries(entry)) { if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new NexusError('INVALID_ARGUMENT', '配置含禁止键'); reject(item); } };
  reject(value);
  return value;
};

export function createQualityModule(services: NexusServices): NexusModule {
  const vcs = createVcsAdapter(services);
  const running = new Map<string, AbortController>();
  const writeLeases = new Set<string>();
  const rootFor = (context?: DispatchContext) => projectRoot(services, context);

  const lifecycle = createLifecycleDispatcher(services);
  const customRules = createCustomRules(services);
  async function ruleSettings(root: string, definitions: CatalogRule[], readProject = true) {
    const filename = '.nexus/quality.json';
    let file;
    try { if (readProject) file = await textFile(root, filename); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const config = file ? json(file.text, filename) : {};
    const configured = config.rules === undefined ? undefined : object(config.rules);
    const ruleSeverities: Record<string, 'error' | 'warning'> = {};
    for (const [id, value] of Object.entries(configured ?? {})) {
      if (!definitions.some(rule => rule.ruleId === id)) throw new NexusError('INVALID_ARGUMENT', '项目质量配置含未知规则', { path: filename, ruleId: id });
      const severity = object(value).severity;
      if (!['error', 'warning', 'off'].includes(String(severity))) throw new NexusError('INVALID_ARGUMENT', '规则级别必须为 error、warning 或 off', { path: filename, ruleId: id });
      if (severity !== 'off') ruleSeverities[id] = severity as 'error' | 'warning';
    }
    const ruleIds = configured === undefined ? definitions.map(rule => rule.ruleId) : Object.keys(ruleSeverities);
    return { ruleIds, ruleSeverities, source: { kind: configured === undefined ? 'builtin' : 'project-file',
      path: file ? filename : null, hash: file?.hash ?? null }, configPresent: Boolean(file) };
  }
  async function discover(root: string, signal?: AbortSignal): Promise<{ id: string; revision: number; value: Profile; updatedAt: string }> {
    root = await fs.realpath(root);
    const allFiles = await walk(root, { signal });
    const files = allFiles.filter(name => sourceExtensions.has(path.extname(name)));
    const configs: Source[] = [];
    const locks: Source[] = [];
    const commands: Command[] = [];
    const conflicts: Profile['conflicts'] = [];
    const missing: string[] = [];
    const frameworks = new Set<string>();
    const languages = new Set<string>();
    for (const name of files) languages.add(name.endsWith('.py') ? 'python' : name.endsWith('.go') ? 'go' : name.endsWith('.vue') ? 'vue' : /\.([cm]?ts|tsx)$/.test(name) ? 'typescript' : 'javascript');
    let declaredManager: string | undefined;
    const managers = new Set<string>();
    const packages = allFiles.filter(name => path.basename(name) === 'package.json' && name.split('/').length <= 5);
    for (const filename of allFiles.filter(name => configPattern.test(name))) {
      try {
        const file = await textFile(root, filename, 2 * 1024 * 1024);
        const source: Source = { path: filename, hash: file.hash, method: /\.(?:[cm]?js|ts)$/.test(filename) ? 'observed-not-evaluated' : 'static-read' };
        if (/lock|go\.sum/.test(path.basename(filename))) {
          locks.push(source);
          if (path.basename(filename) === 'pnpm-lock.yaml') managers.add('pnpm');
          if (/^package-lock/.test(path.basename(filename))) managers.add('npm');
          if (/^yarn.lock/.test(path.basename(filename))) managers.add('yarn');
          if (/^bun.lock/.test(path.basename(filename))) managers.add('bun');
        } else configs.push(source);
      } catch (error) { missing.push(`${filename}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    for (const filename of packages) {
      try {
        const file = await textFile(root, filename);
        const pkg = json(file.text, filename);
        if (filename === 'package.json' && typeof pkg.packageManager === 'string') declaredManager = pkg.packageManager.split('@')[0];
        const dependencies = { ...object(pkg.dependencies), ...object(pkg.devDependencies) };
        for (const name of ['vue', 'nuxt', 'next', 'react', 'svelte', 'astro']) if (dependencies[name]) frameworks.add(name);
        const manager = declaredManager ?? (managers.size === 1 ? [...managers][0] : 'npm');
        for (const [name, value] of Object.entries(object(pkg.scripts))) {
          if (typeof value !== 'string') continue;
          const layer = /format/.test(name) ? 'format' : /type/.test(name) ? 'affected_type' : /lint/.test(name) ? 'syntax' : /test|build|check/.test(name) ? 'project_test' : 'other';
          commands.push({ id: `script:${filename}:${name}`, layer, command: manager!, args: ['run', name], source: { path: filename, hash: file.hash, key: `scripts.${name}`, method: 'declared-not-run' }, sideEffects: `项目脚本可能执行任意代码: ${value.slice(0, 2048)}`, parser: 'exit' });
        }
      } catch (error) { missing.push(`${filename}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    if (managers.size > 1 || (declaredManager && managers.size && !managers.has(declaredManager))) conflicts.push({ subject: 'package-manager', sources: [...managers, ...(declaredManager ? [`package.json:${declaredManager}`] : [])], impact: '选择检查脚本前必须解决包管理器来源冲突' });
    const local = async (packageName: string, bin: string, layer: string, args: string[], parser: string): Promise<void> => {
      try {
        const require = createRequire(path.join(root, 'package.json'));
        const pkgPath = require.resolve(`${packageName}/package.json`);
        const pkg = json(await fs.readFile(pkgPath, 'utf8'), pkgPath);
        const executable = path.resolve(path.dirname(pkgPath), bin);
        await fs.access(executable);
        commands.push({ id: `tool:${packageName}`, layer, command: process.execPath, args: [executable, ...args], source: { path: pkgPath, hash: sha256(await fs.readFile(pkgPath)), key: String(pkg.version), method: 'resolved-package-not-executed' }, sideEffects: '工具配置可能执行项目代码；计划中显式披露', parser, implementation: packageName === '@typescript/native-preview' ? 'go-native-package' : packageName === 'typescript' ? 'typescript-js-package' : packageName });
      } catch { missing.push(`${packageName}: 未解析到已安装本地依赖（不会自动下载）`); }
    };
    if (languages.has('typescript') || languages.has('javascript') || languages.has('vue')) {
      await local('eslint', 'bin/eslint.js', 'syntax', ['--format', 'json'], 'eslint');
      await local('typescript', 'bin/tsc', 'affected_type', ['--noEmit', '--pretty', 'false'], 'tsc');
      if (languages.has('vue')) await local('vue-tsc', 'bin/vue-tsc.js', 'affected_type', ['--noEmit', '--pretty', 'false'], 'tsc');
      const formatters = configs.filter(item => /prettier|oxfmt/.test(item.path)).map(item => /prettier/.test(item.path) ? 'prettier' : 'oxfmt');
      if (new Set(formatters).size > 1) conflicts.push({ subject: 'formatter-owner', sources: formatters, impact: '同一文件不允许多个 formatter 互相覆盖；先选择唯一 owner' });
      if (formatters.includes('prettier')) await local('prettier', 'bin/prettier.cjs', 'format', ['--check'], 'exit');
      if (formatters.includes('oxfmt')) missing.push('oxfmt: 需要受信可执行路径探测；不凭命令名假定实现');
    }
    if (languages.has('python')) {
      commands.push({ id: 'tool:mypy', layer: 'affected_type', command: 'python', args: ['-m', 'mypy', '--check-untyped-defs', '--warn-unused-ignores'], parser: 'mypy', source: { path: 'python:mypy', hash: 'runtime-probe-required', method: 'requires-runtime-probe' }, sideEffects: '读取项目 mypy 配置及可选插件' });
    }
    if (languages.has('go')) {
      commands.push({ id: 'tool:go-vet', layer: 'affected_type', command: 'go', args: ['vet', './...'], parser: 'go', source: { path: 'go.mod', hash: configs.find(item => item.path === 'go.mod')?.hash ?? 'unknown', method: 'requires-runtime-probe' }, sideEffects: 'Go 可能读取缓存/下载缺失模块；外部进程许可独立' });
      commands.push({ id: 'tool:gofmt', layer: 'format', command: 'gofmt', args: ['-l'], parser: 'gofmt', source: { path: 'gofmt', hash: 'runtime-probe-required', method: 'requires-runtime-probe' }, sideEffects: '只读格式检查' });
    }
    const profile: Profile = {
      id: `project_${sha256(root)}`, root, observedAt: now(), languages: [...languages].sort(), frameworks: [...frameworks].sort(),
      packageManager: conflicts.some(item => item.subject === 'package-manager') ? null : declaredManager ?? [...managers][0] ?? null,
      locks, configs, commands, conflicts, missing, files, configHash: sha256({ configs, locks }), formatterOwners: {},
    };
    const previous = await services.store.get<Profile>(collections.profiles, profile.id);
    return services.store.put(collections.profiles, profile.id, profile, previous?.revision);
  }

  async function plan(params: JsonRecord, context?: DispatchContext): Promise<unknown> {
    const root = rootFor(context);
    const profileRecord = params.profileId ? await stored<Profile>(services, collections.profiles, params.profileId) : await discover(root, context?.signal);
    const profile = profileRecord.value;
    if (await fs.realpath(root) !== profile.root) throw new NexusError('SCOPE_MISMATCH', '项目画像不属于当前工作区');
    if (params.profileRevision !== undefined && params.profileRevision !== profileRecord.revision) throw new NexusError('REVISION_CONFLICT', '项目画像已更新');
    const catalog = await customRules.catalog(context), settings = await ruleSettings(profile.root, catalog.rules, context?.scopeLevel !== 'global');
    const selectedRules = [...new Set(strings(params.ruleIds, settings.ruleIds))];
    if (selectedRules.some(id => !catalog.rules.some(rule => rule.ruleId === id))) throw new NexusError('INVALID_ARGUMENT', '未知 ruleId；请刷新目录并移除失效选择');
    const selectedCustomRules = catalog.rules.filter(rule => selectedRules.includes(rule.ruleId) && rule.custom).map(rule => rule.custom!);
    const builtinSelected = selectedRules.some(id => RULES.some(rule => rule.ruleId === id));
    const candidates = [...new Set([...(builtinSelected ? profile.files : []),
      ...(selectedCustomRules.length ? (await walk(profile.root, { signal: context?.signal })).filter(filename => selectedCustomRules.some(rule => customRuleApplies(rule, filename))) : [])])];
    const scope = object(params.scope);
    const mode = String(scope.mode ?? params.mode ?? 'changed');
    let direct: string[];
    if (params.paths) direct = strings(params.paths);
    else if (mode === 'full') direct = candidates;
    else {
      try { direct = await vcs.changedPaths(root, { mode: 'worktree', selectedPaths: scope.includeUntracked === true ? profile.files : undefined, signal: context?.signal }); }
      catch { direct = candidates; }
    }
    const layers = strings(params.layers, ['syntax']);
    if (layers.some(layer => !supportedLayers.includes(layer))) throw new NexusError('INVALID_ARGUMENT', '未知质量层');
    const unknown: string[] = [];
    if (selectedCustomRules.length && !layers.includes('syntax')) unknown.push('自定义字面文本规则仅在 syntax 层运行；本计划未启用该层，无法覆盖这些规则');
    const affected = new Set(direct);
    const expanded: ScanPlan['expanded'] = [];
    // Conservative closure is necessary when aliases/frameworks/multiple languages prevent a complete resolver.
    if (layers.some(layer => ['affected_type', 'semantic'].includes(layer))) {
      for (const filename of profile.files) if (!affected.has(filename)) { affected.add(filename); expanded.push({ path: filename, reason: '跨项目/框架依赖图未经完整证明，保守扩大受影响集合' }); }
    }
    if (direct.some(filename => configPattern.test(filename))) for (const filename of profile.files) { affected.add(filename); expanded.push({ path: filename, reason: '配置或锁文件改变，检查输入 closure 失效' }); }
    const files: ScanPlan['files'] = [];
    for (const filename of [...affected].sort()) {
      try { const file = await textFile(root, filename); files.push({ path: filename, hash: file.hash }); }
      catch (error) { unknown.push(`${filename}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    unknown.push(...unverifiedRuleLimits(selectedRules, files.map(file => file.path), layers));
    const requestedCommands = strings(params.commandIds);
    const commands = requestedCommands.map(id => {
      const command = profile.commands.find(item => item.id === id);
      if (!command) throw new NexusError('INVALID_ARGUMENT', '命令必须引用真实发现的 commandId', { id });
      return command;
    });
    for (const layer of layers) {
      if (layer === 'syntax') continue;
      if (!commands.some(command => command.layer === layer)) {
        const candidates = profile.commands.filter(command => command.layer === layer && command.id.startsWith('tool:'));
        if (layer === 'affected_type') {
          const selected = candidates.find(command => command.id === 'tool:vue-tsc') ?? candidates.find(command => command.id === 'tool:typescript') ?? candidates[0];
          if (selected) commands.push(selected); else unknown.push(`${layer}: 缺少已安装且可验证的 checker`);
        } else if (layer === 'format' && !profile.conflicts.some(item => item.subject === 'formatter-owner')) {
          if (candidates.length === 1) commands.push(candidates[0]!); else unknown.push('format: 缺少唯一 formatter owner');
        } else if (layer === 'semantic') unknown.push('semantic: 需要 nexus_review 独立语义证据；不以 AST 关键词当跨过程证明');
        else if (layer === 'project_test') unknown.push('project_test: 必须显式选择已发现的真实测试/build 命令');
      }
    }
    if (profile.languages.includes('vue') && layers.includes('affected_type') && !commands.some(command => command.id === 'tool:vue-tsc')) unknown.push('Vue template 未由真实模板 checker 覆盖');
    if (profile.conflicts.some(item => item.subject === 'formatter-owner') && layers.includes('format')) unknown.push('formatter-owner 冲突未解决');
    if (profile.conflicts.some(item => item.subject === 'package-manager') && commands.some(command => command.id.startsWith('script:'))) unknown.push('包管理器冲突阻断项目脚本');
    const ruleSeverities = Object.fromEntries(selectedRules.map(id => [id, settings.ruleSeverities[id] ?? catalog.rules.find(rule => rule.ruleId === id)!.severityDefault]));
    const ruleSelectionSource = params.ruleIds === undefined ? settings.source : { kind: 'selected-input', projectFile: settings.source };
    const budget = object(params.budget);
    const partial = {
      id: newId('scanplan'), root: profile.root, profileId: profile.id, profileRevision: profileRecord.revision,
      snapshotId: `snapshot_${sha256({ files, configHash: profile.configHash })}`, files, direct: direct.sort(), affected: [...affected].sort(), expanded,
      excluded: profile.files.filter(filename => !affected.has(filename)), unknown, layers, commands,
      configHash: profile.configHash, ruleIds: selectedRules, ruleSeverities, ruleSelectionSource,
      customRules: selectedCustomRules, ruleScope: qualityRuleScope(profile.root, context),
      epoch: sha256({ rules: selectedRules, customRules: selectedCustomRules, ruleSeverities, version: 3, ts: ts.version, config: profile.configHash }),
      budget: { deadlineMs: number(budget.deadlineMs, 120000, 1000, 900000), maxOutputBytes: number(budget.maxOutputBytes, 5 * 1024 * 1024, 1024, 16 * 1024 * 1024) }, createdAt: now(),
    };
    const result: ScanPlan = { ...partial, planHash: sha256(partial) };
    await services.store.put(collections.plans, result.id, result);
    return { ...result, permissions: commands.length ? ['external_process'] : [], verification: 'not_run', effectState: 'none' };
  }

  async function verifySnapshot(plan: ScanPlan, context?: DispatchContext): Promise<string[]> {
    const changed: string[] = [];
    if (plan.ruleScope && plan.ruleScope !== qualityRuleScope(plan.root, context)) throw new NexusError('SCOPE_MISMATCH', '检查计划不属于当前规则作用域');
    if (plan.customRules?.length) {
      const current = await customRules.catalog(context);
      const selected = current.rules.filter(rule => plan.customRules!.some(saved => saved.ruleId === rule.ruleId) && rule.custom).map(rule => rule.custom!);
      if (sha256(selected) !== sha256(plan.customRules)) changed.push('<custom-rules>');
    }
    for (const file of plan.files) {
      try { if ((await textFile(plan.root, file.path)).hash !== file.hash) changed.push(file.path); }
      catch { changed.push(file.path); }
    }
    const profile = await discover(plan.root);
    if (profile.value.configHash !== plan.configHash) changed.push('<config-closure>');
    return changed;
  }

  function parseOutput(command: Command, stdout: string, root: string): { diagnostics: Diagnostic[]; unknown: string[] } {
    if (command.parser !== 'eslint') return { diagnostics: [], unknown: [] };
    try {
      const files = JSON.parse(stdout) as Array<{ filePath: string; messages: Array<{ ruleId: string | null; severity: number; message: string; line: number; column: number; endLine?: number; endColumn?: number; fatal?: boolean }> }>;
      if (!Array.isArray(files)) throw new Error();
      const diagnostics: Diagnostic[] = [];
      const counts = new Map<string, number>();
      for (const file of files) for (const message of file.messages) {
        const filename = path.relative(root, file.filePath).replaceAll('\\', '/');
        if (filename.startsWith('../') || path.isAbsolute(filename)) throw new Error();
        const logical = sha256({ rule: message.ruleId ?? 'parse', filename, message: message.message });
        const occurrence = counts.get(logical) ?? 0; counts.set(logical, occurrence + 1);
        diagnostics.push({ occurrenceId: sha256({ logical, occurrence, line: message.line }), fingerprint: sha256({ logical, occurrence }), ruleId: `eslint.${message.ruleId ?? 'parse'}`, detectorRef: 'eslint-json/v1', severity: message.severity === 2 ? 'error' : 'warning', messageCode: message.ruleId ?? 'parse', message: message.message, path: filename, range: { startLine: message.line, startColumn: message.column, endLine: message.endLine ?? message.line, endColumn: message.endColumn ?? message.column, unit: 'utf16' }, sourceHash: '', anchor: message.message, state: 'confirmed', fixability: 'none' });
      }
      return { diagnostics, unknown: [] };
    } catch { return { diagnostics: [], unknown: ['ESLint 输出不是受支持 JSON schema；不能解释为零诊断'] }; }
  }

  async function execute(params: JsonRecord, context?: DispatchContext): Promise<Report | unknown> {
    const record = await stored<ScanPlan>(services, collections.plans, params.planId);
    const plan = record.value;
    if (params.planHash !== plan.planHash) throw new NexusError('REVISION_CONFLICT', '计划 hash 不匹配');
    if (await fs.realpath(rootFor(context)) !== plan.root) throw new NexusError('SCOPE_MISMATCH', '检查计划不属于当前项目');
    const stale = await verifySnapshot(plan, context);
    if (stale.length) throw new NexusError('SNAPSHOT_STALE', '检查输入已改变，请重新生成计划', { changed: stale });
    if (typeof params.idempotencyKey === 'string') {
      const existing = await services.store.get<{ reportRef: string }>('quality.idempotency', sha256({ root: plan.root, key: params.idempotencyKey }));
      if (existing) return (await stored<Report>(services, collections.reports, existing.value.reportRef)).value;
    }
    const controller = new AbortController();
    const outerSignal = context?.signal ?? services.signal;
    const abort = () => controller.abort();
    outerSignal?.addEventListener('abort', abort, { once: true });
    const id = newId('qualityrun');
    running.set(id, controller);
    const report: Report = {
      id, planId: plan.id, snapshotId: plan.snapshotId, root: plan.root, status: 'running', verification: 'unknown', execution: 'fresh',
      coverage: { files: [], excluded: plan.excluded,
        unknown: [...new Set([...plan.unknown, ...unverifiedRuleLimits(plan.ruleIds, plan.files.map(file => file.path), plan.layers)])],
        layers: [] }, diagnostics: [], digest: '', epoch: plan.epoch,
      createdAt: now(), stale: { value: false, reasons: [] }, receipts: [], summary: {},
    };
    await services.store.put(collections.runs, id, report);
    if (typeof params.idempotencyKey === 'string') await services.store.put('quality.idempotency', sha256({ root: plan.root, key: params.idempotencyKey }), { reportRef: id });
    services.emit('quality.started', { runId: id, planId: plan.id });
    const started = Date.now();
    try {
      if (plan.layers.includes('syntax')) {
        for (const file of plan.files) {
          checkAbort(controller.signal);
          if (Date.now() - started >= plan.budget.deadlineMs) throw new NexusError('TIMEOUT', '检查总预算已耗尽');
          if (report.diagnostics.length >= 20000) { report.coverage.unknown.push('达到单次检查 20000 条诊断上限，剩余文件未覆盖'); break; }
          const source = await textFile(plan.root, file.path);
          if (source.hash !== file.hash) throw new NexusError('SNAPSHOT_STALE', '扫描前文件变化', { path: file.path });
          const isTypeScript = /\.[cm]?[jt]sx?$/.test(file.path), builtinSelected = plan.ruleIds.some(id => RULES.some(rule => rule.ruleId === id));
          const applicableCustom = (plan.customRules ?? []).filter(rule => customRuleApplies(rule, file.path));
          if (!isTypeScript && builtinSelected && (!applicableCustom.length || sourceExtensions.has(path.extname(file.path)))) {
            report.coverage.unknown.push(`${file.path}: 内置 TS AST 不覆盖此语言；需要对应外部 checker`);
          }
          if ((!isTypeScript || !builtinSelected) && !applicableCustom.length) continue;
          const key = sha256({ source: source.hash, filename: file.path, config: plan.configHash, epoch: plan.epoch });
          const cached = await services.store.get<{ diagnostics: Diagnostic[]; unknown: string[]; origin: string }>(collections.cache, key);
          let result;
          if (cached) {
            result = cached.value;
            report.execution = report.coverage.files.length ? 'mixed' : 'revalidated_cached';
            report.receipts.push({ operation: 'syntax', path: file.path, cacheOrigin: cached.value.origin, revalidatedAt: now(), sourceHash: source.hash });
          } else {
            const builtin = isTypeScript && builtinSelected ? scanTypeScript(file.path, source.text, new Set(plan.ruleIds)) : { diagnostics: [], unknown: [] };
            const custom = scanCustomRules(file.path, source.text, applicableCustom);
            result = { diagnostics: [...builtin.diagnostics, ...custom.diagnostics], unknown: [...builtin.unknown, ...custom.unknown] };
            for (const diagnostic of result.diagnostics) {
              diagnostic.sourceHash = source.hash;
              diagnostic.severity = plan.ruleSeverities?.[diagnostic.ruleId] ?? diagnostic.severity;
            }
            await services.store.put(collections.cache, key, { ...result, origin: id });
            report.receipts.push({ operation: 'syntax', path: file.path,
              tool: isTypeScript && builtinSelected ? `typescript/${ts.version}` : 'nexus-literal/v1',
              tools: [...(isTypeScript && builtinSelected ? [`typescript/${ts.version}`] : []), ...(applicableCustom.length ? ['nexus-literal/v1'] : [])],
              customRuleIds: applicableCustom.map(rule => rule.ruleId), sourceHash: source.hash, executedAt: now() });
          }
          report.diagnostics.push(...result.diagnostics);
          report.coverage.unknown.push(...result.unknown.map(message => `${file.path}: ${message}`));
          report.coverage.files.push(file.path);
        }
        report.coverage.layers.push({ layer: 'syntax', status: report.coverage.unknown.some(message => /AST 不覆盖|语法/.test(message)) ? 'partial' : 'completed', limitations: ['type-aware / manual-semantic 规则需独立外部与模型证据'] });
      }
      for (const command of plan.commands) {
        checkAbort(controller.signal);
        if (Date.now() - started >= plan.budget.deadlineMs) throw new NexusError('TIMEOUT', '检查总预算已耗尽');
        if (!await services.host.approve('external_process', plan.root, { command: command.command, args: command.args, commandId: command.id, sideEffects: command.sideEffects })) {
          report.coverage.layers.push({ layer: command.layer, status: 'blocked', commandId: command.id });
          report.coverage.unknown.push(`${command.id}: external_process 权限未批准`);
          continue;
        }
        const args = [...command.args];
        const applicable = plan.files.filter(file => command.id === 'tool:gofmt' ? file.path.endsWith('.go') : command.id === 'tool:mypy' ? file.path.endsWith('.py') : /\.[cm]?[jt]sx?$/.test(file.path)).map(file => file.path);
        if (['eslint', 'gofmt', 'tool:prettier', 'mypy'].some(item => command.id.includes(item))) {
          if (!applicable.length) { report.coverage.layers.push({ layer: command.layer, status: 'not_applicable', commandId: command.id }); continue; }
          args.push('--', ...applicable);
          if (command.id === 'tool:gofmt') args.splice(args.indexOf('--'), 1);
        }
        const result = await services.executor.run(command.command, args, { cwd: plan.root, signal: controller.signal, timeoutMs: Math.max(1000, plan.budget.deadlineMs - (Date.now() - started)), maxOutputBytes: plan.budget.maxOutputBytes });
        const parsed = parseOutput(command, result.stdout, plan.root);
        report.diagnostics.push(...parsed.diagnostics);
        report.coverage.unknown.push(...parsed.unknown);
        const status = result.cancelled ? 'cancelled' : result.truncated ? 'partial' : parsed.unknown.length ? 'unknown' : result.exitCode === 0 ? 'completed' : 'failed';
        report.coverage.layers.push({ layer: command.layer, commandId: command.id, status, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, durationMs: result.durationMs });
        report.receipts.push({ operation: command.id, argv: args, cwd: plan.root, executable: command.command, implementation: command.implementation ?? 'unknown', source: command.source, exitCode: result.exitCode, cancelled: result.cancelled, truncated: result.truncated ?? false, durationMs: result.durationMs, outputHash: sha256({ stdout: result.stdout, stderr: result.stderr }), completedAt: now(), cacheOrigin: null });
        if (result.cancelled) throw new NexusError('CANCELLED', '外部检查已取消');
        if (result.truncated) report.coverage.unknown.push(`${command.id}: 输出截断，不能证明完整覆盖`);
      }
      report.stale.reasons = await verifySnapshot(plan, context);
      report.stale.value = report.stale.reasons.length > 0;
      const errors = report.diagnostics.filter(item => item.severity === 'error').length;
      const warnings = report.diagnostics.filter(item => item.severity === 'warning').length;
      const failures = report.coverage.layers.some(layer => ['failed', 'cancelled', 'partial', 'unknown', 'blocked'].includes(layer.status));
      report.status = failures || report.coverage.unknown.length || report.stale.value ? 'partial' : 'completed';
      report.verification = errors || report.coverage.layers.some(layer => layer.status === 'failed') ? 'failed' : report.status === 'completed' ? 'passed' : 'unknown';
      report.summary = { errors, warnings, unknown: report.coverage.unknown.length, skipped: plan.excluded.length };
    } catch (error) {
      report.status = (error as NexusError).code === 'CANCELLED' ? 'cancelled' : 'failed';
      report.verification = 'unknown';
      report.coverage.unknown.push(error instanceof Error ? error.message : String(error));
    } finally {
      running.delete(id);
      outerSignal?.removeEventListener('abort', abort);
      report.completedAt = now();
      report.digest = sha256({ snapshotId: plan.snapshotId, epoch: plan.epoch, diagnostics: report.diagnostics.map(item => ({ fingerprint: item.fingerprint, severity: item.severity, state: item.state })).sort((a, b) => a.fingerprint.localeCompare(b.fingerprint)), coverage: report.coverage.layers.map(layer => ({ layer: layer.layer, status: layer.status })), unknown: report.coverage.unknown });
      const current = await services.store.get(collections.runs, id);
      await services.store.put(collections.runs, id, report, current?.revision);
      await services.store.put(collections.reports, id, report);
      services.emit('quality.completed', { runId: id, status: report.status, verification: report.verification, digest: report.digest });
    }
    return { ...report, resultRef: id, effectState: plan.commands.some(command => command.id.startsWith('script:')) ? 'unknown' : 'none' };
  }

  async function fixPreview(params: JsonRecord, context?: DispatchContext): Promise<FixPreview> {
    const report = (await stored<Report>(services, collections.reports, params.reportRef ?? params.runId)).value;
    const selected = strings(params.diagnosticIds);
    if (!selected.length) throw new NexusError('INVALID_ARGUMENT', '必须明确选择诊断');
    const files: FixFile[] = [];
    const conflicts: string[] = [];
    for (const filename of [...new Set(report.diagnostics.filter(item => selected.includes(item.occurrenceId) || selected.includes(item.fingerprint)).map(item => item.path))]) {
      const diagnostics = report.diagnostics.filter(item => item.path === filename && (selected.includes(item.occurrenceId) || selected.includes(item.fingerprint)));
      if (diagnostics.some(item => !item.edit || item.fixability !== 'safe')) { conflicts.push(`${filename}: 包含非白名单安全修复；只生成建议，不自动改语义`); continue; }
      const file = await textFile(rootFor(context), filename);
      if (diagnostics.some(item => item.sourceHash !== file.hash)) { conflicts.push(`${filename}: 原始诊断版本已变化`); continue; }
      const edits = diagnostics.map(item => ({ ...item.edit! }));
      let after: string;
      try { after = applyEdits(file.text, edits); } catch { conflicts.push(`${filename}: 修复重叠`); continue; }
      const inverse: TextEdit[] = [];
      let delta = 0;
      for (const edit of [...edits].sort((a, b) => a.start - b.start)) {
        inverse.push({ start: edit.start + delta, end: edit.start + delta + edit.text.length, text: file.text.slice(edit.start, edit.end) });
        delta += edit.text.length - (edit.end - edit.start);
      }
      // Safe fixes preserve BOM and CRLF; TextDecoder removes BOM, so retain it explicitly.
      const prefix = file.bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? '\ufeff' : '';
      if (prefix) { for (const edit of edits) { edit.start += 1; edit.end += 1; } for (const edit of inverse) { edit.start += 1; edit.end += 1; } }
      after = prefix + after;
      files.push({ path: filename, beforeHash: file.hash, afterHash: sha256(Buffer.from(after)), edits, inverse, mode: file.mode });
    }
    const preview: FixPreview = { id: newId('fixpreview'), root: await fs.realpath(rootFor(context)), reportRef: report.id, snapshotId: report.snapshotId, previewHash: '', expiresAt: new Date(Date.now() + 300000).toISOString(), files, diagnosticIds: selected, conflicts, state: 'preview', createdAt: now(), kind: 'diagnostic-fix' };
    preview.previewHash = sha256(preview);
    await services.store.put(collections.previews, preview.id, preview);
    return preview;
  }

  async function applyPreview(params: JsonRecord, context?: DispatchContext): Promise<unknown> {
    const record = await stored<FixPreview>(services, collections.previews, params.previewId ?? params.proposalId);
    const preview = record.value;
    if (params.expectedRevision !== undefined && params.expectedRevision !== record.revision) throw new NexusError('REVISION_CONFLICT', '预览版本已变化');
    if (params.previewHash !== preview.previewHash && params.proposalHash !== preview.previewHash) throw new NexusError('REVISION_CONFLICT', '预览 hash 不匹配');
    if (preview.state === 'applied') return { state: 'applied', idempotent: true, rollbackRef: preview.id };
    if (preview.expiresAt < now() || preview.conflicts.length) throw new NexusError('REVISION_CONFLICT', '预览已过期或存在未解决冲突', { conflicts: preview.conflicts });
    if (preview.root !== await fs.realpath(rootFor(context))) throw new NexusError('SCOPE_MISMATCH', '预览不属于当前项目');
    if (!await services.host.approve('write', preview.root, { previewId: preview.id, previewHash: preview.previewHash, files: preview.files.map(file => file.path) })) throw new NexusError('AUTHORIZATION_REQUIRED', '宿主未批准此精确变更预览');
    const leaseKeys = preview.files.map(file => `${preview.root}:${file.path}`);
    if (leaseKeys.some(key => writeLeases.has(key))) throw new NexusError('REVISION_CONFLICT', '文件正在被另一变更写入');
    for (const key of leaseKeys) writeLeases.add(key);
    const journal = { id: preview.id, state: 'prepared', files: preview.files, applied: [] as string[], errors: [] as string[], createdAt: now(), root: preview.root };
    try {
      for (const file of preview.files) {
        const filename = await scopedPath(preview.root, file.path, true);
        const hash = await fs.readFile(filename).then(sha256, (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
        if (hash !== file.beforeHash) throw new NexusError('REVISION_CONFLICT', '预览后文件发生变化', { path: file.path });
      }
      await services.store.put(collections.journal, preview.id, journal);
      journal.state = 'applying';
      for (const file of preview.files) {
        checkAbort(context?.signal);
        const before = file.beforeHash === null ? '' : await fs.readFile(await scopedPath(preview.root, file.path), 'utf8');
        const after = file.content ?? applyEdits(before, file.edits);
        if (sha256(Buffer.from(after)) !== file.afterHash) throw new NexusError('EVIDENCE_MISMATCH', '修复内容 hash 校验失败');
        await atomicWrite(preview.root, file.path, Buffer.from(after), file.beforeHash, file.mode);
        journal.applied.push(file.path);
        const current = await services.store.get(collections.journal, preview.id);
        await services.store.put(collections.journal, preview.id, journal, current?.revision);
      }
      journal.state = 'applied';
      preview.state = 'applied';
      await services.store.put(collections.previews, preview.id, preview, record.revision);
      return { state: 'applied', effectState: 'applied', rollbackRef: preview.id, verification: 'not_run', applied: journal.applied, note: '文件 delta 已应用；必须另行运行绑定新快照的检查，不以写成功冒充验证通过' };
    } catch (error) {
      journal.state = journal.applied.length ? 'partial' : 'failed';
      journal.errors.push(error instanceof Error ? error.message : String(error));
      if (!journal.applied.length) throw error;
      return { state: journal.state, effectState: 'partial', applied: journal.applied, errors: journal.errors, rollbackRef: preview.id };
    } finally {
      const current = await services.store.get(collections.journal, preview.id);
      await services.store.put(collections.journal, preview.id, journal, current?.revision);
      for (const key of leaseKeys) writeLeases.delete(key);
    }
  }

  async function dispatch(request: NexusRequest, context?: DispatchContext): Promise<unknown> {
    const params = recordParams(request);
    checkAbort(context?.signal);
    if (request.action.startsWith('lifecycle/')) return lifecycle(request.action.slice('lifecycle/'.length), request, context);
    switch (request.action) {
      case 'discover': return discover(rootFor(context), context?.signal);
      case 'methods': return services.invoke('artifact', { ...request, action: 'methods' }, context);
      case 'method_plan': {
        const route = String(params.route ?? 'risk');
        const catalog: Record<string, JsonRecord> = {
          risk: { owner: 'Aegis', assets: ['aegis'], topics: ['risk', 'baseline', 'ADR', 'anti-entropy', 'reentry', 'closeout'] },
          execution: { owner: 'Superpowers', assets: ['superpowers-dsh'], topics: ['brainstorming', 'planning', 'TDD', 'debugging', 'independent review', 'verification'] },
          cognition: { owner: 'J-Space equivalent', assets: ['j-space/METHODS.md'], topics: ['problem formulation', 'epistemics', 'empirics', 'capacity', 'directed focus', 'orchestration', 'repository', 'self monitoring'] },
          engineering: { owner: 'qiudeng7', assets: ['software-engineering-workflow', 'how-to-lint'], topics: ['requirements', 'design', 'documentation', 'lint', 'quality gates'] },
        };
        if (!catalog[route]) throw new NexusError('INVALID_ARGUMENT', '未知 method route');
        if (!Array.isArray(params.nodes) || !params.nodes.length) return { route, ...catalog[route], execution: 'not_run', required: ['goal', 'nodes'], note: '选择方法只返回按需资源，不伪造 executor 或执行成功' };
        const shared = await services.invoke('workflow', { action: 'plan', params: { goal: requiredString(params, 'goal'), nodes: params.nodes, budgets: params.budget } }, context) as JsonRecord;
        return { ...shared, method: { route, ...catalog[route], evidenceRefs: strings(params.evidenceRefs) } };
      }
      case 'catalog': {
        const catalog = await customRules.catalog(context);
        const rules = catalog.rules.filter(rule => (!params.language || rule.language === params.language) && (!params.severity || rule.severityDefault === params.severity) && (!params.query || `${rule.ruleId} ${rule.summary}`.toLowerCase().includes(String(params.query).toLowerCase())));
        // A complete bounded snapshot keeps selection totals independent of RPC's default 20-row page.
        const result = params.complete === true ? { items: rules, total: rules.length, truncated: false, cursor: null }
          : page(rules, request.cursor ?? params.cursor, params.limit ?? request.limit);
        return { ...result, localRevision: catalog.localRevision, scope: catalog.scope, catalogRevision: catalog.revision };
      }
      case 'rules/settings': return ruleSettings(rootFor(context), (await customRules.catalog(context)).rules, context?.scopeLevel !== 'global');
      case 'rules/save':
      case 'rules/delete': return customRules.mutate(request, context);
      case 'explain': {
        const ids = strings(params.ruleIds);
        const selected = (await customRules.catalog(context)).rules.filter(rule => ids.includes(rule.ruleId));
        const contents = await Promise.all(selected.map(async rule => {
          if (rule.custom) {
            const content = JSON.stringify(rule.custom, null, 2);
            return { ...rule, content, contentHash: sha256(content) };
          }
          const filename = path.resolve(await findAssetsRoot(services), rule.sourceRef);
          let content = '';
          try { content = await fs.readFile(filename, 'utf8'); } catch { content = `${rule.summary}\n例外: ${rule.exceptions.join('；')}\n检测边界: ${rule.knownGaps.join('；')}`; }
          return { ...rule, content, contentHash: sha256(content) };
        }));
        return page(contents, request.cursor ?? params.cursor, request.limit ?? params.limit, 50);
      }
      case 'plan': return plan(params, context);
      case 'run': {
        if (params.background === true) {
          const shared = await services.invoke('workflow', { action: 'plan', params: { goal: '固定快照工程质量检查', nodes: [{ id: 'quality-scan', kind: 'tool', domain: 'quality', action: 'execute_scan', params: { planId: params.planId, planHash: params.planHash, idempotencyKey: params.idempotencyKey } }] } }, context) as { id: string };
          return services.invoke('workflow', { action: 'run', params: { planId: shared.id, idempotencyKey: params.idempotencyKey } }, context);
        }
        return execute(params, context);
      }
      case 'execute_scan': {
        const result = await execute(params, context) as Report;
        if (result.verification !== 'passed') throw new NexusError(result.status === 'cancelled' ? 'CANCELLED' : 'PROCESS_EXIT_NONZERO', '质量检查未通过或证据不完整', { runId: result.id, status: result.status, verification: result.verification });
        return result;
      }
      case 'status': {
        if (!params.runId) return page((await services.store.list<Report>(collections.runs)).map(record => ({ id: record.id, revision: record.revision, status: record.value.status, verification: record.value.verification, summary: record.value.summary, createdAt: record.value.createdAt })), request.cursor, request.limit);
        const record = await stored<Report>(services, collections.runs, params.runId);
        const { diagnostics: _diagnostics, receipts: _receipts, ...summary } = record.value;
        return { ...summary, revision: record.revision };
      }
      case 'report': {
        const report = (await stored<Report>(services, collections.reports, params.resultRef ?? params.reportRef ?? params.runId)).value;
        const items = report.diagnostics.filter(item => (!params.severity || item.severity === params.severity) && (!params.path || item.path === params.path));
        const { diagnostics: _diagnostics, ...metadata } = report;
        return { ...metadata, diagnostics: page(items, request.cursor ?? params.cursor, request.limit ?? params.limit), resultRef: report.id };
      }
      case 'diff': {
        const baseline = (await stored<Report>(services, collections.reports, params.baselineRef)).value;
        const candidate = (await stored<Report>(services, collections.reports, params.candidateRef)).value;
        const old = new Map(baseline.diagnostics.map(item => [item.fingerprint, item]));
        const next = new Map(candidate.diagnostics.map(item => [item.fingerprint, item]));
        const compatible = candidate.epoch === baseline.epoch;
        return { compatible, new: candidate.diagnostics.filter(item => !old.has(item.fingerprint)), unchanged: candidate.diagnostics.filter(item => old.has(item.fingerprint)), moved: candidate.diagnostics.filter(item => old.has(item.fingerprint) && old.get(item.fingerprint)!.range.startLine !== item.range.startLine), resolved: compatible ? baseline.diagnostics.filter(item => !next.has(item.fingerprint) && candidate.coverage.files.includes(item.path)) : [], outOfScope: baseline.diagnostics.filter(item => !next.has(item.fingerprint) && !candidate.coverage.files.includes(item.path)), unknown: compatible ? [] : ['rule/config epoch 变化，不能把不可比诊断伪造成新增或已解决'] };
      }
      case 'fix_preview': return fixPreview(params, context);
      case 'fix_apply':
      case 'init': return applyPreview({ ...params, expectedRevision: request.expectedRevision ?? params.expectedRevision }, context);
      case 'adopt': {
        const root = await fs.realpath(rootFor(context));
        const selection = strings(params.selection, RULES.map(rule => rule.ruleId));
        if (selection.some(id => !RULES.some(rule => rule.ruleId === id))) throw new NexusError('INVALID_ARGUMENT', '规则选择含未知 ID');
        const filename = '.nexus/quality.json';
        let existing = '';
        try { existing = await fs.readFile(await scopedPath(root, filename), 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        const current = existing ? json(existing, filename) : {};
        const content = `${JSON.stringify({ ...current, schema: 'nexus-quality/v1', rulePacks: [{ id: 'how-to-lint', version: 'c6e2b5180917b8fd8952a0338d77c5318856e4a3' }], rules: Object.fromEntries(selection.map(id => [id, { severity: RULES.find(rule => rule.ruleId === id)!.severityDefault }])), compilerBaseline: { strict: true, noUncheckedIndexedAccess: true, noImplicitReturns: true, noFallthroughCasesInSwitch: true } }, null, 2)}\n`;
        const preview: FixPreview = { id: newId('adoption'), root, previewHash: '', expiresAt: new Date(Date.now() + 300000).toISOString(), files: [{ path: filename, beforeHash: existing ? sha256(existing) : null, afterHash: sha256(content), edits: [{ start: 0, end: existing.length, text: content }], inverse: [{ start: 0, end: content.length, text: existing }], content }], diagnosticIds: [], conflicts: existing && /\/[/*]/.test(existing) ? ['已有配置含注释；仅提供草案，请人工最小合并以保留注释'] : [], state: 'preview', createdAt: now(), kind: 'adoption' };
        preview.previewHash = sha256(preview);
        await services.store.put(collections.previews, preview.id, preview);
        return { ...preview, proposalId: preview.id, proposalHash: preview.previewHash, note: '保留原 ESLint/compiler 规则；旁置采纳配置不静默覆盖项目规范', configDraft: content };
      }
      case 'rollback': {
        const journalRecord = await stored<{ root: string; files: FixFile[]; applied: string[]; state: string }>(services, collections.journal, params.rollbackRef);
        const journal = journalRecord.value;
        if (journal.root !== await fs.realpath(rootFor(context))) throw new NexusError('SCOPE_MISMATCH', '操作 delta 不属于当前项目');
        if (journal.state === 'rolled_back') return { state: 'rolled_back', idempotent: true };
        if (!await services.host.approve('write', journal.root, { rollbackRef: journalRecord.id, files: journal.applied })) throw new NexusError('AUTHORIZATION_REQUIRED', '宿主未批准逆向 delta');
        const conflicts: string[] = [];
        const restored: string[] = [];
        for (const file of journal.files.filter(file => journal.applied.includes(file.path)).reverse()) {
          const current = await fs.readFile(await scopedPath(journal.root, file.path), 'utf8');
          if (sha256(current) !== file.afterHash) { conflicts.push(file.path); continue; }
          if (file.beforeHash === null) { await fs.unlink(await scopedPath(journal.root, file.path)); restored.push(file.path); }
          else {
            const reversed = applyEdits(current, file.inverse);
            if (sha256(reversed) !== file.beforeHash) throw new NexusError('EVIDENCE_MISMATCH', '逆向 delta hash 错误');
            await atomicWrite(journal.root, file.path, Buffer.from(reversed), file.afterHash, file.mode); restored.push(file.path);
          }
        }
        journal.state = conflicts.length ? 'partial_rollback' : 'rolled_back';
        await services.store.put(collections.journal, journalRecord.id, journal, journalRecord.revision);
        return { state: journal.state, conflicts, restored, effectState: restored.length ? 'applied' : 'none' };
      }
      case 'baseline': {
        const operation = String(params.operation ?? 'list');
        if (operation === 'list') return services.store.list(collections.baselines);
        if (!['create', 'update', 'revoke'].includes(operation)) throw new NexusError('INVALID_ARGUMENT', 'baseline operation 无效');
        if (operation === 'revoke') return services.store.remove(collections.baselines, requiredString(params, 'baselineId'), request.expectedRevision);
        const report = (await stored<Report>(services, collections.reports, params.reportRef)).value;
        const selected = strings(params.selection);
        const reason = requiredString(params, 'reason');
        const entries = report.diagnostics.filter(item => selected.includes(item.fingerprint)).map(item => ({ fingerprint: item.fingerprint, ruleId: item.ruleId, path: item.path, reason, owner: context?.actorId ?? 'local-user', expiry: params.expiry ?? null, createdFromReport: report.id }));
        if (!entries.length || entries.length !== selected.length) throw new NexusError('INVALID_ARGUMENT', '基线必须匹配明确诊断，不能通配未来问题');
        const id = typeof params.baselineId === 'string' ? params.baselineId : newId('baseline');
        return services.store.put(collections.baselines, id, { id, entries, createdAt: now() }, request.expectedRevision);
      }
      case 'gate': {
        const refs = strings(params.evidenceRefs);
        const reports = await Promise.all(refs.map(async ref => (await stored<Report>(services, collections.reports, ref)).value));
        const policy = object(params.policy);
        const layers = strings(policy.requiredLayers, ['syntax', 'affected_type', 'project_test']);
        const unknowns: string[] = [];
        const blockers: string[] = [];
        const snapshots = new Set(reports.map(report => report.snapshotId));
        if (!reports.length || snapshots.size !== 1 || (params.snapshotId && !snapshots.has(String(params.snapshotId)))) unknowns.push('证据缺失或来自不同 snapshot');
        for (const layer of layers) if (!reports.some(report => report.coverage.layers.some(result => result.layer === layer && ['completed', 'not_applicable'].includes(result.status)))) unknowns.push(`缺少已完成的 ${layer} 层`);
        const baselines = (await services.store.list<{ entries: Array<{ fingerprint: string; expiry: string | null }> }>(collections.baselines)).flatMap(record => record.value.entries).filter(entry => !entry.expiry || entry.expiry > now());
        const accepted = new Set(baselines.map(entry => entry.fingerprint));
        for (const report of reports) {
          if (report.stale.value) unknowns.push(`证据 ${report.id} 已陈旧`);
          unknowns.push(...report.coverage.unknown);
          if (report.status !== 'completed') unknowns.push(`报告 ${report.id} 不是完整终态`);
          blockers.push(...report.diagnostics.filter(item => item.severity === 'error' && !accepted.has(item.fingerprint)).map(item => item.occurrenceId));
          if (report.coverage.layers.some(layer => layer.status === 'failed')) blockers.push(`${report.id}:process-failure`);
        }
        const decision = { id: newId('gate'), snapshotId: [...snapshots][0] ?? null, policy: { id: params.policyId ?? 'default', revision: params.policyRevision ?? 1, requiredLayers: layers }, evidenceRefs: refs, decision: blockers.length ? 'failed' : unknowns.length ? 'unknown' : 'passed', blockers, unknowns: [...new Set(unknowns)], waivers: baselines, createdAt: now(), grantsPublishAuthorization: false };
        await services.store.put(collections.gates, decision.id, decision);
        return decision;
      }
      case 'evidence': {
        const reports = (await services.store.list<Report>(collections.reports)).map(record => record.value);
        const selected = params.receiptRefs ? reports.filter(report => strings(params.receiptRefs).includes(report.id)) : reports;
        if (params.operation === 'verify') return { valid: selected.every(report => report.digest === sha256({ snapshotId: report.snapshotId, epoch: report.epoch, diagnostics: report.diagnostics.map(item => ({ fingerprint: item.fingerprint, severity: item.severity, state: item.state })).sort((a, b) => a.fingerprint.localeCompare(b.fingerprint)), coverage: report.coverage.layers.map(layer => ({ layer: layer.layer, status: layer.status })), unknown: report.coverage.unknown })), checked: selected.map(report => report.id) };
        if (params.operation === 'export') return services.invoke('artifact', { action: 'create', params: { kind: 'evidence', title: '质量证据', content: JSON.stringify({ version: 1, reports: selected }, null, 2), mediaType: 'application/json' } }, context);
        return page(selected.map(report => ({ id: report.id, digest: report.digest, snapshotId: report.snapshotId, receipts: report.receipts, verification: report.verification })), request.cursor, request.limit);
      }
      case 'cancel': {
        const id = requiredString(params, 'runId');
        const controller = running.get(id);
        if (controller) controller.abort();
        const record = await services.store.get<Report>(collections.runs, id);
        return { runId: id, cancelRequested: !!controller, state: record?.value.status ?? 'not_found', effectState: record?.value.coverage.layers.some(layer => layer.commandId?.startsWith('script:')) ? 'unknown' : 'none' };
      }
      default: throw new NexusError('INVALID_ARGUMENT', '未知质量 action', { action: request.action });
    }
  }
  return { id: 'quality', capabilities: [...capabilities(['discover', 'methods', 'method_plan', 'catalog', 'rules/settings', 'explain', 'plan', 'adopt', 'init', 'run', 'execute_scan', 'status', 'report', 'diff', 'fix_preview', 'fix_apply', 'rollback', 'baseline', 'gate', 'evidence', 'cancel', ...['discover', 'catalog', 'create', 'status', 'plan', 'transition', 'artifact', 'review', 'template', 'validate', 'export', 'import', 'evidence', 'cancel'].map(action => `lifecycle/${action}`)], '工程质量'),
    { action: 'rules/save', description: '新建或编辑本层拥有的字面文本规则，按全局→工作区→会话继承。', mutating: true },
    { action: 'rules/delete', description: '删除本层拥有的自定义规则，保留继承规则和内置规则。', mutating: true }],
    dispatch, dispose: () => { for (const controller of running.values()) controller.abort(); } };
}

export { createReviewModule } from '../review/index.js';
export { createArtifactModule } from '../artifacts/index.js';
