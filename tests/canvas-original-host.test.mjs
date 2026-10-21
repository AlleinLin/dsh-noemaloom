import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { getEventListeners } from 'node:events';

// Build first, then exercise the shipping adapter and the actual published
// host code it wraps. No substitute graph/store implementation is used here.
const { applyThoughtdag, applySynapse } = await import(new URL('../lib/canvases.js', import.meta.url).href);

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function response(onWrite = () => {}) {
  return {
    status: 0, headers: {}, body: '', headersSent: false, writableEnded: false,
    writeHead(status, headers = {}) { this.status = status; this.headers = headers; this.headersSent = true; },
    getHeader(name) { return this.headers[name]; },
    removeHeader(name) { delete this.headers[name]; },
    write(body) { this.body += String(body); onWrite(String(body)); },
    end(body = '') { this.body += String(body); this.writableEnded = true; },
  };
}

async function fixture() {
  const profileDirectory = await mkdtemp(join(tmpdir(), 'nexus-original-profile-'));
  const routes = [], disposers = [], listeners = new Map(), errors = [];
  const headers = [
    { id: 'a', cwd: 'D:\\shared-path' },
    { id: 'b', cwd: 'D:\\shared-path' },
  ];
  const workspaces = [
    { id: 'wa', title: 'A', path: 'D:\\shared-path', sessionIds: ['a'] },
    { id: 'wb', title: 'B', path: 'D:\\shared-path', sessionIds: ['b'] },
  ];
  const event = (seq, text) => ({
    seq, type: 'user/message', time: Date.now(),
    data: { id: `message-${seq}`, content: [{ type: 'text', text }] },
  });
  const sessions = new Map(headers.map(header => {
    const events = [event(0, `question from ${header.id}`)];
    return [header.id, {
      id: header.id, header, title: header.id, inheritedEventCount: 0, events,
      get seq() { return events.length; },
      snapshotEvents: () => [...events],
    }];
  }));
  const created = [], forked = [], prompted = [], injected = [], cancelled = [], agents = new Map();
  let nextId = 0;
  const emit = (name, ...args) => [...(listeners.get(name) ?? [])].map(listener => listener(...args));
  const ctx = {
    logger: { info() {}, warn() {}, error(error) { errors.push(error); } },
    get(name) {
      if (name === 'sessionQuery') return {
        listSessions: async () => headers.map(header => ({ header })),
        readSession: async id => ({ session: headers.find(header => header.id === id), events: sessions.get(id)?.events ?? [] }),
      };
      if (name === 'workspaceRegistry') return { list: () => workspaces };
      if (name === 'profileContext') return { dir: profileDirectory };
      throw new Error(`Unexpected native capability ${name}`);
    },
    extend(values) { return Object.assign(Object.create(this), values); },
    effect(callback) { const dispose = callback(); if (typeof dispose === 'function') disposers.push(dispose); },
    inject(names, mount) {
      if (names.includes('permissionPresets') && ctx.permissionPresets) {
        return mount(Object.assign(Object.create(ctx), { permissionPresets: ctx.permissionPresets }));
      }
    },
    on(name, listener) {
      let current = listeners.get(name);
      if (!current) listeners.set(name, current = new Set());
      current.add(listener);
      return () => current.delete(listener);
    },
    webServer: {
      register(route) { routes.push(route); return () => { const at = routes.indexOf(route); if (at >= 0) routes.splice(at, 1); }; },
    },
    sessions: { list: () => [...sessions.values()], get: id => sessions.get(id) },
    agents: {
      get(id) {
        if (!headers.some(header => header.id === id)) return undefined;
        if (!agents.has(id)) agents.set(id, {
          id, session: sessions.get(id),
          inject(message) {
            injected.push({ id, message });
            const session = sessions.get(id);
            session?.events.push({ seq: session.events.length, type: 'user/message', time: Date.now(), data: message });
          },
          whenIdle: async () => {},
          cancel() { cancelled.push(id); },
        });
        return agents.get(id);
      },
    },
    llm: { listModels: async () => [] },
    sessionController: {
      modelCatalog: async () => ({ groups: [], default: null }),
      async create(input) {
        created.push(input);
        const id = `created-${++nextId}`;
        const header = { id, cwd: 'D:\\shared-path' };
        const events = [];
        headers.push(header);
        sessions.set(id, { id, header, inheritedEventCount: 0, events,
          get seq() { return events.length; }, snapshotEvents: () => [...events] });
        workspaces.find(row => row.id === input.workspaceId)?.sessionIds.push(id);
        return { sessionId: id };
      },
      async fork(input) {
        forked.push(input);
        const id = `forked-${++nextId}`;
        headers.push({ id, parentSession: input.sessionId, cwd: 'D:\\shared-path' });
        workspaces.find(row => row.sessionIds.includes(input.sessionId))?.sessionIds.push(id);
        return { sessionId: id };
      },
      async prompt(input) {
        prompted.push(input);
        if (ctx.promptImplementation) return ctx.promptImplementation(input);
        emit('session/event', { id: input.sessionId }, { type: 'turn/start', data: { turn: 1 } });
        emit('session/event', { id: input.sessionId }, {
          type: 'user/message', data: { id: 'own-question', source: { kind: 'user', rpcId: input.requestId } },
        });
        if (ctx.approvalDuringPrompt) {
          const agent = ctx.agents.get(input.sessionId);
          const [decision] = emit('approval/request', { agent, toolName: 'run_code', callId: 'call-1', signal: new AbortController().signal }, () => 'native');
          await decision;
        }
        emit('session/event', { id: input.sessionId }, {
          type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'done' }] } },
        });
        emit('session/event', { id: input.sessionId }, { type: 'turn/end', data: { turn: 1 } });
      },
    },
  };
  async function request(kind, level, id, path, method = 'GET', body, res = response()) {
    const route = routes.find(row => row.path === `/${kind}/api`);
    assert.ok(route, `${kind} original API is registered`);
    const query = new URLSearchParams({ nexusLevel: level, nexusId: id });
    const requestListeners = new Map();
    res.closeRequest = () => requestListeners.get('close')?.();
    const req = {
      method, headers: { host: 'localhost' }, url: `/${kind}/api${path}?${query}`,
      on(name, listener) { requestListeners.set(name, listener); },
      async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)); },
    };
    await route.handler(req, res);
    return {
      status: res.status, text: res.body, headers: res.headers,
      data: res.headers['content-type']?.includes('application/json') ? JSON.parse(res.body) : undefined,
    };
  }
  let unloaded = false;
  const unload = async () => {
    if (unloaded) return;
    unloaded = true;
    for (const dispose of disposers.reverse()) await dispose();
  };
  return {
    ctx, headers, sessions, workspaces, errors, created, forked, prompted, injected, cancelled, agents, request, event, emit, unload,
    async dispose() {
      try { await unload(); }
      finally { await rm(profileDirectory, { recursive: true, force: true }); }
    },
  };
}

