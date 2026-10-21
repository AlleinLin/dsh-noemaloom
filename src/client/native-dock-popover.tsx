import * as React from 'react';

/**
 * A non-modal top-layer surface. The browser owns outside/Escape dismissal;
 * nothing acquires a document-wide input lock or a dock drag gesture.
 */
export function NativeDockPopover({ active, identity, title, children }: {
  active: boolean; identity: string; title: string;
  children(dismiss: () => void): React.ReactNode;
}) {
  const id = React.useId();
  const trigger = React.useRef<HTMLButtonElement>(null);
  const menu = React.useRef<HTMLDivElement>(null);
  const [open, setOpen] = React.useState(false);
  const dismiss = React.useCallback(() => {
    const element = menu.current;
    if (element?.matches(':popover-open')) element.hidePopover();
  }, []);
  const position = React.useCallback(() => {
    const element = menu.current;
    const button = trigger.current;
    if (!element || !button) return;
    const rect = button.getBoundingClientRect();
    const viewport = button.ownerDocument.defaultView!;
    element.style.top = `${Math.min(rect.bottom + 4, Math.max(8, viewport.innerHeight - 80))}px`;
    element.style.right = `${Math.max(8, viewport.innerWidth - rect.right)}px`;
    element.style.maxHeight = `${Math.max(64, viewport.innerHeight - rect.bottom - 12)}px`;
  }, []);
  React.useLayoutEffect(() => {
    // Native seats remain mounted when hidden. A popover must never outlive
    // its visible owner, including a switch to another session.
    if (!active) dismiss();
    return dismiss;
  }, [active, identity, dismiss]);
  React.useEffect(() => {
    if (!open) return;
    const viewport = trigger.current!.ownerDocument.defaultView!;
    viewport.addEventListener('resize', dismiss);
    return () => { viewport.removeEventListener('resize', dismiss); };
  }, [open, dismiss]);
  return <div className="nexus-native-dock-controls" onPointerDown={event => event.stopPropagation()}>
    <button ref={trigger} type="button" aria-label="分栏与布局" title={title}
      aria-expanded={open} aria-controls={id} popoverTarget={id} disabled={!active}>⊞</button>
    <div ref={menu} id={id} popover="auto" role="group" aria-label="分栏与布局"
      className="nexus-native-dock-menu"
      onBeforeToggle={event => { if ((event.nativeEvent as ToggleEvent).newState === 'open') position(); }}
      onToggle={event => setOpen((event.nativeEvent as ToggleEvent).newState === 'open')}>
      {children(dismiss)}
    </div>
  </div>;
}
