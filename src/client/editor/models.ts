import type * as Monaco from 'monaco-editor';
import type { NexusApi, NexusScope } from '../types.js';

export interface EditorRecord {
  key: string; path: string; model: Monaco.editor.ITextModel; base: string; hash: string; encoding: string;
  dirty: boolean; refs: number; lastUsed: number; draftRevision: number; recoveryConflict: boolean;
  saving?: Promise<void>; timer?: ReturnType<typeof setTimeout>; draftSerial: Promise<unknown>;
  views: Map<string, Monaco.editor.ICodeEditorViewState>; listeners: Set<() => void>; error?: string; durable: boolean;
  api: NexusApi; scope: NexusScope;
  allowedValue: string; changing?: boolean;
  retired?: boolean;
}
const records = new Map<string, EditorRecord>();
const pending = new Map<string, Promise<EditorRecord>>();
let epoch = 0;
export function language(path: string) {
  const suffix = path.split('.').pop()?.toLowerCase() ?? '';
  const languages: Record<string, string> = { ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    py: 'python', cs: 'csharp', rs: 'rust', h: 'c', cpp: 'cpp', hpp: 'cpp', yml: 'yaml', md: 'markdown', mdx: 'markdown', jsonc: 'json', sh: 'shell', ps1: 'powershell', cfg: 'ini' };
  return languages[suffix] ?? suffix;
}
export async function retainModel(monaco: typeof Monaco, api: NexusApi, scope: NexusScope, path: string) {
  const generation = epoch;
  // Host returns canonical identity. Session IDs never cause the same workspace file to fork its draft.
  const identity = await api.call<any>('debug', 'draft.get', { path }, { scope });
  const disk = await api.call<any>('files', 'read', { path, maxBytes: 8 * 1024 * 1024 }, { scope });
  if (generation !== epoch) throw new Error('编辑器已卸载');
  if (disk.binary || disk.truncated || typeof disk.content !== 'string') throw new Error('此文件需要外部编辑器（仅支持完整文本，最大8 MiB）');
  // A scoped workspace identifier is supplied by debug draft.get, never inferred from an arbitrary UI address.
  const key = `${identity.workspace}:${identity.file}`;
  let record = records.get(key);
  if (!record) {
    let loading = pending.get(key);
    if (!loading) {
      loading = Promise.resolve().then(() => {
        if (generation !== epoch) throw new Error('编辑器已卸载');
        const draft = identity.draft, recovery = readRecovery(key);
        // A server completion timestamp can be newer than a later edit waiting in its queue.
        // Retain the browser's unsaved candidate and surface disagreement instead of dropping it.
        const candidate = recovery ?? draft;
        const base = disk.content, value = candidate?.content ?? base;
        const weight = [...records.values()].reduce((sum, record) => sum + record.model.getValueLength() * 2, 0);
        if (records.size >= 48 || weight + value.length * 2 > 64 * 1024 * 1024) throw new Error('编辑器内存已达上限；请保存并关闭其他文件后重试');
        const created: EditorRecord = { key, path: identity.file, model: monaco.editor.createModel(value, language(path), monaco.Uri.parse(`nexus-editor://model/${encodeURIComponent(key)}`)),
          base, hash: disk.hash, encoding: disk.encoding, dirty: value !== base, refs: 0, lastUsed: Date.now(),
          draftRevision: identity.draftRevision ?? draft?.revision ?? 0, recoveryConflict: Boolean(candidate && candidate.baseHash !== disk.hash || recovery && draft && recovery.content !== draft.content),
          draftSerial: Promise.resolve(), views: new Map(), listeners: new Set(), durable: Boolean(draft && draft.content === value), api, scope, allowedValue: value,
          error: recovery && draft && recovery.content !== draft.content ? '本地恢复内容与宿主草稿不同；已保留本地内容，请对比后确认保存。' : undefined };
        records.set(key, created);
        created.model.onDidChangeContent(() => {
          if (created.changing || created.retired) return;
          const value = created.model.getValue(), dirty = value !== created.base;
          const others = [...records.values()].filter(record => record !== created && record.dirty);
          if (dirty && (new TextEncoder().encode(value).length > 512 * 1024 || others.length >= 32 ||
            others.reduce((sum, item) => sum + new TextEncoder().encode(item.model.getValue()).length, 0) + new TextEncoder().encode(value).length > 8 * 1024 * 1024)) {
            created.changing = true; created.model.setValue(created.allowedValue); created.changing = false;
            created.error = '草稿上限为每份512 KiB、32份共8 MiB；请先保存其他文件再继续编辑'; notify(created); return;
          }
          created.allowedValue = value;
          created.dirty = created.model.getValue() !== created.base; created.durable = false;
          writeRecovery(created); notify(created);
          clearTimeout(created.timer);
          created.timer = setTimeout(() => { void flushDraft(created).catch(() => {}); }, 400);
        });
        return created;
      }).finally(() => { if (pending.get(key) === loading) pending.delete(key); });
      pending.set(key, loading);
    }
    record = await loading;
  } else if (!record.dirty && record.hash !== disk.hash) {
    record.base = disk.content; record.hash = disk.hash; record.encoding = disk.encoding; record.model.setValue(disk.content);
  }
  if (generation !== epoch || record.retired) throw new Error('编辑器已卸载');
  record.refs++; record.api = api; record.scope = scope; record.lastUsed = Date.now(); evict();
  return record;
}
export function releaseModel(record: EditorRecord, viewId: string, state: Monaco.editor.ICodeEditorViewState | null) {
  if (record.retired) return;
  if (state) { record.views.set(viewId, state); while (record.views.size > 16) record.views.delete(record.views.keys().next().value!); }
  record.refs = Math.max(0, record.refs - 1); record.lastUsed = Date.now();
  clearTimeout(record.timer); void flushDraft(record).catch(() => {}); evict();
}
export function notify(record: EditorRecord) { for (const listener of record.listeners) listener(); }
export async function flushDraft(record: EditorRecord) {
  const content = record.model.getValue(), baseHash = record.hash, dirty = record.dirty, encoding = record.encoding;
  record.draftSerial = record.draftSerial.catch(() => {}).then(async () => {
    try {
      if (!dirty) {
        if (record.draftRevision) {
          const removed = await record.api.call<any>('debug', 'draft.remove', { path: record.path }, { scope: record.scope, mutating: true, revision: record.draftRevision });
          record.draftRevision = removed.revision;
        }
        if (!record.dirty && record.hash === baseHash && record.model.getValue() === content) clearRecovery(record.key);
      } else {
        const result = await record.api.call<any>('debug', 'draft.put', { path: record.path, content, baseHash, encoding },
          { scope: record.scope, mutating: true, revision: record.draftRevision });
        record.draftRevision = result.revision;
      }
      record.durable = record.model.getValue() === content && record.hash === baseHash && record.dirty === dirty; record.error = undefined;
    } catch (error) { record.error = error instanceof Error ? error.message : '草稿恢复存储不可用'; throw error; }
    finally { notify(record); }
  });
  return record.draftSerial;
}
export async function saveModel(record: EditorRecord) {
  if (record.saving) return record.saving;
  if (record.recoveryConflict) throw new Error('恢复草稿的基础版本或副本不同；请先对比并采用当前磁盘快照后保存');
  record.saving = (async () => {
    const content = record.model.getValue();
    const committed = await record.api.call<any>('files', 'write', { path: record.path, content, expectedHash: record.hash, encoding: record.encoding }, { scope: record.scope, mutating: true });
    record.base = content; record.hash = committed.hash; record.dirty = record.model.getValue() !== content; record.recoveryConflict = false;
    await flushDraft(record); notify(record);
  })().finally(() => { record.saving = undefined; });
  return record.saving;
}
export async function discardModel(record: EditorRecord) {
  const disk = await record.api.call<any>('files', 'read', { path: record.path, maxBytes: 8 * 1024 * 1024 }, { scope: record.scope });
  if (disk.binary || disk.truncated) throw new Error('无法重新载入完整文本');
  record.base = disk.content; record.hash = disk.hash; record.encoding = disk.encoding; record.model.setValue(disk.content);
  record.dirty = false; record.recoveryConflict = false; await flushDraft(record); notify(record);
}
export async function adoptDiskBase(record: EditorRecord) {
  const disk = await record.api.call<any>('files', 'read', { path: record.path, maxBytes: 8 * 1024 * 1024 }, { scope: record.scope });
  if (disk.binary || disk.truncated) throw new Error('无法读取完整磁盘版本');
  record.base = disk.content; record.hash = disk.hash; record.encoding = disk.encoding;
  record.dirty = record.model.getValue() !== disk.content; record.recoveryConflict = false;
  await flushDraft(record); notify(record);
}
export async function disposeModels() {
  epoch++;
  const owned = [...records.values()]; records.clear(); pending.clear();
  for (const record of owned) { record.retired = true; clearTimeout(record.timer); }
  await Promise.allSettled(owned.map(async record => { await record.saving?.catch(() => {}); await flushDraft(record); }));
  for (const record of owned) record.model.dispose();
}
function evict() {
  const ordered = [...records.values()].filter(record => !record.refs && !record.dirty).sort((a, b) => a.lastUsed - b.lastUsed);
  let clean = [...records.values()].filter(record => !record.dirty);
  let weight = clean.reduce((sum, record) => sum + record.model.getValueLength() * 2, 0);
  while (ordered.length && (clean.length > 16 || weight > 16 * 1024 * 1024)) {
    const record = ordered.shift()!; records.delete(record.key); weight -= record.model.getValueLength() * 2;
    record.model.dispose(); clean = clean.filter(item => item !== record);
  }
}
const recoveryPrefix = 'nexus-editor-draft:';
function readRecovery(key: string) {
  try { const value = JSON.parse(localStorage.getItem(recoveryPrefix + key) ?? 'null'); return typeof value?.content === 'string' && new TextEncoder().encode(value.content).length <= 512 * 1024 ? value : undefined; } catch { return undefined; }
}
function writeRecovery(record: EditorRecord) {
  if (!record.dirty) { clearRecovery(record.key); return; }
  if (new TextEncoder().encode(record.model.getValue()).length > 512 * 1024) { record.error = '草稿超过512 KiB；请保存文件后关闭标签页'; return; }
  try {
    const keys = Object.keys(localStorage).filter(key => key.startsWith(recoveryPrefix));
    const size = keys.filter(key => key !== recoveryPrefix + record.key).reduce((sum, key) => sum + new TextEncoder().encode(localStorage.getItem(key) ?? '').length, 0);
    const value = JSON.stringify({ content: record.model.getValue(), baseHash: record.hash, encoding: record.encoding, at: Date.now() });
    if ((!keys.includes(recoveryPrefix + record.key) && keys.length >= 32) || size + new TextEncoder().encode(value).length > 4 * 1024 * 1024) throw new Error('Local draft budget exceeded');
    localStorage.setItem(recoveryPrefix + record.key, value);
  } catch { record.error = '本地恢复空间不足；正在使用宿主草稿，请保存后关闭'; }
}
function clearRecovery(key: string) { try { localStorage.removeItem(recoveryPrefix + key); } catch {} }
