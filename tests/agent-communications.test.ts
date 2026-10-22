import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createHash } from 'node:crypto';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { deliverSubagentPrompt } from '@deepseek-ai/dsh-subagent/internal';
import { defineTool, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools';
import { registerAgentCommunications } from '../src/host/communications/index.js';
import { agentDirectory, resolveAgent } from '../src/host/communications/directory.js';
import { AgentMailbox } from '../src/host/communications/broker.js';
import { stepProgressServices, flush } from './step-progress-fixture.js';
import type { HostContext } from '../src/host/types.js';

const signal = () => new AbortController().signal;
function fixture(t: TestContext, configure?: (fixture: any) => void) {
  const { store } = stepProgressServices();
  const listeners = new Map<string, Set<Function>>(), global = new Map<string, any>();
  const scoped = new Map<any, Map<string, any>>(), agents = new Map<string, any>(), parents = new Map<string, any>();
  const events = new Map<string, any[]>(), guards = new Set<Function>(), deliveries: any[] = [], oldCalls: string[] = [];
  let fault: 'before' | 'after' | undefined;
  const emit = (name: string, ...args: any[]) => { for (const callback of [...listeners.get(name) ?? []]) callback(...args); };
  const tools = {
    get(name: string, agent?: any) { return scoped.get(agent)?.get(name) ?? global.get(name); },
    register(definition: any) { global.set(definition.name, definition); emit('tools/change'); return () => { global.delete(definition.name); emit('tools/change'); }; },
    guard(callback: Function) { guards.add(callback); return () => guards.delete(callback); },
  };
  const registry = { get: (id: string) => agents.get(id), list: () => [...agents.values()],
    roots: () => [...agents.values()].filter(agent => !parents.has(agent.id)),
    isOwnedBy: (id: string, owner: any) => agents.has(id) && parents.get(id) === owner };
  const catalog: any[] = [];
  const accept = (agent: any, message: any, delivery = 'steer') => {
    deliveries.push({ id: agent.id, message, delivery });
    events.get(agent.id)!.push({ type: 'agent/inbox/spliced', seq: events.get(agent.id)!.length, time: Date.now(),
      data: { target: delivery === 'queue' ? 'next-turn' : 'next-step', start: 0, inserted: [message] } });
    emit('agent/inbox/inserted', { agent, message });
  };
  const subagents = {
    async listDescendants(id: string) {
      const selected = new Set([id]), rows = [];
      for (const row of catalog) if (selected.has(row.parentId)) { rows.push(row); selected.add(row.id); }
      return rows;
    },
    async sendMessage() { oldCalls.push('subagent-service'); throw new Error('legacy direct-only dispatch'); },
    interrupt(id: string, authority: any) { deliveries.push({ interrupt: id, authority }); },
    async [deliverSubagentPrompt](parent: any, id: string, content: any[], source: any, signal: AbortSignal, delivery: string) {
      signal.throwIfAborted();
      if (fault === 'before') throw new Error('Transport failed before acceptance');
      assert.equal(parent.id, catalog.find(row => row.id === id)?.parentId);
      let target = agents.get(id);
      if (!target) { target = makeAgent(id, parent); emit('agent/created', { agent: target }); }
      const message = createUserMessage({ content, source });
      accept(target, message, delivery);
      if (fault === 'after') throw new Error('Receipt lost after acceptance');
      return message.id;
    },
  };
  const teams = {
    tryMembership: (agent: any) => agent.id === 'root' ? { role: 'lead', root: agent, name: 'lead' } : undefined,
    listMembers: () => [{ id: 'root', name: 'lead' }, { id: 'child-a', name: 'team-a' }],
    async sendMessage() { oldCalls.push('team-service'); throw new Error('active teammate not found'); },
  };
  const query = { async readSession(id: string) {
    assert.equal(arguments.length, 1, 'native sessionQuery.readSession accepts exactly one argument');
    return { events: structuredClone(events.get(id) ?? []), inheritedEventCount: 0 };
  } };
  const services: any = { agents: registry, tools, subagents, agentTeams: teams, sessionQuery: query };
  const ctx = {
    get: (name: string) => services[name],
    on(name: string, handler: Function) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name)!.add(handler); return () => listeners.get(name)?.delete(handler); },
    logger: { warn() {} },
  } as unknown as HostContext;
  function makeAgent(id: string, parent?: any, label = id) {
    const agent: any = {
      id, status: 'idle', session: { id, get seq() { return events.get(id)?.length ?? 0; },
        header: { cwd: process.cwd(), ...(parent ? { parentSession: parent.id, origin: 'subagent' } : {}) } },
      cancel(cause: any) { oldCalls.push(`cancel:${cause.kind}`); },
      steer(message: any) { accept(agent, message); }, followup(message: any) { accept(agent, message, 'queue'); },
    };
    agents.set(id, agent); if (!events.has(id)) events.set(id, []);
    if (parent) {
      parents.set(id, parent);
      if (!catalog.some(row => row.id === id)) catalog.push({ kind: 'child', id, parentId: parent.id, depth: 1, mode: 'continuable', label });
    }
    return agent;
  }
  const root = makeAgent('root'), a = makeAgent('child-a', root), b = makeAgent('child-b', root), other = makeAgent('other-root');
  const legacy = (name: string) => defineTool({
    name, description: 'Legacy active teammate only', parameters: {},
    output: { schema: { type: 'object', additionalProperties: true }, render: () => [] },
    async execute() { oldCalls.push(name); throw new Error('active teammate not found'); },
  });
  for (const name of ['send_message', 'list_agents', 'wait_agent', 'interrupt_agent']) global.set(name, legacy(name));
  const originalSend = global.get('send_message').execute, originalService = subagents.sendMessage;
  configure?.({ ctx, services, store, listeners, guards, global, root, a, b });
  const hook = registerAgentCommunications(ctx, store);
  t.after(() => hook.dispose());
  async function call(agent: any, name: string, args: any = {}, callId = `${name}:${Math.random()}`) {
    const definition = tools.get(name, agent);
    for (const guard of guards) assert.equal(guard({ name, agent }), undefined);
    assert.deepEqual(validateJsonSchemaValue(definition.parameters, args), []);
    const value = await definition.execute(args, { agent, callId, signal: signal() });
    assert.deepEqual(validateJsonSchemaValue(definition.output.schema, value), []);
    await flush();
    return value;
  }
  return { ctx, services, hook, root, a, b, other, call, tools, scoped, agents, parents, catalog, events, emit, deliveries, oldCalls,
    legacy, originalSend, originalService, makeAgent, global, guards, store, listeners, setFault: (value: typeof fault) => { fault = value; } };
}

