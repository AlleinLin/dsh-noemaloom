/**
 * The transfer view's asynchronous half: setup, one pane's listings, and the
 * copies — each started as a job and then polled into the store.
 *
 * The component never awaits anything. It calls `start` / `load` / `toggle` /
 * `navigate` / `reload` / `drop` / `cancel` / `overwrite` / `dismiss`, and this
 * face performs the work and writes the outcome through the store's own actions
 * — the Slot-standard `inject` shape, so the session id is resolved by the
 * framework and the write set stays the store's.
 *
 * One level has one listing in force, per tab and per side, exactly as the
 * browser face does it: asking again retires the listing still in flight, whose
 * settlement then writes nothing. A job's poll keeps its own timer, so a copy
 * started in one tab continues while the reader looks at another, and the tab's
 * own signal is what ends both when its record goes away.
 */

import type { BoundActions } from '@deepseek-ai/dsh-client-store'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { TransferJobView, TransferSide } from '../transfer-protocol.js'
import type { TransferApi, TransferCopyInput, TransferOutcome } from './transfer-client.js'
import type { createDshellFilesStore } from './store.js'

/** States after which a job's row never changes again. */
const SETTLED: readonly TransferJobView['state'][] = ['done', 'failed', 'cancelled']

/** How often a running copy is asked how far it is. */
const POLL_MS = 400

/** What one drag asks for: one side's entry into the other side's directory. */
export interface TransferDropInput {
  readonly from: TransferSide
  readonly fromPath: string
  readonly to: TransferSide
  readonly toDir: string
}

/** The transfer view's injected business face, as the body receives it. */
export interface TransferInjected {
  /** Open this tab: read what the session allows, then seed both panes. */
  readonly start: (tabId: TabId, signal: AbortSignal) => void
  /** List one pane's directory into the store. */
  readonly load: (tabId: TabId, side: TransferSide, path: string, signal: AbortSignal) => void
  /** Open or collapse one directory, listing it the first time it opens. */
  readonly toggle: (tabId: TabId, side: TransferSide, path: string, loaded: boolean, signal: AbortSignal) => void
  /** Stand one pane on a directory. */
  readonly navigate: (tabId: TabId, side: TransferSide, path: string) => void
  /** Drop one pane's cached levels and list its current directory again. */
  readonly reload: (tabId: TabId, side: TransferSide, path: string, signal: AbortSignal) => void
  /** Start copying one entry into the other side's directory. */
  readonly drop: (tabId: TabId, input: TransferDropInput, signal: AbortSignal) => void
  /** Start the same copy again, replacing existing files this time. */
  readonly overwrite: (tabId: TabId, jobId: string, signal: AbortSignal) => void
  /** Stop one copy. */
  readonly cancel: (tabId: TabId, jobId: string) => void
  /** Drop one copy's row. */
  readonly dismiss: (tabId: TabId, jobId: string) => void
}

/** A job row for a copy that never started, so a transport failure is visible. */
function failedJob(input: TransferCopyInput, message: string): TransferJobView {
  return {
    id: `local-${String(Date.now())}-${String(Math.floor(Math.random() * 1e6))}`,
    from: input.from,
    to: input.to,
    fromPath: input.fromPath,
    toDir: input.toDir,
    state: 'failed',
    files: 0,
    bytes: 0,
    skipped: 0,
    error: message,
    createdAt: Date.now(),
    settledAt: Date.now(),
  }
}

/**
 * Bind the transfer face to the route and one session's store.
 * @param api - the calls the face performs.
 * @returns the Slot `inject` factory: session and bound actions in, face out.
 */
