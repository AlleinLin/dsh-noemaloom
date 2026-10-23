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
    // Reset all four insets: native popover defaults and host styles must not
    // combine a right anchor with a stale/default left coordinate.
    Object.assign(element.style, { position: 'fixed', inset: 'auto', margin: '0',
      maxHeight: `${Math.max(64, viewport.innerHeight - 16)}px` });
    const width = element.offsetWidth || Math.min(232, viewport.innerWidth - 16);
    const height = element.offsetHeight || 80;
    const below = viewport.innerHeight - rect.bottom - 12;
    const top = height <= below || below >= rect.top - 12
      ? rect.bottom + 4 : rect.top - height - 4;
    element.style.left = `${Math.max(8, Math.min(rect.right - width, viewport.innerWidth - width - 8))}px`;
    element.style.top = `${Math.max(8, Math.min(top, viewport.innerHeight - height - 8))}px`;
  }, []);
  React.useLayoutEffect(() => {
    const element = menu.current!;
    // DSH can supply an older shared React runtime. Native listeners work
    // even when that runtime does not implement onBeforeToggle/onToggle.
    const toggle = () => {
      const shown = element.matches(':popover-open');
      if (shown) position();
      setOpen(shown);
    };
    element.addEventListener('toggle', toggle);
    return () => element.removeEventListener('toggle', toggle);
  }, [position]);
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
      aria-expanded={open} aria-controls={id} disabled={!active}
      onClick={() => {
        const element = menu.current!;
        if (element.matches(':popover-open')) { dismiss(); return; }
        position();
        element.showPopover();
        position();
        setOpen(true);
      }}>⊞</button>
    <div ref={menu} id={id} popover="auto" role="group" aria-label="分栏与布局"
      className="nexus-native-dock-menu">
      {children(dismiss)}
    </div>
  </div>;
}
