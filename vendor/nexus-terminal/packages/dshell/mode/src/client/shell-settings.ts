/**
 * The shell-helper switches, as the composer's own key handlers read them.
 *
 * Three gestures read the composer's line — Tab path completion, the ↑ history
 * list, and the ghost command hint — and each can be switched off in dshell's
 * settings card. The handlers that would claim those keys are DOM-level
 * listeners that run before React has a say, so the switches are read from this
 * module-level store rather than threaded through props: one subscription per
 * seat, and flipping a switch re-renders every one of them.
 *
 * The durable value lives in the Host settings document (`../settings.ts`,
 * namespace `dshell`). localStorage holds the last accepted value ONLY as a
 * pre-paint cache, for the same reason the palette does: the first render
 * happens before the settings scope answers, and a gesture that is off must not
 * fire once on every load before its switch arrives. A Host answer always wins
 * over the cache.
 */

import { useSyncExternalStore } from 'react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import {
  SHELL_HELPER_DEFAULT, SHELL_HELPER_FIELDS, readShellHelper, type DshellShellHelper,
} from '../settings.js'

/** One switch per shell helper. */
export type ShellHelperSettings = Readonly<Record<DshellShellHelper, boolean>>

export const SHELL_HELPERS_STORAGE_KEY = 'dshell.shellHelpers'

/** Every helper on: the default until a document says otherwise. */
const DEFAULTS: ShellHelperSettings = {
  tabCompletion: SHELL_HELPER_DEFAULT,
  historyList: SHELL_HELPER_DEFAULT,
  commandHint: SHELL_HELPER_DEFAULT,
  completionShellOracle: SHELL_HELPER_DEFAULT,
}

/** Read the whole set from a value of unknown shape, field by field. */
function normalize(value: unknown): ShellHelperSettings {
  const next = {} as Record<DshellShellHelper, boolean>
  for (const field of SHELL_HELPER_FIELDS) next[field] = readShellHelper(value, field)
  return next
}

/** The pre-paint cache; an unknown, partial, or unreadable entry means the defaults. */
function cachedHelpers(): ShellHelperSettings {
  if (typeof localStorage === 'undefined') return DEFAULTS
  try {
    const stored = localStorage.getItem(SHELL_HELPERS_STORAGE_KEY)
    return stored === null ? DEFAULTS : normalize(JSON.parse(stored) as unknown)
  } catch {
    return DEFAULTS
  }
}

/** Write the cache, best effort: a browser that refuses storage still works. */
function cacheHelpers(value: ShellHelperSettings): void {
  if (typeof localStorage === 'undefined') return
  try { localStorage.setItem(SHELL_HELPERS_STORAGE_KEY, JSON.stringify(value)) } catch { /* ignore */ }
}

/** Module-level store; every seat subscribes to this one. */
export const shellHelperStore = createSnapshotStore<ShellHelperSettings>(cachedHelpers())

/**
 * Write the settings namespace, when one is bound. Null only before the plugin
 * body binds it: the sink is bound during `apply`, which runs before any card
 * that could flip a switch is registered, so this is module-order insurance
 * rather than a state a running client reaches — the case that really has no
 * destination is an unwritable namespace, which the caller checks.
 */
let persistHelper: ((field: DshellShellHelper, next: boolean) => void) | null = null

/**
 * Bind the Host settings writer. Called once by the plugin body with the scope
 * it created.
 * @param persist - sink receiving each accepted switch.
 */
export function connectShellHelperSettings(persist: (field: DshellShellHelper, next: boolean) => void): void {
  persistHelper = persist
}

/**
 * Flip one switch. The local store moves first so the gesture takes effect on
 * this click rather than a round trip later; the durable write follows through
 * whichever sink is bound.
 * @param field - which helper.
 * @param next - whether it should be available.
 */
export function setShellHelper(field: DshellShellHelper, next: boolean): void {
  const current = shellHelperStore.getSnapshot()
  if (current[field] === next) return
  const updated = { ...current, [field]: next }
  shellHelperStore.set(updated)
  cacheHelpers(updated)
  persistHelper?.(field, next)
}

/**
 * Adopt the set the Host reported, without writing it back. Used by the
 * settings mirror (another browser, or this user's earlier session).
 * @param value - the bound settings value, possibly partial or absent.
 */
export function adoptShellHelperSettings(value: unknown): void {
  const next = normalize(value)
  const current = shellHelperStore.getSnapshot()
  if (SHELL_HELPER_FIELDS.every(field => current[field] === next[field])) return
  shellHelperStore.set(next)
  cacheHelpers(next)
}

/** React binding for the module-level store. */
export function useShellHelpers(): ShellHelperSettings {
  return useSyncExternalStore(shellHelperStore.subscribe, shellHelperStore.getSnapshot)
}
