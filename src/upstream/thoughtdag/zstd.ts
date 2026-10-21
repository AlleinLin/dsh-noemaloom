/**
 * Adapted verbatim in algorithm from ThoughtDAG src/lib/adapters/dsh-zstd.ts,
 * Copyright (c) 2026 Xia Chen, MIT. Added reserved-bit/block-type checks and
 * hard frame/output bounds. A torn final frame remains unconsumed.
 */
import { NexusError } from '../../ports/contracts.js';

export function scanZstdFrames(buf: Uint8Array, maxFrames = 100_000): { frames: { start: number; end: number }[]; completeBytes: number; warning?: string } {
  const frames: { start: number; end: number }[] = [];
  const u32 = (offset: number): number => (buf[offset] | (buf[offset + 1] << 8) | (buf[offset + 2] << 16) | (buf[offset + 3] << 24)) >>> 0;
  let offset = 0;
  while (offset < buf.length) {
    if (frames.length >= maxFrames) throw new NexusError('CTX-IMPORT-LIMIT', 'zstd 帧数超过上限');
    const start = offset;
    if (buf.length - offset < 4) break;
    const magic = u32(offset);
    if ((magic & 0xfffffff0) === 0x184d2a50) {
      if (buf.length - offset < 8 || buf.length - offset - 8 < u32(offset + 4)) break;
      offset += 8 + u32(offset + 4);
      continue;
    }
    if (magic !== 0xfd2fb528) return { frames, completeBytes: start, warning: `未知 zstd 帧边界，字节 ${start}` };
    offset += 4;
    if (offset >= buf.length) break;
    const descriptor = buf[offset++];
    if ((descriptor & 0x18) !== 0) return { frames, completeBytes: start, warning: `无效 zstd 描述符，字节 ${start}` };
    const sizeFlag = descriptor >>> 6, single = (descriptor & 0x20) !== 0, checksum = (descriptor & 4) !== 0, dictionary = descriptor & 3;
    const rest = (single ? 0 : 1) + (dictionary === 3 ? 4 : dictionary) + (sizeFlag === 0 ? (single ? 1 : 0) : 1 << sizeFlag);
    if (buf.length - offset < rest) break;
    offset += rest;
    let torn = false;
    for (;;) {
      if (buf.length - offset < 3) { torn = true; break; }
      const header = buf[offset] | (buf[offset + 1] << 8) | (buf[offset + 2] << 16);
      offset += 3;
      const type = (header >>> 1) & 3, size = header >>> 3, last = (header & 1) !== 0;
      if (type === 3) return { frames, completeBytes: start, warning: `保留的 zstd block type，字节 ${offset - 3}` };
      const payload = type === 1 ? 1 : size;
      if (buf.length - offset < payload) { torn = true; break; }
      offset += payload;
      if (last) break;
    }
    if (torn) break;
    if (checksum) { if (buf.length - offset < 4) break; offset += 4; }
    frames.push({ start, end: offset });
  }
  return { frames, completeBytes: frames.at(-1)?.end ?? 0 };
}

export function decodeZstdFrames(buf: Uint8Array, inflate: (frame: Uint8Array) => Uint8Array, maxBytes = 128 * 1024 * 1024): { bytes: Uint8Array; cursor: number; warning?: string } {
  const scan = scanZstdFrames(buf);
  const parts: Uint8Array[] = [];
  let length = 0;
  for (const frame of scan.frames) {
    const bytes = inflate(buf.subarray(frame.start, frame.end));
    length += bytes.length;
    if (length > maxBytes) throw new NexusError('CTX-IMPORT-LIMIT', 'zstd 解码结果超过字节上限');
    parts.push(bytes);
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const bytes of parts) { result.set(bytes, offset); offset += bytes.length; }
  return { bytes: result, cursor: scan.completeBytes, warning: scan.warning };
}
