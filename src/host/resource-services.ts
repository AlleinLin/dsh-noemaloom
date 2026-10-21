import { scopeOf } from '@deepseek-ai/dsh-scope';
import { NexusError, type JsonRecord } from '../ports/contracts.js';
import type { HostContext } from './types.js';

function requiredService(ctx: HostContext, name: string, method: string) {
  const service = ctx.get(name);
  if (typeof service?.[method] !== 'function') throw new NexusError('DEPENDENCY_MISSING', `DSH ${name}.${method} 正式服务不可用`);
  return service;
}
function stringParam(params: JsonRecord, key: string) {
  const value = params[key];
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || /[\x00-\x1f]/.test(value)) throw new NexusError('INVALID_ARGUMENT', `${key} 必须为受限非空文本`);
  return value;
}
function objectParam(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function expectedRevision(params: JsonRecord) {
  const revision = params.expectedRevision;
  if (!Number.isSafeInteger(revision) || Number(revision) < 0) throw new NexusError('REVISION_REQUIRED', '宿主配置保存必须携带读取时的 expectedRevision');
  return Number(revision);
}

/**
 * rc.2 public resource seams only. The host adapter remains the sole manager
 * authority; this helper neither reads nor writes profile files.
 *
 * Evidence:
 * - packages/skill/skill/src/index.ts SkillRegistry.list/snapshot/get
 * - packages/settings/settings/src/index.ts SettingsForms.describe/update/mutate
 * - packages/client/ui-settings-general/src/client/desktop-update-source.ts
 *   Desktop updates belong to the isolated renderer preload, not a Host service.
 */
export async function resourceHostAction(ctx: HostContext, action: string, params: JsonRecord): Promise<{ handled: boolean; result?: unknown }> {
  if (['skills.list', 'skills.snapshot', 'skills.get'].includes(action)) {
    const registry = requiredService(ctx, 'skills', action === 'skills.get' ? 'get' : action === 'skills.snapshot' ? 'snapshot' : 'list');
    const sessionId = typeof params.sessionId === 'string' ? params.sessionId : undefined;
    const agent = sessionId ? ctx.get('agents')?.get?.(sessionId) : undefined;
    const scope = agent?.ctx ? scopeOf(agent.ctx) : undefined;
    const options = { ...(typeof params.cwd === 'string' ? { cwd: params.cwd } : {}), ...(scope ? { scope } : {}), ...(params.signal instanceof AbortSignal ? { signal: params.signal } : {}) };
    if (action === 'skills.list') return { handled: true, result: await registry.list(options) };
    if (action === 'skills.snapshot') return { handled: true, result: await registry.snapshot(options) };
    const name = stringParam(params, 'name');
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new NexusError('INVALID_ARGUMENT', '技能名称不是 kebab-case');
    const result = await registry.get(name, options);
    if (!result) throw new NexusError('NOT_FOUND', '宿主 provider 未返回此技能');
    if (typeof params.provider === 'string' && result.provider !== params.provider) throw new NexusError('REVISION_CONFLICT', '此技能的生效 provider 已改变，请刷新来源列表');
    return { handled: true, result };
  }
  if (['settings.describe', 'settings.list', 'settings.get'].includes(action)) {
    const settings = requiredService(ctx, 'settings', 'describe');
    const namespaces = await settings.describe({ redactSecrets: true });
    const result = {
      writable: settings.writable === true,
      hasDocument: typeof settings.documentPath === 'string' && Boolean(settings.documentPath),
      namespaces,
    };
    if (action !== 'settings.get') return { handled: true, result };
    const ns = stringParam(params, 'ns');
    const item = namespaces.find((row: JsonRecord) => row.ns === ns);
    if (!item) throw new NexusError('NOT_FOUND', '配置命名空间不存在');
    return { handled: true, result: item };
  }
  if (['settings.update', 'settings.mutate', 'settings.replace'].includes(action)) {
    const method = action.slice('settings.'.length);
    const settings = requiredService(ctx, 'settings', method);
    if (settings.writable !== true) throw new NexusError('PERMISSION_DENIED', '当前宿主配置只读');
    const ns = stringParam(params, 'ns'), revision = expectedRevision(params);
    if (method === 'mutate') {
      if (!Array.isArray(params.ops) || params.ops.length > 200) throw new NexusError('INVALID_ARGUMENT', '配置字段操作最多 200 项');
      for (const op of params.ops) {
        if (!objectParam(op) || !['set', 'unset'].includes(String(op.op)) || !Array.isArray(op.path) || op.path.length > 32
          || op.path.some(part => typeof part !== 'string' || !part || part.length > 256 || ['__proto__', 'prototype', 'constructor'].includes(part))
          || op.op === 'set' && !Object.hasOwn(op, 'value')) throw new NexusError('INVALID_ARGUMENT', '配置字段路径或操作无效');
      }
      await settings.mutate(ns, params.ops, revision);
    } else {
      const patch = params.patch ?? params.configuration;
      if (!objectParam(patch)) throw new NexusError('INVALID_ARGUMENT', '配置必须为 JSON 对象');
      if (JSON.stringify(patch).length > 1024 * 1024) throw new NexusError('RESOURCE_LIMIT', '配置超过 1 MiB');
      // Merge updates preserve secrets omitted from the redacted editor.
      // Wholesale replacement requires a distinct explicit caller intent.
      if (method === 'replace' && params.replaceEntireNamespace !== true) throw new NexusError('INVALID_ARGUMENT', '完整替换必须显式声明 replaceEntireNamespace');
      await settings[method](ns, patch, revision);
    }
    const current = (await settings.describe({ redactSecrets: true })).find((row: JsonRecord) => row.ns === ns);
    return { handled: true, result: { ns, effect: 'committed', descriptor: current, applies: 'live', writer: 'official-settings-forms' } };
  }
  if (['update.status', 'update.check', 'update.open', 'desktop.update.status', 'desktop.update.check', 'desktop.update.open'].includes(action)) {
    throw new NexusError('HOST_CONTRACT_UNSUPPORTED', 'Desktop 更新由官方隔离预加载桥的 status/open/subscribe 接口拥有；Host 不提供可替代的更新 writer', {
      carrier: 'desktop-renderer-preload', owner: 'official-desktop-shell', requestedAction: action,
      source: 'packages/client/ui-settings-general/src/client/desktop-update-source.ts',
    });
  }
  if (action === 'notification.send') {
    throw new NexusError('HOST_CONTRACT_UNSUPPORTED', '当前正式 Host 合同未声明系统通知发送服务；需由已注册的客户端通知或渠道能力发送，不能伪造已送达', { delivered: false });
  }
  // In particular models.list and extensions.* keep their established adapter implementations.
  return { handled: false };
}
