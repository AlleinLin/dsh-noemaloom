import registrations from './originals.generated.js';
import type { ClientContext } from './types.js';
import type { OriginalClientModule } from './originals-manifest.js';
import { adaptOriginalClientContext } from './original-surface-adapter.js';
import { installOriginalViewNavigation, openOriginalConversationView } from './original-navigation.js';
import { AgentInsightsProvider, AgentFacts, NativeTaskInsights } from './AgentInsights.js';
import * as React from 'react';

export interface OriginalClientStatus {
  packageName: string;
  version: string;
  state: 'loading' | 'ready' | 'failed';
  message?: string;
}

interface OriginalFiber {
  await?(): Promise<unknown>;
  dispose(): Promise<void> | void;
}

interface OriginalContext extends ClientContext {
  modules: { import(specifier: string): Promise<any> };
  plugin(plugin: Record<string, any>): OriginalFiber;
}

const status = new Map<string, OriginalClientStatus>();
const listeners = new Set<() => void>();
let snapshot: readonly OriginalClientStatus[] = [];

export function originalClientSnapshot(): readonly OriginalClientStatus[] { return snapshot; }
export function subscribeOriginalClients(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function publish(item: OriginalClientStatus): void {
  status.set(item.packageName, item);
  snapshot = [...status.values()];
  for (const listener of listeners) listener();
}

/**
 * Materialize original published factories using the desktop's own shared
 * modules, then give each original plugin a real owned Cordis fiber. No eval,
 * second React runtime, duplicate transport, or synthetic plugin context.
 */
export function applyOriginalClients(rawContext: ClientContext): () => void {
  const ctx = rawContext as OriginalContext;
  const fibers: OriginalFiber[] = [];
  let stopped = false;
  const localModules = new Map<string, OriginalClientModule>();
  const sharedModules = new Map<string, unknown>();
  const missingModules = new Map<string, unknown>();
  sharedModules.set('@local/dsh-nexus/original-navigation', { openView: openOriginalConversationView });
  sharedModules.set('@local/dsh-nexus/agent-insights', { AgentInsightsProvider, AgentFacts });
  let stopNavigation: unknown;

  for (const entry of registrations) publish({
    packageName: entry.packageName, version: entry.version, state: 'loading',
  });

  const report = (packageName: string, version: string, error: unknown): void => {
    if (stopped) return;
    const message = error instanceof Error ? error.message : String(error);
    publish({ packageName, version, state: 'failed', message });
    console.error(`[nexus original ${packageName}]`, error);
  };

  void (async () => {
    if (typeof ctx.modules?.import !== 'function' || typeof ctx.plugin !== 'function') {
      throw new Error('Original plugins need the desktop modules and Cordis plugin services');
    }
    stopNavigation = installOriginalViewNavigation(ctx);
    const localNames = new Set(registrations.flatMap(entry => [entry.packageName, `${entry.packageName}/client`]));
    localNames.add('@local/dsh-nexus/original-navigation');
    localNames.add('@local/dsh-nexus/agent-insights');
    const shared = [...new Set(registrations.flatMap(entry => [...entry.requires]))]
      .filter(specifier => !localNames.has(specifier));
    // A failed optional require must retain its original try/catch semantics.
    // Only a factory that actually requires that missing module fails.
    const loaded = await Promise.allSettled(shared.map(specifier => ctx.modules.import(specifier)));
    loaded.forEach((result, index) => {
      if (result.status === 'fulfilled') sharedModules.set(shared[index], result.value);
      else missingModules.set(shared[index], result.reason);
    });
    if (stopped) return;
    const requireOriginal = (specifier: string): any => {
      if (localModules.has(specifier)) return localModules.get(specifier);
      if (sharedModules.has(specifier)) return sharedModules.get(specifier);
      const cause = missingModules.get(specifier);
      throw new Error(`Desktop shared module unavailable: ${specifier}`, { cause });
    };
    // The generated order puts Mnemon core before its source/provider/strategy
    // clients, so every child shares exactly the same extension SDK exports.
    for (const entry of registrations) {
      if (stopped) break;
      try {
        const original = entry.factory(requireOriginal);
        localModules.set(entry.packageName, original);
        localModules.set(`${entry.packageName}/client`, original);
        if (typeof original.apply !== 'function') {
          publish({ packageName: entry.packageName, version: entry.version, state: 'ready' });
          continue;
        }
        const fiber = ctx.plugin({
          ...original,
          name: `nexus-original:${entry.packageName}`,
          inject: original.inject ?? [],
          apply(childContext: ClientContext, config: unknown) {
            return original.apply!(adaptOriginalClientContext(childContext, entry.packageName, component => (props: Record<string, unknown>) =>
              React.createElement(NativeTaskInsights, { ctx: childContext, children: React.createElement(component as any, props) })), config);
          },
        });
        fibers.push(fiber);
        void (fiber.await?.() ?? Promise.resolve()).then(() => {
          if (!stopped) publish({ packageName: entry.packageName, version: entry.version, state: 'ready' });
        }, error => report(entry.packageName, entry.version, error));
      } catch (error) {
        report(entry.packageName, entry.version, error);
      }
    }
  })().catch(error => {
    for (const entry of registrations) {
      if (status.get(entry.packageName)?.state === 'loading') report(entry.packageName, entry.version, error);
    }
  });

  return () => {
    stopped = true;
    if (typeof stopNavigation === 'function') stopNavigation();
    for (const fiber of fibers.reverse()) void Promise.resolve(fiber.dispose()).catch(error => {
      console.error('[nexus original cleanup]', error);
    });
    localModules.clear();
    sharedModules.clear();
    missingModules.clear();
  };
}
