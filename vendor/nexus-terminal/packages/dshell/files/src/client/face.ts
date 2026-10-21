/**
 * The navigator's asynchronous half: listing directories into the store.
 *
 * The component never awaits anything. It calls `start` / `load` / `toggle` /
 * `navigate` / `back` / `forward` / `reload`, and this face performs the listing
 * and writes the outcome through the store's own actions — the Slot-standard
 * `inject` shape, so the session id is resolved by the framework and the write
 * set stays the store's.
 *
 * One level has one listing in force: asking for a level again — the reload
 * gesture, a directory reopened after a reset — retires the listing still in
 * flight for it, whose settlement then writes nothing. Cleanup rides the owner's
 * `signal`: a request is not made for a record that already ended, and when the
 * record goes away the bucket and the tab's listing bookkeeping are forgotten.
 */

import type { BoundActions } from '@deepseek-ai/dsh-client-store'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { ListDirectory, MoveShell } from './client.js'
import type { createDshellFilesStore } from './store.js'

/** The navigator's injected business face, as the body receives it. */
export interface FilesInjected {
  /**
   * Open this tab on a directory, with nothing listed yet.
   *
   * The listing that follows asks the host where the session stands rather than
   * naming this directory, and re-bases the tab onto the answer.
   * @param tabId - the tab being drawn.
   * @param home - the session's directory, where the tab opens.
   * @param signal - the tab record's lifetime.
   */
  readonly start: (tabId: TabId, home: string, signal: AbortSignal) => void
  /**
   * List one directory into the store.
   * @param tabId - the tab being drawn.
   * @param path - absolute directory path in the session's world.
   * @param signal - the tab record's lifetime.
   */
  readonly load: (tabId: TabId, path: string, signal: AbortSignal) => void
  /**
   * Open or collapse one directory, listing it the first time it opens.
   * @param loaded - whether this level already has state.
   */
  readonly toggle: (tabId: TabId, path: string, loaded: boolean, signal: AbortSignal) => void
  /** Stand this tab on a directory, recording it in history. */
  readonly navigate: (tabId: TabId, path: string) => void
  /**
   * Send the session's shell into the directory this tab is standing on.
   * @param tabId - the tab being drawn.
   * @param path - absolute directory path in the session's world.
   */
  readonly cd: (tabId: TabId, path: string) => void
  /** Step one entry back in history. */
  readonly back: (tabId: TabId) => void
  /** Step one entry forward in history. */
  readonly forward: (tabId: TabId) => void
  /**
   * Drop every cached level and list the directory the tab stands on again.
   * @param path - the tab's current directory.
   */
  readonly reload: (tabId: TabId, path: string, signal: AbortSignal) => void
  /**
   * Whether this session has a transfer view to open.
   *
   * True when the transfer type is registered AND the session runs on a device
   * whose binding has a mount directory — the two facts that decide whether the
   * two-pane view could show anything. Read at render time rather than captured,
   * so the header button appears as soon as both are true.
   * @returns whether the pane should offer the way into the transfer view.
   */
  readonly transferAvailable: () => boolean
}

/**
 * The facts the transfer button needs, resolved outside the face because they
 * belong to other plugins: the tab registry, and dshell-ssh's browser service.
 */
export interface TransferAvailability {
  /** Whether the transfer type is registered in this composition. */
  readonly registered: () => boolean
  /** Whether one session is a device session with a mount. */
  readonly deviceSession: (sessionId: string) => boolean
}

/**
 * Bind the navigator's face to one directory listing, one shell jump, and the
 * transfer view's availability.
 * @param list - the bound listing call.
 * @param moveShell - the bound "send the shell here" call.
 * @param availability - what the header's transfer button depends on.
 * @returns the Slot `inject` factory: session and bound actions in, face out.
 */
export function createFilesFace(
  list: ListDirectory,
  moveShell: MoveShell,
  availability: TransferAvailability,
): (sessionId: string, actions: BoundActions<ReturnType<typeof createDshellFilesStore>>) => FilesInjected {
  return (
    sessionId: string,
    actions: BoundActions<ReturnType<typeof createDshellFilesStore>>,
  ): FilesInjected => {
    /** Per tab, per absolute path: the listing generation a settlement must match. */
    const generations = new Map<TabId, Map<string, number>>()
    const nextGeneration = (tabId: TabId, path: string): number => {
      const byPath = generations.get(tabId) ?? new Map<string, number>()
      generations.set(tabId, byPath)
      const generation = (byPath.get(path) ?? 0) + 1
      byPath.set(path, generation)
      return generation
    }
    /**
     * Tabs whose next listing is the one that opens them, and therefore asks
     * without naming a directory.
     *
     * The browser only knows the session's directory as this machine spells it,
     * and for a session that runs on a device that string is not a place in the
     * world that will answer: its shell is elsewhere. Asking "where does this
     * session stand" lets the host answer in the right namespace, and the
     * store's re-basing (see `listed`) then moves the tab onto the path it was
     * given. A later ask always names its path — including a walk back to a
     * device directory that happens to spell like the local one.
     *
     * Held until a listing SUCCEEDS, so a seed that failed (a device still
     * connecting) is retried as a seed by the reload gesture rather than being
     * pinned to a path the device does not have.
     */
    const seeding = new Set<TabId>()
    const load = (tabId: TabId, path: string, signal: AbortSignal): void => {
      if (signal.aborted) return
      const generation = nextGeneration(tabId, path)
      const asked = seeding.has(tabId) ? undefined : path
      actions.loading(tabId, path)
      void list(sessionId, asked, signal).then((outcome) => {
        // A newer listing of this level was asked for since, or the record is
        // gone and its bookkeeping with it: nothing left for this one to write.
        if (generations.get(tabId)?.get(path) !== generation) return
        if (signal.aborted) return
        if (outcome.ok) {
          seeding.delete(tabId)
          actions.loaded(tabId, path, outcome.listing)
        } else {
          actions.failed(tabId, path, outcome.message)
        }
      })
    }
    return {
      start(tabId, home, signal) {
        actions.seed(tabId, home)
        seeding.add(tabId)
        signal.addEventListener('abort', () => {
          generations.delete(tabId)
          seeding.delete(tabId)
          actions.forget(tabId)
        }, { once: true })
      },
      load,
      toggle(tabId, path, loaded, signal) {
        actions.toggled(tabId, path)
        if (!loaded) load(tabId, path, signal)
      },
      navigate(tabId, path) {
        actions.navigated(tabId, path)
      },
      cd(tabId, path) {
        // The shell moves where the pane already stands, so nothing here
        // changes; only a refusal has to be written down for the reader.
        void moveShell(sessionId, path).then((outcome) => {
          if (!outcome.ok) actions.refused(tabId, outcome.message)
        })
      },
      back(tabId) {
        actions.back(tabId)
      },
      forward(tabId) {
        actions.forward(tabId)
      },
      reload(tabId, path, signal) {
        actions.reset(tabId)
        load(tabId, path, signal)
      },
      transferAvailable() {
        return availability.registered() && availability.deviceSession(sessionId)
      },
    }
  }
}
