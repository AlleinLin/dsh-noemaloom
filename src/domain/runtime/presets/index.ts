import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile, realpath, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { NexusError, recordParams, requiredString, type NexusServices, type NexusModule, type JsonRecord } from '../../../ports/contracts.js';

export interface NexusPreset {
  id: string;
  schemaVersion: 1;
  presetRevision: number;
  minimumHostContract: string;
  name: { zh: string; en: string };
  description: { zh: string; en: string };
  platform: string[];
  shell: { id: string; persistent: boolean; loadUserProfile: boolean };
  toolSurface: string[];
  contextStrategy: string;
  permissionRequirements: string[];
  bundleEntry: string;
}
export const NEXUS_PRESETS: NexusPreset[] = [
  {
    id: 'suite.windows-coding', schemaVersion: 1, presetRevision: 1, minimumHostContract: '0.2.1-rc.2',
    name: { zh: 'Windows 编码', en: 'Windows Coding' },
    description: { zh: '使用 PowerShell 7 持久终端和精确文本编辑，其余能力按需发现。', en: 'Persistent PowerShell 7 and precise editing, with capability discovery.' },
    platform: ['win32'], shell: { id: 'pwsh7', persistent: true, loadUserProfile: false },
    toolSurface: ['shell', 'read', 'write', 'edit', 'glob', 'grep', 'nexus_discover', 'nexus_action'],
    contextStrategy: 'stable-schema-epoch-reversible-context', permissionRequirements: ['workspace.read', 'workspace.write', 'process.execute'],
    bundleEntry: 'assets/presets/windows-coding.json',
  },
  {
    id: 'suite.windows-gitbash', schemaVersion: 1, presetRevision: 1, minimumHostContract: '0.2.1-rc.2',
    name: { zh: 'Windows Git Bash', en: 'Windows Git Bash' },
    description: { zh: '使用真正的 Git for Windows Bash；默认每次创建新进程。', en: 'Use genuine Git for Windows Bash with a new process per request by default.' },
    platform: ['win32'], shell: { id: 'git-bash', persistent: false, loadUserProfile: false },
    toolSurface: ['shell', 'read', 'write', 'edit', 'glob', 'grep', 'nexus_discover', 'nexus_action'],
    contextStrategy: 'stable-schema-epoch-reversible-context', permissionRequirements: ['workspace.read', 'workspace.write', 'process.execute'],
    bundleEntry: 'assets/presets/windows-gitbash.json',
  },
  {
    id: 'suite.adaptive-standard', schemaVersion: 1, presetRevision: 1, minimumHostContract: '0.2.1-rc.2',
    name: { zh: '自适应标准', en: 'Adaptive Standard' },
    description: { zh: '六项核心能力起步，按需发现完整目录，压缩后继续同一任务。', en: 'Six core operations, a discoverable catalog, and resumable compacted tasks.' },
    platform: ['win32', 'darwin', 'linux'], shell: { id: process.platform === 'win32' ? 'pwsh7' : 'posix-bash', persistent: true, loadUserProfile: false },
    toolSurface: ['shell', 'read', 'write', 'edit', 'glob', 'grep', 'nexus_discover', 'nexus_action'],
    contextStrategy: 'stable-schema-epoch-reversible-context', permissionRequirements: ['workspace.read', 'workspace.write', 'process.execute'],
    bundleEntry: 'assets/presets/adaptive-standard.json',
  },
];

