import { watch, type FSWatcher } from 'node:fs';
import { readFile, readdir, stat, mkdir, open, rename, unlink, rmdir, copyFile, chmod } from 'node:fs/promises';
import { dirname, relative, extname, join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { zipSync, unzipSync, strFromU8 } from 'fflate';
import { XMLParser } from 'fast-xml-parser';
import { NexusError, recordParams, requiredString, type NexusModule, type NexusRequest, type NexusServices, type DispatchContext, type JsonRecord } from '../../ports/contracts.js';
import { existingFile, workspacePath, sha256, within } from './paths.js';
import { decodeTextBytes, decodeTextAs, bomlessEncoding, lastLineBreakEnd, unitWidth, encodeText, detectEol, restoreEol, type TextEncoding } from './text-encoding.js';

const MAX_FILE = 8 * 1024 * 1024;
const MAX_SCAN = 64 * 1024 * 1024;
const MAX_ITEMS = 10000;
const MAX_ARCHIVE = 128 * 1024 * 1024;
const IGNORED = new Set(['node_modules', '.git', '.codegraph', '.nexus']);
const actions = ['list', 'read', 'stat', 'write', 'edit', 'replace', 'diff', 'mkdir', 'rename', 'move', 'remove', 'copy', 'search', 'glob', 'grep', 'watch.start', 'watch.stop', 'history', 'doc.read', 'pdf.read', 'table.read', 'archive.create', 'archive.list', 'archive.read', 'batch.read', 'batch.edit', 'batch.plan', 'batch.run', 'batch.resume', 'cancel', 'capability.discover', 'result.page', 'result.release'];
const aliases: Record<string, string> = { inspect_local_file: 'read', write_file: 'write', edit_file: 'edit', read_many: 'batch.read', edit_many: 'batch.edit', table_read: 'table.read', doc_read: 'doc.read', pdf_read: 'pdf.read' };

function integer(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new NexusError('INVALID_ARGUMENT', `整数必须在 ${min}–${max} 范围`);
  return value;
}

function archiveName(name: string): void {
  if (!name || name.includes('\0') || name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.split('/').includes('..')) throw new NexusError('SCOPE_MISMATCH', '归档条目路径不安全');
}

function parseTar(input: Buffer): Record<string, Uint8Array> {
  const entries: Record<string, Uint8Array> = {}; let offset = 0, count = 0, total = 0;
  while (offset + 512 <= input.length) {
    const header = input.subarray(offset, offset + 512); if (header.every(byte => byte === 0)) break;
    const text = (start: number, size: number) => header.subarray(start, start + size).toString('utf8').replace(/\0.*$/s, '').trim();
    const name = [text(345, 155), text(0, 100)].filter(Boolean).join('/'), sizeText = text(124, 12);
    if (!/^[0-7]*$/.test(sizeText)) throw new NexusError('FORMAT_UNSUPPORTED', '不支持 TAR base256 大文件尺寸');
    const size = parseInt(sizeText || '0', 8), kind = text(156, 1);
    archiveName(name); total += size; count++;
    if (count > MAX_ITEMS || size > MAX_ARCHIVE || total > MAX_ARCHIVE || offset + 512 + size > input.length) throw new NexusError('RESOURCE_LIMIT', 'TAR 条目预算或长度不合法');
    if (Object.hasOwn(entries, name)) throw new NexusError('SCOPE_MISMATCH', 'TAR 含重复条目');
    if (kind !== '' && kind !== '0' && kind !== '5') throw new NexusError('FORMAT_UNSUPPORTED', '拒绝 TAR 链接、设备和扩展元数据条目');
    const expected = parseInt(text(148, 8), 8), sum = header.reduce((value, byte, index) => value + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (expected !== sum) throw new NexusError('FORMAT_UNSUPPORTED', 'TAR 条目校验失败');
    entries[name] = new Uint8Array(input.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function writeTar(entries: Record<string, Uint8Array>): Buffer {
  const chunks: Buffer[] = [];
  for (const [name, data] of Object.entries(entries)) {
    if (Buffer.byteLength(name) > 100) throw new NexusError('FORMAT_UNSUPPORTED', 'USTAR 当前写入文件名不超过100字节，请使用 ZIP');
    const header = Buffer.alloc(512);
    const field = (offset: number, length: number, value: string) => header.write(value, offset, length, 'ascii');
    header.write(name, 0, 100, 'utf8'); field(100, 8, '0000644\0'); field(108, 8, '0000000\0'); field(116, 8, '0000000\0'); field(124, 12, data.length.toString(8).padStart(11, '0') + '\0'); field(136, 12, Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0'); field(148, 8, '        '); field(156, 1, '0'); field(257, 6, 'ustar\0'); field(263, 2, '00');
    const sum = header.reduce((value, byte) => value + byte, 0); field(148, 8, sum.toString(8).padStart(6, '0') + '\0 ');
    chunks.push(header, Buffer.from(data), Buffer.alloc((512 - data.length % 512) % 512));
  }
  chunks.push(Buffer.alloc(1024)); return Buffer.concat(chunks);
}

function validateZipDirectory(bytes: Buffer): void {
  let end = -1;
  for (let offset = Math.max(0, bytes.length - 65557); offset <= bytes.length - 22; offset++) if (bytes.readUInt32LE(offset) === 0x06054b50) end = offset;
  if (end < 0) throw new NexusError('FORMAT_UNSUPPORTED', 'ZIP 目录尾缺失');
  const count = bytes.readUInt16LE(end + 10), centralSize = bytes.readUInt32LE(end + 12), start = bytes.readUInt32LE(end + 16);
  if (count === 0xffff || start === 0xffffffff || centralSize === 0xffffffff) throw new NexusError('FORMAT_UNSUPPORTED', 'ZIP64 超出受限归档范围');
  if (count > MAX_ITEMS || start + centralSize > end) throw new NexusError('RESOURCE_LIMIT', 'ZIP 目录预算或长度无效');
  const names = new Set<string>(); let offset = start, total = 0;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== 0x02014b50) throw new NexusError('FORMAT_UNSUPPORTED', 'ZIP 中央目录损坏');
    const flags = bytes.readUInt16LE(offset + 8), compressed = bytes.readUInt32LE(offset + 20), original = bytes.readUInt32LE(offset + 24), nameLength = bytes.readUInt16LE(offset + 28), extraLength = bytes.readUInt16LE(offset + 30), commentLength = bytes.readUInt16LE(offset + 32), mode = bytes.readUInt32LE(offset + 38) >>> 16;
    if (flags & 1) throw new NexusError('FORMAT_UNSUPPORTED', '加密ZIP不能作为文档容器读取');
    if (offset + 46 + nameLength + extraLength + commentLength > start + centralSize) throw new NexusError('FORMAT_UNSUPPORTED', 'ZIP目录条目长度无效');
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8'); archiveName(name);
    if (names.has(name)) throw new NexusError('SCOPE_MISMATCH', 'ZIP含重复条目');
    if ((mode & 0xf000) === 0xa000 || ((mode & 0xf000) !== 0 && (mode & 0xf000) !== 0x8000 && (mode & 0xf000) !== 0x4000)) throw new NexusError('SCOPE_MISMATCH', 'ZIP链接或特殊文件条目被拒绝');
    names.add(name); total += original;
    if (total > MAX_ARCHIVE || original > MAX_ARCHIVE || (compressed > 0 && original / compressed > 200)) throw new NexusError('RESOURCE_LIMIT', 'ZIP展开预算超限');
    offset += 46 + nameLength + extraLength + commentLength;
  }
}

function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { field += '"'; i++; } else quoted = !quoted;
    } else if (char === delimiter && !quoted) { row.push(field); field = ''; }
    else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += char;
  }
  if (quoted) throw new NexusError('FORMAT_UNSUPPORTED', 'CSV 存在未闭合引号');
  if (field || row.length) rows.push([...row, field]);
  return rows;
}

export function createFilesModule(services: NexusServices): NexusModule {
  const watchers = new Map<string, FSWatcher>();
  const locks = new Map<string, Promise<unknown>>();
  async function lock<T>(path: string, operation: () => Promise<T>): Promise<T> {
    const previous = locks.get(path) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    locks.set(path, next);
    try { return await next; } finally { if (locks.get(path) === next) locks.delete(path); }
  }
  const rootOf = (context?: DispatchContext) => context?.workspaceRoot ?? services.workspaceRoot;

  async function snapshot(path: string) {
    const info = await stat(path);
    const hash = info.isFile() && info.size <= MAX_ARCHIVE ? sha256(await readFile(path)) : undefined;
    const key = sha256(path);
    const previous = await services.store.get<JsonRecord>('fileRevisions', key);
    if (previous?.value.hash === hash && previous?.value.mtimeMs === info.mtimeMs && previous?.value.size === info.size) return previous;
    return services.store.put('fileRevisions', key, { path, hash, mtimeMs: info.mtimeMs, size: info.size, mode: info.mode, isDirectory: info.isDirectory() }, previous?.revision ?? 0);
  }

  async function read(params: JsonRecord, context?: DispatchContext) {
    const path = await workspacePath(rootOf(context), params.path);
    await existingFile(path, MAX_ARCHIVE);
    const current = await snapshot(path);
    if (params.snapshotId !== undefined && params.snapshotId !== current.value.hash) throw new NexusError('SEARCH_STALE', '文件快照已经变化');
    const offset = integer(params.offset, 0, 0, MAX_ARCHIVE);
    const bytes = integer(params.maxBytes, 65536, 1, MAX_FILE);
    const handle = await open(path, 'r');
    let data = Buffer.alloc(Math.min(bytes, Math.max(0, Number(current.value.size) - offset))), first: ReturnType<typeof decodeTextBytes>;
    try {
      const sniff = Buffer.alloc(Math.min(65536, Number(current.value.size)));
      await handle.read(sniff, 0, sniff.length, 0);
      first = decodeTextBytes(sniff, sniff.length < Number(current.value.size));
      if (first && offset % unitWidth(first.encoding) !== 0) throw new NexusError('INVALID_ARGUMENT', '分页字节偏移必须对齐编码单元');
      await handle.read(data, 0, data.length, offset);
    } finally { await handle.close(); }
    if (first && offset + data.length < Number(current.value.size)) {
      const completeLine = lastLineBreakEnd(data, bomlessEncoding(first.encoding));
      if (completeLine > 0) data = data.subarray(0, completeLine);
      else { const width = unitWidth(first.encoding); data = data.subarray(0, data.length - data.length % width); }
      if (first.encoding === 'utf8' || first.encoding === 'utf8-bom') {
        const decoder = new TextDecoder('utf-8', { fatal: true });
        for (let tail = 0; tail < 4; tail++) {
          try { decoder.decode(data); break; } catch { data = data.subarray(0, Math.max(0, data.length - 1)); }
        }
      }
      if (data.length === 0 && offset < Number(current.value.size)) throw new NexusError('INVALID_ARGUMENT', 'maxBytes 太小，无法容纳一个完整编码单元');
    }
    const truncated = offset + data.length < Number(current.value.size);
    const decoded = first ? { content: offset === 0 ? decodeTextBytes(data, truncated)?.content ?? '' : decodeTextAs(data, bomlessEncoding(first.encoding)), encoding: first.encoding } : null;
    return {
      path: relative(rootOf(context), path), revision: current.revision, hash: current.value.hash,
      snapshotId: current.value.hash, size: current.value.size, encoding: decoded?.encoding ?? null,
      newline: decoded ? detectEol(decoded.content) : null, binary: decoded === null,
      content: decoded?.content ?? undefined, base64: decoded && params.raw !== true ? undefined : data.toString('base64'),
      offset, nextCursor: truncated ? String(offset + data.length) : null, truncated, warnings: [],
    };
  }

  async function write(params: JsonRecord, request: NexusRequest, context?: DispatchContext) {
    const root = rootOf(context), path = await workspacePath(root, params.path, true);
    return lock(path, async () => {
      let current: Awaited<ReturnType<typeof snapshot>> | undefined;
      try { current = await snapshot(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const expected = request.expectedRevision ?? (typeof params.expectedRevision === 'number' ? params.expectedRevision : undefined);
      if (!current && params.createOnly !== true) throw new NexusError('INVALID_ARGUMENT', '创建文件必须声明 createOnly');
      if (current && (params.createOnly === true || (expected === undefined && typeof params.expectedHash !== 'string') || (expected !== undefined && expected !== current.revision) || (params.expectedHash !== undefined && params.expectedHash !== current.value.hash))) {
        throw new NexusError('REVISION_CONFLICT', '文件已变化，保留当前文件与候选内容', { currentRevision: current.revision, currentHash: current.value.hash, candidateHash: typeof params.content === 'string' ? sha256(params.content) : null });
      }
      const before = current ? await readFile(path) : undefined;
      if (before && before.length > MAX_FILE) throw new NexusError('RESOURCE_LIMIT', '大文件只读，请在外部编辑器修改');
      const decoded = before ? decodeTextBytes(before) : undefined;
      if (typeof params.content !== 'string') throw new NexusError('INVALID_ARGUMENT', 'content 必须为字符串，空文件允许空字符串');
      let content = params.content;
      if (params.operation === 'edit' || params.operation === 'replace') {
        if (!decoded) throw new NexusError('FORMAT_UNSUPPORTED', '二进制不可执行文本编辑');
        const oldText = requiredString(params, 'oldText');
        const occurrences = decoded.content.split(oldText).length - 1;
        if (!occurrences || (occurrences > 1 && params.replaceAll !== true)) throw new NexusError('REVISION_CONFLICT', '待替换文本不存在或有多处匹配', { occurrences });
        content = params.replaceAll === true ? decoded.content.split(oldText).join(content) : decoded.content.replace(oldText, content);
      }
      const encoding = (params.encoding ?? decoded?.encoding ?? 'utf8') as TextEncoding;
      const newline = params.newline === 'crlf' || params.newline === 'lf' ? params.newline : decoded ? detectEol(decoded.content) : 'lf';
      const output = encodeText(restoreEol(content.replace(/\r\n/g, '\n'), newline), encoding);
      if (output.length > MAX_FILE) throw new NexusError('RESOURCE_LIMIT', '写入超过文件大小上限');
      await mkdir(dirname(path), { recursive: true });
      await workspacePath(root, dirname(path));
      const temp = join(dirname(path), `.nexus-write-${randomUUID()}.tmp`);
      const handle = await open(temp, 'wx', current ? Number(current.value.mode) & 0o777 : 0o644);
      try {
        await handle.writeFile(output); await handle.sync(); await handle.close();
        if (current) {
          const actualHash = sha256(await readFile(path));
          if (actualHash !== current.value.hash) throw new NexusError('REVISION_CONFLICT', '写入前文件已被外部修改');
        }
        await rename(temp, path);
      } catch (error) { await handle.close().catch(() => undefined); await unlink(temp).catch(() => undefined); throw error; }
      const after = await snapshot(path);
      const audit = await services.store.put('fileAudit', randomUUID(), { path: relative(root, path), beforeHash: current?.value.hash ?? null, afterHash: after.value.hash, revision: after.revision, actor: context?.actorId ?? 'host', operation: params.operation ?? 'write', observedAt: new Date().toISOString() });
      services.emit('files.changed', { path: relative(root, path), revision: after.revision });
      return { path: relative(root, path), revision: after.revision, hash: after.value.hash, encoding, newline, bytes: output.length, effect: 'committed', auditRef: audit.id };
    });
  }

  async function scan(params: JsonRecord, context?: DispatchContext) {
    const root = rootOf(context), start = await workspacePath(root, String(params.path ?? '.'));
    const mode = params.mode ?? 'filename';
    if (!['filename', 'content', 'all', 'off'].includes(String(mode))) throw new NexusError('INVALID_ARGUMENT', '未知搜索模式');
    if (mode === 'off') return { items: [], scanComplete: true, provider: 'off' };
    const query = typeof params.query === 'string' ? params.query : '';
    if (query.length > 4096) throw new NexusError('INVALID_ARGUMENT', '查询过长');
    if (params.regex === true && (query.length > 256 || /\([^)]*[+*][^)]*\)[+*{]|\\[1-9]/.test(query))) throw new NexusError('RESOURCE_LIMIT', '正则复杂度超过受限检索范围');
    let pattern: RegExp | undefined;
    try { if (params.regex === true) pattern = new RegExp(query, params.caseSensitive === true ? '' : 'i'); } catch { throw new NexusError('INVALID_ARGUMENT', '无效正则表达式'); }
    const matches = (value: string) => pattern ? pattern.test(value) : params.caseSensitive === true ? value.includes(query) : value.toLowerCase().includes(query.toLowerCase());
    const items: JsonRecord[] = [], warnings: string[] = [];
    const queue = [start];
    let scannedBytes = 0, inspected = 0, complete = true;
    while (queue.length) {
      context?.signal?.throwIfAborted(); services.signal?.throwIfAborted();
      const directory = queue.shift()!;
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (++inspected > MAX_ITEMS || scannedBytes > MAX_SCAN) { complete = false; break; }
        const path = join(directory, entry.name);
        if (entry.isSymbolicLink()) { warnings.push(`跳过链接: ${relative(root, path)}`); continue; }
        if (entry.isDirectory()) { if (params.includeIgnored === true || !IGNORED.has(entry.name)) queue.push(path); continue; }
        if (!entry.isFile()) continue;
        const rel = relative(root, path).replace(/\\/g, '/'), info = await stat(path);
        if (Array.isArray(params.extensions) && !params.extensions.includes(extname(path))) continue;
        if (typeof params.modifiedAfter === 'string' && info.mtimeMs < Date.parse(params.modifiedAfter)) continue;
        if ((mode === 'filename' || mode === 'all') && matches(rel)) items.push({ path: rel, size: info.size, modifiedAt: info.mtime.toISOString(), match: 'filename' });
        if ((mode === 'content' || mode === 'all') && info.size <= MAX_FILE && scannedBytes + info.size <= MAX_SCAN) {
          const bytes = await readFile(path); scannedBytes += bytes.length;
          const text = decodeTextBytes(bytes);
          if (text) text.content.split(/\r?\n/).forEach((line, index) => { if (matches(line) && items.length < MAX_ITEMS) items.push({ path: rel, line: index + 1, snippet: line.slice(0, 1000), hash: sha256(bytes), match: 'content' }); });
        }
      }
      if (!complete) break;
    }
    items.sort((a, b) => String(a.path).localeCompare(String(b.path)) || Number(a.line ?? 0) - Number(b.line ?? 0));
    const scanId = randomUUID(), snapshotId = sha256(JSON.stringify(items));
    const saved = await services.store.put('fileResults', scanId, { items, root, snapshotId, createdAt: Date.now(), expiresAt: Date.now() + 15 * 60_000, queryHash: sha256(JSON.stringify(params)) });
    const limit = integer(params.limit, 100, 1, 1000);
    return { scanId, snapshotId, root, items: items.slice(0, limit), pageInfo: { cursor: items.length > limit ? String(limit) : null, hasNext: items.length > limit, scanComplete: complete, pageComplete: true }, truncated: !complete || items.length > limit, warnings, resultRef: saved.id, provider: 'bounded-walk', indexedAt: new Date().toISOString(), mayOmit: !complete };
  }

  async function archive(params: JsonRecord, context?: DispatchContext) {
    const path = await workspacePath(rootOf(context), params.path);
    await existingFile(path, MAX_ARCHIVE);
    const bytes = await readFile(path);
    if (/\.(?:tar|tar\.gz|tgz)$/i.test(path)) {
      const expanded = /\.(?:tar\.gz|tgz)$/i.test(path) ? gunzipSync(bytes, { maxOutputLength: MAX_ARCHIVE }) : bytes;
      if (expanded.length > MAX_ARCHIVE || (bytes.length > 0 && expanded.length / bytes.length > 200)) throw new NexusError('RESOURCE_LIMIT', 'TAR 展开预算超限');
      const entries = parseTar(expanded);
      return params.entry === undefined ? entries : Object.fromEntries(Object.entries(entries).filter(([name]) => name === params.entry));
    }
    validateZipDirectory(bytes);
    let total = 0, count = 0;
    const entries = unzipSync(bytes, { filter: (entry) => {
      archiveName(entry.name);
      total += entry.originalSize; count++;
      if (entry.originalSize > MAX_ARCHIVE || total > MAX_ARCHIVE || count > MAX_ITEMS || (entry.size > 0 && entry.originalSize / entry.size > 200)) throw new NexusError('RESOURCE_LIMIT', '归档展开预算超限');
      return params.entry === undefined || entry.name === params.entry;
    } });
    return entries;
  }

  async function dispatch(request: NexusRequest, context?: DispatchContext): Promise<unknown> {
    const params = recordParams(request), action = aliases[request.action] ?? request.action;
    const root = rootOf(context);
    switch (action) {
      case 'read': return read(params, context);
      case 'capability.discover': return { actions: [...actions, ...Object.keys(aliases)], presentation: params.presentation === 'ptc' ? 'ptc' : 'native', formats: { text: true, csv: true, tsv: true, docx: 'structured-text', pdf: 'extractable-text', doc: false, zip: true, tar: true, gzipTar: true }, limits: { fileBytes: MAX_FILE, scanBytes: MAX_SCAN, archiveExpandedBytes: MAX_ARCHIVE, archiveEntries: MAX_ITEMS } };
      case 'diff': {
        const current = await read({ path: params.path, maxBytes: MAX_FILE }, context);
        if (current.binary || current.truncated) throw new NexusError('FORMAT_UNSUPPORTED', 'diff 需要受限文本文件');
        const before = (current.content ?? '').split(/\r?\n/), after = String(params.content ?? '').split(/\r?\n/), changes = [];
        for (let index = 0; index < Math.max(before.length, after.length); index++) if (before[index] !== after[index]) changes.push({ line: index + 1, before: before[index] ?? null, after: after[index] ?? null });
        return { path: params.path, revision: current.revision, hash: current.hash, changes, method: 'line-position', effect: 'preview' };
      }
      case 'stat': { const path = await workspacePath(root, params.path); const value = await snapshot(path); return { ...value.value, path: relative(root, path), revision: value.revision }; }
      case 'list': {
        const path = await workspacePath(root, String(params.path ?? '.'));
        const entries = await readdir(path, { withFileTypes: true });
        return { root, path: relative(root, path), items: await Promise.all(entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name)).map(async (entry) => { const info = await stat(join(path, entry.name)).catch(() => undefined); return { name: entry.name, path: relative(root, join(path, entry.name)), directory: entry.isDirectory(), symlink: entry.isSymbolicLink(), size: info?.size, modifiedAt: info?.mtime.toISOString() }; })) };
      }
      case 'write': return write(params, request, context);
      case 'edit': case 'replace': return write({ ...params, operation: action, content: params.content ?? params.newText }, request, context);
      case 'mkdir': { const path = await workspacePath(root, params.path, true); await mkdir(path, { recursive: params.recursive === true }); return { path: relative(root, path), effect: 'committed' }; }
      case 'move': case 'rename': case 'copy': {
        const from = await workspacePath(root, params.path), to = await workspacePath(root, params.destination, true);
        if (from === root || to === root) throw new NexusError('SCOPE_MISMATCH', '不能移动或覆盖工作区根');
        try { await stat(to); throw new NexusError('REVISION_CONFLICT', '目标已存在'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        const current = await snapshot(from);
        if (request.expectedRevision !== undefined && request.expectedRevision !== current.revision) throw new NexusError('REVISION_CONFLICT', '源文件版本变化');
        await mkdir(dirname(to), { recursive: true });
        if (action === 'copy') await copyFile(from, to, 1);
        else await rename(from, to);
        return { path: relative(root, from), destination: relative(root, to), effect: 'committed' };
      }
      case 'remove': {
        const path = await workspacePath(root, params.path);
        if (path === root) throw new NexusError('SCOPE_MISMATCH', '不能删除工作区根');
        const current = await snapshot(path);
        if (request.expectedRevision === undefined || current.revision !== request.expectedRevision) throw new NexusError('REVISION_CONFLICT', '删除必须携带当前版本', { currentRevision: current.revision });
        if (!await services.host.approve('files.delete', relative(root, path), { recursive: params.recursive === true })) throw new NexusError('PERMISSION_DENIED', '删除未获批准');
        if (current.value.isDirectory) { if (params.recursive) throw new NexusError('INVALID_ARGUMENT', '递归删除须逐项明确列出文件'); await rmdir(path); } else await unlink(path);
        return { path: relative(root, path), effect: 'committed', recoverable: false };
      }
      case 'glob': case 'grep': case 'search': return scan({ ...params, mode: action === 'grep' ? 'content' : params.mode ?? 'filename' }, context);
      case 'watch.start': { const path = await workspacePath(root, String(params.path ?? '.')), id = randomUUID(); const watcher = watch(path, { recursive: params.recursive === true }, (event, filename) => services.emit('files.watch', { id, event, path: relative(root, join(path, filename?.toString() ?? '')) })); watchers.set(id, watcher); return { id, path: relative(root, path) }; }
      case 'watch.stop': { const id = requiredString(params, 'id'); watchers.get(id)?.close(); return { stopped: watchers.delete(id) }; }
      case 'history': return (await services.store.list<JsonRecord>('fileAudit')).filter(row => row.value.path === params.path);
      case 'batch.read': case 'batch.edit': {
        if (!Array.isArray(params.items) || params.items.length > 100) throw new NexusError('INVALID_ARGUMENT', 'items 必须为不超过100条的数组');
        const items = [];
        for (let index = 0; index < params.items.length; index++) {
          try { items.push({ index, status: 'completed', result: await dispatch({ action: action === 'batch.read' ? 'read' : 'edit', params: params.items[index] as JsonRecord }, context) }); }
          catch (error) { items.push({ index, status: 'failed', error: { code: error instanceof NexusError ? error.code : 'INTERNAL_ERROR', message: (error as Error).message } }); }
        }
        return { batchId: randomUUID(), items, atomic: false };
      }
      case 'batch.plan': {
        if (!Array.isArray(params.items) || !params.items.length || params.items.length > 100) throw new NexusError('INVALID_ARGUMENT', 'batch items 须为1–100条');
        const items = [];
        for (const input of params.items) {
          const item = input as JsonRecord, action = String(item.action ?? 'read');
          if (!['read', 'write', 'edit', 'replace', 'stat', 'copy', 'rename'].includes(action)) throw new NexusError('INVALID_ARGUMENT', 'batch action 不受支持');
          await workspacePath(root, item.path, action === 'write');
          items.push({ ...item, action, status: 'pending' });
        }
        const id = randomUUID(); return services.store.put('fileBatches', id, { id, root, state: 'planned', items, completedIndexes: [], atomic: false, createdAt: new Date().toISOString() }, 0);
      }
      case 'batch.run': case 'batch.resume': {
        const id = requiredString(params, 'batchId'), saved = await services.store.get<{ root: string; items: JsonRecord[]; state: string; completedIndexes: number[] }>('fileBatches', id);
        if (!saved || saved.value.root !== root) throw new NexusError('NOT_FOUND', '批次不存在或工作区不匹配');
        if (saved.value.state === 'cancelled') return saved;
        let current = saved;
        for (let index = 0; index < current.value.items.length; index++) {
          if (current.value.completedIndexes.includes(index)) continue;
          context?.signal?.throwIfAborted();
          const latest = await services.store.get<typeof current.value>('fileBatches', id);
          if (latest?.value.state === 'cancelled') return latest;
          const item = current.value.items[index]!, itemParams = { ...item }; delete itemParams.action; delete itemParams.status;
          let receipt: JsonRecord;
          try { receipt = { ...item, status: 'completed', result: await dispatch({ action: String(item.action), params: itemParams, expectedRevision: typeof item.expectedRevision === 'number' ? item.expectedRevision : undefined }, context) }; }
          catch (error) { receipt = { ...item, status: 'failed', error: { code: error instanceof NexusError ? error.code : 'INTERNAL_ERROR' } }; }
          const nextItems = [...current.value.items]; nextItems[index] = receipt;
          current = await services.store.put('fileBatches', id, { ...current.value, items: nextItems, state: 'running', completedIndexes: receipt.status === 'completed' ? [...current.value.completedIndexes, index] : current.value.completedIndexes }, current.revision);
        }
        return services.store.put('fileBatches', id, { ...current.value, state: current.value.items.some(item => item.status !== 'completed') ? 'partial' : 'completed' }, current.revision);
      }
      case 'cancel': {
        const id = requiredString(params, 'batchId'), current = await services.store.get<JsonRecord>('fileBatches', id);
        if (!current) throw new NexusError('NOT_FOUND', '批次不存在');
        return services.store.put('fileBatches', id, { ...current.value, state: 'cancelled' }, current.revision);
      }
      case 'table.read': {
        const result = await read({ ...params, maxBytes: MAX_FILE }, context);
        if (result.binary || result.truncated) throw new NexusError('FORMAT_UNSUPPORTED', '表格必须为受限大小文本');
        const delimiter = String(params.delimiter ?? (extname(String(params.path)) === '.tsv' ? '\t' : ','));
        if (delimiter.length !== 1) throw new NexusError('INVALID_ARGUMENT', '分隔符须为单字符');
        const rows = parseDelimited(result.content ?? '', delimiter), offset = integer(params.rowOffset, 0, 0, Number.MAX_SAFE_INTEGER), limit = integer(params.limit, 100, 1, 1000);
        return { ...result, content: undefined, columns: rows[0] ?? [], rows: rows.slice(offset + 1, offset + limit + 1), totalRows: Math.max(0, rows.length - 1), nextCursor: offset + limit < rows.length - 1 ? String(offset + limit) : null, warnings: rows.flatMap((row, index) => row.length !== rows[0]?.length ? [{ row: index + 1, reason: 'column-count' }] : []) };
      }
      case 'doc.read': {
        if (extname(String(params.path)).toLowerCase() !== '.docx') throw new NexusError('FORMAT_UNSUPPORTED', '仅支持 DOCX 结构化文本；DOC 不受支持');
        const entries = await archive({ ...params }, context);
        const xml = entries['word/document.xml'];
        if (!xml) throw new NexusError('FORMAT_UNSUPPORTED', 'DOCX 主文档缺失');
        const parser = new XMLParser({ ignoreAttributes: false, preserveOrder: true, processEntities: false });
        const document = parser.parse(strFromU8(xml));
        const text = strFromU8(xml).replace(/<\/w:p>/g, '\n').replace(/<w:tab[^>]*\/>/g, '\t').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
        return { format: 'docx', text, document, relations: entries['word/_rels/document.xml.rels'] ? parser.parse(strFromU8(entries['word/_rels/document.xml.rels']!)) : [], partial: true, warnings: ['文本与表格结构抽取；不保留完整排版、页眉页脚'] };
      }
      case 'pdf.read': {
        const path = await workspacePath(root, params.path); await existingFile(path, MAX_ARCHIVE);
        const { PDFParse } = await import('pdf-parse');
        const parser = new PDFParse({ data: await readFile(path) });
        try { const result = await parser.getText(); if (!result.text.trim()) throw new NexusError('FORMAT_UNSUPPORTED', 'PDF 无可抽取文本，可能需要 OCR'); return { format: 'pdf', text: result.text, pages: result.pages, totalPages: result.total, partial: false, warnings: ['文本抽取不保证版面重排一致'] }; }
        finally { await parser.destroy(); }
      }
      case 'archive.list': { const entries = await archive(params, context); return { items: Object.entries(entries).map(([name, bytes]) => ({ name, size: bytes.length, directory: name.endsWith('/') })) }; }
      case 'archive.read': { const entry = requiredString(params, 'entry'); archiveName(entry); const entries = await archive(params, context); const data = entries[entry]; if (!data) throw new NexusError('NOT_FOUND', '归档条目不存在'); const decoded = decodeTextBytes(Buffer.from(data)); return { entry, size: data.length, content: decoded?.content, base64: decoded ? undefined : Buffer.from(data).toString('base64'), encoding: decoded?.encoding, hash: sha256(data) }; }
      case 'archive.create': {
        if (!Array.isArray(params.paths) || !params.paths.length || params.paths.length > 1000) throw new NexusError('INVALID_ARGUMENT', 'paths 必须为1–1000条文件路径');
        const entries: Record<string, Uint8Array> = {}; let total = 0;
        for (const input of params.paths) { const path = await workspacePath(root, input); await existingFile(path, MAX_ARCHIVE); const data = await readFile(path); total += data.length; if (total > MAX_ARCHIVE) throw new NexusError('RESOURCE_LIMIT', '归档总大小超限'); const name = relative(root, path).replace(/\\/g, '/'); archiveName(name); entries[name] = data; }
        const format = params.format ?? 'zip';
        if (!['zip', 'tar', 'tar.gz'].includes(String(format))) throw new NexusError('INVALID_ARGUMENT', '归档格式须为 zip/tar/tar.gz');
        const tarData = format === 'zip' ? undefined : writeTar(entries);
        const id = randomUUID(), data = format === 'zip' ? zipSync(entries, { level: 6 }) : format === 'tar.gz' ? gzipSync(tarData!) : tarData!, dir = join(services.dataDir, 'artifacts'); await mkdir(dir, { recursive: true }); const destination = join(dir, `${id}.${format}`); const file = await open(destination, 'wx'); try { await file.writeFile(data); } finally { await file.close(); }
        const record = await services.store.put('artifacts', id, { id, path: destination, mediaType: format === 'zip' ? 'application/zip' : format === 'tar.gz' ? 'application/gzip' : 'application/x-tar', size: data.length, hash: sha256(data), expiresAt: new Date(Date.now() + 3600_000).toISOString(), producer: 'files.archive.create' }); return { ...record.value, path: undefined, artifactRef: id, state: 'built' };
      }
      case 'result.page': {
        const record = await services.store.get<{ items: JsonRecord[]; root: string; snapshotId: string; expiresAt: number }>('fileResults', requiredString(params, 'resultRef'));
        if (!record || record.value.expiresAt < Date.now() || record.value.root !== root) throw new NexusError('SEARCH_STALE', '结果已过期或作用域不匹配');
        const offset = integer(params.offset, Number(request.cursor ?? 0), 0, MAX_ITEMS), limit = integer(params.limit, 100, 1, 1000);
        return { items: record.value.items.slice(offset, offset + limit), snapshotId: record.value.snapshotId, nextCursor: offset + limit < record.value.items.length ? String(offset + limit) : null };
      }
      case 'result.release': return { released: await services.store.remove('fileResults', requiredString(params, 'resultRef')) };
      default: throw new NexusError('ACTION_NOT_FOUND', `未知文件操作: ${action}`);
    }
  }
  return { id: 'files', capabilities: [...actions, ...Object.keys(aliases)].map(action => ({ action, description: `工作区文件 ${action}`, mutating: /write|edit|replace|mkdir|rename|move|remove|copy|create/.test(action) || ['batch.plan', 'batch.run', 'batch.resume', 'cancel', 'result.release'].includes(action) })), dispatch, dispose() { for (const watcher of watchers.values()) watcher.close(); watchers.clear(); } };
}
