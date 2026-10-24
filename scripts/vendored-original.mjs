import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

function child(directory, path) {
  const target = resolve(directory, path), rel = relative(directory, target);
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error(`Original source path escapes its root: ${path}`);
  }
  return target;
}

/** Verify acquired bytes before generating any bridge around a pinned vendor. */
export async function vendoredOriginal(root, definition) {
  const directory = child(resolve(root), definition.vendor);
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  const source = JSON.parse(await readFile(join(directory, 'SOURCE.json'), 'utf8'));
  if (manifest.name !== definition.packageName || manifest.version !== definition.version
    || source.packageName !== manifest.name || source.version !== manifest.version
    || !/^[a-f0-9]{40}$/u.test(definition.revision ?? '') || source.revision !== definition.revision) {
    throw new Error(`${definition.packageName}: pinned vendor identity changed`);
  }
  const requiredFiles = source.requiredFiles ?? ['package.json', 'lib/client.js', 'lib/index.js', 'LICENSE', 'NOTICE'];
  if (!Array.isArray(requiredFiles) || !requiredFiles.includes('package.json') || !requiredFiles.includes('LICENSE')) {
    throw new Error(`${manifest.name}: invalid required source files`);
  }
  for (const path of requiredFiles) {
    if (!source.files?.[path]) throw new Error(`${manifest.name}: missing upstream hash for ${path}`);
  }
  for (const [path, expected] of Object.entries(source.files)) {
    const actual = createHash('sha256').update(await readFile(child(directory, path))).digest('hex');
    if (!/^[a-f0-9]{64}$/u.test(expected) || actual !== expected) {
      throw new Error(`${manifest.name}: unchanged upstream source required: ${path}`);
    }
  }
  return { directory, manifest, source };
}
