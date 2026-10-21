import * as React from 'react';
import type { Data } from './types.js';
import { Button } from './components.js';
import { NATIVE_APPEARANCE_DEFAULTS, nativeAppearance } from '../shared/native-appearance.js';

export function NativeAppearanceControls({ draft, update }: { draft: Data; update(value: Data): void }) {
  const value = nativeAppearance(draft);
  return <fieldset data-nexus-native-appearance-controls=""><legend>品牌与首页</legend>
    <div className="nexus-setting-row"><label htmlFor="nexus-sidebar-brand">侧栏品牌文字</label><div className="nexus-setting-controls">
      <input id="nexus-sidebar-brand" aria-label="侧栏品牌文字" maxLength={128} value={draft.sidebarBrandText ?? value.sidebarBrandText} onChange={event => update({ sidebarBrandText: event.target.value })} />
      <Button onClick={() => update({ sidebarBrandText: NATIVE_APPEARANCE_DEFAULTS.sidebarBrandText })}>默认文字</Button></div></div>
    <div className="nexus-setting-row"><label htmlFor="nexus-brand-hex">品牌文字颜色</label><div className="nexus-setting-controls">
      <input type="color" aria-label="选择品牌文字颜色" value={value.sidebarBrandColor} onChange={event => update({ sidebarBrandColor: event.target.value })} />
      <input id="nexus-brand-hex" aria-label="品牌文字颜色十六进制" placeholder="#c66a4a" maxLength={7} value={draft.sidebarBrandColor ?? value.sidebarBrandColor} onChange={event => update({ sidebarBrandColor: event.target.value })} />
      <Button onClick={() => update({ sidebarBrandColor: NATIVE_APPEARANCE_DEFAULTS.sidebarBrandColor })}>默认颜色</Button></div></div>
    <div className="nexus-setting-row"><label htmlFor="nexus-home-title">首页标题</label><div className="nexus-setting-controls">
      <input id="nexus-home-title" aria-label="首页标题" maxLength={512} value={draft.homeTitle ?? ''} placeholder="探索未至之境（跟随界面语言）" onChange={event => update({ homeTitle: event.target.value || null })} />
      <Button onClick={() => update({ homeTitle: null })}>默认标题</Button></div></div>
    <div className="nexus-setting-row"><label><input type="checkbox" aria-label="显示首页徽标" checked={value.homeBadgeEnabled} onChange={event => update({ homeBadgeEnabled: event.target.checked })} />显示首页徽标</label><div className="nexus-setting-controls">
      <input aria-label="首页徽标文字" maxLength={80} disabled={!value.homeBadgeEnabled} value={draft.homeBadgeText ?? ''} placeholder="预览版（跟随界面语言）" onChange={event => update({ homeBadgeText: event.target.value || null })} />
      <Button onClick={() => update({ homeBadgeEnabled: true, homeBadgeText: null })}>默认徽标</Button></div></div>
    <div className="nexus-native-brand-preview" aria-label="品牌与首页本地预览">
      <strong style={{ color: value.sidebarBrandColor, fontSize: 19 }}>{value.sidebarBrandText}</strong>
      <div><span style={{ fontSize: 24 }}>{value.homeTitle ?? '探索未至之境'}</span>{value.homeBadgeEnabled && <small>{value.homeBadgeText ?? '预览版'}</small>}</div>
    </div>
  </fieldset>;
}