test('all directional paths and UUID-style ids bypass both legacy teammate and direct-only services', async t => {
  const f = fixture(t);
  for (const [sender, recipient] of [[f.root, f.a], [f.a, f.root], [f.a, f.b], [f.b, f.a]]) {
    const result = await f.call(sender, 'send_message', { target: recipient.id, message: `From ${sender.id}`, request_id: `${sender.id}:${recipient.id}` });
    assert.equal(result.state, 'accepted'); assert.equal(result.target, recipient.id);
    const received = f.deliveries.at(-1).message;
    assert.equal(received.source.kind, 'agent-message'); assert.equal(received.source.senderSessionId, sender.id);
    assert.equal(received.source.nexusMessageId, result.message_id);
  }
  assert.deepEqual(f.oldCalls, []);
  const roster = await f.call(f.root, 'list_agents');
  assert.equal(roster.agents.find((row: any) => row.id === f.b.id).mode, 'continuable');
  assert.ok(roster.agents.every((row: any) => row.id !== f.other.id));
});

test('legacy parameter spellings, Team names, parent/lead aliases and safe reply links share the same mailbox', async t => {
  const f = fixture(t);
  const first = await f.call(f.root, 'send_message', { agent_id: 'team-a', message: 'review', request_id: 'review-1' });
  const reply = await f.call(f.a, 'send_message', { target: 'parent', message: 'done', reply_to: first.message_id });
  assert.equal(reply.target, f.root.id);
  const inbox = await f.call(f.a, 'read_agent_messages');
  assert.equal(inbox.messages.length, 2);
  await assert.rejects(f.call(f.b, 'send_message', { target: 'lead', message: 'forged reply', reply_to: first.message_id }), { code: 'NX_MAIL_REPLY_DENIED' });
  await assert.rejects(f.call(f.a, 'send_message', { target: 'lead', agent_id: f.b.id, message: 'conflict' }), { code: 'NX_MAIL_INVALID_TARGET' });
});

