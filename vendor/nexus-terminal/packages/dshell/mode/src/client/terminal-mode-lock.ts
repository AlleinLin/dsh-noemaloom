/**
 * Lock a terminal-mode session to its terminal tab set.
 *
 * The creation-time choice is locked, so an opted-in session must offer
 * `智能终端` + `轨迹` — never `对话`. Our view takes dsh's own `chat` id (one
 * priority lower, so it is the entry that renders), which means the strip
 * carries TWO entries with that id: ours and the stock conversation. The stock
 * one is the tab to hide, and it is identified by its OWN resolved label — the
 * entry whose label is not ours — so nothing here depends on a locale, on
 * registration order, or on a hashed class name.
 */

import type { Context } from '@deepseek-ai/cordis'

/** dsh's own marker on the view tab strip. */
const TABS = '[data-conversation-tabs]'

/** Slot whose entry order the strip's children follow. */
const SLOT = 'conversation.view'

/** The stock view id an opted-in session must not offer. */
const CHAT = 'chat'

/**
 * Hide (or restore) the stock conversation tab for the current lock state.
 * @param ctx - client context, for the slot ledger.
 * @param locked - whether the current session is locked to its terminal.
 * @param ourLabel - this package's own view label, resolved in the reader's language.
 */
export function applyTabLock(ctx: Context, locked: boolean, ourLabel: string): void {
  if (typeof document === 'undefined') return
  const strip = document.querySelector(TABS)
  if (strip === null) return
  // Every label the stock conversation entry carries, in the reader's
  // language: ours is excluded by identity (both entries share the `chat` id,
  // so only the label tells them apart).
  const stockLabels = new Set(ctx.slots.entries(SLOT)
    .filter(entry => entry.options.id === CHAT)
    .map(entry => resolveLabel(entry.options.label))
    .filter((label): label is string => label !== undefined && label !== ourLabel))
  // Sweep instead of indexing: a pass that ran against an earlier ledger must
  // not leave a tab hidden, so every child is (re)settled on every pass.
  for (const child of strip.children) {
    if (!(child instanceof HTMLElement)) continue
    const hide = locked && stockLabels.has((child.textContent ?? '').trim())
    if (hide) child.style.display = 'none'
    else child.style.removeProperty('display')
  }
}

/** Resolve a slot entry's label, which may be a string or a function. */
function resolveLabel(label: unknown): string | undefined {
  if (typeof label === 'string') return label
  if (typeof label === 'function') {
    try {
      const resolved: unknown = (label as () => unknown)()
      return typeof resolved === 'string' ? resolved : undefined
    } catch {
      return undefined
    }
  }
  return undefined
}
