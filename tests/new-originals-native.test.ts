import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Context } from '@deepseek-ai/cordis';
import { AgentRegistry } from '@deepseek-ai/dsh-agent';
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop';
import { LlmAdapter, LlmRuntime, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { SessionStore, SessionId } from '@deepseek-ai/dsh-session';
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools';
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection';
import { SandboxPolicyService, setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy';
import { approveEscalation } from '@deepseek-ai/dsh-sandbox';
import { ApprovalService } from '@deepseek-ai/dsh-user-approval';
import { SubagentRuntime } from '@deepseek-ai/dsh-subagent';
import { registerAgentCommunications } from '../src/host/communications/index.js';
import type { HostContext } from '../src/host/types.js';
import { stepProgressServices, deferred } from './step-progress-fixture.js';

class LocalAdapter extends LlmAdapter {
  calls = 0;
  async *stream(_request: GenerateOptions): AsyncGenerator<StreamChunk> {
    this.calls++;
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: 'fixture received peer data' };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'fixture received peer data' } };
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
async function fixture(t: TestContext) {
  const root = new Context(), fibers: any[] = [], handles: any[] = [];
  const directory = await mkdtemp(join(tmpdir(), 'nexus-new-native-')), outside = await mkdtemp(join(tmpdir(), 'nexus-new-outside-'));
  const adapter = new LocalAdapter(), f = stepProgressServices();
  let ctx!: Context, tools!: ToolRuntime, connection!: HostConnectionService, hook!: ReturnType<typeof registerAgentCommunications>;
  const base = root.plugin({ name: 'new-native-base', apply(owner: Context) {
    new AgentRegistry(owner); new SessionStore(owner); new SessionProjectionRegistry(owner);
    new SystemPrompt(owner, { includeHarnessIdentity: false });
    new SubagentRuntime(owner, SubagentRuntime.Config({}));
    new LlmRuntime(owner).registerAdapter(['new-native'], adapter);
    connection = new HostConnectionService(owner, [], {} as any);
    const session = (id: string) => {
      const value = owner.sessions.get(SessionId(id));
      if (!value) throw new Error('fixture session is unavailable');
      return value;
    };
    // All fixture sessions are resident. Both read faces use the real native
    // Session and the real registered subagentCatalog projection.
    owner.provide('sessionQuery', {
      async readSession(id: string) {
        const value = session(id);
        return { events: value.snapshotEvents(), inheritedEventCount: value.inheritedEventCount };
      },
      async observeSession(id: string) {
        return { projections: owner.sessionProjections.snapshot(session(id)), [Symbol.dispose]() {} };
      },
    } as any);
  } }); fibers.push(base); await base.await(); assert.equal(base.state, 2);
  const runtime = root.plugin({ name: 'new-native-runtime', inject: ['systemPrompt', 'sessionProjections'], apply(owner: Context) {
    tools = new ToolRuntime(owner);
    new SandboxPolicyService(owner, { mode: 'workspace-write', workspaceRoot: directory });
    new ApprovalService(owner, { policy: 'ask' });
  } }); fibers.push(runtime); await runtime.await(); assert.equal(runtime.state, 2);
  const driver = root.plugin({ name: 'new-native-driver', inject: ['agents','sessions','sessionProjections','llm','tools','systemPrompt','connection','sandboxPolicy','approval'], apply(owner: Context) {
    ctx = owner; new AgentLoop(owner, AgentLoop.Config({ agents: [], maxParallelToolCalls: 1 }));
    owner.provide('permissionPresets', { defaultPreset: 'safe', names: ['safe','wide'], resolve(name: string) {
      return name === 'wide' ? { sandbox: 'danger-full-access', approval: 'ask' } : { sandbox: 'workspace-write', approval: 'ask' };
    }, permissionState(session: any) { return { sandbox: owner.sandboxPolicy.resolve({ session }).mode, approval: (owner.approval as any).effectivePolicy(session) }; } } as any);
    hook = registerAgentCommunications(owner as unknown as HostContext, f.store);
    owner.effect(() => () => hook.dispose(), 'fixture: mailbox provider drain');
  } }); fibers.push(driver); await driver.await(); assert.equal(driver.state, 2);
  async function agent(cwd = directory): Promise<any> {
    const handle = await ctx.agents.create({ sessionId: SessionId(`session-${randomUUID()}`), meta: { cwd },
      agentOptions: { provider: 'new-native', model: 'fixture', maxTokens: 32 } });
    handles.push(handle); return handle.agent;
  }
  t.after(async () => {
    for (const handle of handles.reverse()) await handle.dispose();
    await hook.dispose();
    for (const fiber of fibers.reverse()) await fiber.dispose();
    // Windows may briefly retain a disposed screenshot directory handle.
    // Bounded native retries still fail the test if cleanup cannot complete.
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    await rm(outside, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  return { root, fibers, ctx, tools, connection, directory, outside, agent, adapter, f };
}

test('rc.3 real native cross-session tool lifecycle uses shared receipts, preserves stop attribution and denies foreign scope', async t => {
  const h = await fixture(t);
  const entry = '../lib/original/cross-session-approval.js', original = await import(entry);
  const mounted = h.root.plugin({ ...original, inject: ['tools','agents','nexusCrossSessionMailbox','sandboxPolicy','approval','sessions','permissionPresets'] } as any,
    { stateDir: '.fixture-cross', spawnPermission: 'cap', forkPermission: 'cap', approvalBridge: { enabled: true } });
  h.fibers.push(mounted); await mounted.await(); assert.equal(mounted.state, 2);
  const caller = await h.agent(), recipient = await h.agent(), outsider = await h.agent(h.outside);
  const execute = (name: string, args: any, id = randomUUID()) => h.tools.execute({ name, arguments: args, agent: caller,
    callId: ToolCallId(id), signal: new AbortController().signal });
  assert.equal(h.tools.schemas(caller).filter(row => row.name.startsWith('cross_session_')).length, 10);
  const denied = await execute('cross_session_send', { session_id: outsider.id, message: 'must stay out' });
  assert.equal(denied.isError, true); assert.match(JSON.stringify(denied), /NX_MAIL_SCOPE_DENIED/);
  const sent = await execute('cross_session_send', { session_id: recipient.id, message: 'peer data' });
  assert.equal(sent.isError, false, JSON.stringify(sent));
  const receipt = (sent.value as any).mailbox;
  assert.match(receipt.message_id, /^mail_[a-f0-9]{64}$/);
  await recipient.whenIdle();
  assert.ok(recipient.session.snapshotEvents().some((event: any) =>
    event.type === 'user/message' && event.data.source?.kind === 'agent-message'
      && event.data.source?.nexusMessageId === receipt.message_id));
  const status = await execute('get_message_status', { message_id: receipt.message_id });
  assert.equal(status.isError, false, JSON.stringify(status));
  assert.equal((status.value as any).message_id, receipt.message_id);
  const read = await execute('read_agent_messages', {});
  assert.ok((read.value as any).cross_session_messages.some((row: any) => row.message_id === receipt.message_id));

  const originalSteer = recipient.steer;
  let dispatches = 0;
  recipient.steer = () => { dispatches++; throw new Error('fixture loses the native acceptance reply'); };
  const id = randomUUID(), args = { session_id: recipient.id, message: 'one unknown execution only' };
  const unknown = await execute('cross_session_send', args, id);
  assert.equal((unknown.value as any).mailbox.state, 'unknown');
  const repeated = await execute('cross_session_send', args, id);
  assert.equal((repeated.value as any).mailbox.state, 'unknown');
  assert.equal(dispatches, 1);
  recipient.steer = originalSteer;

  recipient.cancel({ kind: 'user' });
  const stopped = await execute('cross_session_send', { session_id: recipient.id, message: 'do not resume a user stop' });
  assert.equal(stopped.isError, true); assert.match(JSON.stringify(stopped), /NX_MAIL_USER_STOPPED/);
  assert.equal(dispatches, 1);
  const wider = await execute('cross_session_spawn', { name: 'forbidden wider child', task: 'must never run', permission: 'wide' });
  assert.equal(wider.isError, true); assert.match(JSON.stringify(wider), /宽于调用者/);
});

test('rc.3 computer native entry mounts with its real routes while every desktop tool stays off', async t => {
  const h = await fixture(t), entry = '../lib/original/computer-use.js', original = await import(entry);
  const mounted = h.root.plugin(original as any, { defaultEnabled: false, shotDir: join(h.directory, 'shots'),
    tokenGuard: { enabled: false }, appLaunch: { enabled: true } });
  h.fibers.push(mounted); await mounted.await(); assert.equal(mounted.state, 2);
  const caller = await h.agent();
  const desktopNames = [
    'computer_screenshot', 'computer_actions', 'computer_click', 'computer_drag', 'computer_scroll',
    'computer_type', 'computer_key', 'computer_windows', 'computer_ui', 'computer_ui_action',
    'computer_clipboard', 'computer_paste', 'computer_launch', 'computer_stop',
  ].sort();
  const desktopTools = h.tools.schemas().filter(row => row.name.startsWith('computer_')).map(row => row.name).sort();
  assert.deepEqual(desktopTools, desktopNames, 'all 14 tools in the pinned upstream remain registered globally');
  assert.deepEqual(h.tools.schemas(caller).filter(row => row.name.startsWith('computer_')), [],
    'the original per-session restriction hides the off capability without unregistering it');
  assert.ok(h.tools.get('app_launch', caller), 'the native launcher remains registered so its execution grant is exercised');
  const request = () => new Request('http://localhost/api/plugins/dsh-noemaloom/computer-use/state?sessionId=' + caller.id);
  const owner = h.connection.createPeer({ principal: { kind: 'owner' } });
  const delegate = { principal: { kind: 'delegate' } } as any;
  const route = h.connection.createSharedFetchHandler('/api');
  assert.equal((await route.fetch(request(), delegate)).status, 403);
  const status = await (await route.fetch(new Request('http://localhost/api/plugins/dsh-noemaloom/computer-use/status'), owner)).json();
  assert.deepEqual(status.runtime.registrationFailures, [], 'safeRegister must not hide a rejected native tool schema');
  const state = await (await route.fetch(request(), owner)).json();
  assert.equal(state.enabled, false); assert.equal(state.backend.started, false);
  const tool = await h.tools.execute({ name: 'computer_screenshot', arguments: {}, agent: caller,
    callId: ToolCallId('computer-off'), signal: new AbortController().signal });
  assert.equal(tool.isError, true, 'no PowerShell backend or real input starts while the session grant is off');
  const launch = await h.tools.execute({ name: 'app_launch', arguments: { target: process.execPath, verifyWindow: false, waitMs: 0 },
    agent: caller, callId: ToolCallId('app-launch-off'), signal: new AbortController().signal });
  assert.equal(launch.isError, true, 'the formerly independent launcher obeys the same native session grant');
  assert.match(JSON.stringify(launch), /NOT_AUTHORIZED/, 'the launcher must reach the shared grant gate');
  const after = await (await route.fetch(request(), owner)).json();
  assert.equal(after.backend.started, false);
  const doctor = await (await route.fetch(new Request('http://localhost/api/plugins/dsh-noemaloom/computer-use/doctor'), owner)).json();
  assert.equal(doctor.ok, true, JSON.stringify(doctor.findings)); assert.equal(doctor.checks.backend, null);
});

test('computer bootstrap failure exposes authenticated 503 diagnostics without tools or a worker', async t => {
  const h = await fixture(t);
  const degradedEntry = '../lib/original/computer-use/internal/degraded.mjs';
  const { applyDegraded } = await import(degradedEntry);
  const before = h.tools.schemas().map(row => row.name);
  const mounted = h.root.plugin({
    name: 'computer-degraded-fixture', inject: ['connection'],
    apply(owner: Context) {
      applyDegraded(owner, {}, Object.assign(new Error('fixture host module unavailable'), {
        code: 'HOST_PACKAGE_IMPORT_FAILED',
      }));
    },
  });
  h.fibers.push(mounted); await mounted.await(); assert.equal(mounted.state, 2);
  const route = h.connection.createSharedFetchHandler('/api');
  const owner = h.connection.createPeer({ principal: { kind: 'owner' } });
  for (const name of ['status', 'doctor']) {
    const request = () => new Request(`http://localhost/api/plugins/dsh-noemaloom/computer-use/${name}`);
    const denied = await route.fetch(request(), { principal: { kind: 'delegate' } } as any);
    assert.equal(denied.status, 403);
    const response = await route.fetch(request(), owner);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.equal(body.code, 'HOST_PACKAGE_IMPORT_FAILED');
    assert.match(body.note, /no tools, no backend, no actions/);
  }
  assert.deepEqual(h.tools.schemas().map(row => row.name), before);
});

test('computer launch uses native approval, immutable exact plans and original revoke cancellation', { skip: process.platform !== 'win32', timeout: 10000 }, async t => {
  const h = await fixture(t), caller = await h.agent();
  const policyPath = '../src/host/computer-use-policy.mjs', sessionsPath = '../vendor/computer-use/internal/sessions.mjs';
  const executionPath = '../vendor/computer-use/internal/execution.mjs';
  const { createComputerUsePolicy, authorizeNativeAppLaunch } = await import(policyPath);
  const { createSessions } = await import(sessionsPath), { createExecutionRegistry } = await import(executionPath);
  const grants = createSessions({ defaultEnabled: false }), execution = createExecutionRegistry();
  const policy = createComputerUsePolicy(h.ctx, { execution, resolveBrowserEndpoint: () => 'http://127.0.0.1:65535',
    requireGrant(exec: any) { if (!grants.isEnabled(exec.agent.id)) throw new Error('fixture original grant is off'); } });
  let dispatches = 0, browserDispatches = 0, answer: any = 'rejected';
  let asked = deferred<any>();
  const reasons: string[] = [];
  h.ctx.on('approval/request', (request: any) => {
    reasons.push(request.reason); asked.resolve(request);
    return typeof answer === 'string' ? Promise.resolve(answer) : answer.promise;
  }, { prepend: true });
  h.tools.register(defineTool(policy.wrap({
    name: 'app_launch', description: 'Fixture observes the original exact process-dispatch boundary without spawning.',
    parameters: { target: { type: 'string', required: true }, arguments: { type: 'array', items: { type: 'string' } } },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args: any, value: any) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args: any, exec: any) {
      const plan = await authorizeNativeAppLaunch(exec, { file: args.target, arguments: args.arguments ?? [], target: args.target, inspectWindows: false });
      dispatches++; return plan;
    },
  })));
  h.tools.register(defineTool(policy.wrap({
    name: 'browser_state', description: 'Fixture counts dispatch before any network transport can open.', parameters: {},
    output: { schema: { type: 'object', additionalProperties: true }, render: () => [{ type: 'text', text: 'fixture' }] },
    async execute() { browserDispatches++; return {}; },
  })));
  const invoke = (name: string, args: any, signal = new AbortController().signal) =>
    h.tools.execute({ name, arguments: args, agent: caller, callId: ToolCallId(randomUUID()), signal });
  caller.session.append('turn/start', { turn: 1 });
  grants.grant(caller.id);
  const args = { target: process.execPath, arguments: ['--fixture-literal=$();`with spaces'] };
  assert.equal((await invoke('app_launch', args)).isError, true);
  assert.equal(dispatches, 0); assert.match(reasons[0], /native-process-launch/);
  assert.match(reasons[0], /sha256/);
  assert.equal((await invoke('browser_state', {})).isError, true);
  assert.equal(browserDispatches, 0, 'native rejection precedes CDP discovery and socket startup');
  assert.equal(h.ctx.sandboxPolicy.resolve({ session: caller.session }).mode, 'workspace-write');

  answer = 'allowed-once';
  const allowed = await invoke('app_launch', args);
  assert.equal(allowed.isError, false, JSON.stringify(allowed)); assert.equal(dispatches, 1);
  assert.deepEqual((allowed.value as any).arguments, args.arguments);
  assert.equal(h.ctx.sandboxPolicy.resolve({ session: caller.session }).mode, 'workspace-write', 'one-shot approval does not widen standing policy');

  answer = deferred<string>();
  asked = deferred<any>();
  const controller = new AbortController();
  const cancelled = invoke('app_launch', args, controller.signal);
  // The native approval event is the synchronization point; no fixed sleeps.
  await asked.promise;
  grants.revoke(caller.id); execution.abort(caller.id, new Error('fixture user revoked the native computer grant'));
  answer.resolve('allowed-once');
  assert.equal((await cancelled).isError, true);
  assert.equal(dispatches, 1, 'late approval cannot dispatch after the original execution registry was revoked');
  assert.ok(caller.session.snapshotEvents().some((event: any) => event.type === 'approval/decided' && event.data.outcome === 'cancelled'));
  caller.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } } as any);
});

