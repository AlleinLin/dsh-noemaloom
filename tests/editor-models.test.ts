import test from 'node:test';
import assert from 'node:assert/strict';
import { retainModel, releaseModel, flushDraft, saveModel, adoptDiskBase, disposeModels } from '../src/client/editor/models.js';
function harness() {
  const disk = new Map<string, { content: string; hash: string }>(), drafts = new Map<string, any>(), models: any[] = [];
  const api: any = {
    async call(domain: string, action: string, params: any) {
      const value = disk.get(params.path) ?? { content: 'disk', hash: 'a'.repeat(64) };
      if (domain === 'files' && action === 'read') return { ...value, encoding: 'utf8' };
      if (domain === 'files' && action === 'write') {
        if (params.expectedHash !== value.hash) throw new Error('REVISION_CONFLICT');
        const saved = { content: params.content, hash: 'b'.repeat(64) }; disk.set(params.path, saved); return saved;
      }
      if (action === 'draft.get') return { workspace: 'workspace-one', file: params.path, draftRevision: drafts.get(params.path)?.revision ?? 0, draft: drafts.get(params.path) ?? null };
      if (action === 'draft.put') { const value = { ...params, revision: (drafts.get(params.path)?.revision ?? 0) + 1 }; drafts.set(params.path, value); return value; }
      if (action === 'draft.remove') { drafts.delete(params.path); return { revision: 0 }; }
      throw new Error('Unexpected model API action');
    },
  };
  const monaco: any = { Uri: { parse: (value: string) => value }, editor: { createModel(value: string) {
    const listeners = new Set<() => void>();
    const model = {
      value, disposed: false, getValue() { return this.value; }, getValueLength() { return this.value.length; }, getLanguageId() { return 'typescript'; },
      setValue(value: string) { this.value = value; for (const listener of listeners) listener(); },
      onDidChangeContent(listener: () => void) { listeners.add(listener); return { dispose() { listeners.delete(listener); } }; },
      dispose() { this.disposed = true; listeners.clear(); },
    };
    models.push(model); return model;
  } } };
  return { api, monaco, disk, drafts, models };
}
test('split tabs and different sessions share one workspace model and retained dirty draft', async () => {
  const fake = harness();
  try {
    const first = await retainModel(fake.monaco, fake.api, { level: 'session', sessionId: 'a' }, 'shared.ts');
    const second = await retainModel(fake.monaco, fake.api, { level: 'session', sessionId: 'b' }, 'shared.ts');
    assert.equal(first, second); assert.equal(fake.models.length, 1);
    first.model.setValue('unsaved edit');
    releaseModel(first, 'tab-a', null); releaseModel(second, 'tab-b', null);
    await flushDraft(first);
    assert.equal(fake.drafts.get('shared.ts').content, 'unsaved edit');
    assert.equal(fake.models[0].disposed, false);
    const reopened = await retainModel(fake.monaco, fake.api, { level: 'session', sessionId: 'a' }, 'shared.ts');
    assert.equal(reopened.model.getValue(), 'unsaved edit');
  } finally { await disposeModels(); }
});
test('CAS conflicts preserve dirty content and successful saves keep the committed hash', async () => {
  const fake = harness();
  try {
    const record = await retainModel(fake.monaco, fake.api, { level: 'session', sessionId: 'a' }, 'conflict.ts');
    record.model.setValue('candidate');
    fake.disk.set('conflict.ts', { content: 'external edit', hash: 'c'.repeat(64) });
    await assert.rejects(saveModel(record), /REVISION_CONFLICT/);
    assert.equal(record.model.getValue(), 'candidate'); assert.equal(record.dirty, true); assert.equal(record.hash, 'a'.repeat(64));
    fake.disk.set('conflict.ts', { content: 'disk', hash: 'a'.repeat(64) });
    await saveModel(record);
    assert.equal(record.hash, 'b'.repeat(64)); assert.equal(record.dirty, false);
  } finally { await disposeModels(); }
});
test('recovery against a changed disk requires explicitly adopting the reviewed disk base', async () => {
  const fake = harness();
  fake.drafts.set('recovered.ts', { content: 'recovered candidate', baseHash: 'c'.repeat(64), revision: 2 });
  try {
    const record = await retainModel(fake.monaco, fake.api, { level: 'session', sessionId: 'a' }, 'recovered.ts');
    assert.equal(record.recoveryConflict, true);
    await assert.rejects(saveModel(record), /先对比/);
    assert.equal(fake.disk.has('recovered.ts'), false);
    await adoptDiskBase(record); await saveModel(record);
    assert.equal(fake.disk.get('recovered.ts')?.content, 'recovered candidate');
  } finally { await disposeModels(); }
});
test('clean LRU disposes old models while dirty models stay recoverable', async () => {
  const fake = harness();
  try {
    const dirty = await retainModel(fake.monaco, fake.api, { level: 'session', sessionId: 'a' }, 'dirty.ts');
    dirty.model.setValue('recover me'); releaseModel(dirty, 'dirty-tab', null); await flushDraft(dirty);
    for (let index = 0; index < 24; index++) {
      const record = await retainModel(fake.monaco, fake.api, { level: 'session', sessionId: 'a' }, `clean-${index}.ts`);
      releaseModel(record, `tab-${index}`, null);
    }
    assert.equal(fake.models[0].disposed, false);
    assert(fake.models.filter(model => !model.disposed).length <= 17);
  } finally { await disposeModels(); }
});
test('unloading while file RPC is pending cannot create an orphan Monaco model', async () => {
  const fake = harness(), call = fake.api.call;
  let finish!: (value: any) => void, started!: () => void;
  const reading = new Promise<void>(resolve => { started = resolve; });
  const disk = new Promise(resolve => { finish = resolve; });
  fake.api.call = (domain: string, action: string, params: any) => {
    if (domain === 'files' && action === 'read') { started(); return disk; }
    return call(domain, action, params);
  };
  const retained = retainModel(fake.monaco, fake.api, { level: 'session', sessionId: 'a' }, 'late.ts');
  await reading; await disposeModels();
  finish({ content: 'disk', hash: 'a'.repeat(64), encoding: 'utf8' });
  await assert.rejects(retained, /卸载/);
  assert.equal(fake.models.length, 0);
});
test('browser recovery enforces the draft limit in UTF-8 bytes', async () => {
  const fake = harness(), descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const saved = new Map<string, string>([['nexus-editor-draft:workspace-one:multibyte.ts',
    JSON.stringify({ content: '字'.repeat(200000), baseHash: 'a'.repeat(64), at: Date.now() })]]);
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value), removeItem: (key: string) => saved.delete(key),
  } });
  try {
    const record = await retainModel(fake.monaco, fake.api, { level: 'session', sessionId: 'a' }, 'multibyte.ts');
    assert.equal(record.model.getValue(), 'disk'); assert.equal(record.dirty, false);
  } finally {
    await disposeModels();
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else delete (globalThis as any).localStorage;
  }
});
test('a delayed host draft timestamp cannot discard a newer unsaved browser candidate', async () => {
  const fake = harness(), descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  fake.drafts.set('queued.ts', { content: 'older queued edit', baseHash: 'a'.repeat(64), revision: 3, updatedAt: new Date(Date.now() + 1000).toISOString() });
  const saved = new Map<string, string>([['nexus-editor-draft:workspace-one:queued.ts',
    JSON.stringify({ content: 'later browser edit', baseHash: 'a'.repeat(64), at: Date.now() })]]);
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value), removeItem: (key: string) => saved.delete(key),
  } });
  try {
    const record = await retainModel(fake.monaco, fake.api, { level: 'session', sessionId: 'a' }, 'queued.ts');
    assert.equal(record.model.getValue(), 'later browser edit');
    assert.equal(record.recoveryConflict, true); assert.equal(record.durable, false);
  } finally {
    await disposeModels();
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else delete (globalThis as any).localStorage;
  }
});
