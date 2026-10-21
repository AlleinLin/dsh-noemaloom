import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HostContext } from './types.js';

/** Exact content-addressed allowlist. No URL-to-filesystem translation exists. */
export async function registerEditorAssets(ctx: HostContext, packageRoot: string) {
  const manifest = JSON.parse(await readFile(join(packageRoot, 'lib/editor/manifest.json'), 'utf8'));
  if (manifest.schema !== 1 || !Array.isArray(manifest.assets) || manifest.assets.length > 512) throw new Error('Invalid editor asset manifest');
  const disposers: Array<() => unknown> = [];
  try {
    for (const asset of manifest.assets) {
      if (!/^[A-Za-z0-9_./-]+$/.test(asset.file) || asset.file.includes('..') || !/^[a-f0-9]{64}$/.test(asset.sha256) || !['text/javascript', 'text/css', 'font/ttf'].includes(asset.type)) throw new Error('Invalid editor asset entry');
      const bytes = await readFile(join(packageRoot, 'lib/editor', asset.file));
      if (createHash('sha256').update(bytes).digest('hex') !== asset.sha256) throw new Error('Editor asset integrity mismatch');
      const path = `/nexus/editor/${asset.file}`;
      disposers.push(ctx.get('webServer').register({ kind: 'exact', path, handler: (req: any, res: any) => {
        if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); return res.end(); }
        res.writeHead(200, { 'content-type': asset.type, 'cache-control': 'private, max-age=31536000, immutable',
          'x-content-type-options': 'nosniff', 'cross-origin-resource-policy': 'same-origin', 'content-length': bytes.length });
        res.end(req.method === 'HEAD' ? undefined : bytes);
      } }));
    }
    const bytes = Buffer.from(JSON.stringify({ schema: 1, entry: manifest.entry, css: manifest.css, workers: manifest.workers }));
    disposers.push(ctx.get('webServer').register({ kind: 'exact', path: '/nexus/editor/manifest.json', handler: (req: any, res: any) => {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(req.method === 'HEAD' ? undefined : bytes);
    } }));
    return () => { for (const dispose of disposers.reverse()) dispose(); };
  } catch (error) { for (const dispose of disposers.reverse()) dispose(); throw error; }
}