test('native root disposal cancels a persisted pending approval notice before the mailbox provider stops', { timeout: 15000 }, async t => {
  const h = await fixture(t), entry = '../lib/original/cross-session-approval.js', original = await import(entry);
  const mounted = h.root.plugin({ ...original, inject: ['tools','agents','nexusCrossSessionMailbox','sandboxPolicy','approval','sessions','permissionPresets'] } as any,
    { stateDir: '.fixture-cross-drain', spawnPermission: 'cap', forkPermission: 'cap',
      approvalBridge: { enabled: true, timeoutMs: 10000, injectWithdraw: true } });
  h.fibers.push(mounted); await mounted.await(); assert.equal(mounted.state, 2);
  const owner = await h.agent(); setSandboxMode(owner.session, 'danger-full-access');
  const spawn = await h.tools.execute({ name: 'cross_session_spawn', agent: owner, callId: ToolCallId('drain-child'),
    arguments: { name: 'native drain child', task: 'fixture initialization', provider: 'new-native', model: 'fixture', permission: 'safe' },
    signal: new AbortController().signal });
  assert.equal(spawn.isError, false, JSON.stringify(spawn));
  const child = h.ctx.agents.list().find((agent: any) => agent.id !== owner.id)! as any;
  assert.ok(child); await child.whenIdle();
  h.tools.register(defineTool({
    name: 'pwsh', description: 'Approval-only fixture; starts no shell.',
    parameters: { command: { type: 'string', required: true }, sandbox_permissions: { type: 'string', required: true } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { granted: { type: 'boolean', required: true } } },
      render: () => [{ type: 'text', text: 'Approval-only fixture completed.' }],
    },
    async execute(_args: any, exec: any) {
      await approveEscalation({ requestedMode: 'danger-full-access', effectiveMode: 'workspace-write',
        justification: 'observe a pending native approval', subject: 'fixture' },
      { approver: h.ctx.approval, agent: exec.agent!, callId: exec.callId, toolName: exec.name, signal: exec.signal });
      throw new Error('The disposal scenario must never grant this operation.');
    },
  }));
  const queued = deferred<{ collection: string; id: string }>(), release = deferred();
  const save = h.f.store.put.bind(h.f.store); let blocked = false;
  h.f.store.put = async (...args: any[]) => {
    const result = await (save as any)(...args);
    if (!blocked && args[2]?.requestId?.startsWith('approval-notice:') && args[2]?.state === 'queued') {
      blocked = true; queued.resolve({ collection: args[0], id: args[1] }); await release.promise;
    }
    return result;
  };
  child.session.append('turn/start', { turn: 1 });
  const asking = h.tools.execute({ name: 'pwsh', arguments: { command: 'Get-Date', sandbox_permissions: 'danger-full-access' },
    agent: child, callId: ToolCallId('drain-approval'), signal: new AbortController().signal });
  try {
    const saved = await new Promise<{ collection: string; id: string }>((resolve, reject) => {
      const abort = () => reject(t.signal.reason);
      t.signal.addEventListener('abort', abort, { once: true });
      void queued.promise.then(value => {
        t.signal.removeEventListener('abort', abort); resolve(value);
      }, error => {
        t.signal.removeEventListener('abort', abort); reject(error);
      });
      if (t.signal.aborted) abort();
    });
    const closing = h.root.fiber.dispose();
    release.resolve();
    await closing; await asking;
    const row = await h.f.store.get<any>(saved.collection, saved.id);
    assert.equal(row?.value.state, 'discarded', 'no canceled approval notice remains queued for a future activity pump');
    assert.equal(h.tools.get('cross_session_approve'), undefined);
  } finally {
    // A failed/expired fixture must not leave the durable-save boundary blocked.
    release.resolve();
  }
});

