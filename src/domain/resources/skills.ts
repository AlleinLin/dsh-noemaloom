/**
 * Filesystem skill discovery and safe SKILL.md authoring.
 * Source precedence follows dsh-skill-filesystem/dsh-skill-explorer.
 * Unknown frontmatter is data, never executable Cordis configuration.
 */
import { homedir } from 'node:os';
import { readdir, readFile, lstat, stat, realpath, mkdir, open, rename, rm } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parseDocument, stringify } from 'yaml';
import { unzipSync } from 'fflate';
import { NexusError, type DispatchContext, type JsonRecord, type NexusRequest, type NexusServices } from '../../ports/contracts.js';
import { within, workspacePath } from '../files/paths.js';

const MAX_SKILL = 1024 * 1024;
const MAX_IMPORT = 64 * 1024 * 1024;
const MAX_IMPORT_FILES = 2000;
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const skillSourceRanks: Record<string, number> = {
  'project-dsh': 100, 'project-agents': 200, runtime: 250, custom: 300,
  'user-dsh': 400, 'user-agents': 500, bundled: 600,
};
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const plain = (value: unknown): value is JsonRecord => value !== null && typeof value === 'object' && !Array.isArray(value);
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

interface Root { source: string; root: string; ioRoot: string; pathPrefix: string; readOnly: boolean }
export interface SkillSummary extends JsonRecord {
  id: string; kind: 'skill'; name: string; description: string; source: string; priority: number;
  path?: string; root?: string; ioRoot?: string; editable: boolean; fileState: 'editable' | 'provider-file' | 'virtual';
  enabled: boolean; modelInvocable: boolean; userInvocable: boolean; providerEnabled: boolean;
  effective: boolean; shadowedBy?: string; warnings: string[];
}
interface ParsedSkill { metadata: JsonRecord; body: string; document: ReturnType<typeof parseDocument>; newline: string; prefix: string }

export function parseSkillContent(content: string): ParsedSkill {
  if (Buffer.byteLength(content) > MAX_SKILL) throw new NexusError('RESOURCE_LIMIT', '技能文件超过 1 MiB');
  const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(content);
  if (!match) throw new NexusError('FORMAT_UNSUPPORTED', '技能必须有 YAML frontmatter、name 和 description');
  if (match[1].length > 65536) throw new NexusError('RESOURCE_LIMIT', '技能元数据超过 64 KiB');
  const document = parseDocument(match[1], { schema: 'core', uniqueKeys: true, customTags: [] });
  if (document.errors.length || document.warnings.some(warning => warning.code === 'TAG_RESOLVE_FAILED')) {
    throw new NexusError('FORMAT_UNSUPPORTED', '技能 YAML 无效或包含不支持的标签', { errors: document.errors.map(item => item.message) });
  }
  let metadata: unknown;
  try { metadata = document.toJS({ maxAliasCount: 20, mapAsMap: false }); }
  catch { throw new NexusError('FORMAT_UNSUPPORTED', '技能 YAML 别名展开超过上限'); }
  if (!plain(metadata) || Object.keys(metadata).some(key => ['__proto__', 'prototype', 'constructor'].includes(key))) {
    throw new NexusError('FORMAT_UNSUPPORTED', '技能元数据必须为普通映射');
  }
  if (typeof metadata.name !== 'string' || !NAME.test(metadata.name) || metadata.name.length > 128) throw new NexusError('INVALID_ARGUMENT', '技能 name 必须为不超过 128 字符的 kebab-case');
  if (typeof metadata.description !== 'string' || !metadata.description.trim()) throw new NexusError('INVALID_ARGUMENT', '技能 description 不能为空');
  for (const field of ['disable-model-invocation', 'user-invocable']) {
    if (metadata[field] !== undefined && typeof metadata[field] !== 'boolean') throw new NexusError('INVALID_ARGUMENT', `${field} 必须为布尔值`);
  }
  return { metadata, body: content.slice(match[0].length), document, newline: content.includes('\r\n') ? '\r\n' : '\n', prefix: content.startsWith('\uFEFF') ? '\uFEFF' : '' };
}

