/**
 * The file-transfer wire vocabulary: one device session's two file trees, and
 * the copies between them.
 *
 * Separate from `./protocol.ts` because it is a different route with a
 * different subject. The navigator's route answers about ONE world (the
 * session's); this one is about the pair — this machine and the device the
 * session runs on — and about work that outlives one request.
 *
 * Deliberately free of value imports: the browser face imports this module, and
 * anything it pulled in would be bundled into `client.js`. `Buffer`-style host
 * types are not needed on the browser side at all.
 */

/** The exact `/api` path the transfer view talks to. */

// Moved to the shared standard layer: these are wire contracts, not this
// package's, and both halves of every plugin read the same declaration there.
// Re-exported so existing importers keep one import site per package.
export { DSHELL_TRANSFER_PATH } from '@nexus-aethra/dshell-std'
export type { TransferSide, TransferEntry, TransferListing, TransferSetup, TransferJobState, TransferJobView, TransferRequest, TransferResponse } from '@nexus-aethra/dshell-std'
