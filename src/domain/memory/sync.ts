import { memorySettings } from './settings.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NexusError, type DispatchContext, type JsonRecord, type NexusServices } from '../../ports/contracts.js';
import type { MarkdownMemory } from './local.js';
import { assertNoSecret, digest, memoryId, projectId, stableJson, type MemoryRecord } from './types.js';

interface SyncManifest { formatVersion: number; projectId: string; records: MemoryRecord[]; }
interface SyncPlan { id: string; remote: string; branch: string; remoteCommit?: string; projectId: string; baseHash: string; localHash: string; remoteHash: string; local: SyncManifest; remoteManifest: SyncManifest; base: SyncManifest; changes: JsonRecord[]; createdAt: string; }
/** Record-level three-way merge; no last-writer-wins and no host profile copying. */
export class MemorySync {
  private lanes = new Map<string, Promise<unknown>>();
  constructor(private services: NexusServices, private local: MarkdownMemory) {}
  async call(root: string, params: JsonRecord, ctx?: DispatchContext): Promise<unknown> {
    const previous = this.lanes.get(root) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(() => this.execute(root, params, ctx));
    this.lanes.set(root, operation);
    try { return await operation; } finally { if (this.lanes.get(root) === operation) this.lanes.delete(root); }
  }
  private async execute(root: string, params: JsonRecord, ctx?: DispatchContext): Promise<unknown> {
    const project = projectId(root);
    const config = { value: await memorySettings(this.services, root, ctx) };
    if (config?.value.syncEnabled !== true) return { state: 'disabled', gitExecuted: false };
    const remote = String(config.value.syncRemote ?? '');
    if (!remote || remote.startsWith('-') || /[\r\n]/u.test(remote)) throw new NexusError('NOT_CONFIGURED', '需要有效的项目专用记忆同步远端');
    if (/https?:\/\/[^/]*@/iu.test(remote)) throw new NexusError('SECRET_REFERENCE_REQUIRED', '同步URL不可内嵌账号凭据');
    const branch = String(config.value.syncBranch ?? 'nexus-memory');
    if (branch.startsWith('-') || /[\r\n]/u.test(branch)) throw new NexusError('INVALID_BRANCH', '同步分支无效');
    if (!await this.services.host.approve('memory.sync', remote, { projectId: project, mode: params.mode ?? 'preview' })) throw new NexusError('APPROVAL_REQUIRED', '记忆同步需要项目与远端授权');
    const directory = join(this.services.dataDir, 'memory-sync', project);
    await mkdir(directory, { recursive: true });
    const git = async (args: string[], tolerateFailure = false, stdin?: string) => {
      const result = await this.services.executor.run('git', ['-C', directory, ...args], { signal: ctx?.signal, timeoutMs: 60000, maxOutputBytes: 4 * 1024 * 1024, stdin });
      if (result.cancelled) throw new NexusError('CANCELLED', '同步已取消');
      if (result.exitCode !== 0 && !tolerateFailure) throw new NexusError('SYNC_GIT_FAILED', '记忆专用同步Git操作失败', { operation: args[0], exitCode: result.exitCode, diagnostic: result.stderr.slice(0, 1000) });
      return result;
    };
    const empty: SyncManifest = { formatVersion: 1, projectId: project, records: [] };
    if (params.mode !== 'apply') {
      await git(['init', '--quiet']);
      await git(['check-ref-format', '--branch', branch]);
      const localManifest: SyncManifest = { formatVersion: 1, projectId: project, records: (await this.local.list(root, ctx)).items };
      const base = (await this.services.store.get<SyncManifest>('memory-sync-bases', project))?.value ?? empty;
      const fetched = await git(['fetch', '--no-tags', '--depth=1', remote, branch], true);
      let remoteManifest = empty;
      let remoteCommit: string | undefined;
      if (fetched.exitCode === 0) {
        remoteCommit = (await git(['rev-parse', '--verify', 'FETCH_HEAD'])).stdout.trim();
        const show = await git(['show', 'FETCH_HEAD:manifest.json']);
        try { remoteManifest = JSON.parse(show.stdout); } catch { throw new NexusError('SYNC_FORMAT_INVALID', '远端 manifest 不是有效JSON'); }
        if (remoteManifest.formatVersion !== 1 || remoteManifest.projectId !== project || !Array.isArray(remoteManifest.records)) throw new NexusError('SYNC_SCOPE_MISMATCH', '远端格式或项目身份不匹配，需要用户明确登记映射');
        if (remoteManifest.records.length > 100000) throw new NexusError('SYNC_LIMIT', '远端记忆数超出上限');
        assertNoSecret(remoteManifest);
        for (const record of remoteManifest.records) this.local.normalize(record, root, ctx);
      } else if (params.initializeRemote !== true) {
        throw new NexusError('SYNC_FETCH_FAILED', '无法读取远端分支；新仓库可显式 initializeRemote，网络或权限错误不可当空库', { exitCode: fetched.exitCode });
      }
      const localById = new Map(localManifest.records.map(record => [record.id, record]));
      const remoteById = new Map(remoteManifest.records.map(record => [record.id, record]));
      const baseById = new Map(base.records.map(record => [record.id, record]));
      const changes: JsonRecord[] = [];
      for (const id of [...new Set([...localById.keys(), ...remoteById.keys(), ...baseById.keys()])].sort()) {
        const l = localById.get(id), r = remoteById.get(id), b = baseById.get(id);
        const lh = l?.contentHash ?? null, rh = r?.contentHash ?? null, bh = b?.contentHash ?? null;
        if (lh === rh) changes.push({ id, state: 'unchanged', choice: 'local' });
        else if (lh === bh) changes.push({ id, state: r ? 'remote_changed' : 'remote_deleted', choice: 'remote' });
        else if (rh === bh) changes.push({ id, state: l ? 'local_changed' : 'local_deleted', choice: 'local' });
        else changes.push({ id, state: 'conflict', choice: null, local: l ?? null, remote: r ?? null, base: b ?? null });
      }
      const plan: SyncPlan = { id: memoryId('syncplan'), remote, branch, remoteCommit, projectId: project, baseHash: digest(stableJson(base)), localHash: digest(stableJson(localManifest)), remoteHash: digest(stableJson(remoteManifest)), local: localManifest, remoteManifest, base, changes, createdAt: new Date().toISOString() };
      await this.services.store.put('memory-sync-plans', plan.id, plan);
      return { state: 'fetched', preview: true, planId: plan.id, changes, conflicts: changes.filter(change => change.state === 'conflict').length, committed: false };
    }
    const stored = await this.services.store.get<SyncPlan>('memory-sync-plans', String(params.planId ?? ''));
    if (!stored || stored.value.projectId !== project || stored.value.remote !== remote || stored.value.branch !== branch) throw new NexusError('SYNC_PLAN_INVALID', '同步计划不存在或范围已改变');
    const plan = stored.value;
    const applied = await this.services.store.get<JsonRecord>('memory-sync-results', plan.id);
    if (applied) return { ...applied.value, duplicate: true };
    if (Date.now() - Date.parse(plan.createdAt) > 15 * 60 * 1000) throw new NexusError('STALE_PLAN', '同步计划已过期，请重新预览');
    const current: SyncManifest = { formatVersion: 1, projectId: project, records: (await this.local.list(root, ctx)).items };
    if (digest(stableJson(current)) !== plan.localHash) throw new NexusError('REVISION_CONFLICT', '本地记忆已改变，重新生成三方合并计划');
    const resolutions = (params.resolutions ?? {}) as Record<string, { choice: string; record?: JsonRecord }>;
    const localById = new Map(current.records.map(record => [record.id, record]));
    const remoteById = new Map(plan.remoteManifest.records.map(record => [record.id, record]));
    const merged: MemoryRecord[] = [], receipts: unknown[] = [];
    // Validate the entire resolution set before changing the first local source record.
    for (const change of plan.changes) {
      const id = String(change.id), resolution = resolutions[id], choice = resolution?.choice ?? change.choice;
      if (!['local', 'remote', 'merged'].includes(String(choice))) throw new NexusError('SYNC_CONFLICT', '每个冲突都需要明确选择', { recordId: id });
      const selected = choice === 'local' ? localById.get(id) : choice === 'remote' ? remoteById.get(id) : resolution?.record;
      if (choice === 'merged' && !selected) throw new NexusError('SYNC_CONFLICT', '合并选择需要完整记录', { recordId: id });
      if (selected) this.local.normalize({ ...selected, id } as JsonRecord, root, ctx, localById.get(id));
    }
    const remoteProbe = await git(['ls-remote', '--exit-code', remote, `refs/heads/${branch}`], true);
    const currentRemoteCommit = remoteProbe.exitCode === 0 ? remoteProbe.stdout.split(/\s+/u)[0] : undefined;
    if (remoteProbe.exitCode !== 0 && remoteProbe.exitCode !== 2) throw new NexusError('SYNC_FETCH_FAILED', '应用前无法确认远端版本');
    if (currentRemoteCommit !== plan.remoteCommit) throw new NexusError('REMOTE_CHANGED', '远端已改变，请重新预览合并');
    for (const change of plan.changes) {
      const id = String(change.id);
      const resolution = resolutions[id];
      const choice = resolution?.choice ?? change.choice;
      if (!['local', 'remote', 'merged'].includes(String(choice))) throw new NexusError('SYNC_CONFLICT', '每个冲突都需要明确选择', { recordId: id });
      let selected = choice === 'local' ? localById.get(id) : choice === 'remote' ? remoteById.get(id) : resolution?.record as MemoryRecord | undefined;
      const localRecord = localById.get(id);
      if (!selected && localRecord) selected = { ...localRecord, lifecycle: 'tombstoned' };
      if (!selected) continue;
      if (choice !== 'local' || selected.lifecycle !== localRecord?.lifecycle) {
        const data = { ...selected, id };
        receipts.push(await this.local.save(data as unknown as JsonRecord, root, ctx, localRecord?.revision));
      }
      // Read actual persisted record after semantic revision assignment.
      merged.push(await this.local.read(id, root, ctx));
    }
    const manifest: SyncManifest = { formatVersion: 1, projectId: project, records: merged.sort((a, b) => a.id.localeCompare(b.id)) };
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
    await git(['add', '--', 'manifest.json']);
    const tree = (await git(['write-tree'])).stdout.trim();
    const oldHead = await git(['rev-parse', '--verify', 'HEAD'], true);
    const parents = [...new Set([oldHead.exitCode === 0 ? oldHead.stdout.trim() : undefined, plan.remoteCommit].filter((value): value is string => Boolean(value)))];
    const commit = (await git(['-c', 'user.name=DSH Nexus', '-c', 'user.email=nexus@local.invalid', 'commit-tree', tree, ...parents.flatMap(parent => ['-p', parent])], false, `Nexus memory merge ${plan.id}\n`)).stdout.trim();
    await git(['update-ref', 'HEAD', commit, oldHead.exitCode === 0 ? oldHead.stdout.trim() : '0000000000000000000000000000000000000000']);
    await this.services.store.put('memory-sync-bases', project, manifest);
    if (params.push === true) {
      await git(['push', remote, `HEAD:refs/heads/${branch}`]);
      const result = { state: 'pushed', committed: true, receipts, contentHash: digest(stableJson(manifest)), commit };
      await this.services.store.put('memory-sync-results', plan.id, result);
      return result;
    }
    const result = { state: 'merged', committed: true, pushed: false, receipts, contentHash: digest(stableJson(manifest)), commit };
    await this.services.store.put('memory-sync-results', plan.id, result);
    return result;
  }
}
