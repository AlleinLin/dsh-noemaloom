/**
 * The machine readout's poll interval, as the card and the poller read it.
 *
 * Same shape as the shell-helper switches for the same reason: the reader picks
 * it in dshell's settings card, the durable value lives in the Host settings
 * document, and localStorage holds the last accepted value ONLY as a pre-paint
 * cache — the first render happens before the settings scope answers, and a
 * poller that started at the wrong cadence before its setting arrived would
 * spend a second over ssh on a device the reader had already asked it to leave
 * alone. A Host answer always wins over the cache.
 */

import { useSyncExternalStore } from 'react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import {
  DEVICE_POLL_CHOICES, DEVICE_POLL_DEFAULT, DEVICE_POLL_FIELD,
  type DevicePollMs,
} from '../settings.js'

export const DEVICE_POLL_STORAGE_KEY = 'dshell.devicePollMs'

/** Narrow a value crossing the settings boundary to an interval on the ladder. */
function readInterval(value: unknown): DevicePollMs {
  const raw = (value as Record<string, unknown> | null | undefined)?.[DEVICE_POLL_FIELD]
  return (DEVICE_POLL_CHOICES as readonly number[]).includes(raw as number)
    ? raw as DevicePollMs
    : DEVICE_POLL_DEFAULT
}

/** The pre-paint cache; an absent, unreadable or off-ladder entry means the default. */
function cachedInterval(): DevicePollMs {
  if (typeof localStorage === 'undefined') return DEVICE_POLL_DEFAULT
  try {
    const stored = localStorage.getItem(DEVICE_POLL_STORAGE_KEY)
    const parsed: unknown = stored === null ? undefined : JSON.parse(stored)
    return (DEVICE_POLL_CHOICES as readonly number[]).includes(parsed as number)
      ? parsed as DevicePollMs
      : DEVICE_POLL_DEFAULT
  } catch {
    return DEVICE_POLL_DEFAULT
  }
}

/** Write the cache, best effort: a browser that refuses storage still polls. */
function cacheInterval(value: DevicePollMs): void {
  if (typeof localStorage === 'undefined') return
  try { localStorage.setItem(DEVICE_POLL_STORAGE_KEY, JSON.stringify(value)) } catch { /* ignore */ }
}

/** Module-level store; the poller and the card subscribe to this one. */
export const devicePollStore = createSnapshotStore<DevicePollMs>(cachedInterval())

let persistInterval: ((next: DevicePollMs) => void) | null = null

/**
 * Bind the Host settings writer. Called once by the plugin body.
 * @param persist - sink receiving each accepted interval.
 */
export function connectDevicePollSettings(persist: (next: DevicePollMs) => void): void {
  persistInterval = persist
}

/**
 * Choose an interval. The local store moves first so the poller re-arms on this
 * click rather than a round trip later; the durable write follows.
 * @param next - the interval in milliseconds.
 */
export function setDevicePollMs(next: DevicePollMs): void {
  if (devicePollStore.getSnapshot() === next) return
  devicePollStore.set(next)
  cacheInterval(next)
  persistInterval?.(next)
}

/**
 * Adopt the interval the Host reported, without writing it back. Used by the
 * settings mirror (another browser, or this user's earlier session).
 * @param value - the bound settings value, possibly partial or absent.
 */
export function adoptDevicePollSettings(value: unknown): void {
  const next = readInterval(value)
  if (devicePollStore.getSnapshot() === next) return
  devicePollStore.set(next)
  cacheInterval(next)
}

/** React binding for the module-level store. */
export function useDevicePollMs(): DevicePollMs {
  return useSyncExternalStore(devicePollStore.subscribe, devicePollStore.getSnapshot)
}
