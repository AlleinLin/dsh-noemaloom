import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { LlmAdapter, LlmRuntime, ReasoningEffortId, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm';

class ChildCatalogAdapter extends LlmAdapter {
  calls = 0;
  async listModels(provider: string) {
    return ['deep', 'compact', 'plain'].map(id => ({ provider, id, name: id }));
  }
  async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    if (!['deep', 'compact', 'plain'].includes(model)) throw new Error('unknown fixture model');
    const levels = model === 'deep' ? ['quick', 'thorough', 'maximum'] : model === 'compact' ? ['low', 'high'] : [];
    return { provider, id: model, name: model, inputModalities: ['text'],
      ...(levels.length ? { reasoning: {
        efforts: levels.map(id => ({ id: ReasoningEffortId(id), name: id })),
        defaultEffort: ReasoningEffortId(levels[0]),
      } } : {}) };
  }
  async *stream(_options: GenerateOptions): AsyncGenerator<StreamChunk> {
    this.calls++;
    throw new Error('metadata checks must never send a model request');
  }
}

export async function childCatalogHarness(t: TestContext) {
  const root = new Context();
  const adapter = new ChildCatalogAdapter();
  let llm!: LlmRuntime;
  const fiber = root.plugin({ name: 'child-model-catalog-fixture', apply(ctx: Context) {
    llm = new LlmRuntime(ctx);
    llm.registerAdapter(['fixture'], adapter);
  } });
  await fiber.await();
  t.after(async () => { assert.equal(adapter.calls, 0); await fiber.dispose(); });
  return { llm, adapter };
}
