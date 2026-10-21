import assert from 'node:assert/strict';
import test from 'node:test';
import { Context, Service, symbols } from '@deepseek-ai/cordis';
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { createScope } from '@deepseek-ai/dsh-scope';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { registerAgentCommunications } from '../src/host/communications/index.js';
import { stepProgressServices } from './step-progress-fixture.js';
import type { HostContext } from '../src/host/types.js';

test('real rc.2 registry retains scoped ownership, monotonic denies and canonical native output after takeover', async t => {
  const root = new Context(), f = stepProgressServices(), fibers: any[] = [];
  let host!: Context, hook!: ReturnType<typeof registerAgentCommunications>, runtime!: ToolRuntime;
  const caller: any = { id: 'native-mail-root', status: 'idle', session: { header: { cwd: process.cwd() } }, cancel() {} };
  const child: any = { id: 'native-mail-child', status: 'idle', session: { header: { cwd: process.cwd() } }, cancel() {} };
  const agents = { get: (id: string) => id === caller.id ? caller : id === child.id ? child : undefined,
    list: () => [caller, child], roots: () => [caller], isOwnedBy: (id: string, owner: any) => id === child.id && owner === caller };
  let oldRuns = 0, intercepted = 0;
  class NativeSubagents extends Service {
    constructor(ctx: Context) { super(ctx, 'subagents'); }
    async sendMessage() { oldRuns++; }
    async listDescendants() {
      return [{ id: child.id, parentId: caller.id, mode: 'continuable', kind: 'child', label: 'worker' }];
    }
  }
  let service!: NativeSubagents;
  const base = root.plugin({ name: 'native-mail-base', apply(ctx: Context) {
    new SystemPrompt(ctx, { includeHarnessIdentity: false });
    ctx.provide('agents', agents as any);
    service = new NativeSubagents(ctx);
    ctx.provide('sessionQuery', { async readSession() { return { events: [], inheritedEventCount: 0 }; } } as any);
  } }); fibers.push(base); await base.await(); assert.equal(base.state, 2);
  const toolOwner = root.plugin({ name: 'native-mail-tools', inject: ['systemPrompt'], apply(ctx: Context) {
    runtime = new ToolRuntime(ctx);
    ctx.tools.register(defineTool({ name: 'send_message', description: 'active teammate only', parameters: { target: { type: 'string', required: true } },
      output: { schema: { type: 'object', additionalProperties: true }, render: () => [] }, async execute() { oldRuns++; return {}; } }));
    ctx.tools.register(defineTool({ name: 'list_agents', description: 'legacy Team roster', parameters: {},
      output: { schema: { type: 'array', items: { type: 'string' } }, render: () => [] }, async execute() { oldRuns++; return []; } }));
  } }); fibers.push(toolOwner); await toolOwner.await(); assert.equal(toolOwner.state, 2);
  const plugin = root.plugin({ name: 'native-mail-hook', inject: ['tools', 'agents', 'subagents', 'systemPrompt'], apply(ctx: Context) {
    host = ctx; hook = registerAgentCommunications(ctx as unknown as HostContext, f.store);
    ctx.on('tools/pre-execute', async (exec, next) => {
      intercepted++;
      if ((exec.arguments as any)?.message === 'deny-by-policy') return { kind: 'deny', reason: 'native policy denial' };
      return next();
    });
  } }); fibers.push(plugin); await plugin.await(); assert.equal(plugin.state, 2);
  const firstView = host.get('subagents') as any, secondView = host.get('subagents') as any;
  assert.notEqual(firstView, secondView, 'tracked Cordis services expose fresh views');
  assert.equal(firstView[symbols.original], service);
  assert.equal(secondView[symbols.original], service);
  const installedSend = service.sendMessage;
  (host as any).emit('internal/service', 'subagents', service);
  assert.equal(service.sendMessage, installedSend, 'fresh views do not stack wrappers');
  const restrictedKey = { kind: 'restricted' };
  const scope = createScope(host, child), restricted = createScope(host, restrictedKey);
  const local = defineTool({ name: 'send_message', description: 'Scoped Team override', parameters: { target: { type: 'string', required: true } },
    output: { schema: { type: 'object', additionalProperties: true }, render: () => [] }, async execute() { oldRuns++; return {}; } });
  scope.ctx.tools.register(local);
  restricted.ctx.tools.restrict({ deny: ['send_message'] });
  t.after(async () => { await hook.dispose(); await scope.dispose(); await restricted.dispose(); for (const fiber of fibers.reverse()) await fiber.dispose(); });
  const schema = runtime.schemas(child).find(row => row.name === 'send_message')!;
  assert.match(schema.description, /Unified agent messaging/);
  assert.ok((schema.parameters as any).properties.agent_id, 'legacy agent_id calls remain valid even under Team scope');
  assert.equal(runtime.get('send_message', child), local, 'no extra overriding layer stole the original scope owner');
  assert.equal(runtime.get('send_message', restrictedKey as any), undefined);
  const denied = await runtime.execute({ callId: ToolCallId('native-mail-denied'), name: 'send_message',
    agent: child, arguments: { target: caller.id, message: 'deny-by-policy' }, signal: new AbortController().signal });
  assert.equal(denied.isError, true); assert.match(JSON.stringify(denied), /native policy denial/);
  const listed = await runtime.execute({ callId: ToolCallId('native-mail-roster'), name: 'list_agents',
    agent: caller, arguments: {}, signal: new AbortController().signal });
  assert.ok(!listed.isError);
  assert.match(JSON.stringify(listed), /native-mail-child/);
  assert.equal(oldRuns, 0); assert.equal(intercepted, 2);
  const assembly = await host.systemPrompt.assemble({ scope: child });
  assert.ok(assembly.contexts.some(row => row.name === 'nexus:agent-communication'));
  assert.equal(assembly.tools.find(row => row.name === 'send_message')?.description, schema.description);
  await hook.dispose();
  assert.equal(Object.getOwnPropertyDescriptor(service, 'sendMessage'), undefined, 'unload restores inherited method placement');
  assert.equal(service.sendMessage, NativeSubagents.prototype.sendMessage);
});
