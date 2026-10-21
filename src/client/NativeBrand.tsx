import * as React from 'react';
import { createPortal } from 'react-dom';
import mark from '../../assets/brand/nexus-mark-256.png';
import { getNativeAppearance, subscribeNativeAppearance } from './native-appearance.js';
import { NATIVE_APPEARANCE_DEFAULTS } from '../shared/native-appearance.js';

/** A generated image, rendered as a mask so the host can select the ink color. */
export function NativeBrandMark({ size = 24, anchorRef }: { size?: number; className?: string; anchorRef?: React.Ref<HTMLSpanElement> }) {
  return <span ref={anchorRef} role="img" aria-label="DSH Nexus" data-nexus-brand-mark="" style={{
    display: 'inline-block', flex: 'none', width: size, height: size,
    backgroundColor: 'var(--nexus-brand-color, #c66a4a)',
    maskImage: `url("${mark}")`, maskSize: 'contain', maskRepeat: 'no-repeat', maskPosition: 'center',
  }} />;
}

export function NativeBrandName({ nativeComponent: NativeName, ...nativeProps }: { nativeComponent?: React.ComponentType<any>; [key: string]: any }) {
  const value = React.useSyncExternalStore(subscribeNativeAppearance, getNativeAppearance, getNativeAppearance);
  if (NativeName && value.sidebarBrandText === NATIVE_APPEARANCE_DEFAULTS.sidebarBrandText) {
    return <span data-nexus-sidebar-brand="" style={{ display: 'inline-flex', maxWidth: '100%', color: value.sidebarBrandColor }}>
      <NativeName {...nativeProps} />
    </span>;
  }
  return <span data-nexus-sidebar-brand="" style={{ display: 'flex', alignItems: 'baseline', flexWrap: 'wrap', gap: '4px 7px', minWidth: 0 }}>
    <span data-nexus-sidebar-brand-text="" style={{ color: value.sidebarBrandColor, overflowWrap: 'anywhere', whiteSpace: 'normal', fontSize: 19, lineHeight: 1.25 }}>{value.sidebarBrandText}</span>
    <span style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 9, letterSpacing: '.12em', flex: 'none' }}>HARNESS</span>
  </span>;
}

/** rc.2 exposes only the hero mark seat. Locate its own containing headline;
 * attach React-owned text seats beside the two native text spans. Removing
 * this component restores the original locale-owned nodes and styles. */
export function NativeHeroBrand(props: { size?: number }) {
  const value = React.useSyncExternalStore(subscribeNativeAppearance, getNativeAppearance, getNativeAppearance);
  const anchor = React.useRef<HTMLSpanElement>(null);
  const [targets, setTargets] = React.useState<{ title?: HTMLSpanElement; badge?: HTMLSpanElement }>({});
  React.useLayoutEffect(() => {
    const headline = anchor.current?.closest<HTMLElement>('[class$="_headline"]');
    if (!headline || !headline.contains(anchor.current)) return;
    const group = headline.querySelector<HTMLElement>(':scope > [class$="_titleGroup"]');
    const title = group?.children[0] as HTMLElement | undefined, badge = group?.children[1] as HTMLElement | undefined;
    if (!group || title?.tagName !== 'SPAN' || badge?.tagName !== 'SPAN'
      || !badge.className.split(/\s+/).some(name => name.endsWith('_previewBadge'))) return;
    const cleanups: Array<() => void> = [], next: typeof targets = {};
    const hide = (node: HTMLElement) => {
      const previous = node.style.display; node.style.display = 'none'; cleanups.push(() => { node.style.display = previous; });
    };
    const seat = (node: HTMLElement, key: 'title' | 'badge') => {
      const target = document.createElement('span'); target.dataset[key === 'title' ? 'nexusHomeTitle' : 'nexusHomeBadge'] = '';
      target.className = node.className; group.insertBefore(target, node); next[key] = target;
      cleanups.push(() => target.remove()); hide(node);
    };
    if (value.homeTitle !== null) seat(title, 'title');
    if (!value.homeBadgeEnabled) hide(badge);
    else if (value.homeBadgeText !== null) seat(badge, 'badge');
    setTargets(next);
    return () => { for (const cleanup of cleanups.reverse()) cleanup(); };
  }, [value]);
  return <><NativeBrandMark {...props} anchorRef={anchor} />
    {targets.title && value.homeTitle !== null ? createPortal(value.homeTitle, targets.title) : null}
    {targets.badge && value.homeBadgeEnabled && value.homeBadgeText !== null ? createPortal(value.homeBadgeText, targets.badge) : null}
  </>;
}