test('new updates accept empty reply links and unused recipient fields without inventing a mailbox reply', async t => {
  const f = fixture(t);
  for (const [index, reply_to] of ['', '   '].entries()) {
    const args = { target: '', agent_id: f.root.id, message: 'New child status update', request_id: `empty-reply-${index}`, reply_to };
    const sent = await f.call(f.a, 'send_message', args);
    assert.equal(sent.state, 'accepted');
    const { reply_to: _emptyReply, ...withoutReply } = args;
    const retried = await f.call(f.a, 'send_message', withoutReply);
    assert.equal(retried.message_id, sent.message_id);
  }
  assert.equal(f.deliveries.length, 2, 'empty and omitted reply links have the same idempotency fingerprint');
  const read = await f.call(f.a, 'read_agent_messages');
  assert.ok(read.messages.every((row: any) => row.reply_to === null));
  const fallback = await f.call(f.a, 'send_message', { target: 'parent', agent_id: '', message: 'Optional intent key', request_id: '', reply_to: '' }, 'empty-request-call');
  assert.equal(fallback.request_id, 'empty-request-call');
});

test('aliases and exact recipient ids agree by identity while real conflicts remain rejected before delivery', async t => {
  const f = fixture(t);
  const first = await f.call(f.a, 'send_message', {
    target: 'parent', agent_id: f.root.id, message: 'One status update', request_id: 'parent-alias', reply_to: '',
  });
  const repeated = await f.call(f.a, 'send_message', {
    target: f.root.id, message: 'One status update', request_id: 'parent-alias',
  });
  assert.equal(first.message_id, repeated.message_id);
  assert.equal(first.target, f.root.id);
  assert.equal(f.deliveries.length, 1);
  await assert.rejects(f.call(f.a, 'send_message', {
    target: 'parent', agent_id: f.b.id, message: 'Conflicting recipient',
  }), { code: 'NX_MAIL_INVALID_TARGET' });
  assert.equal(f.deliveries.length, 1);
  const stopped = await f.call(f.root, 'interrupt_agent', { target: 'team-a', agent_id: f.a.id });
  assert.equal(stopped.accepted, true);
});

test('invalid nonempty reply links give an actionable correction and never degrade into an unlinked send', async t => {
  const f = fixture(t);
  for (const reply_to of ['business-intent-1', 'parent', f.root.id]) {
    await assert.rejects(f.call(f.a, 'send_message', {
      target: f.root.id, message: 'Status update', request_id: 'correctable-intent', reply_to,
    }), (error: any) => {
      assert.equal(error.code, 'NX_MAIL_REPLY_DENIED');
      assert.match(error.message, /No message was sent/);
      assert.match(error.message, /NEW message omit reply_to/);
      assert.match(error.message, /read_agent_messages/);
      assert.match(error.message, /same request_id/);
      return true;
    });
  }
  assert.equal(f.deliveries.length, 0);
  assert.equal((await f.call(f.a, 'read_agent_messages')).messages.length, 0);
  const corrected = await f.call(f.a, 'send_message', {
    target: f.root.id, message: 'Status update', request_id: 'correctable-intent', reply_to: '',
  });
  assert.equal(corrected.state, 'accepted');
  assert.equal(f.deliveries.length, 1);
});

test('the model-facing definition explains a new send separately from replies and send idempotency', t => {
  const f = fixture(t), definition = f.tools.get('send_message', f.a);
  assert.match(definition.description, /NEW message omit reply_to/);
  assert.match(definition.parameters.properties.reply_to.description, /OPTIONAL reply link/);
  assert.match(definition.parameters.properties.reply_to.description, /Never use request_id/);
  assert.match(definition.parameters.properties.request_id.description, /NOT a received message_id/);
});

