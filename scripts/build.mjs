import { build } from 'esbuild';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { buildCanvases } from './build-canvases.mjs';
import { buildNativeCapabilities } from './build-native-capabilities.mjs';
import { canonicalizeSourceMapFile } from './canonicalize-sourcemap.mjs';

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
await mkdir(new URL('../lib/', import.meta.url), { recursive: true });
await import('./build-originals.mjs');
await buildNativeCapabilities();
await buildCanvases();
const shared = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
  '@deepseek-ai/cordis', 'zod', '@tanstack/react-virtual',
  '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-dockkit',
];
const externalHost = Object.keys(manifest.peerDependencies);
const host = await build({
  entryPoints: ['src/host/index.ts'], outfile: 'lib/index.js',
  bundle: true, platform: 'node', format: 'esm', target: 'node22',
  packages: 'external', sourcemap: true, metafile: true,
  external: externalHost, logLevel: 'info',
});
await build({
  entryPoints: ['src/host/compaction.ts'], outfile: 'lib/compaction.js',
  bundle: true, platform: 'node', format: 'esm', target: 'node22',
  packages: 'external', sourcemap: true,
});
await build({
  entryPoints: ['src/host/canvases.ts'], outfile: 'lib/canvases.js',
  bundle: true, platform: 'node', format: 'esm', target: 'node22',
  packages: 'external', sourcemap: true,
});
await build({
  entryPoints: ['vendor/agent-instructions/index.mjs'], outfile: 'lib/project-rules.js',
  bundle: true, platform: 'node', format: 'esm', target: 'node22',
  packages: 'external', sourcemap: true,
});
await build({
  entryPoints: ['vendor/tool-subagent/index.js'], outfile: 'lib/subagent.js',
  bundle: true, platform: 'node', format: 'esm', target: 'node22',
  packages: 'external', sourcemap: true,
});
await mkdir('lib/workers', { recursive: true });
await copyFile('src/workers/file-memory-parser.mjs', 'lib/workers/file-memory-parser.mjs');
await build({
  entryPoints: ['src/domain/runtime/presets/host.ts'], outfile: 'lib/preset-runtime.js',
  bundle: true, platform: 'node', format: 'esm', target: 'node22',
  packages: 'external', sourcemap: true,
  plugins: [{ name: 'nexus-shared-authority', setup(builder) {
    builder.onResolve({ filter: /host\/host-adapter\.js$/ }, () => ({ path: './index.js', external: true }));
  } }],
});
await build({
  entryPoints: ['src/workers/isolated-extension.ts'],
  outfile: 'lib/workers/isolated-extension.js',
  bundle: true, platform: 'node', format: 'esm', target: 'node22', packages: 'external', sourcemap: true,
});
await build({
  entryPoints: ['src/workers/storage-worker.ts'], outfile: 'lib/workers/storage-worker.js',
  bundle: true, platform: 'node', format: 'esm', target: 'node22', packages: 'external', sourcemap: true,
});
const client = await build({
  entryPoints: ['src/client/index.tsx'], outfile: 'lib/client.js',
  loader: { '.png': 'dataurl' },
  bundle: true, platform: 'browser', format: 'cjs', target: 'es2022',
  sourcemap: true, metafile: true, jsx: 'automatic', jsxImportSource: '@nexus/i18n',
  alias: { '@nexus/i18n/jsx-runtime': resolve('src/client/jsx-runtime.ts') },
  external: shared, define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.MODE': '"production"' },
  banner: { js: `window.__ModuleLoader__.load({id:${JSON.stringify(manifest.name)},factory:(require)=>{var module={exports:{}};var exports=module.exports;` },
  footer: { js: 'return module.exports;}});' },
  plugins: [{
    name: 'nexus-css-owner',
    setup(builder) {
      builder.onLoad({ filter: /\.css$/ }, async args => ({
        loader: 'js',
        contents: `export default ${JSON.stringify(await readFile(args.path, 'utf8'))};`,
      }));
    },
  }],
  logLevel: 'info',
});
await canonicalizeSourceMapFile('lib/client.js.map');
const buildInfo = {
  package: manifest.name, version: manifest.version, dsh: manifest.engines.dsh,
  node: process.version, builtAt: new Date().toISOString(),
  hostInputs: Object.keys(host.metafile.inputs).sort(),
  clientInputs: Object.keys(client.metafile.inputs).sort(),
};
for (const path of ['lib/index.js', 'lib/client.js']) {
  buildInfo[path] = createHash('sha256').update(await readFile(path)).digest('hex');
}
await writeFile('lib/build-info.json', JSON.stringify(buildInfo, null, 2) + '\n');
