import type { CanvasScope } from './canvas-scope.js';

interface ProviderState { providers: unknown[]; users: number; used: number }

/** Original browser-defined providers stay private to their selected canvas. */
export function createCanvasOriginalState(current: () => CanvasScope, maximum = 24) {
  const records = new Map<string, ProviderState>();
  let stopped = false;
  const evict = () => {
    for (const [key, record] of [...records].sort((a, b) => a[1].used - b[1].used)) {
      if (records.size < maximum) break;
      if (!record.users) records.delete(key);
    }
  };
  const recordOf = () => {
    const record = records.get(current().key);
    if (stopped || !record) throw new Error('图谱模型配置范围未就绪');
    return record;
  };
  return {
    acquire(scope: CanvasScope) {
      if (stopped) throw new Error('图谱已卸载');
      let record = records.get(scope.key);
      if (!record) {
        evict();
        if (records.size >= maximum) throw new Error('图谱正在处理其他范围，请稍后重试');
        record = { providers: [], users: 0, used: Date.now() };
        records.set(scope.key, record);
      }
      record.users++;
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        record!.users--;
        record!.used = Date.now();
      };
    },
    get providers() { return recordOf().providers; },
    set providers(providers: unknown[]) { recordOf().providers = providers; },
    get scopeKey() { return current().key; },
    dispose() { stopped = true; records.clear(); },
  };
}