export function createPresetsModule(services: NexusServices): NexusModule {
  const importedHandles = new Map<string, string>();
  function validateDefinition(value: unknown): JsonRecord {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new NexusError('INVALID_PRESET', '预设必须是对象');
    const definition = value as JsonRecord;
    if (typeof definition.id !== 'string' || !/^[a-z0-9][a-z0-9_.-]{0,127}$/i.test(definition.id)) throw new NexusError('INVALID_PRESET', '预设 id 无效');
    if (NEXUS_PRESETS.some(preset => preset.id === definition.id)) throw new NexusError('BUILTIN_PRESET_PROTECTED', '导入预设不能覆盖 Nexus 内置预设');
    if (!Array.isArray(definition.plugins) || definition.plugins.length > 500) throw new NexusError('INVALID_PRESET', '预设必须提供完整 plugins 组合');
    function entries(rows: unknown[], depth: number): void {
      if (depth > 12) throw new NexusError('INVALID_PRESET', '插件组合嵌套超过上限');
      for (const entry of rows) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new NexusError('INVALID_PRESET', 'plugin entry 无效');
        const row = entry as JsonRecord;
        if (typeof row.name !== 'string' || (row.name !== 'cordis:group' && !/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+(?:\/[a-z0-9_.-]+)*$/i.test(row.name))) throw new NexusError('INVALID_PRESET', '插件包入口无效');
        if (row.disabled !== undefined && typeof row.disabled !== 'boolean') throw new NexusError('INVALID_PRESET', '导入声明的 disabled 必须是布尔值');
        if (row.name === 'cordis:group') {
          if (!Array.isArray(row.config)) throw new NexusError('INVALID_PRESET', 'group config 必须是插件数组');
          entries(row.config, depth + 1);
        }
      }
    }
    entries(definition.plugins, 0);
    return { id: definition.id, name: definition.name, description: definition.description, order: definition.order, plugins: definition.plugins };
  }
  return {
    id: 'presets',
    capabilities: [
      { action: 'list', description: '查看三套当前正式 bundle 预设' },
      { action: 'get', description: '读取预设及用户配置修订' },
      { action: 'configure', description: '以 CAS 保存用户预设设置', mutating: true },
      { action: 'migrate.preview', description: '只读审查指定旧预设目录与功能映射' },
      { action: 'migrate.apply', description: '导入审查过的用户设置与文本资源', mutating: true },
      { action: 'import.preview', description: '审查具备完整插件组合的市场或本地预设声明' },
      { action: 'import.apply', description: '通过正式 registry 激活已批准的完整预设', mutating: true },
      { action: 'import.remove', description: '注销指定导入预设，保留已有会话精确代际', mutating: true },
      { action: 'restore', description: '恢复用户明确持久保存的导入预设', mutating: true },
    ],
    async dispatch(request, context) {
      const params = recordParams(request);
      const selected = (): NexusPreset => {
        const id = String(params.id ?? request.target?.id ?? '');
        const preset = NEXUS_PRESETS.find(entry => entry.id === id);
        if (!preset) throw new NexusError('NOT_FOUND', `预设不存在 ${id}`);
        return preset;
      };
      if (request.action === 'list') {
        const builtin = await Promise.all(NEXUS_PRESETS.map(async preset => ({
          ...preset, availableOnPlatform: preset.platform.includes(process.platform),
          configuration: await services.store.get('preset-config', preset.id),
          source: 'installed-bundle', permissionSandbox: false,
        })));
        return { items: builtin, imported: await services.store.list('imported-presets') };
      }
      if (request.action === 'get') {
        const preset = selected();
        return { preset, configuration: await services.store.get('preset-config', preset.id) };
      }
      if (request.action === 'configure') {
        const preset = selected();
        const config = params.configuration;
        if (!config || typeof config !== 'object' || Array.isArray(config)) throw new NexusError('INVALID_ARGUMENT', 'configuration 必须是对象');
        const existing = await services.store.get('preset-config', preset.id);
        if (request.expectedRevision === undefined) throw new NexusError('REVISION_REQUIRED', '修改预设需要 expectedRevision');
        if (request.expectedRevision !== (existing?.revision ?? 0)) throw new NexusError('STALE_REVISION', '预设已被更新');
        return services.store.put('preset-config', preset.id, {
          presetRevision: preset.presetRevision, settings: config, updatedAt: new Date().toISOString(),
          generation: Number((existing?.value as JsonRecord | undefined)?.generation ?? 0) + 1,
        }, request.expectedRevision);
      }
      if (request.action === 'migrate.preview') {
        const root = await realpath(requiredString(params, 'directory'));
        if (!await services.host.approve('presets.migrate.read', root, { readOnly: true })) throw new NexusError('APPROVAL_REQUIRED', '需要读取明确选择的旧预设目录');
        const files = [];
        for (const name of (await readdir(root)).slice(0, 200)) {
          const path = join(root, name);
          const stat = await lstat(path);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024 || !/\.(?:json|ya?ml|md|txt)$/i.test(name)) continue;
          const body = await readFile(path, 'utf8');
          files.push({ name, digest: createHash('sha256').update(body).digest('hex'), body, disposition: /prompt|persona|system|instruction/i.test(name) ? 'user-resource-requires-explicit-import' : 'configuration-review' });
        }
        const id = randomUUID();
        const mapping = { powershell: 'suite.windows-coding', bash: 'suite.windows-gitbash', adaptive: 'suite.adaptive-standard' };
        const preview = { id, directory: root, files, mapping, digest: createHash('sha256').update(JSON.stringify(files)).digest('hex'), createdAt: new Date().toISOString() };
        await services.store.put('preset-migrations', id, preview, 0);
        return preview;
      }
      if (request.action === 'migrate.apply') {
        const stored = await services.store.get<JsonRecord>('preset-migrations', requiredString(params, 'previewId'));
        if (!stored || stored.value.digest !== params.digest) throw new NexusError('STALE_REVISION', '迁移预览不存在或摘要不匹配');
        const files = stored.value.files as Array<{ name: string; body: string; digest: string }>;
        const selectedNames = Array.isArray(params.importResources) ? params.importResources.map(String) : [];
        if (!await services.host.approve('presets.migrate.import', String(stored.value.directory), { previewId: stored.id, resources: selectedNames })) throw new NexusError('APPROVAL_REQUIRED', '需要确认导入的具体资源');
        const imported = [];
        for (const file of files.filter(file => selectedNames.includes(file.name))) {
          const currentBody = await readFile(join(String(stored.value.directory), file.name), 'utf8');
          if (createHash('sha256').update(currentBody).digest('hex') !== file.digest) throw new NexusError('SOURCE_CHANGED', '旧预设文件已变化，请重新预览');
          const resourceId = randomUUID();
          await services.store.put('user-resources', resourceId, { name: file.name, body: file.body, trust: 'user-selected-data', executableInstruction: false, sourceDigest: file.digest }, 0);
          imported.push(resourceId);
        }
        return { importedResources: imported, originalsPreserved: true, automaticPromptInjection: false };
      }
      if (request.action === 'import.preview') {
        let definition: JsonRecord;
        let sourceDigest: string;
        let path: string | undefined;
        if (typeof params.resourceId === 'string') {
          const resource = await services.store.get<JsonRecord>('resources', params.resourceId);
          if (!resource || resource.value.kind !== 'preset' || typeof resource.value.path !== 'string') throw new NexusError('NOT_FOUND', '预设市场资源不存在');
          const root = await realpath(resource.value.path);
          const hashes = resource.value.fileHashes as Record<string, string>;
          const bodies: Record<string, string> = {};
          for (const file of ['preset.yml', 'agent.cordis.yml']) {
            if (!hashes?.[file]) throw new NexusError('INVALID_PRESET', `市场资源缺少完整组合 ${file}`);
            const content = await readFile(join(root, file), 'utf8');
            if (createHash('sha256').update(content).digest('hex') !== hashes[file]) throw new NexusError('RESOURCE_HASH_MISMATCH', '市场预设文件摘要不匹配');
            if (/!!js|!<[^>]+>/.test(content)) throw new NexusError('PRESET_CODE_REVIEW_REQUIRED', '带代码表达式的预设须经可信扩展工作台审查');
            bodies[file] = content;
          }
          const metadataDocument = parseDocument(bodies['preset.yml']);
          const pluginsDocument = parseDocument(bodies['agent.cordis.yml']);
          if (metadataDocument.errors.length || pluginsDocument.errors.length || metadataDocument.warnings.length || pluginsDocument.warnings.length) throw new NexusError('INVALID_PRESET', '市场预设 YAML 存在未解决诊断');
          const metadata = metadataDocument.toJS({ maxAliasCount: 20 }) as JsonRecord;
          const plugins = pluginsDocument.toJS({ maxAliasCount: 20 }) as unknown;
          const id = `market.${String(resource.value.marketId ?? params.resourceId).replace(/[^a-z0-9_.-]/gi, '_')}`;
          definition = validateDefinition({ id, name: metadata.name, description: metadata.description, order: metadata.order, plugins });
          sourceDigest = createHash('sha256').update(JSON.stringify(hashes)).digest('hex');
        } else if (params.definition !== undefined) {
          definition = validateDefinition(params.definition);
          sourceDigest = createHash('sha256').update(JSON.stringify(definition)).digest('hex');
        } else {
          path = await realpath(requiredString(params, 'path'));
          if (!await services.host.approve('presets.import.read', path, { explicitSelection: true })) throw new NexusError('APPROVAL_REQUIRED', '需要读取用户选择的预设声明');
          const info = await lstat(path);
          if (!info.isFile() || info.size > 4 * 1024 * 1024) throw new NexusError('INVALID_PRESET', '声明必须为不超过 4 MiB 的普通文件');
          const body = await readFile(path, 'utf8');
          if (/!!js|!<[^>]+>/.test(body)) throw new NexusError('PRESET_CODE_REVIEW_REQUIRED', '市场声明中的代码表达式须打包为可信插件并通过扩展工作台审查');
          const parsed = parseDocument(body);
          if (parsed.errors.length || parsed.warnings.length) throw new NexusError('INVALID_PRESET', '预设 YAML 存在未解决的语法或标签诊断', { errors: parsed.errors.map(error => error.message), warnings: parsed.warnings.map(warning => warning.message) });
          const raw = parsed.toJS({ maxAliasCount: 20 }) as unknown;
          const candidate = Array.isArray(raw) && raw.length === 1 ? (raw[0] as JsonRecord).config : raw;
          definition = validateDefinition(candidate);
          sourceDigest = createHash('sha256').update(body).digest('hex');
        }
        const preview = { id: randomUUID(), definition, path, resourceId: params.resourceId, sourceDigest, digest: createHash('sha256').update(JSON.stringify(definition)).digest('hex'), requiredApproval: 'trusted-plugin-composition', persistent: params.persistent !== false, createdAt: new Date().toISOString() };
        await services.store.put('preset-import-plans', preview.id, preview, 0);
        return preview;
      }
      if (request.action === 'import.apply') {
        if (typeof params.resourceId === 'string' && params.planId === undefined) {
          const preview = await services.invoke('presets', { action: 'import.preview', params: { resourceId: params.resourceId, persistent: true } }, context) as JsonRecord;
          const id = String((preview.definition as JsonRecord).id);
          const current = await services.store.get('imported-presets', id);
          return services.invoke('presets', { action: 'import.apply', requestId: randomUUID(), expectedRevision: current?.revision ?? 0, params: { planId: preview.id, digest: preview.digest } }, context);
        }
        const stored = await services.store.get<JsonRecord>('preset-import-plans', requiredString(params, 'planId'));
        if (!stored || stored.value.digest !== params.digest) throw new NexusError('STALE_REVISION', '预设导入计划不存在或摘要不一致');
        const plan = stored.value;
        const definition = validateDefinition(plan.definition);
        if (typeof plan.resourceId === 'string') {
          const freshPreview = await services.invoke('presets', { action: 'import.preview', params: { resourceId: plan.resourceId } }, context) as JsonRecord;
          if (freshPreview.sourceDigest !== plan.sourceDigest || freshPreview.digest !== plan.digest) throw new NexusError('RESOURCE_CHANGED', '市场预设组合已变化，请重新预览');
        }
        if (typeof plan.path === 'string' && createHash('sha256').update(await readFile(plan.path)).digest('hex') !== plan.sourceDigest) throw new NexusError('SOURCE_CHANGED', '预设来源变化，请重新预览');
        if (!context?.permissions?.has('presets.import.activate') && !await services.host.approve('presets.import.activate', String(definition.id), { planId: stored.id, digest: plan.digest, definition, persistent: plan.persistent })) throw new NexusError('APPROVAL_REQUIRED', '需要确认该预设会运行的完整插件组合');
        const current = await services.store.get('imported-presets', String(definition.id));
        if (request.expectedRevision !== (current?.revision ?? 0)) throw new NexusError('STALE_REVISION', '需要匹配 expectedRevision 才能更新导入预设');
        const result = await services.host.sessions('presets.register', { owner: `nexus.preset.${definition.id}`, definition });
        const handle = (result as JsonRecord)?.handle;
        if (typeof handle !== 'string') throw new NexusError('PRESET_REGISTRATION_UNVERIFIED', '宿主未返回精确声明句柄');
        const prior = importedHandles.get(String(definition.id));
        importedHandles.set(String(definition.id), handle);
        const saved = await services.store.put('imported-presets', String(definition.id), { definition, persistent: plan.persistent, sourceDigest: plan.sourceDigest, digest: plan.digest, registeredAt: new Date().toISOString(), status: 'registered' }, current?.revision ?? 0);
        if (prior) await services.host.sessions('presets.unregister', { handle: prior, owner: `nexus.preset.${definition.id}` });
        return { ...saved, hostRegistered: true };
      }
      if (request.action === 'import.remove') {
        const id = requiredString(params, 'id');
        const row = await services.store.get('imported-presets', id);
        if (!row) throw new NexusError('NOT_FOUND', '导入预设不存在');
        if (!context?.permissions?.has('presets.import.remove') && !await services.host.approve('presets.import.remove', id, {})) throw new NexusError('APPROVAL_REQUIRED', '需要确认注销该导入预设');
        const handle = importedHandles.get(id);
        if (handle) await services.host.sessions('presets.unregister', { handle, owner: `nexus.preset.${id}` });
        importedHandles.delete(id);
        await services.store.remove('imported-presets', id, request.expectedRevision);
        return { id, unregistered: Boolean(handle), existingSessionGenerationsPreserved: true };
      }
      if (request.action === 'restore') {
        const restored = []; const failures = [];
        for (const row of await services.store.list<JsonRecord>('imported-presets')) {
          if (row.value.persistent !== true || importedHandles.has(row.id)) continue;
          try {
            const result = await services.host.sessions('presets.register', { owner: `nexus.preset.${row.id}`, definition: validateDefinition(row.value.definition) }) as JsonRecord;
            if (typeof result.handle !== 'string') throw new NexusError('PRESET_REGISTRATION_UNVERIFIED', '缺少声明句柄');
            importedHandles.set(row.id, result.handle); restored.push(row.id);
          } catch (error) { failures.push({ id: row.id, error: String(error) }); }
        }
        return { restored, failures };
      }
      throw new NexusError('UNKNOWN_ACTION', `未知预设操作 ${request.action}`);
    },
    async dispose() {
      await Promise.allSettled([...importedHandles].map(([id, handle]) => services.host.sessions('presets.unregister', { handle, owner: `nexus.preset.${id}` })));
      importedHandles.clear();
    },
  };
}