test('idempotent same request sends once and conflicting content never replays', async t => {
  const f = fixture(t), args = { target: f.a.id, message: 'One work update', request_id: 'stable-request' };
  const [first, second] = await Promise.all([f.call(f.root, 'send_message', args), f.call(f.root, 'send_message', args)]);
  assert.equal(first.message_id, second.message_id); assert.equal(f.deliveries.length, 1);
  await assert.rejects(f.call(f.root, 'send_message', { ...args, message: 'different' }), { code: 'NX_MAIL_REQUEST_CONFLICT' });
  assert.equal(f.deliveries.length, 1);
});

test('lost receipt reconciles accepted native inbox without replay and absent evidence stays unknown', async t => {
  const f = fixture(t);
  f.setFault('after');
  const first = await f.call(f.root, 'send_message', { target: f.a.id, message: 'accepted despite lost receipt', request_id: 'lost' });
  // A live observer can already have confirmed acceptance after the body returns.
  assert.ok(['unknown', 'accepted'].includes(first.state));
  const known = await f.call(f.root, 'get_message_status', { message_id: first.message_id });
  assert.equal(known.state, 'accepted'); assert.equal(f.deliveries.length, 1);
  f.setFault('before');
  const second = await f.call(f.root, 'send_message', { target: f.b.id, message: 'uncertain effect', request_id: 'no-evidence' });
  assert.equal(second.state, 'unknown');
  const retry = await f.call(f.root, 'send_message', { target: f.b.id, message: 'uncertain effect', request_id: 'no-evidence' });
  assert.equal(retry.state, 'unknown'); assert.equal(f.deliveries.length, 1);
});

test('recipient consumption/discard and sender-only receipt authority are explicit', async t => {
  const f = fixture(t);
  const sent = await f.call(f.a, 'send_message', { target: f.b.id, message: 'peer data' });
  const message = f.deliveries.at(-1).message;
  f.emit('agent/inbox/claimed', { agent: f.b, message }); await flush();
  assert.equal((await f.call(f.a, 'get_message_status', { message_id: sent.message_id })).state, 'consumed');
  await assert.rejects(f.call(f.root, 'get_message_status', { message_id: sent.message_id }), { code: 'NX_MAIL_RECEIPT_NOT_FOUND' });
  const next = await f.call(f.a, 'send_message', { target: f.b.id, message: 'pending second' });
  f.emit('agent/inbox/discarded', { agent: f.b, message: f.deliveries.at(-1).message }); await flush();
  assert.equal((await f.call(f.a, 'get_message_status', { message_id: next.message_id })).state, 'discarded');
});

test('user stop holds a message until human input resumes it, without waking or canceling another agent', async t => {
  const f = fixture(t);
  f.a.cancel({ kind: 'user' });
  const sent = await f.call(f.root, 'send_message', { target: f.a.id, message: 'Do not override user stop' });
  assert.equal(sent.state, 'held'); assert.equal(f.deliveries.length, 0);
  f.emit('agent/status', { agent: f.a }); await flush();
  assert.equal(f.deliveries.length, 0);
  f.emit('agent/inbox/inserted', { agent: f.a, message: createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'continue' }] }) });
  for (let index = 0; index < 100 && !f.deliveries.length; index++) {
    await flush(); await new Promise<void>(resolve => setImmediate(resolve));
  }
  assert.equal(f.deliveries.length, 1);
  assert.equal(f.oldCalls.filter(value => value.startsWith('cancel:')).length, 1);
});

test('inactive continuable target cold-resumes through its exact native owner; one-shot/external never pretend to resume', async t => {
  const f = fixture(t);
  f.agents.delete(f.b.id);
  const sent = await f.call(f.a, 'send_message', { target: f.b.id, message: 'Resume original' });
  assert.equal(sent.state, 'accepted'); assert.equal(f.deliveries.length, 1);
  f.catalog.push({ kind: 'child', id: 'external', parentId: f.root.id, mode: 'external', label: 'external' });
  await assert.rejects(f.call(f.root, 'send_message', { target: 'external', message: 'not resumable' }), { code: 'NX_MAIL_NOT_RESUMABLE' });
});

