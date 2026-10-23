import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { NativeDockPopover } from '../../src/client/native-dock-popover.js';
import { AgentInsightsProvider, AgentFacts } from '../../src/client/AgentInsights.js';
import css from '../../src/client/native-docking.css';
// @ts-expect-error Test virtual module contains the actual adapted vendor gate.
import { installGate } from 'nexus:test-drag-gate';

installGate();
let tabPresses = 0, tabMoves = 0, canvasClicks = 0;
let active = true;
const calls: any[] = [];
const snapshot = { byId: { child: { origin: 'subagent', parentId: 'main' } }, projectionsBySession: {
  child: { values: { contextPressure: { projectedTokens: 0, contextWindow: 500000 },
    contextBreakdown: { systemTokens: 4700, toolsTokens: 28600, messageTokens: 244100 } } },
} };
const generation = { id: 1 };
const ctx = {
  sessions: { list: { getSnapshot: () => snapshot, subscribe: () => () => {} } },
  connection: { generation: { getSnapshot: () => generation, subscribe: () => () => {} },
    rpc: { async call(_channel: string, _method: string, request: any) {
      calls.push(request);
      const action = request.payload.action, domain = request.payload.params.domain;
      const value = domain === 'insights' && action === 'settings' ? { automatic: false, maxCallsPerDay: 24, local: { revision: 0 } }
        : domain === 'insights' && action === 'get' ? { state: 'ready', summary: {
          goal: '核对原始记录'.repeat(50), currentWork: '分析当前任务'.repeat(30), nextStep: '复核'.repeat(50),
          plan: Array.from({ length: 8 }, (_, i) => `步骤 ${i + 1}：${'原始证据'.repeat(15)}`),
        } } : domain === 'autonomy' ? { items: [], enabled: false } : { items: [] };
      return { ok: true, value };
    } } },
};
const root = createRoot(document.getElementById('root')!);
const draw = () => flushSync(() => root.render(<>
  <style>{css}{`
    body { margin:0; background:#211f1d; --dsw-alias-bg-layer-1:#292724; --dsw-alias-label-primary:#e7ded4; }
    .strip {position:fixed;right:30px;top:45px;width:440px;height:34px;display:flex;justify-content:flex-end;transform:translateZ(0);overflow:hidden}
    .canvas {position:absolute;left:600px;top:160px;width:440px;transform:scale(.42);transform-origin:top left}
    [data-dockkit-tab] {padding:8px;background:#444;color:white;touch-action:none}
  `}</style>
  <div className="strip"><div data-dockkit-tab="probe" onPointerDown={event => {
    tabPresses++;
    const move = () => { tabMoves++; };
    const done = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', done); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', done);
  }}>任务管理</div>
    <NativeDockPopover active identity="main" title="分栏与布局">{dismiss =>
      <><button onClick={dismiss}>并排分栏</button><label>会话<select><option>主会话</option><option>子代理</option></select></label>
        <div style={{ height: 260 }}>布局</div></>}</NativeDockPopover>
  </div>
  <div className="canvas" onClick={() => canvasClicks++}><AgentInsightsProvider ctx={ctx} sessionId="main" active={active}>
    <AgentFacts node={{ id: 'child', depth: 1, state: 'running', label: '子代理' }} />
  </AgentInsightsProvider></div>
  <button id="outside" style={{ position: 'fixed', bottom: 12, left: 12 }}>交互探针</button>
</>));
draw();
(window as any).__interactions = {
  snapshot: () => ({ tabPresses, tabMoves, canvasClicks, calls }),
  active(value: boolean) { active = value; draw(); },
  dispose: () => flushSync(() => root.unmount()),
};