test('Synapse original store isolates native tiers and removes moved sessions without losing manual nodes', { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nexus-canvas-store-'));
  const f = await fixture();
  try {
    await applySynapse(f.ctx, { dataDir: directory });
    const read = (level, id) => f.request('synapse', level, id, '/workspaces');
    const initialA = await read('workspace', 'wa');
    const initialB = await read('workspace', 'wb');
    assert.equal(initialA.status, 200);
    const workspaceA = initialA.data.workspaces[0];
    const workspaceB = initialB.data.workspaces[0];
    const details = await f.request('synapse', 'workspace', 'wa', `/workspaces/${workspaceA.id}`);
    assert.deepEqual(details.data.workspace.threads.map(row => row.dshSessionId), ['a']);
    const forbidden = await f.request('synapse', 'workspace', 'wa', `/workspaces/${workspaceB.id}`);
    assert.equal(forbidden.status, 404, 'a graph id from a sibling store cannot resolve');
    const manual = await f.request('synapse', 'workspace', 'wa', '/workspaces', 'POST', { title: 'manual graph' });
    const note = await f.request('synapse', 'workspace', 'wa', `/workspaces/${manual.data.workspace.id}`,
      'POST', { title: 'manual node' });
    assert.equal(note.status, 201);
    const sessionScope = await read('session', 'a');
    assert.equal(sessionScope.data.workspaces.some(row => row.id === manual.data.workspace.id), false,
      'session and workspace have separate editable graphs');

    const live = f.sessions.get('a');
    live.events.push(f.event(1, 'first newly committed event'));
    const next = await f.request('synapse', 'workspace', 'wa', `/workspaces/${workspaceA.id}`);
    assert.equal(next.data.workspace.threads[0].messages.some(row => row.text === 'first newly committed event'), true,
      'the next event index is not skipped');

    f.workspaces[0].sessionIds = [];
    f.workspaces[1].sessionIds.push('a');
    const afterMove = await read('workspace', 'wa');
    assert.deepEqual(afterMove.data.workspaces.map(row => row.id), [manual.data.workspace.id]);
    const manualAfterMove = await f.request('synapse', 'workspace', 'wa', `/workspaces/${manual.data.workspace.id}`);
    assert.equal(manualAfterMove.data.workspace.threads[0].id, note.data.thread.id);
    const syncRemoval = await f.request('synapse', 'workspace', 'wa', '/sessions/sync', 'POST',
      { sessions: [], removedSessionIds: ['a'] });
    assert.equal(syncRemoval.status, 200);
    const noScope = await f.request('synapse', '', '', '/workspaces');
    assert.equal(noScope.status, 400);
    assert.deepEqual(f.errors, []);
  } finally {
    await f.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

function frames(res) {
  return res.body.split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)));
}
function startTurn(f, input, turn = 1) {
  f.emit('session/event', { id: input.sessionId }, { type: 'turn/start', data: { turn } });
  f.emit('session/event', { id: input.sessionId }, {
    type: 'user/message', data: { id: `own-${turn}`, source: { kind: 'user', rpcId: input.requestId } },
  });
}
function endTurn(f, input, turn = 1) {
  f.emit('session/event', { id: input.sessionId }, { type: 'turn/end', data: { turn } });
}
const turnBody = harness => ({
  model: 'harness/agent', messages: [{ role: 'user', content: 'canvas question' }], harness: { session: 'a', ...harness },
});

