import { nativeAppearance, type NativeAppearance } from '../shared/native-appearance.js';
import { boundedRead } from '../shared/bounded-read.js';
import type { NexusApi } from './types.js';

const KEY = 'dsh-nexus:native-appearance:v1';
let saved = nativeAppearance();
try { saved = nativeAppearance(JSON.parse(localStorage.getItem(KEY) ?? '{}')); } catch {}
let preview: NativeAppearance | undefined;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(listener => listener());
export const getNativeAppearance = () => preview ?? saved;
export const subscribeNativeAppearance = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function saveNativeAppearance(value: Record<string, any>) {
  saved = nativeAppearance(value);
  try { localStorage.setItem(KEY, JSON.stringify(saved)); } catch {}
  emit();
}
/** Drafts are local to this renderer and never written to storage or the host. */
export function previewNativeAppearance(value?: Record<string, any>) {
  preview = value ? nativeAppearance(value) : undefined; emit();
}
export function installNativeAppearance(api: NexusApi): () => void {
  let controller: AbortController | undefined, disposed = false;
  const read = () => {
    controller?.abort(); controller = new AbortController(); const signal = controller.signal;
    void boundedRead(waitSignal => api.call('resources', 'themes.config', {}, { scope: { level: 'global' }, signal: waitSignal }),
      { signal, timeoutMs: 10000, timeout: () => new Error('外观读取超时'), cancelled: () => new Error('外观读取已取消') })
      .then(value => { if (!disposed && !signal.aborted) saveNativeAppearance(value); }).catch(() => {});
  };
  const stop = api.subscribe(read); read();
  return () => { disposed = true; controller?.abort(); stop(); previewNativeAppearance(); };
}
