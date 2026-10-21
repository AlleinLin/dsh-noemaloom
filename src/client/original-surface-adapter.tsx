import type { ClientContext, Data } from './types.js';

export const originalConversationViews = {
  reader: { id: 'chat', order: 0 },
  context: { id: 'context', order: 20 },
  agents: { id: 'nexus.agents', order: 30 },
  fleet: { id: 'fleet', order: 35 },
  graph: { id: 'nexus.thoughtdag', order: 40 },
  map: { id: 'nexus.synapse', order: 50 },
  workflow: { id: 'nexus.workflow', order: 60 },
} as const;

type OriginalContext = ClientContext & {
  extend?(meta: Record<string, unknown>): OriginalContext;
};

/** Narrowly changes placement, retaining the original component and injector. */
export function originalSlotOptions(originalId: string, options: Data): Data | undefined {
  if (originalId === 'dsh-better-display' && options.name === 'conversation.view' && options.id === 'reader') return undefined;
  if (originalId === 'dsh-context'
    && (options.name === 'sidebar.right.pane.tab' || options.name === 'sidebar.right.pane.tab.title')
    && options.key === 'dsh-context') return undefined;
  if (options.name !== 'conversation.view') return options;
  const view = Object.values(originalConversationViews).find(item => item.id === options.id);
  return view ? { ...options, order: view.order } : options;
}

const adaptedContexts = new WeakMap<object, Map<string, OriginalContext>>();
const noop = () => {};

/**
 * A real Cordis child keeps the upstream fiber, service tracing and cleanup.
 * Only the slot service is shadowed. Never proxy the Context itself, mutate
 * the host's slot registry, or append a replacement shell to document.body.
 */
export function adaptOriginalClientContext<T extends ClientContext>(ctx: T, originalId: string, wrapTaskBoard?: (component: unknown) => unknown): T {
  const original = ctx as OriginalContext;
  const cached = adaptedContexts.get(ctx)?.get(originalId);
  if (cached) return cached as T;
  const slots = new Proxy(original.slots, {
    get(target, key) {
      if (key === 'register') return (options: Data, component: unknown) => {
        const adapted = originalSlotOptions(originalId, options);
        if (!adapted) return noop;
        const decorated = originalId === '@linxin666/dsh-client-ui-task-board' && options.name === 'main' && options.key === 'task-board'
          ? wrapTaskBoard?.(component) ?? component : component;
        return target.register(adapted, decorated);
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const meta: Record<string, unknown> = { slots };
  // A stripped capture context is useful for source validation. Production
  // always takes extend(), which preserves Cordis lifecycle identity.
  const adapted = original.extend ? original.extend(meta) : Object.assign(Object.create(original), meta);
  let byId = adaptedContexts.get(ctx);
  if (!byId) adaptedContexts.set(ctx, byId = new Map());
  byId.set(originalId, adapted);
  return adapted as T;
}
