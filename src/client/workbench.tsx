import * as React from 'react';
import type { Data, ViewContext } from './types.js';
import { Button, DataView, ErrorMessage, useQuery } from './components.js';

export function useWorkbenchOperation(context: ViewContext, onDone?: () => void) {
  const [busy, setBusy] = React.useState('');
  const [error, setError] = React.useState<unknown>();
  const [message, setMessage] = React.useState('');
  const lifetime = React.useRef<AbortController | undefined>(undefined);
  const pending = React.useRef(false);
  React.useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    return () => { controller.abort(); lifetime.current = undefined; };
  }, []);
  async function run(label: string, domain: string, action: string, params: Data = {}, options: { mutating?: boolean; revision?: number } = {}) {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted || pending.current) return;
    pending.current = true; setBusy(label); setError(undefined); setMessage('');
    try {
      const result = await context.api.call(domain, action, params, { scope: context.scope, signal, ...options });
      if (signal.aborted) return;
      if (result?.result?.ok === false) throw new Error(String(result.result.error ?? '操作未应用'));
      setMessage(`${label}：已收到宿主回执`); onDone?.();
      return result;
    } catch (cause) { if (!signal.aborted) setError(cause); }
    finally { pending.current = false; if (!signal.aborted) setBusy(''); }
  }
  return { busy, run, feedback: <>{Boolean(error) && <ErrorMessage error={error} />}{message && <p className="nexus-workbench-feedback" role="status">{message}</p>}</> };
}

export function useScopedDefaults(context: ViewContext, feature: string, action: string) {
  const query = useQuery(context.api, 'scope', 'settings', { feature }, { scope: context.scope, refresh: context.refreshToken });
  const operation = useWorkbenchOperation(context, query.reload);
  const local = query.data?.local;
  const effective: Data = query.data?.effective?.defaults?.[action] ?? {};
  const layers: Data[] = query.data?.layers ?? [];
  async function save(values: Data) {
    const config = local?.config ?? {};
    return operation.run('保存配置', 'scope', 'configure', { feature, config: { ...config,
      defaults: { ...config.defaults, [action]: { ...config.defaults?.[action], ...values } } } },
    { mutating: true, revision: local?.revision ?? 0 });
  }
  async function inherit(keys: string[]) {
    const config = local?.config ?? {}, defaults = { ...config.defaults }, values = { ...defaults[action] };
    for (const key of keys) delete values[key];
    if (Object.keys(values).length) defaults[action] = values; else delete defaults[action];
    const remaining: Data = { ...config, defaults };
    if (!Object.keys(defaults).length) delete remaining.defaults;
    return operation.run('恢复继承', 'scope', Object.keys(remaining).length ? 'configure' : 'reset',
      { feature, ...(Object.keys(remaining).length ? { config: remaining } : {}) }, { mutating: true, revision: local?.revision ?? 0 });
  }
  return { query, operation, effective, layers, local, save, inherit };
}

const scopeNames: Data = { global: '全局', workspace: '工作区', session: '当前会话' };
export function ScopeSource({ context, settings, field, fallback }: { context: ViewContext; settings: ReturnType<typeof useScopedDefaults>; field: string; fallback: string }) {
  const source = [...settings.layers].reverse().find(layer => layer.config?.defaults?.[field.split('/')[0]]?.[field.split('/')[1]] !== undefined);
  return <p className="nexus-workbench-source">配置作用域：{scopeNames[context.scope.level ?? 'workspace']} · 当前选择来源：{source ? `${scopeNames[source.scope]}配置（r${source.revision}）` : fallback}</p>;
}

export function EvidenceDisclosure({ title = '查看技术证据', value }: { title?: string; value: unknown }) {
  return <details className="nexus-workbench-evidence"><summary>{title}</summary><DataView value={value} /></details>;
}

export function SaveDefaults({ context, settings, values, fields, disabled = false, onApplied }: { context: ViewContext; settings: ReturnType<typeof useScopedDefaults>; values: Data; fields: string[]; disabled?: boolean; onApplied?(value: Data): void }) {
  const applied = (result: Data | undefined) => { if (result) onApplied?.(result); };
  return <div className="nexus-actions">
    <Button busy={Boolean(settings.operation.busy)} disabled={disabled || !settings.query.data || Boolean(settings.query.error)} onClick={() => void settings.save(values).then(applied)}>保存到{scopeNames[context.scope.level ?? 'workspace']}</Button>
    <Button disabled={!settings.local?.revision || Boolean(settings.operation.busy)} onClick={() => void settings.inherit(fields).then(applied)}>恢复继承</Button>
  </div>;
}
