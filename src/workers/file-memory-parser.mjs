import { parentPort } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { parse } from 'yaml';

const hash = text => `sha256:${createHash('sha256').update(text).digest('hex')}`;
const secret = /-----BEGIN (?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----|(?:sk-(?:proj-)?[a-zA-Z0-9_-]{20,})|(?:gh[pousr]_[A-Za-z0-9]{30,})|(?:AKIA[0-9A-Z]{16})|(?:Bearer\s+[A-Za-z0-9._-]{24,})/u;
parentPort.on('message', ({ id, buffer }) => {
  try {
    const bytes = Buffer.from(buffer);
    let text, encoding;
    if (bytes[0] === 0xff && bytes[1] === 0xfe) { text = new TextDecoder('utf-16le', { fatal: true }).decode(bytes.subarray(2)); encoding = 'utf-16le-bom'; }
    else if (bytes[0] === 0xfe && bytes[1] === 0xff) { text = new TextDecoder('utf-16be', { fatal: true }).decode(bytes.subarray(2)); encoding = 'utf-16be-bom'; }
    else { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); encoding = bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? 'utf-8-bom' : 'utf-8'; }
    text = text.replace(/^\uFEFF/u, '');
    if (text.includes('\0')) throw new Error('BINARY_FILE');
    const lines = text.split(/\r?\n/u);
    let frontmatter, warning, frontmatterEnd = -1;
    if (lines[0] === '---') {
      frontmatterEnd = lines.indexOf('---', 1);
      if (frontmatterEnd > 0) {
        try { frontmatter = parse(lines.slice(1, frontmatterEnd).join('\n')); } catch { warning = 'frontmatter_parse_warning'; }
      }
    }
    const chunks = [], headings = [], headingPath = [];
    for (let offset = 0; offset < lines.length; offset += 48) {
      const group = lines.slice(offset, offset + 48);
      for (let index = 0; index < group.length; index++) {
        if (offset + index <= frontmatterEnd) continue;
        const match = /^(#{1,6})\s+(.+)$/u.exec(group[index]);
        if (match) { const level = match[1].length; headingPath.length = level - 1; headingPath[level - 1] = match[2]; headings.push({ title: match[2], line: offset + index + 1, level }); }
      }
      const raw = group.join('\n'), quarantined = secret.test(raw);
      chunks.push({ text: quarantined ? '[该段含疑似凭据，已隔离]' : raw, startLine: offset + 1, endLine: Math.min(lines.length, offset + 48), chunkHash: hash(raw), headingPath: [...headingPath], quarantined });
    }
    const quarantined = chunks.some(chunk => chunk.quarantined);
    // Only safe text crosses back to a persistence-capable host.
    parentPort.postMessage({ id, ok: true, value: { encoding, frontmatter: secret.test(JSON.stringify(frontmatter) ?? '') ? undefined : frontmatter, warning, headings, chunks, empty: !text.trim(), quarantined, safeOriginal: quarantined ? undefined : text } });
  } catch (error) { parentPort.postMessage({ id, ok: false, error: error.message === 'BINARY_FILE' ? 'BINARY_FILE' : 'INVALID_ENCODING' }); }
});
