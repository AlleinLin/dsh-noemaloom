import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm, readdir, stat } from 'node:fs/promises';
import { join, dirname, resolve, relative, isAbsolute } from 'node:path';
import { x as extractTar } from 'tar';
import { unzipSync } from 'fflate';
import { NexusError } from '../../ports/contracts.js';

export interface DebugArtifact { id: string; name: string; version: string; url: string; sha256: string; license: string }
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export class AdapterCache {
  private installing = new Map<string, Promise<string>>();
  constructor(readonly root: string, readonly artifacts: DebugArtifact[], private seedDirectory?: string) {}
  async ensure(id: string, signal: AbortSignal): Promise<string> {
    if (process.platform !== 'win32' || process.arch !== 'x64') throw new NexusError('DEPENDENCY_MISSING', 'Pinned debugger assets currently target Windows x64');
    const artifact = this.artifacts.find(item => item.id === id);
    if (!artifact || !/^[a-f0-9]{64}$/.test(artifact.sha256)) throw new Error(`Unknown pinned debug artifact: ${id}`);
    let pending = this.installing.get(id);
    if (!pending) {
      pending = this.install(artifact, signal).finally(() => this.installing.delete(id));
      this.installing.set(id, pending);
    }
    return pending;
  }
  private async install(artifact: DebugArtifact, signal: AbortSignal): Promise<string> {
    await mkdir(this.root, { recursive: true });
    const target = join(this.root, `${artifact.id}-${artifact.sha256.slice(0, 16)}`);
    try {
      const receipt = JSON.parse(await readFile(join(target, 'installation.json'), 'utf8'));
      if (receipt.sha256 === artifact.sha256 && Object.keys(receipt.files ?? {}).length) {
        const actual = (await tree(target)).map(path => relative(target, path).replaceAll('\\', '/')).filter(path => path !== 'installation.json');
        if (actual.length !== Object.keys(receipt.files).length || actual.some(path => !Object.hasOwn(receipt.files, path))) throw new Error('Cached adapter file set changed');
        for (const [path, expected] of Object.entries(receipt.files)) {
          if (hash(await readFile(safePath(target, path))) !== expected) throw new Error('Cached adapter bytes changed');
        }
        return target;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`Adapter cache needs removal/reinstall: ${artifact.id}`);
    }
    let bytes: Buffer | undefined;
    if (this.seedDirectory) {
      try { bytes = await readFile(join(this.seedDirectory, artifact.name)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    if (!bytes) {
      const response = await fetch(artifact.url, { signal: AbortSignal.any([signal, AbortSignal.timeout(180000)]), redirect: 'follow' });
      if (!response.ok || !response.body) throw new Error(`Adapter download failed: ${artifact.id} HTTP ${response.status}`);
      const chunks: Uint8Array[] = []; let size = 0;
      for await (const chunk of response.body as any as AsyncIterable<Uint8Array>) {
        size += chunk.length; if (size > 180 * 1024 * 1024) throw new Error('Adapter download exceeds 180 MiB');
        chunks.push(chunk);
      }
      bytes = Buffer.concat(chunks);
    }
    if (hash(bytes) !== artifact.sha256) throw new Error(`Pinned adapter SHA-256 mismatch: ${artifact.id}`);
    signal.throwIfAborted();
    const staging = join(this.root, `.install-${randomUUID()}`);
    await mkdir(staging);
    try {
      let total = 0, count = 0;
      const account = (size: number) => { total += size; if (++count > 25000 || total > 768 * 1024 * 1024) throw new Error('Expanded adapter exceeds budget'); };
      if (/\.(?:zip|vsix|whl)$/.test(artifact.name)) {
        const entries = unzipSync(bytes, { filter(entry) { account(entry.originalSize); safePath(staging, entry.name); return true; } });
        for (const [path, content] of Object.entries(entries)) {
          const file = safePath(staging, path);
          if (path.endsWith('/')) { await mkdir(file, { recursive: true }); continue; }
          await mkdir(dirname(file), { recursive: true }); await writeFile(file, content, { flag: 'wx' });
        }
      } else {
        const archive = join(staging, '.archive.tgz'); await writeFile(archive, bytes);
        await extractTar({ file: archive, cwd: staging, strict: true, preservePaths: false,
          filter(path, entry) {
            safePath(staging, path);
            if (!('type' in entry) || !['File', 'Directory'].includes(entry.type)) throw new Error('Adapter archive contains an unsupported member type');
            account(entry.size); return true;
          } });
        await rm(archive);
      }
      const files: Record<string, string> = {};
      for (const path of await tree(staging)) files[relative(staging, path).replaceAll('\\', '/')] = hash(await readFile(path));
      await writeFile(join(staging, 'installation.json'), JSON.stringify({ ...artifact, installedAt: new Date().toISOString(), files }, null, 2));
      signal.throwIfAborted();
      await rename(staging, target);
      return target;
    } finally { await rm(staging, { recursive: true, force: true }); }
  }
  async find(id: string, predicate: (path: string) => boolean, signal: AbortSignal) {
    const root = await this.ensure(id, signal);
    const matches = (await tree(root)).filter(path => predicate(path.replaceAll('\\', '/')));
    if (matches.length !== 1) throw new Error(`Expected one ${id} entry point; found ${matches.length}`);
    return matches[0];
  }
}
function safePath(root: string, path: string): string {
  if (path.includes('\0') || path.includes('\\') || /^[A-Za-z]:/.test(path)) throw new Error('Unsafe archive member');
  const target = resolve(root, path), rel = relative(root, target);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith('..\\') || rel.startsWith('../')) throw new Error('Archive member escapes cache');
  return target;
}
export async function tree(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await tree(path));
    else if (entry.isFile()) files.push(path);
    else throw new Error('Adapter cache may not contain links');
  }
  return files;
}
