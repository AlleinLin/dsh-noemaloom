/**
 * dshell-conversation browser face — the `terminal` conversation target.
 *
 * The target is what takes a session out of dsh's centered hero phase and into
 * the docked composer: ui-conversation resolves the shell phase from active
 * targets, and its restore path falls back to `chat` whenever no preference
 * exists. Registering it unconditionally (the old shape) forced EVERY session —
 * including stock ones — into the docked layout, which is exactly the native
 * surface this package must now leave alone.
 *
 * So the target, and the auto-activation that steers an opted-in session onto
 * it, exist only while the CURRENT session carries the terminal-mode flag. The
 * flag lives in dshell-mode's browser half and is reached by service key: a
 * composition without it simply never registers the target.
 *
 * A subsequent `selectView` from the reader (the strip's 会话 tab) takes
 * precedence through the stock path — activation only steers the default, and
 * the strip's selection is a separate per-session preference.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
// Type-only: pulls the sessions service merge (ctx.sessions).
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
// Type-only: pulls the renderer-owned slots service (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {
  ConversationViewBuilder,
  ConversationViewDefinition,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { mainSessionId } from '@nexus-aethra/dshell-std'

export const name = '@nexus-aethra/dshell-conversation/client'

export const inject = ['uiConversation', 'sessions', 'slots'] as const

interface TerminalSnapshot {
  readonly rows: readonly never[]
}

class TerminalViewBuilder implements ConversationViewBuilder<never, TerminalSnapshot> {
  readonly empty: TerminalSnapshot = { rows: [] }

  replace(): TerminalSnapshot {
    return this.empty
  }

  apply(): TerminalSnapshot {
    return this.empty
  }
}

const viewDefinition: ConversationViewDefinition<never, TerminalSnapshot> = {
  target: 'terminal',
  create: () => new TerminalViewBuilder(),
  // The terminal surface IS dshell's content (design 4.1): it counts as
  // visible activity even in a blank session, so the conversation renders
  // its docked composer instead of the centered hero.
  isActive: () => true,
}

/** The flag face this package needs: a read and a wake-up. */
interface TerminalModeFace {
  isOn(sessionId: string): boolean
  subscribe(listener: () => void): () => void
}

/** Register the `terminal` target and its activation only for opted-in sessions. */
export function apply(ctx: Context): void {
  // Cast through unknown: the 'sessions' key collides across faces in one
  // tsc program (host SessionStore vs client ISessions); see terminal-bridge.
  const sessions = ctx.get('sessions') as unknown as ISessions

  let modes: TerminalModeFace | undefined
  let resync: (() => void) | undefined
  // Reached by service key with a structural cast, exactly as this bundle reads
  // the SSH and buffer seats: a composition without dshell-mode simply never
  // registers the target instead of failing to load.
  const modeHost = ctx as unknown as {
    inject(keys: readonly string[], callback: (scope: { dshellTerminalMode: TerminalModeFace }) => void): unknown
  }
  modeHost.inject(['dshellTerminalMode'], (scope) => {
    modes = scope.dshellTerminalMode
    resync?.()
  })

  ctx.effect(() => {
    let stop: (() => void) | undefined
    let held: string | undefined
    const sync = (): void => {
      const current = mainSessionId(Object.values(sessions.list.getSnapshot().byId))
      const wanted = current !== undefined && modes?.isOn(String(current)) === true
        ? String(current)
        : undefined
      if (wanted === held) return
      stop?.()
      stop = undefined
      held = wanted
      if (wanted === undefined) return
      const disposeRegister = ctx.uiConversation.views.register(viewDefinition)
      // The terminal target must be the active view or the shell renders the
      // (empty) chat transcript instead. Re-assert on every session-list and
      // view-slot change — these subscriptions are registered after
      // ui-conversation's, so this activation runs last and wins the tick.
      // `activate` is idempotent (the assembler ignores a target already active).
      const disposeReconcile = ctx.effect(() => {
        const reconcile = (): void => {
          const now = mainSessionId(Object.values(sessions.list.getSnapshot().byId))
          if (now === undefined || String(now) !== held) return
          try {
            ctx.uiConversation.binding(now).activate('terminal')
          } catch {
            // Session scope not materialized yet; retry on the next change.
          }
        }
        const disposeList = sessions.list.subscribe(reconcile)
        const disposeViews = ctx.slots.subscribe('conversation.view', reconcile)
        reconcile()
        return () => {
          disposeList()
          disposeViews()
        }
      }, 'dshell-conversation: open opted-in session into terminal view')
      stop = () => {
        disposeReconcile()
        disposeRegister()
      }
    }
    resync = sync
    const disposeList = sessions.list.subscribe(sync)
    const disposeModes = modes?.subscribe(sync)
    sync()
    return () => {
      resync = undefined
      disposeList()
      disposeModes?.()
      stop?.()
    }
  }, 'dshell-conversation: terminal target for opted-in sessions')
}
