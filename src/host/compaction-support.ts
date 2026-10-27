import { Context } from '@deepseek-ai/cordis';
import NexusCompactionEngine from './compaction.js';
import type { HostContext } from './types.js';

/** Cover native children using custom or retained preset generations that do
 * not mount our compactor. Exact preset owners take priority; both drivers
 * check that binding before handling a request, so there is one maintainer.
 * The isolated service never replaces a host/preset service registration. */
export function registerUnifiedCompaction(ctx: HostContext) {
  const fiber = (ctx as unknown as Context).isolate('compaction').plugin({
    name: 'noemaloom-unified-compaction',
    inject: [...NexusCompactionEngine.inject, 'agents'],
    apply(owner: Context) {
      const engine = new NexusCompactionEngine(owner, {}, { fallback: true });
      owner.provide('nexusCompactionMaintenance', engine);
    },
  });
  return () => fiber.dispose();
}