test('ThoughtDAG native question forms enforce originating scope and preserve answer normalization', { timeout: 10_000 }, async () => {
  const f = await fixture(), question = deferred(), answer = deferred();
  const signal = new AbortController().signal;
  f.ctx.promptImplementation = async input => {
    startTurn(f, input);
    const [result] = f.emit('user-questions/request', {
      agent: f.ctx.agents.get(input.sessionId), signal,
      questions: [{ id: 'choice', header: 'Target', question: 'Which target?', options: [{ label: 'A' }, { label: 'B' }] }],
    }, () => 'native');
    answer.resolve(await result);
    endTurn(f, input);
  };
  try {
    await applyThoughtdag(f.ctx, { whyTools: false, whyPrompt: false });
    const stream = response(frame => {
      for (const line of frame.split('\n')) if (line.startsWith('data: {')) {
        const payload = JSON.parse(line.slice(6));
        if (payload.approval?.kind === 'form') question.resolve(payload.approval);
      }
    });
    const running = f.request('thoughtdag', 'workspace', 'wa', '/stream', 'POST', turnBody(), stream);
    const form = await question.promise;
    assert.equal(getEventListeners(signal, 'abort').length, 1);
    assert.equal((await f.request('thoughtdag', 'session', 'a', `/approvals/${form.id}`, 'POST', {
      answers: [{ id: 'choice', selected: ['B'] }],
    })).status, 404);
    assert.equal((await f.request('thoughtdag', 'workspace', 'wa', `/approvals/${form.id}`, 'POST', {
      answers: [{ id: 'choice', selected: ['A', 'invalid'], custom: '  another option  ' }, { id: 'foreign', selected: ['B'] }],
    })).status, 200);
    assert.deepEqual(await answer.promise, { answers: [{ id: 'choice', selected: ['A'], custom: 'another option' }] });
    await running;
    assert.equal(getEventListeners(signal, 'abort').length, 0);
    assert.equal((await f.request('thoughtdag', 'workspace', 'wa', `/approvals/${form.id}`, 'POST', { answers: [] })).status, 404);
    assert.equal(frames(stream).some(frame => frame.approvalDecided?.outcome === 'answered'), true);
  } finally { await f.dispose(); }
});

