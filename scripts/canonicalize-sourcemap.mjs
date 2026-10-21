import { readFile, writeFile } from 'node:fs/promises';
import { posix } from 'node:path';

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function decodeSegment(text) {
  const values = [];
  let value = 0, scale = 1;
  for (const character of text) {
    const digit = alphabet.indexOf(character);
    if (digit < 0) throw new Error('Invalid source map VLQ digit');
    value += (digit % 32) * scale;
    if (!Number.isSafeInteger(value)) throw new Error('Source map VLQ exceeds safe integer range');
    if (digit >= 32) { scale *= 32; continue; }
    values.push((value % 2 ? -1 : 1) * Math.floor(value / 2));
    value = 0; scale = 1;
  }
  if (scale !== 1 || ![1, 4, 5].includes(values.length)) throw new Error('Invalid source map segment');
  return values;
}

function encodeSegment(values) {
  return values.map(value => {
    let payload = Math.abs(value) * 2 + (value < 0 ? 1 : 0);
    if (!Number.isSafeInteger(payload)) throw new Error('Source map VLQ exceeds safe integer range');
    let text = '';
    do {
      const digit = payload % 32;
      payload = Math.floor(payload / 32);
      text += alphabet[digit + (payload > 0 ? 32 : 0)];
    } while (payload > 0);
    return text;
  }).join('');
}

/** Merge identical embedded sources while preserving every generated mapping.
 * Conflicting text at one source identity is a build failure, never discarded. */
export function canonicalizeSourceMap(map) {
  if (map.version !== 3 || map.sections !== undefined || !Array.isArray(map.sources)
    || !Array.isArray(map.sourcesContent) || map.sources.length !== map.sourcesContent.length
    || typeof map.mappings !== 'string') throw new Error('Expected a complete flat source map');
  const identities = new Map(), sources = [], contents = [], remap = [];
  for (let index = 0; index < map.sources.length; index++) {
    const source = map.sources[index], content = map.sourcesContent[index];
    if (typeof source !== 'string' || typeof content !== 'string') throw new Error('Source map requires embedded source text');
    const identity = posix.normalize(posix.join(map.sourceRoot ?? '', source));
    const existing = identities.get(identity);
    if (existing !== undefined) {
      if (contents[existing] !== content) throw new Error(`Conflicting source map contents: ${identity}`);
      remap.push(existing);
    } else {
      identities.set(identity, sources.length);
      remap.push(sources.length);
      sources.push(source); contents.push(content);
    }
  }
  if (sources.length === map.sources.length) return map;
  let oldSource = 0, newSource = 0;
  const mappings = map.mappings.split(';').map(line => line === '' ? '' : line.split(',').map(segment => {
    const values = decodeSegment(segment);
    if (values.length > 1) {
      oldSource += values[1];
      if (!Number.isInteger(oldSource) || oldSource < 0 || oldSource >= remap.length) throw new Error('Source map source index is out of range');
      const nextSource = remap[oldSource];
      values[1] = nextSource - newSource;
      newSource = nextSource;
    }
    return encodeSegment(values);
  }).join(',')).join(';');
  const result = { ...map, sources, sourcesContent: contents, mappings };
  for (const field of ['ignoreList', 'x_google_ignoreList']) {
    if (map[field] === undefined) continue;
    if (!Array.isArray(map[field]) || map[field].some(index => !Number.isInteger(index) || remap[index] === undefined)) {
      throw new Error('Invalid source map ignore list');
    }
    result[field] = [...new Set(map[field].map(index => remap[index]))];
  }
  return result;
}

export async function canonicalizeSourceMapFile(filename) {
  const original = JSON.parse(await readFile(filename, 'utf8'));
  const canonical = canonicalizeSourceMap(original);
  if (canonical !== original) await writeFile(filename, JSON.stringify(canonical) + '\n');
}
