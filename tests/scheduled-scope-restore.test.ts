import test from 'node:test';
import assert from 'node:assert/strict';
import { workspaceModules, workspaceStore } from '../src/domain/workspace-runtime.js';
import { createWorkflowModule } from '../src/domain/workflow/index.js';
import { stepProgressServices } from './step-progress-fixture.js';

test('session delayed work restores at composition without opening its scope and keeps sibling scopes isolated', async () => {
  const f = stepProgressServices(), deliveries: any[] = [];
  f.services.dataDir = process.cwd();
  f.services.host = { async sessions(action: string, params: Record<string, unknown>) {
    deliveries.push({ action, params }); return { accepted: true, durable: true };
  } } as any;
  let modules = await workspaceModules(f.services, [createWorkflowModule]);
  const context = { scopeLevel: 'session' as const, sessionId: 'released-child', workspaceRoot: process.cwd() };
  const row: any = await modules[0].dispatch({ action: 'prompt/schedule',
    params: { text: 'survive host restart', delayMinutes: 60 } }, context);
  await modules[0].dispose?.();
  const store = workspaceStore(f.store, process.cwd(), context.sessionId);
  const saved: any = await store.get('workflow-injections', row.id);
  await store.put('workflow-injections', row.id, { ...saved.value, dueAt: new Date(Date.now() - 1).toISOString() }, saved.revision);
  assert.equal((await workspaceStore(f.store, process.cwd(), 'sibling').list('workflow-injections')).length, 0);
  modules = await workspaceModules(f.services, [createWorkflowModule]);
  try {
    // No session dispatch here: startup itself must rebuild the timer.
    for (let i = 0; i < 100 && deliveries.length === 0; i++) await new Promise(done => setTimeout(done, 10));
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].action, 'scheduled.prompt');
    assert.equal(deliveries[0].params.sessionId, context.sessionId);
    assert.equal(deliveries[0].params.requestId, row.id);
  } finally { await modules[0].dispose?.(); }
});
