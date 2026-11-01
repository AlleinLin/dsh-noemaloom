import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionBridge } from '../src/host/session-bridge.js';
import { Session, SessionId } from '@deepseek-ai/dsh-session';

test('released child accepts and durably restores model selection without starting an Agent', async () => {
  const id = SessionId('released-child');
  const initial = Session.create(id);
  const session = Session.create(id, [], { ...initial.header, origin: 'subagent', parentSession: SessionId('parent') });
  const stored: any[] = [];
  const lifecycle = new Map<string, (...args: any[]) => any>();
  const listeners = new Map<string, (...args: any[]) => Promise<any>>();
  let opened = 0, flushed = 0, closed = 0;
  let live: any;
  const ctx: any = {
    on(name: string, handler: (...args: any[]) => any) { lifecycle.set(name, handler); return () => lifecycle.delete(name); },
    get(name: string) {
      if (name === 'agents') return {
        get: () => live,
        resume() { assert.fail('changing a model must not resume or start an Agent'); },
      };
      if (name === 'llm') return { resolveCallConfig: async (selection: any) => selection };
      if (name === 'sessionQuery') return { readSession: async () => ({
        session: session.header, inheritedEventCount: 0, events: stored,
      }) };
      if (name === 'sessionPersistence') return { open: async (requested: string, access: string) => {
        assert.equal(requested, id);
        assert.equal(access, 'write');
        opened++;
        return {
          id, header: session.header, inheritedEventCount: 0,
          read: async () => ({ events: [...stored], eventState: 'owned' }),
          append: async (events: any[]) => { stored.push(...events); },
          flush: async () => { flushed++; },
          close: async () => { closed++; },
        };
      } };
    },
  };
  const selected = { provider: 'hjmclaude', model: 'claude-opus-5-5' };
  let bridge = createSessionBridge(ctx, {}, process.cwd(), new AbortController().signal, () => ({} as any));
  const result: any = await bridge.dispatch('model.select', { sessionId: id, ...selected });
  assert.deepEqual(result.selected, selected);
  assert.equal(result.durableSelectionEvent, true);
  assert.deepEqual([opened, flushed, closed], [1, 1, 1]);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].type, 'model/selection');
  assert.equal(stored[0].seq, 0);
  assert.deepEqual(stored[0].data, selected);
  await bridge.dispose();

  // A new plugin instance must recover from the official log, not a process cache.
  bridge = createSessionBridge(ctx, {}, process.cwd(), new AbortController().signal, () => ({} as any));
  live = {
    id, session: { header: session.header },
    ctx: { on(name: string, handler: (...args: any[]) => Promise<any>) {
      listeners.set(name, handler); return () => listeners.delete(name);
    } },
  };
  await lifecycle.get('agent/created')!({ agent: live });
  const assembly = await listeners.get('system-prompt/assemble')!(
    {}, {}, async () => ({ variables: { provider: 'claude', model: 'claude-opus-5-5' } }),
  );
  assert.deepEqual(assembly.variables, selected);
  const request = await listeners.get('agent/request')!(
    {}, async () => ({ provider: 'claude', model: 'claude-opus-5-5', reasoningEffort: 'xhigh' }),
  );
  assert.deepEqual(request, selected);
  await bridge.dispose();
});

test('child model selection appends the official projection and routes the next request', async () => {
  const listeners = new Map<string, (...args: any[]) => Promise<any>>();
  const appended: any[] = [];
  const agent: any = {
    id: 'child-session',
    options: { provider: 'anthropic', model: 'claude-sonnet-5-5' },
    session: {
      id: 'child-session',
      requestHeader: () => ({ config: { provider: 'anthropic', model: 'claude-sonnet-5-5' } }),
      append(type: string, data: unknown) { appended.push({ type, data }); },
    },
    ctx: {
      on(name: string, handler: (...args: any[]) => Promise<any>) {
        listeners.set(name, handler);
        return () => listeners.delete(name);
      },
    },
  };
  const ctx: any = {
    get(name: string) {
      if (name === 'agents') return { get: (id: string) => id === agent.id ? agent : undefined };
      if (name === 'llm') return {
        resolveCallConfig: async (selection: any) => selection,
      };
      if (name === 'sessions') return { flush: async () => true };
      return undefined;
    },
  };
  const bridge = createSessionBridge(ctx, {}, process.cwd(), new AbortController().signal, () => ({} as any));
  try {
    const result: any = await bridge.dispatch('model.select', {
      sessionId: agent.id,
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      reasoningEffort: 'xhigh',
    });
    assert.deepEqual(result.selected, {
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      reasoningEffort: 'xhigh',
    });
    assert.equal(result.durableSelectionEvent, true);
    assert.deepEqual(appended, [{
      type: 'model/selection',
      data: { provider: 'anthropic', model: 'claude-opus-5-5', reasoningEffort: 'xhigh' },
    }]);

    const assembled = await listeners.get('system-prompt/assemble')!(
      {}, {}, async () => ({ variables: { provider: 'anthropic', model: 'claude-sonnet-5-5' } }),
    );
    assert.deepEqual(assembled.variables, { provider: 'anthropic', model: 'claude-opus-5-5' });
    const request = await listeners.get('agent/request')!(
      {}, async () => ({ provider: 'anthropic', model: 'claude-sonnet-5-5', reasoningEffort: 'high', maxTokens: 100 }),
    );
    assert.deepEqual(request, { provider: 'anthropic', model: 'claude-opus-5-5', reasoningEffort: 'xhigh', maxTokens: 100 });
  } finally {
    await bridge.dispose();
  }
});
