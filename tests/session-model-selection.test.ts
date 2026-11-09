import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionBridge } from '../src/host/session-bridge.js';
import { AgentModel, modelSelectionProjectionDefinition } from '@deepseek-ai/dsh-agent';
import { Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session';

test('released child accepts and durably restores model selection without starting an Agent', async () => {
  const id = SessionId('released-child');
  const initial = Session.create(id);
  const session = Session.create(id, [], { ...initial.header, origin: 'subagent', parentSession: SessionId('parent') });
  const stored: any[] = [];
  let opened = 0, flushed = 0, closed = 0;
  let live: any;
  const ctx: any = {
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
  const restored = Session.create(id, stored, session.header);
  const definition = modelSelectionProjectionDefinition;
  const read = () => restored.snapshotEvents().reduce(definition.apply,
    definition.init(restored.header, SessionLogOffset(0)));
  live = { id, session: restored, model: new AgentModel(read, restored, { provider: 'old', model: 'old' }) };
  assert.deepEqual(live.model.current(), selected, 'rc.1 owns durable cold model restoration');
  await bridge.dispose();
});

test('child model selection uses the official model owner and durably replaces the next route', async () => {
  const session = Session.create(SessionId('child-session'));
  const definition = modelSelectionProjectionDefinition;
  const read = () => session.snapshotEvents().reduce(definition.apply,
    definition.init(session.header, SessionLogOffset(0)));
  const agent = {
    id: session.id, session,
    model: new AgentModel(read, session, { provider: 'anthropic', model: 'claude-sonnet-5-5' }),
  };
  let flushed = 0;
  const ctx: any = {
    get(name: string) {
      if (name === 'agents') return { get: (id: string) => id === agent.id ? agent : undefined };
      if (name === 'llm') return { resolveCallConfig: async (selection: any) => selection };
      if (name === 'sessions') return { flush: async () => { flushed++; return true; } };
    },
  };
  const bridge = createSessionBridge(ctx, {}, process.cwd(), new AbortController().signal, () => ({} as any));
  try {
    const selected = { provider: 'anthropic', model: 'claude-opus-5-5', reasoningEffort: 'xhigh' };
    const result: any = await bridge.dispatch('model.select', { sessionId: agent.id, ...selected });
    assert.deepEqual(result.selected, selected);
    assert.equal(result.durableSelectionEvent, true);
    assert.deepEqual(agent.model.current(), selected);
    assert.equal(session.snapshotEvents().filter(e => e.type === 'model/selection').length, 1);
    await bridge.dispatch('model.select', { sessionId: agent.id, ...selected });
    assert.equal(session.snapshotEvents().filter(e => e.type === 'model/selection').length, 1,
      'the official owner does not append an equal selection twice');
    await bridge.dispatch('model.select', { sessionId: agent.id, provider: 'new', model: 'route' });
    assert.deepEqual(agent.model.current(), { provider: 'new', model: 'route' }, 'new route drops previous effort');
    assert.equal(flushed, 3);
  } finally { await bridge.dispose(); }
});