function rewrite(parsed: ParsedSkill, fields: JsonRecord, body = parsed.body) {
  for (const [key, value] of Object.entries(fields)) parsed.document.set(key, value);
  const block = parsed.document.toString().replace(/\r?\n/g, parsed.newline).replace(/(?:\r?\n)+$/, '');
  return `${parsed.prefix}---${parsed.newline}${block}${parsed.newline}---${parsed.newline}${body}`;
}

function safeRel(value: string) {
  if (!value || value.includes('\0') || value.includes('\\') || value.startsWith('/') || /^[a-z]:/i.test(value)
    || value.split('/').some(part => !part || part === '.' || part === '..' || /[:\x00-\x1f]/.test(part))) {
    throw new NexusError('SCOPE_MISMATCH', '导入条目路径不安全');
  }
  return value;
}

async function hasLinkedAncestor(path: string): Promise<boolean> {
  // realpath also expands Windows short names; a spelling change alone is
  // not evidence of a link. Inspect every component to retain junction and
  // symlink protection, including links above the configured skill root.
  let current = resolve(path);
  for (;;) {
    if ((await lstat(current)).isSymbolicLink()) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

export function createSkillResources(services: NexusServices) {
  async function roots(context?: DispatchContext): Promise<Root[]> {
    const workspace = resolve(context?.workspaceRoot ?? services.workspaceRoot);
    let facts: JsonRecord = {};
    try { facts = await services.host.facts(); } catch { /* Conventional roots remain discoverable when a registry is unavailable. */ }
    const userDsh = typeof facts.dshHome === 'string' ? resolve(facts.dshHome) : join(homedir(), '.dsh');
    const userAgents = typeof facts.agentsHome === 'string' ? resolve(facts.agentsHome) : join(homedir(), '.agents');
    const list: Root[] = [
      { source: 'project-dsh', root: join(workspace, '.dsh', 'skills'), ioRoot: workspace, pathPrefix: '.dsh/skills', readOnly: false },
      { source: 'project-agents', root: join(workspace, '.agents', 'skills'), ioRoot: workspace, pathPrefix: '.agents/skills', readOnly: false },
      { source: 'user-dsh', root: join(userDsh, 'skills'), ioRoot: dirname(userDsh), pathPrefix: `${basename(userDsh)}/skills`, readOnly: false },
      { source: 'user-agents', root: join(userAgents, 'skills'), ioRoot: dirname(userAgents), pathPrefix: `${basename(userAgents)}/skills`, readOnly: false },
    ];
    const configured = Array.isArray(facts.customSkillDirs) ? facts.customSkillDirs : [];
    for (const directory of configured) if (typeof directory === 'string') {
      const root = resolve(directory);
      // Provider configuration is host evidence; these are never accepted from RPC input.
      list.push({ source: 'custom', root, ioRoot: root, pathPrefix: '', readOnly: false });
    }
    if (services.packageRoot) list.push({ source: 'bundled', root: join(services.packageRoot, 'assets', 'skills'), ioRoot: services.packageRoot, pathPrefix: 'assets/skills', readOnly: true });
    return list;
  }

  async function file(action: string, params: JsonRecord, root: string, context: DispatchContext | undefined, request?: NexusRequest) {
    const permissions = new Set(context?.permissions ?? []);
    // The resource action already authorizes this exact, freshly resolved skill path.
    if (['write', 'edit', 'rename', 'mkdir'].includes(action)) permissions.add(`files.${action}`);
    return services.invoke('files', {
      action, params, ...(request?.requestId ? { requestId: `${request.requestId}:skill:${action}:${hash(String(params.path)).slice(0, 16)}` } : {}),
      ...(request?.expectedRevision !== undefined ? { expectedRevision: request.expectedRevision } : {}),
    }, { ...context, workspaceRoot: root, permissions }) as Promise<JsonRecord>;
  }

  async function scan(context?: DispatchContext) {
    const items: SkillSummary[] = [], issues: JsonRecord[] = [];
    for (const source of await roots(context)) {
      let entries;
      try { entries = await readdir(source.root, { withFileTypes: true }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') issues.push({ source: source.source, root: source.root, code: 'UNREADABLE', message: errorText(error) });
        continue;
      }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name.startsWith('.')) continue;
        let candidate = entry.isDirectory() ? join(source.root, entry.name, 'SKILL.md')
          : entry.isFile() && entry.name.toLowerCase().endsWith('.md') ? join(source.root, entry.name) : undefined;
        if (entry.isSymbolicLink()) {
          const target = await stat(join(source.root, entry.name)).catch(() => undefined);
          if (target?.isDirectory()) candidate = join(source.root, entry.name, 'SKILL.md');
          else if (target?.isFile() && entry.name.toLowerCase().endsWith('.md')) candidate = join(source.root, entry.name);
        }
        if (!candidate) continue;
        try {
          const info = await stat(candidate);
          if (!info.isFile()) continue;
          if (info.size > MAX_SKILL) throw new NexusError('RESOURCE_LIMIT', '技能文件超过 1 MiB');
          const actual = await realpath(candidate), linked = await hasLinkedAncestor(candidate);
          const content = await readFile(candidate, 'utf8'), parsed = parseSkillContent(content);
          const local = within(await realpath(source.ioRoot), actual);
          const editable = !source.readOnly && local && !linked;
          const warnings: string[] = [];
          if (linked) warnings.push('链接技能只读，不能由资源页改写或删除链接目标');
          const refs = [...parsed.body.matchAll(/\]\((?!https?:|mailto:|#)([^)\s]+)(?:\s+[^)]*)?\)/g)].map(match => match[1]);
          const enabled = parsed.metadata['disable-model-invocation'] !== true;
          items.push({
            id: `skill:${source.source}:${hash(resolve(candidate)).slice(0, 24)}`, kind: 'skill',
            name: String(parsed.metadata.name), description: String(parsed.metadata.description),
            whenToUse: parsed.metadata.whenToUse ?? parsed.metadata.applicability ?? null,
            source: source.source, priority: skillSourceRanks[source.source] ?? 999, provider: 'filesystem',
            path: candidate, root: source.root, ioRoot: source.ioRoot,
            hash: hash(content), byteLength: info.size, updatedAt: info.mtime.toISOString(),
            license: parsed.metadata.license ?? null, version: parsed.metadata.version ?? null,
            tags: Array.isArray(parsed.metadata.tags) ? parsed.metadata.tags : [],
            editable, readOnly: !editable, fileState: editable ? 'editable' : 'provider-file',
            enabled, modelInvocable: enabled, disableModelInvocation: !enabled,
            userInvocable: parsed.metadata['user-invocable'] !== false, providerEnabled: true,
            effective: false, linked, warnings, references: refs, metadataKeys: Object.keys(parsed.metadata),
            resourceBase: dirname(candidate),
          });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') issues.push({ source: source.source, path: candidate, code: error instanceof NexusError ? error.code : 'UNREADABLE', message: errorText(error) });
        }
      }
    }
    let registry: unknown;
    try { registry = await services.host.sessions('skills.list', { cwd: context?.workspaceRoot ?? services.workspaceRoot, sessionId: context?.sessionId }); }
    catch (error) { issues.push({ source: 'registry', code: 'PROVIDER_UNAVAILABLE', message: errorText(error), checked: false }); }
    const providerRows = Array.isArray(registry) ? registry : plain(registry) && Array.isArray(registry.items) ? registry.items : [];
    for (const raw of providerRows) {
      if (!plain(raw) || typeof raw.name !== 'string' || !NAME.test(raw.name)) continue;
      if (typeof raw.path === 'string' && items.some(item => item.path && resolve(item.path) === resolve(raw.path as string))) continue;
      const source = typeof raw.source === 'string' ? raw.source : 'runtime';
      const invocation = plain(raw.invocation) ? raw.invocation : {};
      const provider = typeof raw.provider === 'string' ? raw.provider : 'host';
      const id = `skill:${source}:${hash(`${provider}:${raw.name}:${String(raw.path ?? '')}`).slice(0, 24)}`;
      const switchState = await services.store.get<JsonRecord>('resourceProviderSwitches', id);
      const providerEnabled = switchState?.value.enabled !== false;
      items.push({
        id, kind: 'skill', name: raw.name, description: typeof raw.description === 'string' ? raw.description : '',
        whenToUse: raw.whenToUse ?? null, source, provider, priority: skillSourceRanks[source] ?? 999,
        path: typeof raw.path === 'string' ? raw.path : undefined, editable: false, readOnly: true,
        fileState: typeof raw.path === 'string' ? 'provider-file' : 'virtual',
        enabled: invocation.modelInvocable !== false, modelInvocable: invocation.modelInvocable !== false,
        disableModelInvocation: invocation.modelInvocable === false, userInvocable: invocation.userInvocable !== false,
        providerEnabled, effective: false, warnings: [], license: raw.license ?? null,
        version: raw.version ?? null, resourceBase: raw.resourceBase ?? null,
      });
    }
    items.sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    const winners = new Map<string, SkillSummary>();
    for (const item of items) {
      const winner = winners.get(item.name);
      if (winner) { item.shadowedBy = winner.id; item.effective = false; }
      else { item.effective = true; winners.set(item.name, item); }
      item.status = item.shadowedBy ? 'shadowed' : !item.providerEnabled ? 'provider-disabled' : item.enabled ? 'enabled' : 'disabled';
      item.providerToggleScope = item.provider === 'filesystem' ? 'frontmatter' : 'nexus-invocable-view';
      if (item.provider !== 'filesystem') item.warnings.push('provider 开关仅控制 Nexus 可调用视图，不改变宿主模型实际加载策略');
    }
    return { items, issues, roots: (await roots(context)).map(({ ioRoot: _io, ...root }) => root), observedAt: new Date().toISOString() };
  }

  async function resolveSkill(params: JsonRecord, context?: DispatchContext) {
    const all = await scan(context);
    const found = all.items.filter(item => typeof params.id === 'string' ? item.id === params.id
      : item.name === params.name && (params.source === undefined || item.source === params.source) && (params.path === undefined || item.path === params.path));
    if (found.length === 0) throw new NexusError('NOT_FOUND', '技能不存在；请刷新来源列表');
    if (found.length > 1) throw new NexusError('INVALID_ARGUMENT', '存在同名技能，请指定 id 或 source/path');
    return found[0];
  }

  async function get(params: JsonRecord, context?: DispatchContext): Promise<JsonRecord> {
    const skill = await resolveSkill(params, context);
    if (skill.ioRoot && skill.path) {
      const observed = await file('read', { path: relative(skill.ioRoot, skill.path), maxBytes: MAX_SKILL }, skill.ioRoot, context);
      if (observed.binary || observed.truncated || typeof observed.content !== 'string') throw new NexusError('FORMAT_UNSUPPORTED', '技能不是完整文本文件');
      const parsed = parseSkillContent(observed.content);
      return { ...skill, ...observed, path: skill.path, metadata: parsed.metadata, body: parsed.body, content: observed.content };
    }
    const detail = await services.host.sessions('skills.get', { name: skill.name, provider: skill.provider, cwd: context?.workspaceRoot ?? services.workspaceRoot, sessionId: context?.sessionId });
    return { ...skill, detail, readOnly: true };
  }

  async function write(request: NexusRequest, context?: DispatchContext) {
    const params = request.params ?? {};
    const current = await get(params, context);
    if (!current.editable || typeof current.ioRoot !== 'string' || typeof current.path !== 'string' || typeof current.content !== 'string') throw new NexusError('PERMISSION_DENIED', '系统、provider-owned、虚拟或链接技能为只读');
    if (params.expectedHash === undefined && request.expectedRevision === undefined && params.expectedRevision === undefined) throw new NexusError('REVISION_CONFLICT', '保存技能必须携带读取时的 expectedHash 或 expectedRevision');
    const before = parseSkillContent(current.content);
    let candidate: string;
    if (typeof params.content === 'string' && request.action.endsWith('write')) {
      candidate = params.content;
      const after = parseSkillContent(candidate);
      for (const key of ['name', 'disable-model-invocation', 'user-invocable']) if (after.metadata[key] !== before.metadata[key]) {
        throw new NexusError('INVALID_ARGUMENT', '正文/frontmatter 编辑不能改技能名或启用状态；请使用专用开关');
      }
    } else {
      const fields: JsonRecord = {};
      for (const key of ['description', 'whenToUse', 'applicability']) if (params[key] !== undefined) {
        if (typeof params[key] !== 'string') throw new NexusError('INVALID_ARGUMENT', `${key} 必须为文本`);
        fields[key] = params[key];
      }
      if (plain(params.metadata)) for (const [key, value] of Object.entries(params.metadata)) {
        if (['name', 'disable-model-invocation', 'user-invocable', '__proto__', 'constructor', 'prototype'].includes(key)) throw new NexusError('INVALID_ARGUMENT', '此元数据字段不能由描述编辑修改');
        fields[key] = value;
      }
      if (params.body !== undefined && typeof params.body !== 'string') throw new NexusError('INVALID_ARGUMENT', 'body 必须为文本');
      candidate = rewrite(before, fields, typeof params.body === 'string' ? params.body : before.body);
      parseSkillContent(candidate);
    }
    const result = await file('write', {
      path: relative(current.ioRoot, current.path), content: candidate,
      expectedHash: params.expectedHash, expectedRevision: params.expectedRevision,
    }, current.ioRoot, context, request);
    services.emit('resources.skills.changed', { id: current.id, name: current.name, effect: 'committed' });
    return { ...result, id: current.id, name: current.name, path: current.path };
  }

  async function toggle(request: NexusRequest, enabled: boolean, context?: DispatchContext) {
    const params = request.params ?? {}, current = await get(params, context);
    if (!current.editable || typeof current.path !== 'string' || typeof current.ioRoot !== 'string' || typeof current.content !== 'string') throw new NexusError('PERMISSION_DENIED', '只读技能不能改写 frontmatter；provider 视图请使用 skills.provider.set');
    const parsed = parseSkillContent(current.content);
    const content = rewrite(parsed, { 'disable-model-invocation': !enabled });
    const result = await file('write', {
      path: relative(current.ioRoot, current.path), content,
      expectedHash: typeof params.expectedHash === 'string' ? params.expectedHash : current.hash,
      expectedRevision: params.expectedRevision,
    }, current.ioRoot, context, request);
    services.emit('resources.skills.changed', { id: current.id, enabled });
    return { ...result, id: current.id, enabled, modelInvocable: enabled, userInvocable: current.userInvocable };
  }

  async function providerSet(request: NexusRequest, context?: DispatchContext) {
    const params = request.params ?? {}, skill = await resolveSkill(params, context);
    if (skill.provider === 'filesystem') throw new NexusError('INVALID_ARGUMENT', '文件系统技能请使用 enable/disable');
    if (typeof params.enabled !== 'boolean') throw new NexusError('INVALID_ARGUMENT', 'enabled 必须为布尔值');
    const previous = await services.store.get<JsonRecord>('resourceProviderSwitches', skill.id);
    const result = await services.store.put('resourceProviderSwitches', skill.id, { enabled: params.enabled, provider: skill.provider, name: skill.name }, request.expectedRevision ?? previous?.revision ?? 0);
    return { ...result, scope: 'nexus-invocable-view', hostModelPolicyChanged: false };
  }

  async function targetRoot(params: JsonRecord, context?: DispatchContext) {
    const scope = String(params.scope ?? params.root ?? 'project-dsh');
    const source = scope === 'project' ? 'project-dsh' : scope === 'user' ? 'user-dsh' : scope;
    const root = (await roots(context)).find(item => item.source === source && !item.readOnly);
    if (!root) throw new NexusError('INVALID_ARGUMENT', '技能位置必须为项目 .dsh/.agents、用户 .dsh/.agents 或宿主声明的自定义根');
    return root;
  }

  async function create(request: NexusRequest, context?: DispatchContext) {
    const params = request.params ?? {}, root = await targetRoot(params, context);
    if (typeof params.name !== 'string' || !NAME.test(params.name) || params.name.length > 128) throw new NexusError('INVALID_ARGUMENT', 'name 必须为 kebab-case');
    let content = typeof params.content === 'string' && /^\uFEFF?---\r?\n|^---\r?\n/.test(params.content) ? params.content : undefined;
    if (content === undefined) {
      if (typeof params.description !== 'string' || !params.description.trim()) throw new NexusError('INVALID_ARGUMENT', 'description 不能为空');
      const metadata: JsonRecord = { ...(plain(params.metadata) ? params.metadata : {}), name: params.name, description: params.description };
      if (typeof params.whenToUse === 'string') metadata.whenToUse = params.whenToUse;
      content = `---\n${stringify(metadata)}---\n${typeof params.body === 'string' ? params.body : typeof params.content === 'string' ? params.content : ''}`;
    }
    const parsed = parseSkillContent(content);
    if (parsed.metadata.name !== params.name) throw new NexusError('INVALID_ARGUMENT', 'frontmatter name 与目标技能名不一致');
    const all = await scan(context);
    const stronger = all.items.find(item => item.name === params.name && item.priority <= (skillSourceRanks[root.source] ?? 999));
    const path = join(root.root, params.name, 'SKILL.md');
    if (params.dryRun === true) return { effect: 'preview', name: params.name, path, source: root.source, shadowedBy: stronger?.id ?? null, contentHash: hash(content), overwrite: false };
    const result = await file('write', { path: relative(root.ioRoot, path), content, createOnly: true }, root.ioRoot, context, request);
    services.emit('resources.skills.changed', { name: params.name, path });
    return { ...result, name: params.name, path, source: root.source, shadowedBy: stronger?.id ?? null };
  }

  async function remove(request: NexusRequest, context?: DispatchContext) {
    const params = request.params ?? {}, current = await get(params, context);
    if (!current.editable || typeof current.ioRoot !== 'string' || typeof current.path !== 'string' || typeof current.root !== 'string') throw new NexusError('PERMISSION_DENIED', '只读、provider-owned 或链接技能不能删除');
    const expected = request.expectedRevision ?? params.expectedRevision;
    if (typeof expected !== 'number' || expected !== current.revision || (params.expectedHash !== undefined && params.expectedHash !== current.hash)) throw new NexusError('REVISION_CONFLICT', '删除必须携带当前版本，且 Hash 必须匹配');
    // Product trash is a move of the selected instruction file, never a profile or deployment snapshot.
    const destination = join(current.root, '.trash', `${Date.now()}-${randomUUID()}-${basename(dirname(current.path))}`, 'SKILL.md');
    const result = await file('rename', { path: relative(current.ioRoot, current.path), destination: relative(current.ioRoot, destination) }, current.ioRoot, context, { ...request, expectedRevision: expected });
    await services.store.put('resourceTrash', randomUUID(), { kind: 'skill', name: current.name, path: destination, originalPath: current.path, hash: current.hash, movedAt: new Date().toISOString() });
    services.emit('resources.skills.changed', { id: current.id, removed: true });
    return { ...result, id: current.id, trashed: true, destination, sourceAssetsPreserved: true };
  }

  async function importSkills(request: NexusRequest, context?: DispatchContext) {
    const params = request.params ?? {}, root = await targetRoot(params, context);
    const groups = new Map<string, Map<string, Buffer>>();
    const problems: JsonRecord[] = [];
    let total = 0, count = 0;
    const add = (group: string, rel: string, bytes: Buffer) => {
      safeRel(rel);
      if (++count > MAX_IMPORT_FILES || (total += bytes.length) > MAX_IMPORT || bytes.length > 8 * 1024 * 1024) throw new NexusError('RESOURCE_LIMIT', '技能导入超过文件数或展开预算');
      if (!groups.has(group)) groups.set(group, new Map());
      if (groups.get(group)!.has(rel)) throw new NexusError('INVALID_ARGUMENT', '导入包含重复文件');
      groups.get(group)!.set(rel, bytes);
    };
    if (typeof params.base64 === 'string' || typeof params.zipBase64 === 'string') {
      const encoded = String(params.base64 ?? params.zipBase64);
      if (encoded.length > 24 * 1024 * 1024 || !/^[a-z0-9+/=\s]+$/i.test(encoded)) throw new NexusError('RESOURCE_LIMIT', 'ZIP 数据超过预算或编码无效');
      let expanded = 0, entries = 0;
      const files = unzipSync(Buffer.from(encoded, 'base64'), { filter: item => {
        if (item.name.endsWith('/')) { safeRel(item.name.slice(0, -1)); return false; }
        safeRel(item.name);
        if (++entries > MAX_IMPORT_FILES || (expanded += item.originalSize) > MAX_IMPORT || item.originalSize > 8 * 1024 * 1024
          || (item.size > 0 && item.originalSize / item.size > 200)) throw new NexusError('RESOURCE_LIMIT', 'ZIP 展开超过安全预算');
        return true;
      } });
      const skillFiles = Object.keys(files).filter(path => basename(path) === 'SKILL.md');
      for (const skillPath of skillFiles) {
        const directory = dirname(skillPath).replace(/\\/g, '/');
        const key = directory === '.' ? 'root' : directory;
        for (const [path, bytes] of Object.entries(files)) {
          if (path === skillPath || (directory !== '.' && path.startsWith(`${directory}/`))) {
            const rel = directory === '.' ? path : path.slice(directory.length + 1);
            if (!rel.split('/').some(part => part.startsWith('.') || ['node_modules', '__MACOSX'].includes(part))) add(key, rel, Buffer.from(bytes));
          }
        }
      }
      if (!skillFiles.length) throw new NexusError('FORMAT_UNSUPPORTED', 'ZIP 内没有 SKILL.md');
    } else if (typeof params.path === 'string' && params.path) {
      const workspace = context?.workspaceRoot ?? services.workspaceRoot;
      let source: string;
      if (isAbsolute(params.path) && !within(resolve(workspace), resolve(params.path))) {
        source = await realpath(params.path);
        if (!await services.host.approve('resources.import.read', source, { readOnly: true, explicitSource: params.path })) throw new NexusError('PERMISSION_DENIED', '导入来源超出工作区且未获宿主授权');
      } else source = await workspacePath(workspace, params.path);
      const info = await lstat(source);
      if (info.isSymbolicLink()) throw new NexusError('SCOPE_MISMATCH', '不能从链接目录导入技能');
      if (info.isFile() && extname(source).toLowerCase() === '.zip') {
        const bytes = await readFile(source);
        if (bytes.length > 16 * 1024 * 1024) throw new NexusError('RESOURCE_LIMIT', 'ZIP 文件超过 16 MiB');
        return importSkills({ ...request, params: { ...params, path: undefined, zipBase64: bytes.toString('base64') } }, context);
      }
      const directories: string[] = [];
      if (info.isDirectory()) {
        if (await stat(join(source, 'SKILL.md')).then(value => value.isFile()).catch(() => false)) directories.push(source);
        else for (const entry of await readdir(source, { withFileTypes: true })) {
          if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
          if (entry.isDirectory()) directories.push(join(source, entry.name));
          else if (entry.isFile() && entry.name.endsWith('.md')) {
            try { add(entry.name, 'SKILL.md', await readFile(join(source, entry.name))); }
            catch (error) { problems.push({ path: entry.name, status: 'invalid', message: errorText(error) }); }
          }
        }
      } else if (info.isFile() && extname(source).toLowerCase() === '.md') add(basename(source), 'SKILL.md', await readFile(source));
      else throw new NexusError('FORMAT_UNSUPPORTED', '技能导入来源须为目录、Markdown 或 ZIP');
      for (const directory of directories) {
        const queue = [directory];
        while (queue.length) {
          const current = queue.shift()!;
          for (const entry of await readdir(current, { withFileTypes: true })) {
            if (entry.name.startsWith('.') || entry.isSymbolicLink() || entry.name === 'node_modules') continue;
            const path = join(current, entry.name);
            if (!within(directory, await realpath(path))) throw new NexusError('SCOPE_MISMATCH', '技能资源链接越界');
            if (entry.isDirectory()) queue.push(path);
            else if (entry.isFile()) {
              const info = await stat(path);
              if (info.size > 8 * 1024 * 1024 || total + info.size > MAX_IMPORT) throw new NexusError('RESOURCE_LIMIT', '技能资源超过导入预算');
              add(directory, relative(directory, path).replace(/\\/g, '/'), await readFile(path));
            }
          }
        }
      }
    } else if (Array.isArray(params.items)) {
      if (params.items.length > 100) throw new NexusError('RESOURCE_LIMIT', '最多导入 100 个文本技能');
      for (let index = 0; index < params.items.length; index++) {
        const item = params.items[index];
        if (!plain(item) || typeof item.content !== 'string') { problems.push({ index, status: 'invalid', message: 'content 必须为文本' }); continue; }
        add(String(index), 'SKILL.md', Buffer.from(item.content));
      }
    } else throw new NexusError('INVALID_ARGUMENT', '请指定目录 path、zipBase64 或 items');
    const existing = await scan(context), reports: JsonRecord[] = [...problems], plannedNames = new Set<string>();
    for (const [group, files] of groups) {
      let parsed: ParsedSkill;
      try {
        const instruction = files.get('SKILL.md');
        if (!instruction) { reports.push({ source: group, status: 'skipped', reason: 'missing-skill' }); continue; }
        parsed = parseSkillContent(instruction.toString('utf8'));
      } catch (error) { reports.push({ source: group, status: 'invalid', message: errorText(error) }); continue; }
      const name = String(parsed.metadata.name), destination = join(root.root, name);
      const stronger = existing.items.find(item => item.name === name && item.priority <= (skillSourceRanks[root.source] ?? 999));
      const destinationExists = await lstat(destination).then(() => true).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return false; });
      if (stronger || destinationExists || plannedNames.has(name)) {
        reports.push({ source: group, name, status: 'skipped', reason: stronger ? 'same-name-stronger-source' : 'destination-exists', shadowedBy: stronger?.id ?? null }); continue;
      }
      plannedNames.add(name);
      const preview: JsonRecord = {
        source: group, name, path: destination, status: params.dryRun === false ? 'pending' : 'preview',
        files: files.size, bytes: [...files.values()].reduce((sum, bytes) => sum + bytes.length, 0),
        license: parsed.metadata.license ?? null, licenseStatus: parsed.metadata.license ? 'declared' : 'undeclared',
      };
      if (params.dryRun !== false) { reports.push(preview); continue; }
      let stage: string | undefined;
      try {
        await workspacePath(root.ioRoot, relative(root.ioRoot, destination), true);
        await mkdir(root.root, { recursive: true });
        await workspacePath(root.ioRoot, relative(root.ioRoot, root.root));
        stage = join(root.root, `.nexus-import-${randomUUID()}`);
        await mkdir(stage, { recursive: false });
        const hashes: Record<string, string> = {};
        for (const [rel, bytes] of files) {
          const target = join(stage, rel);
          await mkdir(dirname(target), { recursive: true });
          const handle = await open(target, 'wx', 0o600);
          try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
          hashes[rel] = hash(bytes);
        }
        // Rename never replaces a populated skill directory; an explicit existence check also rejects an empty destination.
        if (await lstat(destination).then(() => true).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return false; })) throw new NexusError('REVISION_CONFLICT', '导入期间目标已创建');
        await rename(stage, destination); stage = undefined;
        const provenance = await services.store.put('resourceImports', randomUUID(), { kind: 'skill', name, source: group, destination, files: hashes, importedAt: new Date().toISOString(), license: parsed.metadata.license ?? null });
        reports.push({ ...preview, status: 'imported', provenanceRef: provenance.id });
        services.emit('resources.skills.changed', { name, path: destination });
      } catch (error) { reports.push({ ...preview, status: 'failed', message: errorText(error) }); }
      finally { if (stage && within(root.root, stage)) await rm(stage, { recursive: true, force: true }); }
    }
    return { effect: params.dryRun !== false ? 'preview' : 'committed', items: reports, overwrite: false, atomicPerSkill: true };
  }

  async function health(context?: DispatchContext) {
    const result = await scan(context), checks: JsonRecord[] = [...result.issues];
    for (const item of result.items) {
      if (item.shadowedBy) checks.push({ id: item.id, name: item.name, code: 'SHADOWED', status: 'warning', shadowedBy: item.shadowedBy });
      if (item.fileState === 'virtual') checks.push({ id: item.id, code: 'NO_LOCAL_FILE', status: 'not-applicable' });
      if (typeof item.path === 'string' && item.ioRoot) {
        for (const reference of Array.isArray(item.references) ? item.references : []) {
          if (typeof reference !== 'string') continue;
          try {
            const raw = decodeURIComponent(reference.split('#')[0]);
            const path = resolve(dirname(item.path), raw);
            if (!within(dirname(item.path), path)) checks.push({ id: item.id, reference, code: 'REFERENCE_OUTSIDE_SKILL', status: 'warning' });
            else if (!await stat(path).then(() => true).catch(() => false)) checks.push({ id: item.id, reference, code: 'BROKEN_REFERENCE', status: 'failed' });
          } catch { checks.push({ id: item.id, reference, code: 'INVALID_REFERENCE', status: 'failed' }); }
        }
      }
    }
    return { observedAt: result.observedAt, checked: ['frontmatter', 'source-priority', 'paths', 'relative-references'], items: checks, skillCount: result.items.length, complete: !result.issues.some(item => item.checked === false), healthy: checks.some(item => item.status === 'failed') ? false : result.issues.length ? null : true };
  }

  return { scan, get, write, toggle, providerSet, create, remove, importSkills, health };
}
