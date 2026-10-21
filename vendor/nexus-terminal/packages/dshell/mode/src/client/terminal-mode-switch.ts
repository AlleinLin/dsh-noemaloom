/**
 * The seats the blank-session creation controls read.
 *
 * The controls themselves are built as plain DOM (`creation-controls-dom.ts`)
 * and mounted into dsh's hero control row; this module holds only the shapes
 * they exchange, plus the flag hook the composer entries gate on.
 */

import { useSyncExternalStore } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TerminalModeClient } from './terminal-mode.js'

/** What the run-location control needs from dshell-ssh, by service key. */
export interface DeviceChoiceSeat {
  snapshot(): {
    readonly devices: readonly { readonly id: string; readonly name: string }[]
    readonly bindings: readonly {
      readonly sessionId: string
      readonly deviceId: string
      /** Directory override on the device, when the session set one. */
      readonly remoteRoot?: string | undefined
      /** Local directory standing in for the device's tree, when one was mounted. */
      readonly mount?: string | undefined
    }[]
    /**
     * The group the last refusal was about, when a credential could not be
     * opened. Published by the seat so a surface that cannot read the vault
     * itself still knows which group to send the reader to.
     */
    readonly lockedGroup?: { readonly id: string; readonly name: string } | undefined
  }
  bind(sessionId: string, deviceId: string | null): Promise<void>
  /**
   * Open the vault's unlock box for one group, revealing the panel if it is
   * closed. The creation page calls this the moment a device it picked turns
   * out to draw its credential from a locked group: that is one of the three
   * moments a token is genuinely needed, and waiting for the reader to go
   * looking for it would leave the page stuck on a refusal.
   *
   * @returns whether the panel was opened; false tells the caller to say where
   *   to go in words instead.
   */
  revealUnlock(group: { readonly id: string; readonly name: string }): boolean
  subscribe(listener: () => void): () => void
}

/** The framework's own current-session reading (ui-session's binding source). */
export interface CurrentSessionSeat {
  get(): SessionId | undefined
  subscribe(listener: () => void): () => void
}

/** The committed flag for one session, reactive to host answers. */
export function useTerminalModeOn(modes: TerminalModeClient, sessionId: SessionId | undefined): boolean {
  const snapshot = useSyncExternalStore(modes.subscribe, modes.getSnapshot)
  return sessionId !== undefined && snapshot.sessions.includes(sessionId)
}
