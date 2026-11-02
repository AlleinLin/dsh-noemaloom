import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { registerContextMaintenance } from '../../src/client/ContextMaintenance.js';
import css from '../../src/client/native-chrome.css';
import type { ClientContext, NexusApi } from '../../src/client/types.js';

const calls: any[] = [], controls: any[] = [];
let checking = false, complete = false, resolveResume: ((value: any) => void) | undefined;
const api = {
  subscribe: () => () => {}, getGeneration: () => 1,
  async call(domain: string, action: string, params: any, options: any) {
    calls.push({ domain, action, params, scope: options.scope, requestId: options.requestId });
    if (action === 'maintenance/status') return {
      occupancyPercent: null, windowTokens: null, occupiedTokens: null,
      recovery: complete ? { state: 'available' } : {
        state: checking ? 'checking' : 'resume-required', available: !checking,
        message: checking ? '正在检查原步骤的上下文' : '原步骤已暂停，输入与工具结果仍保留。',
      },
    };
    if (action === 'maintenance/resume') {
      checking = true;
      return new Promise(resolve => { resolveResume = resolve; });
    }
    if (domain === 'scope' && action === 'settings') return { local: { revision: 0, config: {} }, effective: {} };
    return { items: [] };
  },
} as unknown as NexusApi;
const ctx = {
  sessions: { binding: (id: string) => ({ sessionId: id }) },
  slots: { inject: (_name: string, mount: () => any) => mount(), register: (_seat: any, control: any) => {
    controls.push(control); return () => {};
  } },
} as unknown as ClientContext;
const runtime = registerContextMaintenance(ctx, api), Control = controls[0];
const root = createRoot(document.getElementById('root')!);
flushSync(() => root.render(<><style>{css}{'body{background:#211f1d;color:#eee;}'}</style>
  <Control sessionId="main" /><Control sessionId="paused-child" /></>));
(window as any).__recovery = {
  calls: () => calls,
  async finish() {
    complete = true;
    resolveResume?.({ queued: true, state: 'checking' });
  },
  dispose() { flushSync(() => root.unmount()); runtime.dispose(); },
};
