/**
 * The buffer's wire vocabulary, shared by the host route and the browser face.
 *
 * Deliberately free of value imports: the browser half imports this module, and
 * anything it pulls in would be bundled into `client.js`. Identifiers that the
 * host validates against (a request `action`, a ticket `state`) are plain
 * strings here and narrowed on the host side.
 *
 * Session ids travel as plain strings rather than the branded `SessionId`
 * because this is a JSON boundary; the host converts at the edges.
 */

/** The exact `/api` path the pipe UI talks to. */

// Moved to the shared standard layer: these are wire contracts, not this
// package's, and both halves of every plugin read the same declaration there.
// Re-exported so existing importers keep one import site per package.
export { DSHELL_BUFFER_PATH, BUFFER_PLUGIN, SETTLED_STATES } from '@nexus-aethra/dshell-std'
export type { BufferTicketState, BufferRight, BufferArea, BufferLink, BufferReport, BufferTicket, BufferGrant, BufferTransfer, BufferState, BufferUserEntry, BufferListing, BufferRequest, BufferResponse } from '@nexus-aethra/dshell-std'
