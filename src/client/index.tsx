import * as React from 'react';
import type { ClientContext } from './types.js';
import { NexusApp } from './app.js';
import { createNexusApi } from './transport.js';
import { Icon } from './components.js';
import { ruDictionaries } from './upstream-ru/pack/index.js';
import { getLanguage, registerDictionary, setLanguage } from './i18n.js';
import { applyExtensionClientBridge } from './extension-bridge.js';
import { registerNativePanels } from './native-workspace.js';
import { NativeTheme } from './NativeTheme.js';
import { NativeBrandMark } from './NativeBrand.js';
import { applyOriginalClients } from './originals.js';
import { applyNativeCapabilities } from './native-capabilities.js';
import { registerCanvasPanels } from './original-canvases.js';
import { createNativeDockViewProvider } from './native-dock-views.js';
import { mountNativeDocking } from './native-docking.js';
import { registerLiveCommandMonitor } from './LiveCommands.js';
import { registerRecoveryDiagnostics } from './RecoveryDiagnostics.js';
import { registerAutonomyConversation } from './AutonomyPlan.js';
import { registerCompanionConversation } from './Companion.js';
const WorkflowEditor = React.lazy(() => import('./WorkflowEditor.js').then(module => ({ default: module.WorkflowEditor })));

export const name = 'dsh-nexus-client';
export const inject = ['slots', 'connection', 'locale', 'modules', 'uiWorkspace', 'uiConversation', 'conversation', 'sessions', 'workspaces', 'layout', 'sidebarRight', 'sidebarRightTabs'];
export { NexusApp, createNexusApi };

/** All seats and requests belong to this client effect and are withdrawn together. */
export function apply(ctx: ClientContext) {
  const api = createNexusApi(ctx);
  ctx.effect(() => applyOriginalClients(ctx), 'nexus original plugin components');
  ctx.effect(() => applyNativeCapabilities(ctx), 'nexus native procedures and dshell capabilities');
  ctx.effect(() => registerCanvasPanels(ctx), 'nexus original scoped canvases');
  ctx.effect(() => applyExtensionClientBridge(ctx), 'nexus extension browser generations');
  ctx.effect(() => {
    const disposers: (() => void)[] = [];
    if (ctx.locale?.addLanguage) {
      try { disposers.push(ctx.locale.addLanguage({ id: 'ru', label: 'Русский', fallback: 'en' })); } catch { /* An existing language provider keeps ownership. */ }
    }
    for (const [namespace, dictionary] of Object.entries(ruDictionaries)) {
      if (ctx.locale?.register) { try { disposers.push(ctx.locale.register(namespace, 'ru', dictionary)); } catch { /* An existing namespace owner keeps its dictionary. */ } }
      try { disposers.push(registerDictionary(namespace, 'ru', dictionary)); } catch { /* Idempotent composition. */ }
    }
    const hostLocale = ctx.locale as (typeof ctx.locale & {
      getSnapshot?(): { active: string };
      getLocale?(): { active: string };
      subscribe?(listener: () => void): () => void;
    });
    const syncLanguage = () => {
      let chosen: string | null = null;
      try { chosen = localStorage.getItem('dsh-nexus:language'); } catch {}
      // rc.2 exposes the active language through its locale snapshot. A
      // deliberate Nexus preference continues to override later host changes.
      const language = chosen || hostLocale?.getSnapshot?.().active || hostLocale?.getLocale?.().active;
      if (language && getLanguage() !== language) setLanguage(language);
    };
    syncLanguage();
    const stopLanguageSync = hostLocale?.subscribe?.(syncLanguage);
    if (stopLanguageSync) disposers.push(stopLanguageSync);
    if (ctx.locale?.register) disposers.push(ctx.locale.register('nexus', {
      zh: { title: '枢纽', description: '会话、记忆、工程与多模型编排工作台', settings: 'Nexus 设置' },
      en: { title: 'Nexus', description: 'Workspace, memory, engineering and multi-model orchestration', settings: 'Nexus settings' },
      ru: { title: 'Nexus', description: 'Рабочая среда, память, разработка и оркестрация моделей', settings: 'Настройки Nexus' },
    }));
    const onReset = ctx.on?.('connection/reset', () => api.reset());
    if (onReset) disposers.push(onReset);
    disposers.push(registerNativePanels(ctx, {
      panel: level => () => <NexusApp api={api} ctx={ctx} level={level} />,
      conversation: page => ({ sessionId, openView }: { sessionId: string; openView?: (id: string) => void }) => <NexusApp api={api} ctx={ctx} level="session" fixedPage={page} boundSessionId={sessionId} openView={openView} embedded />,
      workflow: ({ sessionId, active }: { sessionId: string; active?: boolean }) => <React.Suspense fallback={<span>加载中…</span>}>
        <WorkflowEditor api={api} scope={{ level: 'session', sessionId }} active={active} />
      </React.Suspense>,
      icon: name => ({ size }: { size?: number }) => <span data-nexus-native-entry=""><Icon name={name} size={size ?? 18} /></span>,
      settings: () => <NexusApp api={api} ctx={ctx} level="global" initialPage="settings" />,
      theme: NativeTheme,
      brand: NativeBrandMark,
    }));
    const dockViews = createNativeDockViewProvider(ctx);
    disposers.push(dockViews.dispose);
    disposers.push(mountNativeDocking(ctx, {
      providers: [dockViews.provider],
      workspaceForSession(sessionId) {
        return (ctx as any).workspaces.list.getSnapshot().items
          .find((item: any) => item.sessionIds.includes(sessionId))?.workspaceId;
      },
    }));
    disposers.push(registerLiveCommandMonitor(ctx, api));
    disposers.push(registerRecoveryDiagnostics(ctx));
    disposers.push(registerAutonomyConversation(ctx));
    disposers.push(registerCompanionConversation(ctx));
    return () => { for (const disposer of disposers.reverse()) disposer(); api.dispose(); };
  }, 'nexus: native workspace, settings, navigation and authenticated connection');
}
