import * as React from 'react';

/** Marks only the native subagent sidebar's embedded Conversation occurrence. */
export const NativeSubagentViewScope = React.createContext(false);

interface NativeSubagentConversationViewsProps {
  component: React.ComponentType<any>;
  owner: any;
  activate(sessionId: string, viewId: string): void;
}

/** Reuse the child's native store, view roster, navigation, and view renderer. */
export function NativeSubagentConversationViews({ component: Conversation, owner, activate }: NativeSubagentConversationViewsProps) {
  const views = owner.useConversationViews((value: any) => value) as readonly { id: string; label: string }[];
  const tabs = views.filter(tab => tab.id === 'chat' || tab.id === 'trajectory' || tab.id === 'context');
  const selectedId = owner.useStore((value: any) => value.view) as string | null;
  const active = tabs.find(tab => tab.id === selectedId) ?? tabs.find(tab => tab.id === 'chat');
  React.useEffect(() => {
    if (active) activate(owner.sessionId, active.id);
  }, [activate, owner.sessionId, active?.id]);
  return <>
    {tabs.length > 1 ? <nav role="tablist" aria-label="子代理视图" data-nexus-subagent-views={owner.sessionId}
      style={{ display: 'flex', flexWrap: 'wrap', gap: 4, padding: '4px 8px' }}>
      {tabs.map(tab => <button key={tab.id} type="button" role="tab" data-nexus-subagent-view={tab.id}
        aria-selected={active?.id === tab.id} onClick={() => owner.openView(tab.id)}
        style={{ cursor: 'pointer', border: 0, borderRadius: 'var(--dsw-radius-sm)', padding: '4px 8px',
          color: active?.id === tab.id ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-tertiary)',
          background: active?.id === tab.id ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
          fontWeight: active?.id === tab.id ? 600 : undefined }}>
        {tab.label}
      </button>)}
    </nav> : null}
    <Conversation {...owner} view={active?.id} />
  </>;
}

function SelectableSubagentConversationView(props: any) {
  return <NativeSubagentViewScope.Provider value={true}>
    {props.renderSlot('conversation.session', {})}
  </NativeSubagentViewScope.Provider>;
}

/**
 * Replace only the native subagent panel's fixed-chat local view. Its outer
 * SessionProvider keeps the original child address, reference, and binding;
 * ConversationContent still owns its composer and one-shot restrictions.
 */
export function installNativeSubagentConversationViews(ctx: any): () => void {
  const stop = ctx.slots.inject('sidebar.chat.conversation', () => {
    let current: { entry: any; component: any; restore(): void } | undefined;
    const reconcile = () => {
      const entry = ctx.slots.entriesOfSlot('sidebar.chat.conversation')[0];
      if (current && current.entry === entry && entry.component === current.component) return;
      current?.restore();
      current = undefined;
      if (typeof entry?.component !== 'function') return;
      const OriginalPanel = entry.component;
      function SelectableSubagentConversationPanel(props: any) {
        const renderFactorySlot = React.useCallback((key: string, owner: any, options?: any) => {
          if (key !== 'conversation.content') return props.renderFactorySlot(key, owner, options);
          return props.renderFactorySlot(key, owner, {
            ...options,
            slots: { ...options?.slots, views: SelectableSubagentConversationView },
          });
        }, [props.renderFactorySlot]);
        return <OriginalPanel {...props} renderFactorySlot={renderFactorySlot} />;
      }
      const entries = ctx.slots.entries?.('sidebar.chat.conversation') ?? [entry];
      const priority = Math.max(0, ...entries.map((item: any) => item.options.priority ?? 0)) + 1000000;
      let stopVersion: (() => void) | undefined;
      try {
        entry.component = SelectableSubagentConversationPanel;
        // Publish the adaptation without replacing the original slot ownership.
        stopVersion = ctx.slots.register({ name: 'sidebar.chat.conversation', priority }, () => null);
      } catch (error) {
        if (entry.component === SelectableSubagentConversationPanel) entry.component = OriginalPanel;
        throw error;
      }
      current = { entry, component: SelectableSubagentConversationPanel, restore() {
        if (entry.component === SelectableSubagentConversationPanel) entry.component = OriginalPanel;
        stopVersion?.();
      } };
    };
    // The declaration can precede the native subagent component registration.
    const unsubscribe = ctx.slots.subscribe('sidebar.chat.conversation', reconcile);
    try { reconcile(); } catch (error) { unsubscribe(); throw error; }
    return () => {
      unsubscribe();
      current?.restore();
      current = undefined;
    };
  });
  return () => { if (typeof stop === 'function') stop(); };
}