test('task-root/fork isolation, ambiguous aliases, stale agent identities and peer interrupt permissions fail closed', async t => {
  const f = fixture(t);
  f.other.session.header.parentSession = f.root.id;
  await assert.rejects(f.call(f.a, 'send_message', { target: f.other.id, message: 'unrelated fork' }), { code: 'NX_MAIL_TARGET_NOT_FOUND' });
  f.catalog.find(row => row.id === f.a.id).label = 'duplicate';
  f.catalog.find(row => row.id === f.b.id).label = 'duplicate';
  const directory = await agentDirectory(f.ctx, f.root, signal());
  assert.throws(() => resolveAgent(directory, 'duplicate'), { code: 'NX_MAIL_TARGET_AMBIGUOUS' });
  await assert.rejects(agentDirectory(f.ctx, { ...f.a }, signal()), { code: 'NX_MAIL_SENDER_STALE' });
  await assert.rejects(f.call(f.a, 'interrupt_agent', { target: f.b.id }), { code: 'NX_MAIL_CONTROL_DENIED' });
  const interrupted = await f.call(f.root, 'interrupt_agent', { target: f.a.id });
  assert.equal(interrupted.accepted, true);
});

test('late Team scoped tool shadow is taken over in place and exact original owners restore on unload', async t => {
  const f = fixture(t);
  const teamSend = f.legacy('send_message'), originalTeam = teamSend.execute;
  f.scoped.set(f.a, new Map([['send_message', teamSend]]));
  f.emit('tools/change');
  assert.equal(f.tools.get('send_message', f.a), teamSend);
  await f.call(f.a, 'send_message', { target: f.b.id, message: 'scoped override routed' });
  assert.deepEqual(f.oldCalls, []);
  const nativeId = await f.services.subagents.sendMessage(f.root, f.a.id, [{ type: 'text', text: 'service path' }], { signal: signal() });
  assert.equal(typeof nativeId, 'string');
  await f.services.agentTeams.sendMessage(f.a, { target: f.b.id, content: [{ type: 'text', text: 'Team service path' }], signal: signal() });
  assert.deepEqual(f.oldCalls, []);
  const currentService = f.services.subagents.sendMessage;
  f.emit('tools/change'); assert.equal(f.services.subagents.sendMessage, currentService, 'service hooks do not stack on every registry change');
  await f.hook.dispose();
  assert.equal(f.global.get('send_message').execute, f.originalSend);
  assert.equal(teamSend.execute, originalTeam);
  assert.equal(f.services.subagents.sendMessage, f.originalService);
});

test('immutable legacy definitions are blocked instead of falling back to active-teammate routing', t => {
  const f = fixture(t), immutable = Object.freeze(f.legacy('send_message'));
  f.scoped.set(f.a, new Map([['send_message', immutable]])); f.emit('tools/change');
  assert.ok([...f.guards].some(guard => String(guard({ name: 'send_message', agent: f.a })).includes('NX_MAIL_HOOK_UNSUPPORTED')));
  assert.deepEqual(f.oldCalls, []);
});

test('wait uses cursor and mailbox events without requiring active teammates and cancels only itself', async t => {
  const f = fixture(t), roster = await f.call(f.a, 'list_agents');
  const waiting = f.call(f.a, 'wait_agent', { after_cursor: roster.cursor, timeout_ms: 10000 });
  await f.call(f.root, 'send_message', { target: f.a.id, message: 'wake observer' });
  const event = await waiting;
  assert.equal(event.timedOut, false); assert.ok(event.events.length > 0);
  assert.deepEqual(f.oldCalls, []);
});

test('frozen own service rejects installation synchronously and restores every earlier mutation', t => {
  let before: any;
  assert.throws(() => fixture(t, state => {
    before = state;
    before.send = state.services.subagents.sendMessage;
    before.cancel = state.root.cancel;
    before.execute = state.global.get('send_message').execute;
    Object.defineProperty(state.services.agentTeams, 'sendMessage', {
      value: state.services.agentTeams.sendMessage, configurable: false, writable: false,
    });
  }), { code: 'NX_MAIL_HOOK_UNSUPPORTED' });
  assert.equal(before.services.subagents.sendMessage, before.send);
  assert.equal(before.root.cancel, before.cancel);
  assert.equal(before.global.get('send_message').execute, before.execute);
  assert.equal(before.global.has('read_agent_messages'), false);
  assert.equal(before.guards.size, 0);
  assert.equal([...before.listeners.values()].reduce((sum: number, callbacks: any) => sum + callbacks.size, 0), 0);
});

