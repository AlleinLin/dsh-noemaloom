import * as React from 'react';
import { createPortal } from 'react-dom';
import type { DockLayout, DockPane, DockTab } from './dock-model.js';

interface NativeTreeProps {
  kit: { DockSurface: React.ComponentType<any>; FloatLayer: React.ComponentType<any> };
  state: DockLayout;
  active?: boolean;
  keepMounted?(tab: DockTab): boolean;
  renderTab(tab: DockTab): React.ReactNode;
  [key: string]: any;
}
interface TabContainer { element: HTMLDivElement }

/** This native pane is only a landing point; it never owns the viewer's React identity. */
function DockLanding({ container }: { container: TabContainer }) {
  const landing = React.useRef<HTMLDivElement>(null);
  React.useLayoutEffect(() => {
    const element = landing.current!;
    element.appendChild(container.element);
    return () => {
      if (container.element.parentNode === element) element.removeChild(container.element);
    };
  }, [container]);
  return <div ref={landing} className="nexus-native-dock-landing" />;
}

function StableNativeTab({ tab, pane, container, state, active = true, retained, renderTab, intents }: {
  tab: DockTab; pane: DockPane; container: TabContainer; state: DockLayout; active?: boolean;
  retained: boolean; renderTab(tab: DockTab): React.ReactNode;
  intents: { focusPane(id: string): void };
}) {
  const selected = pane.host === 'float' || pane.activeTabId === tab.id;
  const visible = active && selected && (pane.host === 'float' || state.expanded);
  const [visited, setVisited] = React.useState(visible);
  if (visible && !visited) setVisited(true);
  React.useLayoutEffect(() => {
    const element = container.element;
    element.inert = !visible;
    element.setAttribute('aria-hidden', String(!visible));
    const focused = document.activeElement;
    if (!visible && focused instanceof HTMLElement && element.contains(focused)) focused.blur();
  }, [container, visible]);
  React.useLayoutEffect(() => {
    const element = container.element;
    const focusPane = () => {
      if (visible && (pane.host === 'float' || state.activePaneId !== pane.id)) intents.focusPane(pane.id);
    };
    // Portal events follow the React owner rather than the destination pane;
    // native DOM capture preserves the original pane focus/float raise rule.
    element.addEventListener('pointerdown', focusPane, true);
    element.addEventListener('focus', focusPane, true);
    return () => {
      element.removeEventListener('pointerdown', focusPane, true);
      element.removeEventListener('focus', focusPane, true);
    };
  }, [container, visible, pane.id, pane.host, state.activePaneId, intents]);
  React.useLayoutEffect(() => () => { container.element.remove(); }, [container]);
  // Match native TabHost's lazy visitation and retention policy. The portal
  // target and keyed owner survive pane-tree changes, docking and floating.
  return createPortal(visited && (retained || active && selected) ? renderTab(tab) : null, container.element, tab.id);
}

/**
 * The native recursive renderer handles tree geometry and every gesture.
 * Native business viewers stay in one keyed portal per tab instead of being
 * owned by the recursive pane that happens to display them.
 */
export function NativeDockTree({ kit, ...props }: NativeTreeProps) {
  const containers = React.useRef(new Map<string, TabContainer>());
  const getContainer = (id: string) => {
    let container = containers.current.get(id);
    if (!container) {
      const element = document.createElement('div');
      element.className = 'nexus-native-dock-portal';
      element.dataset.nexusNativeDockTab = id;
      container = { element };
      containers.current.set(id, container);
    }
    return container;
  };
  const renderLanding = (tab: DockTab) => <DockLanding key={tab.id} container={getContainer(tab.id)} />;
  const { DockSurface, FloatLayer } = kit;
  const state = props.state;
  React.useLayoutEffect(() => {
    for (const [id, container] of containers.current) if (!state.tabs[id]) {
      container.element.remove();
      containers.current.delete(id);
    }
  }, [state.tabs]);
  return <>
    <div className="nexus-native-dock-tree" data-dockkit-host="dock">
      <DockSurface {...props} renderTab={renderLanding} />
    </div>
    <FloatLayer {...props} renderTab={renderLanding} />
    {Object.values(state.tabs).sort((a, b) => a.id.localeCompare(b.id)).map(tab => {
      const pane = Object.values(state.nodes).find((node): node is DockPane => node.kind === 'pane' && node.tabs.includes(tab.id));
      if (!pane) return null;
      return <StableNativeTab key={tab.id} tab={tab} pane={pane} container={getContainer(tab.id)}
        state={state} active={props.active} retained={props.keepMounted?.(tab) ?? false} renderTab={props.renderTab} intents={props.intents} />;
    })}
  </>;
}
