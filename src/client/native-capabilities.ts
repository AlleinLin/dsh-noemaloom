import registrations from './native-capabilities.generated.js';
import type { ClientContext } from './types.js';
import type { OriginalClientModule } from './originals-manifest.js';

/** Register the original plugin faces in real Cordis fibers on the native UI. */
export function applyNativeCapabilities(rawContext: ClientContext): () => void {
  const ctx = rawContext as ClientContext & {
    modules: { import(specifier: string): Promise<unknown> };
    plugin(plugin: OriginalClientModule): { await?(): Promise<unknown>; dispose(): unknown };
  };
  const fibers: Array<{ dispose(): unknown }> = [];
  const modules = new Map<string, unknown>();
  let stopped = false;
  void (async () => {
    const dependencies = [...new Set(registrations.flatMap(entry => [...entry.requires]))];
    const results = await Promise.allSettled(dependencies.map(specifier => ctx.modules.import(specifier)));
    const failures = new Map<string, unknown>();
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') modules.set(dependencies[index], result.value);
      else failures.set(dependencies[index], result.reason);
    });
    if (stopped) return;
    const requireNative = (specifier: string): unknown => {
      if (modules.has(specifier)) return modules.get(specifier);
      throw new Error(`DSH native module unavailable: ${specifier}`, { cause: failures.get(specifier) });
    };
    for (const entry of registrations) {
      if (stopped) break;
      const original = entry.factory(requireNative);
      modules.set(entry.packageName, original);
      modules.set(`${entry.packageName}/client`, original);
      if (typeof original.apply !== 'function') continue;
      const fiber = ctx.plugin(original);
      fibers.push(fiber);
      void fiber.await?.().catch(error => { console.error(`[native ${entry.packageName}]`, error); });
    }
  })().catch(error => { if (!stopped) console.error('[native capabilities]', error); });
  return () => {
    stopped = true;
    for (const fiber of fibers.reverse()) void Promise.resolve(fiber.dispose()).catch(error => {
      console.error('[native capability cleanup]', error);
    });
    modules.clear();
  };
}
