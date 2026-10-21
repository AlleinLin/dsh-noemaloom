import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { NativeDockPopover } from '../../src/client/native-dock-popover.js';
import css from '../../src/client/native-docking.css';

// Real Chromium fixture used only by desktop-dock-regression.mjs. The frame
// recreates the native strip's clipping, transformed ancestor and input scope.
const frame = document.createElement('iframe');
frame.id = 'nexus-r24-fixture';
frame.style.cssText = 'position:fixed;inset:80px auto auto 40px;width:620px;height:480px;border:0;z-index:100000';
document.body.append(frame);
const owner = frame.contentDocument!;
owner.body.innerHTML = '<div id="root"></div>';
const style = owner.createElement('style');
style.textContent = css + `
  body { margin:0; font:14px sans-serif; background:#eee; }
  .fixture-panel { height:460px; pointer-events:none; overflow:clip; transform:translateZ(0); }
  .fixture-pane { height:100%; pointer-events:none; position:relative; }
  .fixture-strip { height:34px; display:flex; justify-content:flex-end; overflow:hidden; }
  #nexus-r24-target { display:block; margin:20px; width:160px; height:36px; pointer-events:auto; }
  #nexus-r24-scroll { margin:20px; width:180px; height:180px; overflow:auto; pointer-events:auto; }
`;
owner.head.append(style);
const root = createRoot(owner.getElementById('root')!);
let active = true, mounted = true, identity = 'synthetic-owner-a', clicks = 0, drags = 0;
function draw() {
  flushSync(() => root.render(<div className="fixture-panel"><div className="fixture-pane">
    <div className="fixture-strip" onPointerDown={() => { drags++; }}>
      {mounted && <NativeDockPopover active={active} identity={identity} title="分栏与布局">
        {dismiss => <><button type="button" id="nexus-r24-action" onClick={dismiss}>完成布局</button>
          <label>会话视图<select><option>对话</option><option>上下文</option></select></label>
          <div style={{ height: 180 }}>布局内容</div></>}
      </NativeDockPopover>}
    </div>
    <button type="button" id="nexus-r24-target" onClick={() => { clicks++; }}>交互探针</button>
    <div id="nexus-r24-scroll"><div style={{ height: 1600 }}>滚动探针</div></div>
  </div></div>));
}
draw();
(window as any).__nexusDockRegression = {
  frame, owner,
  snapshot: () => ({ clicks, drags, active, mounted, identity,
    open: !!owner.querySelector('.nexus-native-dock-menu:popover-open'),
    menus: owner.querySelectorAll('.nexus-native-dock-menu').length,
    scrollTop: owner.getElementById('nexus-r24-scroll')?.scrollTop,
    bodyInert: owner.body.inert, bodyPointerEvents: getComputedStyle(owner.body).pointerEvents }),
  active(value: boolean) { active = value; draw(); },
  identity(value: string) { identity = value; draw(); },
  mounted(value: boolean) { mounted = value; draw(); },
  dispose() { flushSync(() => root.unmount()); frame.remove(); delete (window as any).__nexusDockRegression; },
};
