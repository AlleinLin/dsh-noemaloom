import test from 'node:test';
import assert from 'node:assert/strict';
import { installExecutionPolicy } from '../src/host/execution-policy.js';

test('read-only child rejects raw shell, Nexus mutations and delegation using the actual tool guard', () => {
  let guard: (execution: any) => string | undefined = () => undefined;
  const tools = { guard(callback: typeof guard) { guard = callback; return () => {}; } };
  const ctx: any = { get: () => tools, on: () => () => {} };
  const policies = new Map([['child', { readOnly: true, allowChildren: false }]]);
  const dispose = installExecutionPolicy(ctx, policies, domain => domain === 'memory' ? [
    { action: 'search', description: 'read' }, { action: 'save', description: 'write', mutating: true },
  ] : []);
  const call = (name: string, action?: string) => guard({ agent: { id: 'child' }, name, arguments: { action } });
  assert.match(call('bash')!, /read-only/);
  assert.match(call('nexus_memory', 'save')!, /read-only/);
  assert.match(call('subagent')!, /delegation/);
  assert.equal(call('read_file'), undefined);
  assert.equal(call('nexus_memory', 'search'), undefined);
  dispose();
});
test('persistent agent execution grant applies without a transient child map and cannot widen capability access', () => {
  let guard: (execution: any) => string | undefined = () => undefined;
  const ctx: any = { get: () => ({ guard(callback: typeof guard) { guard = callback; return () => {}; } }), on: () => () => {} };
  installExecutionPolicy(ctx, new Map(), () => [{ action: 'search', description: 'read' }, { action: 'read', description: 'read' }]);
  const agent = { id: 'persistent', ctx: { get: () => ({ allowedCapabilityIds: ['memory.search'], allowChildren: false }) } };
  assert.equal(guard({ agent, name: 'nexus_memory', arguments: { action: 'search' } }), undefined);
  assert.match(guard({ agent, name: 'nexus_memory', arguments: { action: 'read' } })!, /outside/);
  assert.match(guard({ agent, name: 'nexus_agents', arguments: { action: 'session/spawn' } })!, /delegation/);
});
