import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { LlmAdapter, LlmRuntime, ProviderRequestId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { createHostAdapter } from '../src/host/host-adapter.js';
import type { HostContext } from '../src/host/types.js';
import type { NexusServices } from '../src/ports/contracts.js';
import { companionFixture } from './companion-fixture.js';

const route = { provider: 'test-auxiliary-provider', model: 'test-auxiliary-model', maxTokens: 32768 };
class Adapter extends LlmAdapter {
  readonly calls: GenerateOptions[] = [];
  constructor(private readonly chunks: StreamChunk[]) { super(); }
  async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    this.calls.push(options);
    yield* this.chunks;
  }
}
async function harness(t: TestContext, chunks: StreamChunk[]) {
  const dataDir = await mkdtemp(join(tmpdir(), 'nexus-auxiliary-response-'));
  const root = new Context(), adapter = new Adapter(chunks), diagnostics: unknown[] = [];
  const fixture = companionFixture();
  let host!: ReturnType<typeof createHostAdapter>;
  const fiber = root.plugin({ name: 'test-auxiliary-response', apply(owner: Context) {
    const llm = new LlmRuntime(owner); llm.registerAdapter([route.provider], adapter);
    host = createHostAdapter(owner as unknown as HostContext, {}, process.cwd(), new AbortController().signal);
    host.connect({ ...fixture.services, dataDir, workspaceRoot: process.cwd(),
      emit(event, facts) { if (event === 'auxiliary/diagnostic') diagnostics.push(facts); },
      async invoke(domain, request) {
        if (domain === 'context' && request.action === 'prepare') return {
          planId: 'test-context-plan', messages: request.params?.messages, system: '',
        };
        return {};
      },
    } as NexusServices);
  } });
  await fiber.await(); assert.equal(fiber.state, 2);
  t.after(async () => {
    await host.dispose(); await fiber.dispose();
    assert.equal(dirname(resolve(dataDir)), resolve(tmpdir())); assert.ok(basename(dataDir).startsWith('nexus-auxiliary-response-'));
    await rm(dataDir, { recursive: true, force: true });
  });
  return { adapter, diagnostics, run: () => host.model({ ...route, role: 'companion-assessment', prompt: 'Public evidence', maxTokens: route.maxTokens }) };
}

test('the official runtime assembled text blocks replace deltas once and exclude private reasoning', async t => {
  const h = await harness(t, [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: 'test-private-reasoning' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'test-private-reasoning' } },
    { type: 'block-start', index: 1, blockType: 'text' },
    { type: 'text-delta', index: 1, text: '{"complete":' },
    { type: 'text-delta', index: 1, text: 'true}' },
    { type: 'block-end', index: 1, block: { type: 'text', text: '{"complete":true}' } },
    { type: 'block-end', index: 2, block: { type: 'text', text: '\nVisible assembled suffix' } },
    { type: 'usage', usage: { inputTokens: 80, outputTokens: 120 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]);
  const result = await h.run();
  assert.equal(result.text, '{"complete":true}\nVisible assembled suffix');
  assert.equal(result.usage?.outputTokens, 120);
  assert.equal(h.adapter.calls[0].purpose, 'workflow-planning');
  assert.deepEqual(h.adapter.calls[0].tools, []);
});

test('max-tokens rejects even valid-looking partial JSON and records only safe terminal/usage facts', async t => {
  const h = await harness(t, [
    { type: 'reasoning-delta', index: 0, text: 'test-private-reasoning' },
    { type: 'text-delta', index: 1, text: '{"complete":true}' },
    { type: 'usage', usage: { inputTokens: 100, outputTokens: 32768 } },
    { type: 'finish', reason: { kind: 'max-tokens' } },
  ]);
  await assert.rejects(h.run(), (error: any) => {
    assert.equal(error.code, 'MODEL_OUTPUT_LIMIT');
    assert.equal(error.details.diagnosticCode, 'NX_MODEL_OUTPUT_LIMIT');
    assert.equal(error.details.phase, 'auxiliary-model-response');
    assert.equal(error.details.terminalKind, 'max-tokens');
    assert.equal(error.details.maxOutputTokens, 32768);
    assert.equal(error.details.outputTokens, 32768);
    assert.match(error.message, /思考/);
    return true;
  });
  assert.equal(h.diagnostics.length, 1);
  assert.doesNotMatch(JSON.stringify(h.diagnostics), /test-private|complete/);
});

test('official error finishes retain provider routing and retry-after metadata', async t => {
  const h = await harness(t, [
    { type: 'finish', reason: { kind: 'error', failure: {
      code: 'RATE_LIMIT', message: 'test-private-provider-body',
      requestId: ProviderRequestId('test-provider-request'), providerRetryAfterMs: 1250,
    } } },
  ]);
  await assert.rejects(h.run(), (error: any) => {
    assert.equal(error.code, 'RATE_LIMIT');
    assert.equal(error.details.diagnosticCode, 'NX_GATEWAY_RATE_LIMIT');
    assert.equal(error.details.providerRetryAfterMs, 1250);
    assert.equal(error.details.requestId, 'test-provider-request');
    assert.doesNotMatch(error.message, /test-private/);
    return true;
  });
});

test('tool finishes without tools are invalid output and missing finishes are unsupported host contracts', async t => {
  const tools = await harness(t, [{ type: 'finish', reason: { kind: 'tool-calls' } }]);
  await assert.rejects(tools.run(), { code: 'INVALID_MODEL_OUTPUT' });
  const missing = await harness(t, [{ type: 'text-delta', index: 0, text: 'Uncommitted prefix' }]);
  await assert.rejects(missing.run(), { code: 'HOST_CONTRACT_UNSUPPORTED' });
});

test('a successful finish containing only reasoning cannot become a public auxiliary answer', async t => {
  const h = await harness(t, [
    { type: 'reasoning-delta', index: 0, text: 'test-private-reasoning' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'test-private-reasoning' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]);
  await assert.rejects(h.run(), { code: 'EMPTY_RESPONSE' });
});

test('an official aborted finish keeps cancellation identity instead of inventing a missing contract', async t => {
  const h = await harness(t, [
    { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'test-provider-aborted' } } },
  ]);
  await assert.rejects(h.run(), (error: any) => {
    assert.equal(error.code, 'ABORTED');
    assert.equal(error.details.terminalKind, 'aborted');
    assert.equal(error.details.diagnosticCode, 'NX_ABORT_UNATTRIBUTED');
    return true;
  });
});
