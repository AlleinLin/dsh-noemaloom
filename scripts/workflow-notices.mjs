import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

async function locate(name, from) {
  for (const modules of createRequire(from).resolve.paths(name) ?? []) {
    const directory = join(modules, name);
    try {
      const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
      if (manifest.name === name) return { directory, manifest };
    } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
  }
  throw new Error(`Workflow dependency unavailable: ${name}`);
}

/** Preserve exact licenses for the original workflow providers and CLI closure. */
export async function workflowNotices(root) {
  const seeds = ['@wenaixi/dsh-superpower', '@wenaixi/dsh-ponytail',
    '@dragon-talon/dsh-openspec', '@fission-ai/openspec', 'dsh-karpathy-methodology', 'dsh-ops',
    'dsh-motion-ui', 'dsh-cross-session-approval'];
  const queue = seeds.map(name => ({ name, from: join(root, 'package.json') }));
  const visited = new Set(), packages = [];
  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
  while (queue.length) {
    const { name, from } = queue.shift();
    if (name.startsWith('@deepseek-ai/')) continue; // supplied by the pinned host
    const { directory, manifest } = await locate(name, from);
    const key = `${name}@${manifest.version}`;
    if (visited.has(key)) continue;
    visited.add(key);
    const destination = join(root, 'notices/workflows', name.replaceAll('/', '__'));
    await mkdir(destination, { recursive: true });
    const files = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !/^(?:licen[cs]e|notice|copying)(?:[._-]|$)/i.test(entry.name)) continue;
      await copyFile(join(directory, entry.name), join(destination, entry.name));
      files.push({ file: entry.name, sha256: createHash('sha256').update(await readFile(join(directory, entry.name))).digest('hex') });
    }
    const installed = lock.packages[directory.slice(root.length + 1).replaceAll('\\', '/')];
    packages.push({ name, version: manifest.version, license: manifest.license ?? null,
      integrity: installed?.integrity ?? null, licenses: files,
      ...(files.length ? {} : { notice: 'Published package contains no standalone license file; declared metadata retained.' }) });
    for (const dependency of Object.keys(manifest.dependencies ?? {}))
      queue.push({ name: dependency, from: join(directory, 'package.json') });
    for (const dependency of Object.keys(manifest.optionalDependencies ?? {})) {
      try { await locate(dependency, join(directory, 'package.json')); }
      catch { continue; }
      queue.push({ name: dependency, from: join(directory, 'package.json') });
    }
  }
  await writeFile(join(root, 'notices/workflows/SOURCE.json'), JSON.stringify({ schemaVersion: 1, packages }, null, 2) + '\n');
}
