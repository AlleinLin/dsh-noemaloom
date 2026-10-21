/**
 * The data-directory field, as the settings card reads and writes it.
 *
 * The durable value lives in its own Host settings document (`dshell-data`), and
 * this store is the card's view of it — the same shape `shell-settings.ts` has,
 * with one deliberate difference: no localStorage pre-paint cache. The other cached
 * values gate a GESTURE (a key that must not fire once before its switch
 * arrives), so they have to be right at first paint; this one is only ever
 * displayed and only takes effect at the next harness start, which means a
 * cache could do nothing but show a path that is not the one in force.
 *
 * A write here does not move anything. The Host stores the value and applies it
 * on its next start (see `../data-root.ts`); the card's copy is where the
 * reader is told that, because it is the reader's decision to make.
 */

import { useSyncExternalStore } from 'react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { DATA_DIR_DEFAULT, readDataSettings } from '../settings.js'

/** The stored directory; empty means "follow dsh's location". */
export const dataDirStore = createSnapshotStore<string>(DATA_DIR_DEFAULT)

/**
 * Write the settings namespace, when one is bound. Null only before the plugin
 * body binds it: the sink is bound during `apply`, which runs before the card
 * that opens the picker is registered.
 */
let persistDataDir: ((next: string) => void) | null = null

/**
 * Bind the Host settings writer. Called once by the plugin body with the scope
 * it created.
 * @param persist - sink receiving each accepted directory.
 */
export function connectDataDirSettings(persist: (next: string) => void): void {
  persistDataDir = persist
}

/**
 * Store one directory choice (or the empty string to follow dsh).
 *
 * The local store moves first so the card shows the choice on this click rather
 * than a round trip later; the durable write follows through the bound sink.
 *
 * @param next - an absolute directory, or empty for the default.
 */
export function setDataDir(next: string): void {
  const trimmed = next.trim()
  if (dataDirStore.getSnapshot() === trimmed) return
  dataDirStore.set(trimmed)
  persistDataDir?.(trimmed)
}

/**
 * Adopt the value the Host reported, without writing it back. Used by the
 * settings mirror (another browser, or this user's earlier session).
 * @param value - the bound settings value, possibly partial or absent.
 */
export function adoptDataDir(value: unknown): void {
  const next = readDataSettings(value).dir
  if (dataDirStore.getSnapshot() !== next) dataDirStore.set(next)
}

/** React binding for the module-level store. */
export function useDataDir(): string {
  return useSyncExternalStore(dataDirStore.subscribe, dataDirStore.getSnapshot)
}
