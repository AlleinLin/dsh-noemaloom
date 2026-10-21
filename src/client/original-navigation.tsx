import * as React from 'react';
import type { ClientContext } from './types.js';

interface NativeActions {
  openView(view: string, focus: string): void;
}

interface NativeSlotProps {
  sessionId: string;
  actions: NativeActions;
}

const actionsBySession = new Map<string, NativeActions>();
const pendingViews = new Map<string, { view: string; focus: string }>();
let navigationContext: any;

/**
 * The rc.2 UiConversation binding activates data targets; selection belongs to
 * the native session store. Reuse that exact store rather than click chrome.
 */
export function openOriginalConversationView(sessionId: unknown, view: string, focus = ''): boolean {
  const ctx = navigationContext;
  const id = typeof sessionId === 'string' && sessionId
    ? sessionId : ctx?.uiWorkspace?.selection?.getSnapshot?.().sessionId;
  if (typeof id !== 'string') return false;
  const actions = actionsBySession.get(id);
  if (!actions || typeof actions.openView !== 'function') return false;
  ctx?.uiConversation?.binding(id).activate(view);
  actions.openView(view, focus);
  return true;
}

/** Prefill the real composer; graph gestures never submit a model request. */
export async function openOriginalComposer(rawContext: ClientContext, sessionId: string, text = '') {
  const ctx = rawContext as any;
  const reference = ctx.get('sessions').retain(sessionId, { source: 'nexus-graph-composer' });
  try {
    await reference.ready;
    const input = ctx.get('conversation').input;
    let draftStatus = 'unchanged';
    if (text) {
      const result = input.requestDraftInitialization(reference.binding, { prompt: text, clearPreviousDraft: false });
      draftStatus = typeof result === 'string' ? result : result?.status ?? 'unchanged';
    }
    ctx.uiWorkspace.openSession(sessionId);
    ctx.layout?.selectPanel(null);
    if (!openOriginalConversationView(sessionId, 'chat')) pendingViews.set(sessionId, { view: 'chat', focus: '' });
    input.for(reference.binding.ctx).focus();
    return { draftStatus };
  } finally { reference.release(); }
}

function NavigationSeat({ sessionId, actions }: NativeSlotProps): null {
  React.useLayoutEffect(() => {
    actionsBySession.set(sessionId, actions);
    const pending = pendingViews.get(sessionId);
    if (pending) {
      pendingViews.delete(sessionId);
      openOriginalConversationView(sessionId, pending.view, pending.focus);
    }
    return () => {
      if (actionsBySession.get(sessionId) === actions) actionsBySession.delete(sessionId);
    };
  }, [sessionId, actions]);
  return null;
}

export function installOriginalViewNavigation(rawContext: ClientContext): unknown {
  const ctx = rawContext as any;
  navigationContext = ctx;
  const stop = ctx.slots.inject('conversation.input.dock', () => {
    const native = ctx.slots.entriesOfSlot('conversation.session')[0]?.store;
    if (native?.spec?.persist !== 'dsh.conversation' || typeof native.spec.actions.openView !== 'function') {
      throw new Error('Nexus original navigation cannot bind the desktop conversation store');
    }
    return ctx.slots.register({
      name: 'conversation.input.dock',
      id: 'nexus.original-navigation',
      store: native,
      order: -100,
    }, NavigationSeat);
  });
  return () => {
    if (typeof stop === 'function') stop();
    if (navigationContext === ctx) navigationContext = undefined;
    actionsBySession.clear();
    pendingViews.clear();
  };
}
