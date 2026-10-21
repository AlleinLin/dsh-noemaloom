import * as React from 'react';
import css from './native-theme.css';
import liveCommandsCss from './live-commands.css';
import recoveryDiagnosticsCss from './recovery-diagnostics.css';
import { claudeThemeCss } from './native-theme-tokens.js';
function enabled() {
  try { return JSON.parse(localStorage.getItem('dsh-nexus:ui-preferences:v1') ?? '{}').skin !== 'host'; } catch { return true; }
}
function subscribe(listener: () => void) {
  window.addEventListener('nexus:appearance', listener);
  window.addEventListener('storage', listener);
  return () => { window.removeEventListener('nexus:appearance', listener); window.removeEventListener('storage', listener); };
}
/** One global, removable skin. DSH continues to own light/dark selection. */
export function NativeTheme() {
  const active = React.useSyncExternalStore(subscribe, enabled, () => true);
  return <>
    <style data-nexus-live-commands="">{liveCommandsCss}</style>
    <style data-nexus-recovery-diagnostics="">{recoveryDiagnosticsCss}</style>
    <style data-nexus-brand-theme="">{'body[data-ds-dark-theme] { --nexus-brand-color: #de977a; }'}</style>
    {active ? <style data-nexus-native-theme="claude">{claudeThemeCss + css}</style> : null}
  </>;
}
