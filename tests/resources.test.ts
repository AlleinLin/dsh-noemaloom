import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { zipSync, strToU8 } from 'fflate';
import { createResourcesModule, resourceValidation } from '../src/domain/resources/index.js';
import { createFilesModule } from '../src/domain/files/index.js';
import { parseSkillContent } from '../src/domain/resources/skills.js';
import { bundledSkinCatalog } from '../src/domain/resources/market-catalog.js';
import { resourceHostAction } from '../src/host/resource-services.js';
import type { HostContext } from '../src/host/types.js';
import { NexusError, type JsonRecord, type NexusServices, type NexusStore, type StoredRecord, type DispatchContext } from '../src/ports/contracts.js';

class ResourceTestStore implements NexusStore {
  rows = new Map<string, StoredRecord>();
  async get<T>(collection: string, id: string): Promise<StoredRecord<T> | undefined> {
    return this.rows.get(`${collection}:${id}`) as StoredRecord<T> | undefined;
  }
  async put<T>(collection: string, id: string, value: T, expectedRevision?: number): Promise<StoredRecord<T>> {
    const key = `${collection}:${id}`, prior = this.rows.get(key);
    if (expectedRevision !== undefined && expectedRevision !== (prior?.revision ?? 0)) throw new NexusError('REVISION_CONFLICT', 'stale revision');
    const next = { id, value: JSON.parse(JSON.stringify(value)) as T, revision: (prior?.revision ?? 0) + 1, updatedAt: new Date().toISOString() };
    this.rows.set(key, next);
    return next;
  }
  async list<T>(collection: string): Promise<StoredRecord<T>[]> {
    return [...this.rows.entries()].filter(([key]) => key.startsWith(`${collection}:`)).map(([, value]) => value as StoredRecord<T>);
  }
  async remove(collection: string, id: string, expectedRevision?: number) {
    const prior = await this.get(collection, id);
    if (expectedRevision !== undefined && prior?.revision !== expectedRevision) throw new NexusError('REVISION_CONFLICT', 'stale revision');
    return this.rows.delete(`${collection}:${id}`);
  }
}

