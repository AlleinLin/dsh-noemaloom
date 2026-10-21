/**
 * The transfer view's calls: setup, one side's listing, and the copy jobs.
 *
 * Not a client Service: nothing else in the composition drives a transfer, so a
 * module-level set of calls behind the tab's inject face is the whole interface,
 * exactly as the navigator's listing calls are.
 */

import {
  DSHELL_TRANSFER_PATH, type TransferJobView, type TransferListing, type TransferRequest,
  type TransferResponse, type TransferSetup, type TransferSide,
} from '../transfer-protocol.js'

/** Either a value, or the reason there is none. */
export type TransferOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string }

/** One copy as the view asks for it. */
export interface TransferCopyInput {
  readonly sessionId: string
  readonly from: TransferSide
  readonly to: TransferSide
  readonly fromPath: string
  readonly toDir: string
  readonly overwrite: boolean
}

/** The calls the transfer face performs. */
export interface TransferApi {
  readonly state: (sessionId: string, signal: AbortSignal) => Promise<TransferOutcome<TransferSetup>>
  readonly list: (
    sessionId: string,
    side: TransferSide,
    path: string,
    signal: AbortSignal,
  ) => Promise<TransferOutcome<TransferListing>>
  readonly copy: (input: TransferCopyInput) => Promise<TransferOutcome<TransferJobView>>
  readonly job: (jobId: string, signal?: AbortSignal) => Promise<TransferOutcome<TransferJobView>>
  readonly cancel: (jobId: string) => Promise<TransferOutcome<TransferJobView>>
}

/** One request against the transfer route. */
async function post(request: TransferRequest, signal?: AbortSignal): Promise<TransferResponse> {
  const response = await fetch(DSHELL_TRANSFER_PATH, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
    ...signal === undefined ? {} : { signal },
  })
  return await response.json() as TransferResponse
}

/** Turn a response into an outcome, keeping the route's own words on refusal. */
function unwrap<T>(
  body: TransferResponse,
  take: (body: TransferResponse) => T | undefined,
  fallback: string,
): TransferOutcome<T> {
  const value = take(body)
  return value === undefined ? { ok: false, message: body.error ?? fallback } : { ok: true, value }
}

/** Build the calls the transfer face performs. */
export function createTransferApi(): TransferApi {
  return {
    async state(sessionId, signal) {
      try {
        return unwrap(await post({ action: 'state', sessionId }, signal), body => body.setup, '传输状态没有返回内容')
      } catch (error) {
        if (signal.aborted) return { ok: false, message: '已取消' }
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    },
    async list(sessionId, side, path, signal) {
      try {
        return unwrap(
          await post({ action: 'list', sessionId, side, path }, signal),
          body => body.listing,
          '文件列表没有返回内容',
        )
      } catch (error) {
        if (signal.aborted) return { ok: false, message: '已取消' }
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    },
    async copy(input) {
      try {
        return unwrap(
          await post({
            action: 'copy',
            sessionId: input.sessionId,
            from: input.from,
            to: input.to,
            fromPath: input.fromPath,
            toDir: input.toDir,
            overwrite: input.overwrite,
          }),
          body => body.job,
          '传输没有开始',
        )
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    },
    async job(jobId, signal) {
      try {
        return unwrap(await post({ action: 'job', jobId }, signal), body => body.job, '这次传输的记录已经不在了')
      } catch (error) {
        if (signal?.aborted === true) return { ok: false, message: '已取消' }
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    },
    async cancel(jobId) {
      try {
        return unwrap(await post({ action: 'cancel', jobId }), body => body.job, '这次传输的记录已经不在了')
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    },
  }
}