test('ThoughtDAG standing tool allowances match exact arguments and remain within one canvas scope', { timeout: 10_000 }, async () => {
  const f = await fixture(), outcomes = [];
  let turn = 0, command = 'pwd';
  f.ctx.promptImplementation = async input => {
    const current = ++turn;
    startTurn(f, input, current);
    for (const [index, description] of ['first wording', 'other wording'].entries()) {
      const callId = `call-${current}-${index}`;
      f.emit('session/event', { id: input.sessionId }, {
        type: 'tool/call', data: { turn: current, callId, name: 'bash', arguments: { command, description } },
      });
      const [result] = f.emit('approval/request', {
        agent: f.ctx.agents.get(input.sessionId), toolName: 'run_code', callId, signal: new AbortController().signal,
      }, () => 'native');
      outcomes.push(await result);
    }
    endTurn(f, input, current);
  };
  try {
    await applyThoughtdag(f.ctx, { whyTools: false, whyPrompt: false });
    const run = async level => {
      const replies = [], asked = [];
      const stream = response(frame => {
        for (const line of frame.split('\n')) if (line.startsWith('data: {')) {
          const payload = JSON.parse(line.slice(6));
          if (payload.approval) {
            asked.push(payload.approval);
            // The host emits the frame immediately before registering its waiter.
            replies.push(Promise.resolve().then(() => f.request('thoughtdag', level, level === 'workspace' ? 'wa' : 'a',
              `/approvals/${payload.approval.id}`, 'POST', { outcome: 'allowed-session' })));
          }
        }
      });
      await f.request('thoughtdag', level, level === 'workspace' ? 'wa' : 'a', '/stream', 'POST', turnBody(), stream);
      assert.equal((await Promise.all(replies)).every(reply => reply.status === 200), true);
      return { asked, stream };
    };
    assert.equal((await run('workspace')).asked.length, 1, 'prose-only argument changes retain the exact step allowance');
    assert.equal((await run('workspace')).asked.length, 0, 'the same live session can reuse its standing allowance');
    command = 'whoami';
    assert.equal((await run('workspace')).asked.length, 1, 'another command needs a new decision');
    command = 'pwd';
    assert.equal((await run('session')).asked.length, 1, 'the same session in a different native tier cannot reuse it');
    f.emit('agent/disposed', { agent: f.agents.get('a') });
    f.agents.delete('a');
    assert.equal((await run('workspace')).asked.length, 1, 'a replacement agent has no prior in-memory allowances');
    assert.equal(outcomes.every(outcome => outcome === 'allowed-once'), true, 'standing decisions are translated to the native one-shot vocabulary');
  } finally { await f.dispose(); }
});

test('ThoughtDAG temporary permission presets start and restore at the owned turn boundaries', { timeout: 10_000 }, async () => {
  const f = await fixture(), policies = [];
  let preset = 'default';
  f.ctx.approval = { setPolicy(_agent, policy) { policies.push(policy); } };
  f.ctx.permissionPresets = {
    names: ['default', 'auto', 'danger-full-access'], current: () => preset,
    apply(_session, name, setPolicy) { preset = name; setPolicy(name); },
  };
  f.ctx.promptImplementation = async input => {
    f.emit('session/event', { id: input.sessionId }, { type: 'turn/start', data: { turn: 99 } });
    assert.deepEqual(policies, [], 'a queued canvas request cannot alter a preceding human turn');
    startTurn(f, input, 100);
    assert.equal(preset, 'danger-full-access');
    endTurn(f, input, 100);
    assert.equal(preset, 'default', 'the preset is restored synchronously before the next user turn');
    f.emit('session/event', { id: input.sessionId }, { type: 'turn/start', data: { turn: 101 } });
    const [native] = f.emit('approval/request', { agent: f.ctx.agents.get(input.sessionId), toolName: 'bash' }, () => 'native');
    assert.equal(await native, 'native', 'a later user turn retains native approval handling');
  };
  try {
    await applyThoughtdag(f.ctx, { whyTools: false, whyPrompt: false });
    assert.deepEqual((await f.request('thoughtdag', 'workspace', 'wa', '/permission-modes')).data, { auto: true, allow: true });
    const stream = response();
    await f.request('thoughtdag', 'workspace', 'wa', '/stream', 'POST', turnBody({ permission: 'allow' }), stream);
    assert.deepEqual(policies, ['danger-full-access', 'default']);
    assert.equal(frames(stream).some(frame => frame.permission?.mode === 'allow' && frame.permission.applied), true);
    assert.deepEqual(f.cancelled, []);
  } finally { await f.dispose(); }
});

test('closing a queued ThoughtDAG request cannot change permissions or cancel a different native turn', { timeout: 10_000 }, async () => {
  const f = await fixture(), entered = deferred(), policies = [];
  f.ctx.approval = { setPolicy(_agent, policy) { policies.push(policy); } };
  f.ctx.permissionPresets = {
    names: ['default', 'danger-full-access'], current: () => 'default',
    apply(_session, name, setPolicy) { setPolicy(name); },
  };
  f.ctx.promptImplementation = async input => {
    f.emit('session/event', { id: input.sessionId }, { type: 'turn/start', data: { turn: 42 } });
    entered.resolve();
  };
  try {
    await applyThoughtdag(f.ctx, { whyTools: false, whyPrompt: false });
    const stream = response();
    const running = f.request('thoughtdag', 'workspace', 'wa', '/stream', 'POST', turnBody({ permission: 'allow' }), stream);
    await entered.promise;
    stream.closeRequest();
    await running;
    assert.deepEqual(policies, []);
    assert.deepEqual(f.cancelled, []);
  } finally { await f.dispose(); }
});

