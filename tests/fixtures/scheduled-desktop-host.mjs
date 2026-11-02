// Installed only by desktop-delayed-message.mjs into its marked synthetic home.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';

export const name = 'noemaloom-scheduled-fixture';
export const inject = ['nexus', 'llm', 'agents', 'subagents', 'webServer', 'sessionQuery', 'sessionPersistence', 'sessionController'];
export async function apply(ctx, config) {
  const temporary = resolve(config.temporary), home = resolve(process.env.DSH_HOME);
  assert(basename(temporary).startsWith('nexus-original-desktop-'));
  assert(!relative(tmpdir(), temporary).startsWith('..'));
  assert.equal(home, join(temporary, 'home'));
  assert.equal(JSON.parse(await readFile(join(home, 'profiles/desktop/package.json'))).name, 'nexus-disposable-desktop-profile');
  const provider = 'noemaloom-offline-scheduled', model = 'scheduled-fixture';
  const stateFile = join(temporary, 'scheduled-fixture-state.json');
  let ids;
  try { ids = JSON.parse(await readFile(stateFile)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const requests = [];
  const failures = [];
  ctx.on('agent/request', async (payload, next) => {
    try { return await next(); } catch (error) {
      failures.push({ sessionId: payload.agent.id, stack: error.stack, code: error.code });
      throw error;
    }
  }, { prepend: true });
  ctx.on('agent/request-error', async (payload, next) => {
    failures.push({ sessionId: payload.agent.id, failure: payload.failure });
    return next();
  }, { prepend: true });
  class Adapter extends LlmAdapter {
    async listModels() { return [{ provider, id: model, name: 'Offline scheduled fixture' }]; }
    async resolveModel() { return { provider, id: model, name: 'Offline scheduled fixture', context: { contextWindow: 1000000 }, defaultMaxTokens: 128 }; }
    async *stream(request) {
      requests.push({ sessionId: request.sessionId, model: request.model,
        texts: request.messages.flatMap(m => m.content ?? []).filter(b => b.type === 'text').map(b => b.text) });
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: '离线延时投递已收到。' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '离线延时投递已收到。' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  ctx.llm.registerAdapter([provider], new Adapter());
  const services = ctx.nexus.services;
  async function snapshot() {
    const result = { ids, requests, failures, remoteModelRequests: 0 };
    if (!ids) return result;
    result.plans = [];
    for (const id of Object.values(ids)) {
      const metadata = await ctx.sessionPersistence.stat(SessionId(id), { signal: services.signal });
      // Observe persisted scope rows directly: polling must not lazily create
      // the session's Workflow runtime and accidentally mask a restart defect.
      const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 24);
      const root = resolve(metadata.header.cwd);
      const prefix = `ss_${hash(process.platform === 'win32' ? root.toLowerCase() : root)}_${hash(id)}_`;
      result.plans.push(...await services.store.list(`${prefix}workflow-injections`));
    }
    result.sessions = {};
    for (const id of Object.values(ids)) {
      const source = await ctx.sessionQuery.readSession(SessionId(id));
      result.sessions[id] = { header: source.session, live: !!ctx.agents.get(SessionId(id)),
        scheduled: source.events.filter(e => e.type === 'user/message' && e.data.source?.meta?.operation === 'scheduled-prompt')
          .map(e => ({ id: e.data.id, source: e.data.source, content: e.data.content })) };
    }
    return result;
  }
  async function action(body) {
    if (body.action === 'prepare') {
      assert(!ids, 'prepare only once; restart uses the durable fixture identity');
      const parent = ctx.agents.get(SessionId(body.parentId)); assert(parent);
      const workspace = relative(resolve(config.workspace), resolve(parent.session.header.cwd));
      assert(workspace !== '..' && !workspace.startsWith(`..${sep}`) && !isAbsolute(workspace));
      await ctx.sessionController.selectModel({ sessionId: parent.id, provider, model });
      const activation = await ctx.subagents.startActivation({
        childId: SessionId(`session-${randomUUID()}`), provider: 'spawn',
        label: '延时发送验收子代理', delivery: 'caller', signal: services.signal,
        request: { parent, prompt: [{ type: 'text', text: '离线验收初始任务，完成后等待后续文字。' }],
          agentOptions: { provider, model, maxTokens: 128 } },
      });
      assert.equal((await activation.result).stopReason, 'completed');
      ids = { parentId: parent.id, childId: activation.childId };
      await writeFile(stateFile, JSON.stringify(ids));
      for (let i = 0; i < 200 && ctx.agents.get(activation.childId); i++) await new Promise(done => setTimeout(done, 25));
      assert.equal(ctx.agents.get(activation.childId), undefined, 'the real child must release before delay verification');
      return snapshot();
    }
    if (body.action === 'snapshot') return snapshot();
    assert(ids);
    if (body.action === 'repeat') {
      const row = (await snapshot()).plans.find(row => row.id === body.id); assert(row);
      return services.host.sessions('scheduled.prompt', { sessionId: row.value.sessionId, requestId: row.id, text: row.value.body });
    }
    throw new Error('Unknown synthetic action');
  }
  ctx.webServer.register({ kind: 'exact', path: '/__noemaloom_scheduled_fixture', handler: async (req, res) => {
    if (req.method !== 'POST' || req.headers['x-noemaloom-fixture'] !== config.token) { res.writeHead(403); res.end(); return; }
    try {
      let text = ''; for await (const chunk of req) { text += chunk; assert(text.length <= 4096); }
      const value = await action(JSON.parse(text));
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value));
    } catch (e) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: e.stack })); }
  } });
}
