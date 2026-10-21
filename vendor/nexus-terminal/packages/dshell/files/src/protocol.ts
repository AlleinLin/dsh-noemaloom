/**
 * The file navigator's wire vocabulary, shared by the host route and the
 * browser face.
 *
 * Deliberately free of value imports: the browser half imports this module, and
 * anything it pulls in would be bundled into `client.js`.
 *
 * A path on the wire is always the CANONICAL absolute path **in the session's
 * own execution world** — the host path for a local session, the device path
 * for a device-bound one. That is the string the client shows, splits into
 * segments, trims for `..`, and hands back to list again, so both ends agree on
 * one spelling without either knowing which world produced it.
 */

/** The exact `/api` path the file navigator talks to. */

// Moved to the shared standard layer: these are wire contracts, not this
// package's, and both halves of every plugin read the same declaration there.
// Re-exported so existing importers keep one import site per package.
export { DSHELL_FILES_PATH } from '@nexus-aethra/dshell-std'
export type { DshellFileKind, DshellFileEntry, DshellFilesListing, DshellFilesRequest, DshellCompletionCandidate, DshellCompletionKind, DshellCompletion, DshellFilesResponse } from '@nexus-aethra/dshell-std'
