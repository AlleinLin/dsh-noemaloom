import { build } from 'esbuild';
import { mkdir, readFile, writeFile, readdir, copyFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, relative, resolve, dirname } from 'node:path';

export async function buildEditor() {
  const root = resolve('lib/editor');
  if (dirname(root) !== resolve('lib')) throw new Error('Editor output must stay inside lib');
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  const reactShim = {
    name: 'native-editor-react-instance',
    setup(builder) {
      builder.onResolve({ filter: /^react(?:\/jsx-runtime)?$/ }, args => ({ path: args.path, namespace: 'host-react' }));
      builder.onLoad({ filter: /.*/, namespace: 'host-react' }, args => ({
        loader: 'js', contents: args.path === 'react'
          ? `const React=globalThis[Symbol.for("dsh-nexus.editor.react")];if(!React)throw new Error("Native React unavailable");export default React;export const {createElement,Fragment,useState,useEffect,useLayoutEffect,useMemo,useCallback,useRef,useSyncExternalStore,Suspense,lazy,Component}=React;`
          : `const R=globalThis[Symbol.for("dsh-nexus.editor.react")];export const Fragment=R.Fragment;export function jsx(type,props,key){return R.createElement(type,{...props,key})}export const jsxs=jsx;`,
      }));
    },
  };
  const entries = {
    editor: 'src/client/editor/Editor.tsx',
    'worker-core': 'node_modules/monaco-editor/esm/vs/editor/editor.worker.js',
    'worker-typescript': 'node_modules/monaco-editor/esm/vs/languages/features/typescript/ts.worker.js',
    'worker-json': 'node_modules/monaco-editor/esm/vs/languages/features/json/json.worker.js',
    'worker-css': 'node_modules/monaco-editor/esm/vs/languages/features/css/css.worker.js',
    'worker-html': 'node_modules/monaco-editor/esm/vs/languages/features/html/html.worker.js',
  };
  const result = await build({ entryPoints: entries, outdir: root, entryNames: '[name]-[hash]', chunkNames: 'chunks/[name]-[hash]', assetNames: 'assets/[name]-[hash]',
    bundle: true, splitting: true, platform: 'browser', format: 'esm', target: 'es2022', jsx: 'automatic',
    loader: { '.ttf': 'file' }, metafile: true, minify: true, legalComments: 'eof',
    plugins: [reactShim], define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'info' });
  const assets = [];
  const workers = {};
  let entry, css;
  for (const [path, output] of Object.entries(result.metafile.outputs)) {
    const file = relative(root, resolve(path)).replaceAll('\\', '/');
    const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.ttf') ? 'font/ttf' : undefined;
    if (!type) throw new Error(`Unrecognized editor output ${file}`);
    const body = await readFile(path);
    assets.push({ file, type, size: body.length, sha256: createHash('sha256').update(body).digest('hex') });
    for (const [name, source] of Object.entries(entries)) {
      if (output.entryPoint?.replaceAll('\\', '/') !== source) continue;
      if (name === 'editor') { entry = file; css = output.cssBundle ? relative(root, resolve(output.cssBundle)).replaceAll('\\', '/') : undefined; }
      else workers[name.slice(7)] = file;
    }
  }
  if (!entry || Object.keys(workers).length !== 5) throw new Error('Editor output is incomplete');
  await writeFile(join(root, 'manifest.json'), JSON.stringify({ schema: 1, monaco: '0.57.0', entry, css, workers, assets }, null, 2) + '\n');
  const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
  const packages = ['monaco-editor', 'tar', '@isaacs/fs-minipass', 'chownr', 'minipass', 'minizlib', 'yallist',
    'monaco-editor/node_modules/dompurify', 'monaco-editor/node_modules/marked'];
  const notices = [];
  for (const name of packages) {
    const packageRoot = join('node_modules', name), pkg = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
    const pinned = lock.packages[`node_modules/${name}`];
    if (!pinned?.integrity || pinned.version !== pkg.version) throw new Error(`Editor dependency lock mismatch: ${name}`);
    const destination = join('notices/editor', name.replaceAll('/', '__')); await mkdir(destination, { recursive: true });
    const files = (await readdir(packageRoot)).filter(file => /^(?:licen[cs]e(?:[.-].*)?|ThirdPartyNotices\.txt)$/i.test(file));
    if (!files.length) throw new Error(`Missing license for ${name}`);
    const hashes = {};
    for (const file of files) {
      await copyFile(join(packageRoot, file), join(destination, file));
      hashes[file] = createHash('sha256').update(await readFile(join(destination, file))).digest('hex');
    }
    const source = { name, version: pkg.version, license: pkg.license, resolved: pinned.resolved, integrity: pinned.integrity, files: hashes };
    await writeFile(join(destination, 'SOURCE.json'), JSON.stringify(source, null, 2) + '\n'); notices.push(source);
  }
  await writeFile('notices/editor/SOURCE.json', JSON.stringify({ schema: 1, packages: notices }, null, 2) + '\n');
  return { monaco: '0.57.0', inputs: Object.keys(result.metafile.inputs).sort(),
    manifestSha256: createHash('sha256').update(await readFile(join(root, 'manifest.json'))).digest('hex') };
}