test('writable nonconfigurable service restores its exact descriptor and service changes are hooked once', async t => {
  let descriptor!: PropertyDescriptor;
  const f = fixture(t, state => {
    Object.defineProperty(state.services.subagents, 'sendMessage', {
      value: state.services.subagents.sendMessage, writable: true, configurable: false, enumerable: false,
    });
    descriptor = Object.getOwnPropertyDescriptor(state.services.subagents, 'sendMessage')!;
  });
  const current = f.services.subagents.sendMessage;
  f.emit('internal/service', 'subagents', f.services.subagents);
  assert.equal(f.services.subagents.sendMessage, current);
  const replacement = { ...f.services.agentTeams, async sendMessage() { throw new Error('legacy replacement must not run'); } };
  const original = replacement.sendMessage;
  f.services.agentTeams = replacement; f.emit('internal/service', 'agentTeams', replacement);
  assert.notEqual(replacement.sendMessage, original);
  const disposing = f.hook.dispose();
  assert.equal(f.hook.dispose(), disposing);
  await disposing;
  assert.deepEqual(Object.getOwnPropertyDescriptor(f.services.subagents, 'sendMessage'), descriptor);
  assert.equal(replacement.sendMessage, original);
  await assert.rejects(current(f.root, f.a.id, [{ type: 'text', text: 'late captured wrapper' }], { signal: signal() }),
    { code: 'NX_MAIL_HOOK_UNSUPPORTED' });
});

test('durable user stop survives reload and real human input releases held mail', async t => {
  const f = fixture(t);
  // An old human input after an older stop must not release this newer idle stop.
  f.events.get(f.a.id)!.push(
    { type: 'turn/end', seq: 0, time: 1, data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } },
    { type: 'user/message', seq: 1, time: 2, data: createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'old resume' }] }) },
  );
  f.a.cancel({ kind: 'user' });
  await f.hook.dispose();
  const restarted = registerAgentCommunications(f.ctx, f.store);
  t.after(() => restarted.dispose());
  const held = await f.call(f.root, 'send_message', { target: f.a.id, message: 'still stopped', request_id: 'persisted-stop' });
  assert.equal(held.state, 'held'); assert.equal(f.deliveries.length, 0);
  const human = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'resume now' }] });
  f.events.get(f.a.id)!.push({ type: 'agent/inbox/spliced', seq: 2, time: Date.now(), data: { target: 'next-step', start: 0, inserted: [human] } });
  f.emit('agent/inbox/inserted', { agent: f.a, message: human });
  for (let attempt = 0; attempt < 100 && !f.deliveries.length; attempt++) {
    await flush(); await new Promise<void>(resolve => setImmediate(resolve));
  }
  assert.equal(f.deliveries.length, 1);
});

