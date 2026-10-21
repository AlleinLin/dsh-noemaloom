/**
 * dshell's storage engines.
 *
 * The contract — record shape, store surface, on-disk naming, layout version,
 * failure vocabulary — lives in `@nexus-aethra/dshell-std` (`storage.ts`). This
 * package owns the media, and a feature package imports from here only to open a
 * store; it never names a file, a pragma or a schema.
 *
 * Host-only by construction: `node:sqlite` cannot appear in a client bundle,
 * which is exactly why the contract is separate from the engine.
 */

export { closeHistoryStore, openHistoryStore } from './history.js'
