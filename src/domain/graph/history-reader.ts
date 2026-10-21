import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { NexusError } from '../../ports/contracts.js';
import { parseHistory } from './history-parser.js';
import type { CanonicalSession, HistorySource } from './types.js';

/** Hash exact consumed bytes without retaining a raw log in memory. */
export async function hashPrefix(file: string, bytes: number, signal?: AbortSignal): Promise<string> {
  const digest = createHash('sha256');
  if (bytes > 0) {
    for await (const chunk of createReadStream(file, { start: 0, end: bytes - 1, highWaterMark: 256 * 1024, signal })) digest.update(chunk);
  }
  return digest.digest('hex');
}

/** Read only complete JSONL records, keeping at most one 8 MiB line and
 * one 2 MiB parse batch. UTF-8 is decoded after a whole line is available. */
export async function* jsonlBatches(file: string, start: number, signal?: AbortSignal): AsyncGenerator<{ text: string; cursor: number }> {
  let carry: Buffer = Buffer.alloc(0);
  let offset = start, batchBytes = 0;
  let lines: string[] = [];
  for await (const raw of createReadStream(file, { start, highWaterMark: 256 * 1024, signal })) {
    signal?.throwIfAborted();
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    carry = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    let lineEnd: number;
    while ((lineEnd = carry.indexOf(10)) >= 0) {
      if (lineEnd > 8 * 1024 * 1024) throw new NexusError('CTX-IMPORT-LIMIT', 'JSONL 单行超过 8 MiB 上限');
      const bytes = carry.subarray(0, lineEnd + 1);
      offset += bytes.length; batchBytes += bytes.length;
      lines.push(bytes.toString('utf8')); carry = carry.subarray(lineEnd + 1);
      if (batchBytes >= 2 * 1024 * 1024 || lines.length >= 256) {
        yield { text: lines.join(''), cursor: offset };
        lines = []; batchBytes = 0;
      }
    }
    if (carry.length > 8 * 1024 * 1024) throw new NexusError('CTX-IMPORT-LIMIT', 'JSONL 未完成尾行超过 8 MiB 上限');
  }
  if (lines.length) yield { text: lines.join(''), cursor: offset };
}

export async function readIncrementalHistory(input: {
  file: string; relative: string; source: HistorySource; previous?: CanonicalSession;
  byteLength: number; mtimeMs: number; projectRoot: string; signal?: AbortSignal;
}): Promise<{ session: CanonicalSession; mode: 'unchanged' | 'append' | 'rebuild'; parsedBytes: number }> {
  const { previous, byteLength, mtimeMs, source, relative, file, projectRoot, signal } = input;
  const old = previous?.fileState;
  if (previous && old && old.relative === relative && old.byteLength === byteLength && old.mtimeMs === mtimeMs) {
    return { session: previous, mode: 'unchanged', parsedBytes: 0 };
  }
  let append = false;
  if (previous && old && old.relative === relative && byteLength >= old.byteLength && old.cursor <= byteLength) {
    // An append accompanied by an earlier rewrite is a rebuild. Checking the
    // entire previously consumed prefix catches middle-of-file changes too.
    append = await hashPrefix(file, old.cursor, signal) === old.prefixHash;
  }
  const start = append ? old!.cursor : 0;
  let session = append ? previous : undefined, cursor = start;
  for await (const batch of jsonlBatches(file, start, signal)) {
    session = parseHistory(source, relative, batch.text, { projectRoot, seed: session, cursorBytes: batch.cursor });
    cursor = batch.cursor;
  }
  session ??= parseHistory(source, relative, '', { projectRoot, seed: append ? previous : undefined });
  session.cursor = cursor; session.byteLength = byteLength;
  session.fileState = { relative, byteLength, mtimeMs, cursor, prefixHash: await hashPrefix(file, cursor, signal) };
  session.warnings = session.warnings.filter(warning => !warning.message.includes('最后一行未完成'));
  if (cursor < byteLength) session.warnings.push({ offset: cursor, message: '最后一行未完成，未提交尾行；等待完整追加' });
  return { session, mode: append ? 'append' : 'rebuild', parsedBytes: cursor - start };
}