async function fixture(t: { after(callback: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'nexus-resources-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceRoot = join(root, 'project'), dataDir = join(root, 'data'), user = join(root, 'user');
  await Promise.all([mkdir(workspaceRoot), mkdir(dataDir), mkdir(user)]);
  const events: Array<{ event: string; data: unknown }> = [];
  let files: ReturnType<typeof createFilesModule>, resources: ReturnType<typeof createResourcesModule>;
  const services: NexusServices = {
    store: new ResourceTestStore(), dataDir, workspaceRoot, packageRoot: root,
    emit(event, data) { events.push({ event, data }); },
    executor: { async run() { throw new Error('resource actions must not execute processes'); } },
    host: {
      async facts() { return { dshHome: join(user, '.dsh'), agentsHome: join(user, '.agents') }; },
      async sessions(action) {
        if (action === 'skills.list') return [];
        throw new NexusError('HOST_CONTRACT_UNSUPPORTED', action);
      },
      async model() { throw new Error('resource actions must not call models'); },
      async spawn() { throw new Error('resource actions must not spawn agents'); },
      async secret() { throw new Error('resource actions must not request secrets'); },
      async approve() { return true; },
    },
    async invoke(domain, request, context) {
      if (domain === 'files') return files.dispatch(request, context);
      if (domain === 'resources') return resources.dispatch(request, context);
      if (domain === 'agents' || domain === 'presets') return { items: [] };
      throw new NexusError('NOT_FOUND', domain);
    },
  };
  files = createFilesModule(services); resources = createResourcesModule(services);
  const context: DispatchContext = { workspaceRoot, actorId: 'resource-test-owner', permissions: new Set(['resources.skills.create', 'resources.skills.import', 'resources.themes.apply']) };
  const call = (action: string, params: JsonRecord = {}, expectedRevision?: number) => resources.dispatch({ action, params, requestId: randomUUID(), expectedRevision }, context) as Promise<any>;
  return { root, workspaceRoot, dataDir, services, context, resources, files, events, call };
}

const skill = (name: string, description: string, body = 'Read [guide](references/guide.md).') =>
  `---\nname: ${name}\ndescription: ${description}\nlicense: MIT\nunknown-extension:\n  keep: exact\n---\n${body}\n`;

test('skill discovery keeps same-name sources, chooses official priority, and CAS protects an external edit', async t => {
  const f = await fixture(t);
  await Promise.all([
    mkdir(join(f.workspaceRoot, '.dsh', 'skills', 'same'), { recursive: true }),
    mkdir(join(f.workspaceRoot, '.agents', 'skills', 'same'), { recursive: true }),
  ]);
  const projectPath = join(f.workspaceRoot, '.dsh', 'skills', 'same', 'SKILL.md');
  await writeFile(projectPath, skill('same', 'Project winner'));
  await writeFile(join(f.workspaceRoot, '.agents', 'skills', 'same', 'SKILL.md'), skill('same', 'Agents shadow'));
  const result = await f.call('skills.list');
  assert.equal(result.items.length, 2);
  const winner = result.items.find((item: any) => item.source === 'project-dsh');
  const shadow = result.items.find((item: any) => item.source === 'project-agents');
  assert.equal(winner.effective, true);
  assert.equal(shadow.effective, false);
  assert.equal(shadow.shadowedBy, winner.id);
  assert.equal('body' in winner, false, 'listing is metadata only');
  const detail = await f.call('skills.get', { id: winner.id });
  assert.equal(detail.metadata['unknown-extension'].keep, 'exact');
  await writeFile(projectPath, skill('same', 'External edit'));
  await assert.rejects(f.call('skills.edit', { id: winner.id, expectedHash: detail.hash, description: 'Overwritten' }), /文件已变化|变化|revision/i);
  assert.match(await readFile(projectPath, 'utf8'), /External edit/);
  const fresh = await f.call('skills.get', { id: winner.id });
  await f.call('skills.edit', { id: winner.id, expectedHash: fresh.hash, description: 'Saved description', body: 'Updated body.' });
  const saved = parseSkillContent(await readFile(projectPath, 'utf8'));
  assert.equal(saved.metadata.description, 'Saved description');
  assert.equal((saved.metadata['unknown-extension'] as JsonRecord).keep, 'exact');
  assert.equal(saved.metadata.name, 'same');
  assert.equal(saved.body, 'Updated body.');
  assert.ok(f.events.some(item => item.event === 'resources.skills.changed'));
});

test('skill directory links and linked discovery roots remain read-only even for targets inside the workspace', async t => {
  const f = await fixture(t);
  const target = join(f.workspaceRoot, 'actual-skills');
  await mkdir(join(target, 'linked'), { recursive: true });
  await writeFile(join(target, 'linked', 'SKILL.md'), skill('linked', 'Linked target'));
  const projectSkills = join(f.workspaceRoot, '.dsh', 'skills');
  await mkdir(projectSkills, { recursive: true });
  await symlink(join(target, 'linked'), join(projectSkills, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await mkdir(join(f.workspaceRoot, '.agents'));
  await symlink(target, join(f.workspaceRoot, '.agents', 'skills'), process.platform === 'win32' ? 'junction' : 'dir');
  const items = (await f.call('skills.list')).items;
  assert.equal(items.length, 2);
  for (const item of items) {
    assert.equal(item.editable, false, item.source);
    assert.ok(item.warnings.some((warning: string) => warning.includes('链接')));
    await assert.rejects(f.call('skills.disable', { id: item.id }), (error: unknown) => (error as NexusError).code === 'PERMISSION_DENIED');
  }
  assert.equal(await readFile(join(target, 'linked', 'SKILL.md'), 'utf8'), skill('linked', 'Linked target'));
});

test('skill toggles preserve body, user invocation, unknown frontmatter and read-only registry ownership', async t => {
  const f = await fixture(t);
  await f.call('skills.create', { name: 'toggle-me', description: 'toggle', body: 'Keep this body', metadata: { 'user-invocable': false, extra: { nested: 3 } } });
  const listed = await f.call('skills.list');
  const current = listed.items[0];
  await f.call('skills.disable', { id: current.id });
  const detail = await f.call('skills.get', { id: current.id });
  assert.equal(detail.metadata['disable-model-invocation'], true);
  assert.equal(detail.metadata['user-invocable'], false);
  assert.equal(detail.metadata.extra.nested, 3);
  assert.equal(detail.body, 'Keep this body');
  await assert.rejects(f.call('skills.write', { id: current.id, expectedHash: detail.hash, content: detail.content.replace('name: toggle-me', 'name: renamed') }), /技能名|状态/);
  f.services.host.sessions = async action => {
    if (action === 'skills.list') return [{ name: 'system-only', description: 'host provider', provider: 'system', source: 'bundled' }];
    if (action === 'skills.get') return { body: 'Read-only provider text' };
    throw new NexusError('HOST_CONTRACT_UNSUPPORTED', action);
  };
  const registry = (await f.call('skills.list')).items.find((item: any) => item.name === 'system-only');
  assert.equal(registry.fileState, 'virtual');
  assert.equal(registry.editable, false);
  await assert.rejects(f.call('skills.disable', { id: registry.id }), /只读/);
});

test('ZIP import previews first, commits attached resources atomically, and never overwrites', async t => {
  const f = await fixture(t);
  const bytes = zipSync({
    'pack/SKILL.md': strToU8(skill('zip-skill', 'imported')),
    'pack/references/guide.md': strToU8('Actual supporting content.'),
    'pack/scripts/check.ps1': strToU8('Write-Output "inert asset"'),
  });
  const zipBase64 = Buffer.from(bytes).toString('base64');
  const preview = await f.call('skills.import', { zipBase64 });
  assert.equal(preview.effect, 'preview');
  assert.equal(preview.items[0].files, 3);
  await assert.rejects(readFile(join(f.workspaceRoot, '.dsh', 'skills', 'zip-skill', 'SKILL.md')), /ENOENT/);
  const result = await f.call('skills.import', { zipBase64, dryRun: false });
  assert.equal(result.items[0].status, 'imported');
  const target = join(f.workspaceRoot, '.dsh', 'skills', 'zip-skill');
  assert.equal(await readFile(join(target, 'references', 'guide.md'), 'utf8'), 'Actual supporting content.');
  const provenance = await f.services.store.list<JsonRecord>('resourceImports');
  assert.equal(provenance.length, 1);
  assert.match(String((provenance[0].value.files as JsonRecord)['scripts/check.ps1']), /^[a-f0-9]{64}$/);
  const again = await f.call('skills.import', { zipBase64, dryRun: false });
  assert.equal(again.items[0].status, 'skipped');
  assert.equal((await readdir(join(f.workspaceRoot, '.dsh', 'skills'))).some(name => name.startsWith('.nexus-import-')), false);
  const traversal = Buffer.from(zipSync({ '../escape/SKILL.md': strToU8(skill('escape', 'bad')) })).toString('base64');
  await assert.rejects(f.call('skills.import', { zipBase64: traversal, dryRun: false }), /路径不安全/);
  assert.equal(await readFile(join(target, 'references', 'guide.md'), 'utf8'), 'Actual supporting content.');
});

test('appearance preview is independent; apply uses CAS, rejects executable CSS and reverts selected appearance only', async t => {
  const f = await fixture(t);
  const before = await f.call('themes.config');
  assert.equal(before.glass, false);
  assert.equal(before.petEnabled, false);
  const preview = await f.call('themes.preview', { config: { mode: 'dark', tokens: { accent: '#ca7654' }, fontSize: 16 } });
  assert.match(preview.css, /^\.nexus-shell\{/);
  assert.equal((await f.call('themes.config')).mode, 'host');
  const applied = await f.call('themes.apply', { previewId: preview.previewId }, before.revision);
  assert.equal(applied.mode, 'dark');
  assert.equal(applied.tokens['--nexus-accent'], '#ca7654');
  await assert.rejects(f.call('themes.apply', { config: { mode: 'light' } }, before.revision), /修订号/);
  await assert.rejects(f.call('themes.preview', { config: { tokens: { accent: 'url(https://example.com/beacon)' } } }), /安全值/);
  await assert.rejects(f.call('themes.preview', { config: { tokens: { accent: 'red;}body{display:none' } } }), /安全值/);
  const restored = await f.call('themes.revert', {}, applied.revision);
  assert.equal(restored.mode, 'host');
  assert.equal((await f.services.store.list('resources')).length, 0);
});

test('catalog validation retains full bundled K catalog and unknown metrics; rejects traversal and unpinned metadata', () => {
  const catalog = resourceValidation.normalizeK(bundledSkinCatalog, 'bundled');
  assert.equal(catalog.items.length, bundledSkinCatalog.skins.length);
  assert.ok(catalog.items.length > 10);
  assert.ok(catalog.items.every(item => typeof item.name === 'string' && item.pinnedRevision && item.catalogSource === 'bundled'));
  const entry = resourceValidation.normalizeW({ generated: '2026-10-18', items: [{ id: 'safe', name: 'Safe asset', files: ['skin.json'], version: '1.0' }] }, 'skin', 'bundled').items[0];
  assert.deepEqual(entry.statistics, { downloads: null, installs: null, likes: null });
  assert.throws(() => resourceValidation.normalizeW({ items: [{ id: 'safe', files: ['../outside'] }] }, 'skin', 'remote'), /路径不安全/);
  assert.throws(() => resourceValidation.normalizeW({ items: [{ id: 'safe', files: ['A.txt', 'a.txt'] }] }, 'skin', 'remote'), /重复|冲突/);
  const invalid = JSON.parse(JSON.stringify(bundledSkinCatalog));
  invalid.skins[0].install.commit = 'main';
  assert.throws(() => resourceValidation.normalizeK(invalid, 'remote'), /固定版本/);
});

test('theme adaptation selects color scheme and namespaces all variable dependencies without retaining CSS rules', () => {
  const source = ':root{--dsw-alias-brand-primary:#123456;--dsw-alias-brand-text:#111111;--custom:blue;--nexus-bg:var(--custom)} [data-theme="dark"]{--dsw-alias-brand-text:#eeeeee} body{background:url(https://example.com/track)}';
  const light = resourceValidation.stylesheetTokens(source, 'light');
  const dark = resourceValidation.stylesheetTokens(source, 'dark');
  assert.equal(light['--nexus-theme-dsw-alias-brand-text'], '#111111');
  assert.equal(dark['--nexus-theme-dsw-alias-brand-text'], '#eeeeee');
  assert.equal(light['--nexus-theme-nexus-bg'], 'var(--nexus-theme-custom)');
  assert.equal(light['--nexus-accent'], 'var(--nexus-theme-dsw-alias-brand-primary)');
  assert.ok(!JSON.stringify(light).includes('example.com'));
});

test('official settings bridge always requests redaction and supplies the caller CAS without replacing omitted secrets', async () => {
  let revision = 4;
  const calls: unknown[][] = [];
  const settings = {
    writable: true, documentPath: 'private-local-path',
    describe(options: unknown) { calls.push(['describe', options]); return [{ ns: 'nexus', revision, value: { language: 'zh' }, secrets: [{ path: ['apiKey'], set: true }] }]; },
    async update(ns: string, patch: JsonRecord, expected: number) {
      calls.push(['update', ns, patch, expected]);
      assert.equal(expected, revision);
      revision++;
    },
  };
  const context = { get(name: string) { return name === 'settings' ? settings : undefined; } } as HostContext;
  const read = await resourceHostAction(context, 'settings.describe', {});
  assert.equal((read.result as any).hasDocument, true);
  assert.equal('documentPath' in (read.result as JsonRecord), false);
  await assert.rejects(resourceHostAction(context, 'settings.update', { ns: 'nexus', patch: { language: 'en' } }), /expectedRevision/);
  const result = await resourceHostAction(context, 'settings.update', { ns: 'nexus', patch: { language: 'en' }, expectedRevision: 4 });
  assert.equal((result.result as any).descriptor.revision, 5);
  assert.deepEqual(calls.find(call => call[0] === 'update'), ['update', 'nexus', { language: 'en' }, 4]);
  assert.ok(calls.filter(call => call[0] === 'describe').every(call => (call[1] as JsonRecord).redactSecrets === true));
  assert.deepEqual(await resourceHostAction(context, 'models.list', {}), { handled: false });
});

test('custom media import preserves disabled defaults, verifies bytes, and enables only on explicit command', async t => {
  const f = await fixture(t);
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
  const preview = await f.call('asset.import', { kind: 'pet', base64: png, filename: 'custom.png' });
  assert.equal(preview.effect, 'preview');
  assert.equal((await f.services.store.list('resources')).length, 0);
  const imported = await f.call('asset.import', { kind: 'pet', base64: png, filename: 'custom.png', dryRun: false });
  assert.equal(imported.enabled, false);
  assert.equal((await f.call('themes.config')).petEnabled, false);
  const media = await f.call('asset.read', { id: imported.id, path: imported.media.path });
  assert.equal(media.base64, png);
  await f.call('enable', { id: imported.id }, imported.revision);
  const after = await f.call('themes.config');
  assert.equal(after.petEnabled, true);
  assert.equal(after.petId, imported.id);
  await assert.rejects(f.call('asset.import', { kind: 'pet', base64: Buffer.from('<svg/>').toString('base64'), filename: 'spoof.png', dryRun: false }), /文件头/);
  await assert.rejects(f.call('asset.import', { kind: 'pet', base64: png, filename: 'custom.png', dryRun: false }), /已存在/);
});