test('claimed native splice proves consumption, canceled splice proves discard without creating user stop', async t => {
  const f = fixture(t);
  const first = await f.call(f.root, 'send_message', { target: f.a.id, message: 'claim without user-message event' });
  f.events.get(f.a.id)!.push({ type: 'agent/inbox/spliced', seq: 1, data: { target: 'next-step', start: 0, removedCount: 1, inserted: [] } });
  assert.equal((await f.call(f.root, 'get_message_status', { message_id: first.message_id })).state, 'consumed');
  const second = await f.call(f.root, 'send_message', { target: f.b.id, message: 'canceled inbox' });
  f.events.get(f.b.id)!.push({ type: 'agent/inbox/spliced', seq: 1, data: { target: 'next-step', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' } });
  assert.equal((await f.call(f.root, 'get_message_status', { message_id: second.message_id })).state, 'discarded');
  assert.equal((await f.call(f.root, 'send_message', { target: f.b.id, message: 'ancestor canceled, still resumable' })).state, 'accepted');
});

test('root CAS reservations enforce the last capacity slot across independent mailbox instances', async t => {
  const f = fixture(t), hash = createHash('sha256').update(JSON.stringify(f.root.id)).digest('hex').slice(0, 32);
  const collection = `agent-mail-${hash}-index`, entries: Record<string, any> = {};
  for (let index = 0; index < 2047; index++) entries[`mail_${index.toString(16).padStart(64, '0')}`] = {
    senderId: f.root.id, targetId: f.a.id, fingerprint: `retained-${index}`, state: 'consumed', revision: 1, createdAt: new Date(0).toISOString(),
  };
  await f.store.put(collection, 'root', { schema: 1, rootId: f.root.id, entries }, 0);
  const left = new AgentMailbox(f.ctx, f.store), right = new AgentMailbox(f.ctx, f.store);
  t.after(async () => { await left.dispose(); await right.dispose(); });
  f.events.get(f.root.id)!.push({ type: 'turn/end', seq: 0, data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } });
  const result = await Promise.allSettled([left, right].map((mailbox, index) => mailbox.send(f.root,
    { target: f.a.id, content: [{ type: 'text', text: 'last slot' }], requestId: `last-slot-${index}` }, signal())));
  assert.equal(result.filter(row => row.status === 'fulfilled').length, 1);
  const denied = result.find(row => row.status === 'rejected') as PromiseRejectedResult;
  assert.equal(denied.reason.code, 'NX_MAILBOX_FULL');
  assert.equal(Object.keys((await f.store.get<any>(collection, 'root'))!.value.entries).length, 2048);
  assert.equal(f.deliveries.length, 0);
});

test('normal admissions never rescan bodies and a mailbox page reads only requested bodies', async t => {
  const f = fixture(t), originalList = f.store.list.bind(f.store), originalGet = f.store.get.bind(f.store);
  let bodyLists = 0, bodyGets = 0;
  f.store.list = async <T>(collection: string) => { if (/^agent-mail-[a-f0-9]{32}$/.test(collection)) bodyLists++; return originalList<T>(collection); };
  f.store.get = async <T>(collection: string, id: string) => { if (/^agent-mail-[a-f0-9]{32}$/.test(collection)) bodyGets++; return originalGet<T>(collection, id); };
  for (let index = 0; index < 12; index++) await f.call(f.root, 'send_message', { target: f.a.id, message: `page ${index}`, request_id: `page-${index}` });
  assert.equal(bodyLists, 1);
  bodyGets = 0;
  const page = await f.call(f.root, 'read_agent_messages', { offset: 5, limit: 3 });
  assert.equal(page.messages.length, 3); assert.equal(bodyGets, 3); assert.equal(bodyLists, 1);
});

test('unknown remains unreplayed after reload and aborted native observation releases only its caller', async t => {
  const f = fixture(t);
  f.setFault('before');
  const args = { target: f.a.id, message: 'unconfirmed', request_id: 'never-replay-after-reload' };
  const sent = await f.call(f.root, 'send_message', args);
  await f.hook.dispose();
  const restarted = registerAgentCommunications(f.ctx, f.store);
  t.after(() => restarted.dispose());
  f.setFault(undefined); f.emit('agent/status', { agent: f.a });
  assert.equal((await f.call(f.root, 'send_message', args)).state, 'unknown');
  assert.equal(f.deliveries.length, 0);
  let finish!: (snapshot: any) => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  f.services.sessionQuery.readSession = function () {
    assert.equal(arguments.length, 1); entered();
    return new Promise(resolve => { finish = resolve; });
  };
  const cancel = new AbortController();
  const observing = restarted.mailbox.status(f.root, sent.message_id, cancel.signal);
  await started; cancel.abort(new Error('cancel observation only'));
  await assert.rejects(observing, /cancel observation only/);
  finish({ events: [], inheritedEventCount: 0 });
  assert.equal(f.deliveries.length, 0); assert.deepEqual(f.oldCalls, []);
});

test('canceling one wait leaves another wait and the recipient running', async t => {
  const f = fixture(t), roster = await f.call(f.root, 'list_agents'), cancel = new AbortController();
  const one = f.hook.mailbox.wait(f.root, cancel.signal, roster.cursor);
  const two = f.hook.mailbox.wait(f.root, signal(), roster.cursor);
  cancel.abort(new Error('stop only one wait'));
  await assert.rejects(one, /stop only one wait/);
  f.emit('agent/status', { agent: f.a });
  assert.equal((await two).timedOut, false);
  assert.deepEqual(f.oldCalls, []);
});