export function createTransferFace(
  api: TransferApi,
): (sessionId: string, actions: BoundActions<ReturnType<typeof createDshellFilesStore>>) => TransferInjected {
  return (
    sessionId: string,
    actions: BoundActions<ReturnType<typeof createDshellFilesStore>>,
  ): TransferInjected => {
    /** Per tab, per side and path: the listing generation a settlement must match. */
    const generations = new Map<TabId, Map<string, number>>()
    /** Per job: the tab that owns it, its poll timer, and whether it still runs. */
    const running = new Map<string, { tabId: TabId; timer?: ReturnType<typeof setTimeout> }>()
    /** Per job: the request, so `overwrite` can repeat it. */
    const inputs = new Map<string, TransferCopyInput>()

    const generation = (tabId: TabId, side: TransferSide, path: string): number => {
      const byPath = generations.get(tabId) ?? new Map<string, number>()
      generations.set(tabId, byPath)
      const key = `${side}:${path}`
      const next = (byPath.get(key) ?? 0) + 1
      byPath.set(key, next)
      return next
    }

    const load = (
      tabId: TabId,
      side: TransferSide,
      path: string,
      signal: AbortSignal,
      options?: { readonly silent?: boolean },
    ): void => {
      if (signal.aborted) return
      const mine = generation(tabId, side, path)
      // A silent read keeps the level already on screen: it is what a finished
      // copy asks for, and flipping the pane to "reading…" for a directory the
      // reader is looking at would be a flicker with nothing to say.
      if (options?.silent !== true) actions.transferLoading(tabId, side, path)
      void api.list(sessionId, side, path, signal).then((outcome) => {
        if (generations.get(tabId)?.get(`${side}:${path}`) !== mine) return
        if (signal.aborted) return
        if (outcome.ok) actions.transferLoaded(tabId, side, path, outcome.value)
        else if (options?.silent === true) return
        else actions.transferFailed(tabId, side, path, outcome.message)
      })
    }

    /**
     * Re-list the directory a finished copy landed in, so the new entry appears.
     *
     * Relisting the DROP DIRECTORY rather than the whole pane keeps the tree's
     * other levels intact; a directory that is no longer on screen simply gets a
     * level nobody draws.
     */
    const refresh = (tabId: TabId, side: TransferSide, dir: string, signal: AbortSignal): void => {
      if (signal.aborted) return
      load(tabId, side, dir, signal, { silent: true })
    }

    /** Keep asking a job how it is doing until it settles. */
    const poll = (tabId: TabId, job: TransferJobView, signal: AbortSignal): void => {
      const entry = running.get(job.id)
      if (entry === undefined) return
      if (SETTLED.includes(job.state)) {
        running.delete(job.id)
        const input = inputs.get(job.id)
        if (input !== undefined) refresh(tabId, input.to, input.toDir, signal)
        return
      }
      entry.timer = setTimeout(() => {
        void api.job(job.id, signal).then((outcome) => {
          if (signal.aborted) { running.delete(job.id); return }
          if (outcome.ok) {
            actions.jobUpdated(tabId, outcome.value)
            poll(tabId, outcome.value, signal)
            return
          }
          // The record is gone (a restart, or the TTL): stop asking and say so
          // on the row rather than leaving it spinning forever.
          running.delete(job.id)
          actions.jobUpdated(tabId, { ...job, state: 'failed', error: outcome.message, settledAt: Date.now() })
        })
      }, POLL_MS)
    }

    const copy = (tabId: TabId, input: TransferCopyInput, signal: AbortSignal): void => {
      if (signal.aborted) return
      void api.copy(input).then((outcome: TransferOutcome<TransferJobView>) => {
        if (signal.aborted) return
        if (!outcome.ok) {
          actions.jobStarted(tabId, failedJob(input, outcome.message))
          return
        }
        inputs.set(outcome.value.id, input)
        actions.jobStarted(tabId, outcome.value)
        running.set(outcome.value.id, { tabId })
        poll(tabId, outcome.value, signal)
      })
    }

    return {
      start(tabId, signal) {
        signal.addEventListener('abort', () => {
          generations.delete(tabId)
          for (const [jobId, entry] of running) {
            if (entry.tabId !== tabId) continue
            if (entry.timer !== undefined) clearTimeout(entry.timer)
            running.delete(jobId)
          }
          actions.transferForget(tabId)
        }, { once: true })
        void api.state(sessionId, signal).then((outcome) => {
          if (signal.aborted) return
          actions.transferSeeded(tabId, outcome.ok
            ? outcome.value
            : { localRoot: '/', canTransfer: false, reason: outcome.message })
        })
      },
      load,
      toggle(tabId, side, path, loaded, signal) {
        actions.transferToggled(tabId, side, path)
        if (!loaded) load(tabId, side, path, signal)
      },
      navigate(tabId, side, path) {
        actions.transferNavigated(tabId, side, path)
      },
      reload(tabId, side, path, signal) {
        actions.transferReset(tabId, side)
        load(tabId, side, path, signal)
      },
      drop(tabId, input, signal) {
        copy(tabId, { sessionId, ...input, overwrite: false }, signal)
      },
      overwrite(tabId, jobId, signal) {
        const input = inputs.get(jobId)
        if (input === undefined) return
        actions.jobDismissed(tabId, jobId)
        copy(tabId, { ...input, overwrite: true }, signal)
      },
      cancel(tabId, jobId) {
        void api.cancel(jobId).then((outcome) => {
          if (outcome.ok) actions.jobUpdated(tabId, outcome.value)
        })
      },
      dismiss(tabId, jobId) {
        running.delete(jobId)
        inputs.delete(jobId)
        actions.jobDismissed(tabId, jobId)
      },
    }
  }
}