test('rc.3 Motion registers native tools and owner-only document routes with exact session ownership', async t => {
  const h = await fixture(t), entry = '../lib/original/motion-ui.js', original = await import(entry);
  const priorHome = process.env.DSH_HOME; process.env.DSH_HOME = h.directory;
  const mounted = h.root.plugin(original as any, { autoRepair: false });
  h.fibers.push(mounted);
  try { await mounted.await(); } finally { if (priorHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = priorHome; }
  assert.equal(mounted.state, 2);
  const caller = await h.agent();
  const rendered = await h.tools.execute({ name: 'render_ui', agent: caller, callId: ToolCallId('motion-render'),
    arguments: { document: { version: 1, title: 'Fixture', fallback: 'Native motion fixture',
      nodes: [{ id: 'hello', type: 'text', text: 'Native motion fixture' }] } }, signal: new AbortController().signal });
  assert.equal(rendered.isError, false, JSON.stringify(rendered));
  const value = rendered.value as any, route = h.connection.createSharedFetchHandler('/api');
  const owner = h.connection.createPeer({ principal: { kind: 'owner' } });
  const url = `http://localhost/api/plugins/dsh-generative-ui/document?documentId=${value.documentId}&sessionId=${caller.id}`;
  assert.equal((await route.fetch(new Request(url), { principal: { kind: 'delegate' } } as any)).status, 403);
  assert.equal((await route.fetch(new Request(url), owner)).status, 200);
  assert.equal((await route.fetch(new Request(url.replace(caller.id, 'another-session')), owner)).status, 403);
  await mounted.dispose();
  assert.equal(h.tools.get('render_ui'), undefined);
});
