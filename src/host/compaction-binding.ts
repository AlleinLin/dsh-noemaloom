import type { HostContext } from './types.js';

interface NativeCompactor {
  compactRanges(agent: any, params: Record<string, unknown>, signal: AbortSignal): Promise<any>;
  recoverOverflow?(payload: any, managed?: { retry: number; maxRetries: number }): Promise<{ kind: 'retry' } | undefined>;
  selfCompaction?(agent: any, args: any, signal: AbortSignal): Promise<any>;
  contextStatus?(agent: any, signal: AbortSignal, requestId?: string): Promise<any>;
}
type Binding = { provider: NativeCompactor; owner: symbol; agent: any; fallback?: boolean };
// The host adapter and compactor are separate bundle entries. Share only
// process-local capabilities; no provider is reconstructed from saved data.
const KEY = Symbol.for('dsh-nexus.native-compaction.bindings.v1');
function bindings(): Map<string, Binding> {
  const runtime = globalThis as typeof globalThis & { [KEY]?: Map<string, Binding> };
  return runtime[KEY] ??= new Map();
}

/** Presets isolate compaction in a child group, outside agent.ctx's lookup.
 * Bind the actual scoped provider to its announced live Agent instead. */
export function registerNativeCompactionBinding(ctx: HostContext, provider: NativeCompactor, options: { fallback?: boolean } = {}) {
  const owner = Symbol('native-compaction-provider'), ids = new Set<string>();
  let disposed = false;
  const bind = (agent: any) => {
    if (disposed || typeof agent?.id !== 'string') return;
    const current = bindings().get(agent.id);
    // A host fallback covers custom/legacy presets and restored children.
    // A preset's own implementation always wins, independent of event order.
    if (options.fallback && current && current.agent === agent && !current.fallback) return;
    bindings().set(agent.id, { provider, owner, agent, fallback: options.fallback });
    ids.add(agent.id);
  };
  const remove = ctx.on('agent/created', ({ agent }: any) => bind(agent));
  const release = ctx.on('agent/disposed', ({ agent }: any) => {
    const entry = bindings().get(agent?.id);
    if (entry?.owner === owner && entry.agent === agent) {
      bindings().delete(agent.id); ids.delete(agent.id);
    }
  });
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (typeof remove === 'function') remove();
    if (typeof release === 'function') release();
    for (const id of ids) if (bindings().get(id)?.owner === owner) bindings().delete(id);
    ids.clear();
  };
  ctx.effect(() => dispose);
  return { bind, dispose };
}

export function nativeCompactionFor(agent: any): NativeCompactor | undefined {
  const entry = typeof agent?.id === 'string' ? bindings().get(agent.id) : undefined;
  return entry?.agent === agent ? entry?.provider : undefined;
}