test('ThoughtDAG unload resolves pending forms and removes their abort listeners', { timeout: 10_000 }, async () => {
  const f = await fixture(), question = deferred(), answers = deferred();
  const signal = new AbortController().signal;
  f.ctx.promptImplementation = async input => {
    startTurn(f, input);
    const [result] = f.emit('user-questions/request', {
      agent: f.ctx.agents.get(input.sessionId), signal,
      questions: [{ id: 'q', question: 'Choose', options: [{ label: 'A' }] }],
    }, () => 'native');
    question.resolve();
    answers.resolve(await result);
  };
  try {
    await applyThoughtdag(f.ctx, { whyTools: false, whyPrompt: false });
    const running = f.request('thoughtdag', 'workspace', 'wa', '/stream', 'POST', turnBody());
    await question.promise;
    assert.equal(getEventListeners(signal, 'abort').length, 1);
    await f.unload();
    assert.deepEqual(await answers.promise, { answers: [{ id: 'q', selected: [] }] });
    await running;
    assert.equal(getEventListeners(signal, 'abort').length, 0);
    assert.deepEqual(f.cancelled, ['a'], 'unload can cancel the still-active owned canvas turn');
  } finally { await f.dispose(); }
});

test('ThoughtDAG preserves the original host while scoping models, archives, and new native sessions', { timeout: 10_000 }, async () => {
  const f = await fixture();
  try {
    await applyThoughtdag(f.ctx, { whyTools: false, whyPrompt: false });
    const providers = [{ name: 'Private A', baseURL: 'https://model.invalid/v1', apiKey: 'fake-fixture-only', models: ['custom-a'] }];
    const registered = await f.request('thoughtdag', 'workspace', 'wa', '/runtime-providers', 'POST', { providers });
    assert.equal(registered.data.models.some(model => model.id === 'custom-a'), true);
    const ownModels = await f.request('thoughtdag', 'workspace', 'wa', '/models');
    const siblingModels = await f.request('thoughtdag', 'workspace', 'wb', '/models');
    const sessionModels = await f.request('thoughtdag', 'session', 'a', '/models');
    assert.equal(ownModels.data.models.some(model => model.id === 'custom-a'), true);
    assert.equal(siblingModels.data.models.some(model => model.id === 'custom-a'), false);
    assert.equal(sessionModels.data.models.some(model => model.id === 'custom-a'), false);
    const archive = await f.request('thoughtdag', 'workspace', 'wa', '/disksessions');
    assert.deepEqual(archive.data.sessions.map(row => row.id), ['a']);
    const foreignArchive = await f.request('thoughtdag', 'workspace', 'wa', '/disksessions/b/log');
    assert.equal(foreignArchive.status, 400);

    const question = { model: 'harness/agent', messages: [
      { role: 'system', content: 'canvas role selected by user' },
      { role: 'user', content: 'edited selected branch' },
      { role: 'assistant', content: 'selected branch answer' },
      { role: 'user', content: 'question' },
    ] };
    const freshSession = await f.request('thoughtdag', 'session', 'a', '/claude', 'POST', question);
    assert.equal(freshSession.status, 200);
    assert.equal(freshSession.data.text, 'done');
    assert.deepEqual(f.forked, [], 'fresh compiled context never inherits a source-session prefix');
    assert.deepEqual(f.created, [{ workspaceId: 'wa' }], 'session canvas creates an ordinary native conversation in its source workspace');
    const generatedId = f.prompted[0].sessionId;
    const compiled = f.injected.filter(item => item.id === generatedId);
    assert.equal(compiled.length, 1, 'the actual upstream fresh-session path injects its compiled graph selection');
    const injectedText = compiled[0].message.content.map(block => block.text ?? '').join('\n');
    assert.match(injectedText, /canvas role selected by user/);
    assert.match(injectedText, /edited selected branch/);
    assert.match(injectedText, /selected branch answer/);
    assert.doesNotMatch(injectedText, /question from a|question from b/, 'excluded source history is absent from the fresh model context');
    assert.deepEqual(f.prompted[0].content, [{ type: 'text', text: 'question' }]);
    assert.equal(f.sessions.get(generatedId).header.parentSession, undefined, 'plugin origin does not pretend to be native seed lineage');
    assert.deepEqual(f.sessions.get('a').events.map(item => item.data.content[0].text), ['question from a'],
      'editing and compiling a graph leaves the source log intact');
    const nextArchive = await f.request('thoughtdag', 'session', 'a', '/disksessions');
    assert.equal(nextArchive.data.sessions.some(row => row.id === generatedId), true,
      'the following request recovers generated session membership from persisted plugin origin');
    const siblingArchive = await f.request('thoughtdag', 'session', 'b', '/disksessions');
    assert.equal(siblingArchive.data.sessions.some(row => row.id === generatedId), false);
    const freshWorkspace = await f.request('thoughtdag', 'workspace', 'wa', '/claude', 'POST',
      { ...question, harness: { cwd: 'D:\\foreign' } });
    assert.equal(freshWorkspace.status, 200);
    assert.deepEqual(f.created, [{ workspaceId: 'wa' }, { workspaceId: 'wa' }],
      'workspace canvas creates in the selected native workspace');
    const promptCount = f.prompted.length;
    const foreign = await f.request('thoughtdag', 'workspace', 'wa', '/claude', 'POST',
      { ...question, harness: { session: 'b' } });
    assert.equal(foreign.status, 500);
    assert.equal(f.prompted.length, promptCount, 'foreign native session is rejected before prompting');
    assert.match(foreign.data.detail, /不属于当前图谱范围/);
  } finally {
    await f.dispose();
  }
});

