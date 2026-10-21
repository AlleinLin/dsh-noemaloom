/**
 * Extension subprocess protocol. The parent launches this file with Node's
 * permission model; it never receives the Cordis context or account secrets.
 * Network confinement is reported independently from filesystem confinement.
 */
import { pathToFileURL } from 'node:url';

interface ToolDefinition {
  name: string;
  description?: string;
  schema?: Record<string, unknown>;
  execute?(args: unknown): Promise<unknown> | unknown;
  handler?(args: unknown): Promise<unknown> | unknown;
}
interface ExtensionExport {
  tools?: ToolDefinition[];
  health?(): Promise<unknown> | unknown;
  dispose?(): Promise<void> | void;
}
let extension: ExtensionExport | undefined;
const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
let sequence = 0;
const api = Object.freeze({
  async invoke(domain: string, action: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = `capability_${++sequence}`;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      process.send?.({ kind: 'capability', id, domain, action, params });
    });
  },
  emit(event: string, data: unknown): void { process.send?.({ kind: 'event', event, data }); },
});
process.on('message', async (message: unknown) => {
  const request = message as { kind: string; id: string; entry?: string; generation?: number; name?: string; args?: unknown; result?: unknown; error?: string };
  if (request.kind === 'capability-result') {
    const waiter = pending.get(request.id);
    pending.delete(request.id);
    if (request.error) waiter?.reject(new Error(request.error));
    else waiter?.resolve(request.result);
    return;
  }
  try {
    let result: unknown;
    if (request.kind === 'initialize') {
      if (!request.entry) throw new Error('entry is required');
      const imported = await import(`${pathToFileURL(request.entry).href}?nexusGeneration=${request.generation}`);
      const factory = imported.createExtension ?? (typeof imported.default === 'function' ? imported.default : undefined);
      extension = factory ? await factory(api) : imported.default ?? imported;
      if (!extension || !Array.isArray(extension.tools)) throw new Error('isolated extension must export tools[] or createExtension(api)');
      for (const tool of extension.tools) {
        if (!/^[a-z][a-z0-9_.-]{0,127}$/i.test(tool.name) || !(tool.execute || tool.handler)) throw new Error('invalid tool export');
      }
      const health = extension.health ? await extension.health() : { initialized: true, toolCount: extension.tools.length };
      result = { tools: extension.tools.map(({ name, description, schema }) => ({ name, description, schema })), health };
    } else if (request.kind === 'call') {
      const tool = extension?.tools?.find(tool => tool.name === request.name);
      if (!tool) throw new Error('tool not found');
      result = await (tool.execute ?? tool.handler)!(request.args);
    } else if (request.kind === 'health') result = extension?.health ? await extension.health() : { initialized: Boolean(extension) };
    else if (request.kind === 'dispose') {
      await extension?.dispose?.();
      result = { disposed: true };
      process.send?.({ kind: 'result', id: request.id, result });
      process.disconnect();
      return;
    } else throw new Error('unknown worker request');
    process.send?.({ kind: 'result', id: request.id, result });
  } catch (error) {
    process.send?.({ kind: 'result', id: request.id, error: error instanceof Error ? error.message : String(error) });
  }
});
