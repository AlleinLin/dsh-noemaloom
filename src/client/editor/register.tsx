import * as React from 'react';
import type { ClientContext, NexusApi } from '../types.js';
import { nativeEditorExtensions } from '../../shared/editor-extensions.js';

const ID = 'nexus-monaco-editor-v1';
const reactKey = Symbol.for('dsh-nexus.editor.react');
interface Assets {
  refs: number; disposed: boolean; controller: AbortController; workers: Set<Worker>; styles: Set<HTMLLinkElement>;
  barrier: Promise<void>; loading?: Promise<any>; module?: any;
  environment?: any; previousEnvironment?: any; previousReact?: any; installed?: boolean;
}
let current: Assets | undefined;
let teardown: Promise<void> = Promise.resolve();
function acquire() {
  const assets = current ??= { refs: 0, disposed: false, controller: new AbortController(), workers: new Set(), styles: new Set(), barrier: teardown };
  assets.refs++;
  return assets;
}
function releaseResources(assets: Assets) {
  for (const worker of assets.workers) worker.terminate();
  assets.workers.clear();
  for (const style of assets.styles) style.remove();
  assets.styles.clear();
  if (assets.installed) {
    if ((globalThis as any).MonacoEnvironment === assets.environment) (globalThis as any).MonacoEnvironment = assets.previousEnvironment;
    if ((globalThis as any)[reactKey] === React) (globalThis as any)[reactKey] = assets.previousReact;
    assets.installed = false;
  }
}
function release(assets: Assets) {
  if (--assets.refs > 0 || assets.disposed) return;
  assets.disposed = true; assets.controller.abort();
  if (current === assets) current = undefined;
  teardown = (async () => {
    try {
      const module = assets.module ?? await assets.loading?.catch(() => undefined);
      await module?.disposeEditorRuntime?.();
    } finally { releaseResources(assets); }
  })().catch(() => {}); // Host/browser drafts remain available even when a late flush is cancelled.
}
function load(assets: Assets) {
  return assets.loading ??= (async () => {
    await assets.barrier;
    assets.controller.signal.throwIfAborted();
    const response = await fetch('/nexus/editor/manifest.json', { credentials: 'same-origin', cache: 'no-store', signal: assets.controller.signal });
    if (!response.ok) throw new Error('Local editor assets unavailable');
    const manifest = await response.json();
    const path = (value: unknown) => {
      if (typeof value !== 'string' || !/^[A-Za-z0-9_./-]+$/.test(value) || value.includes('..')) throw new Error('Invalid local editor manifest');
      return `/nexus/editor/${value}`;
    };
    if (manifest.schema !== 1) throw new Error('Unsupported editor asset manifest');
    assets.controller.signal.throwIfAborted();
    assets.previousReact = (globalThis as any)[reactKey];
    assets.previousEnvironment = (globalThis as any).MonacoEnvironment;
    (globalThis as any)[reactKey] = React;
    assets.environment = {
      getWorker(_module: string, label: string) {
        assets.controller.signal.throwIfAborted();
        const kind = ['typescript', 'javascript'].includes(label) ? 'typescript' : ['css', 'scss', 'less'].includes(label) ? 'css'
          : ['html', 'handlebars', 'razor'].includes(label) ? 'html' : label === 'json' ? 'json' : 'core';
        const worker = new Worker(path(manifest.workers[kind]), { type: 'module', name: `nexus-${kind}` });
        const terminate = worker.terminate.bind(worker);
        worker.terminate = () => { assets.workers.delete(worker); terminate(); };
        assets.workers.add(worker); return worker;
      },
    };
    (globalThis as any).MonacoEnvironment = assets.environment; assets.installed = true;
    if (manifest.css) {
      const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = path(manifest.css); link.dataset.nexusEditor = '';
      assets.styles.add(link);
      await new Promise<void>((resolve, reject) => {
        const abort = () => { cleanup(); reject(new Error('Editor stylesheet loading cancelled')); };
        const cleanup = () => { link.onload = null; link.onerror = null; assets.controller.signal.removeEventListener('abort', abort); };
        link.onload = () => { cleanup(); resolve(); };
        link.onerror = () => { cleanup(); reject(new Error('Editor stylesheet unavailable')); };
        assets.controller.signal.addEventListener('abort', abort, { once: true }); document.head.append(link);
      });
    }
    assets.controller.signal.throwIfAborted();
    // Kept opaque to the main CJS build: Monaco and UI are a genuine separate ESM boundary.
    const module = await (new Function('url', 'return import(url)') as (url: string) => Promise<any>)(path(manifest.entry));
    assets.module = module;
    assets.controller.signal.throwIfAborted();
    return module;
  })().catch(error => { releaseResources(assets); assets.loading = undefined; throw error; });
}
function EditorLoader({ assets, ...props }: any) {
  const [state, setState] = React.useState<{ module?: any; error?: string }>({});
  React.useEffect(() => {
    let mounted = true;
    void load(assets).then(module => { if (mounted && !assets.disposed) setState({ module }); }, error => { if (mounted && !assets.disposed) setState({ error: error.message }); });
    return () => { mounted = false; };
  }, [assets]);
  if (state.error) return <p role="alert">{state.error}</p>;
  if (!state.module) return <p aria-live="polite">加载本地编辑器…</p>;
  return <state.module.Editor {...props} />;
}
/** Native renderer only. Tabs, splits, floating panes and resource identity remain native. */
export function registerEditor(ctx: ClientContext, api: NexusApi): () => void {
  const assets = acquire(), disposers: Array<() => void> = [];
  const disposeOf = (value: any) => typeof value === 'function' ? value : typeof value?.dispose === 'function' ? () => value.dispose() : () => {};
  const Loader = (props: any) => <EditorLoader {...props} assets={assets} />;
  const activate = (context: any) => context.effect(() => {
    const previews = context.documentPreviews ?? context.get?.('documentPreviews');
    if (!previews) return;
    const local = [previews.register({ id: ID, extensions: nativeEditorExtensions, priority: 'extension', title: () => '代码编辑器', loading: 'renderer', wrap: false }),
      context.slots.inject('sidebar.right.tab.document', () => context.slots.register({
      name: 'sidebar.right.tab.document', key: ID, inject: (sessionId: string) => ({ sessionId, api }),
    }, Loader))];
    let active = true;
    return () => { if (!active) return; active = false; for (const value of local.reverse()) disposeOf(value)(); };
  });
  if (ctx.inject) disposers.push(disposeOf(ctx.inject(['documentPreviews'], activate)));
  else if (ctx.get?.('documentPreviews')) disposers.push(disposeOf(activate(ctx)));
  let active = true;
  return () => {
    if (!active) return; active = false;
    for (const dispose of disposers.reverse()) dispose();
    release(assets);
  };
}