test('Synapse projects unloaded native archives once and resumes live sequence updates', { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nexus-canvas-archive-'));
  const f = await fixture();
  const archived = f.sessions.get('a');
  const originalGet = f.ctx.get;
  let reads = 0;
  f.ctx.get = function (name) {
    const service = originalGet.call(this, name);
    if (name !== 'sessionQuery') return service;
    return { ...service, async readSession(id) {
      reads++;
      return { session: archived.header, events: [...archived.events], inheritedEventCount: 0 };
    } };
  };
  f.sessions.delete('a');
  try {
    await applySynapse(f.ctx, { dataDir: directory });
    const list = await f.request('synapse', 'workspace', 'wa', '/workspaces');
    const graphId = list.data.workspaces[0].id;
    const read = () => f.request('synapse', 'workspace', 'wa', `/workspaces/${graphId}`);
    const first = await read();
    assert.equal(first.data.workspace.threads[0].messages.some(row => row.text === 'question from a'), true);
    await read();
    assert.equal(reads, 1, 'unloaded archives are not rescanned by every projection poll');
    f.sessions.set('a', archived);
    archived.events.push(f.event(1, 'live update after loading archive'));
    const live = await read();
    assert.equal(live.data.workspace.threads[0].messages.some(row => row.text === 'live update after loading archive'), true);
    assert.deepEqual(f.errors, []);
  } finally {
    await f.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('ThoughtDAG approval responses require the exact originating scope', { timeout: 10_000 }, async () => {
  const f = await fixture();
  f.ctx.approvalDuringPrompt = true;
  try {
    await applyThoughtdag(f.ctx, { whyTools: false, whyPrompt: false });
    const approval = deferred();
    const stream = response(frame => {
      for (const line of frame.split('\n')) if (line.startsWith('data: {')) {
        const payload = JSON.parse(line.slice(6));
        if (payload.approval) approval.resolve(payload.approval.id);
      }
    });
    const running = f.request('thoughtdag', 'workspace', 'wa', '/stream', 'POST', {
      model: 'harness/agent', messages: [{ role: 'user', content: 'question' }], harness: { session: 'a' },
    }, stream);
    const id = await approval.promise;
    const sibling = await f.request('thoughtdag', 'workspace', 'wb', `/approvals/${id}`, 'POST', { outcome: 'allowed-once' });
    const otherTier = await f.request('thoughtdag', 'session', 'a', `/approvals/${id}`, 'POST', { outcome: 'allowed-once' });
    assert.equal(sibling.status, 404);
    assert.equal(otherTier.status, 404, 'even the same session in another tier does not own this request');
    const own = await f.request('thoughtdag', 'workspace', 'wa', `/approvals/${id}`, 'POST', { outcome: 'allowed-once' });
    assert.equal(own.status, 200);
    const completed = await running;
    assert.match(completed.text, /"approvalDecided"/);
    assert.match(completed.text, /\[DONE\]/);
    assert.deepEqual(f.cancelled, []);
  } finally {
    await f.dispose();
  }
});
