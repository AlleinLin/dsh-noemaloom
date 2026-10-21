import type { ContextArchiveHead } from './archive-types.js';
import type { ContextSession } from './types.js';
import { hashObject } from './cache.js';

export const NATIVE_SYNC_CHECKPOINTS = 'context.nativeSync';
export interface NativeSyncCheckpoint {
  schemaVersion: 1;
  sessionKey: string;
  inputHash: string;
  stateHash: string;
  state: 'started' | 'finished';
  planId?: string;
  requestId?: string;
  compressionNotice?: string;
}
/** Ignore bookkeeping revisions/timestamps but invalidate on kernel, policy,
 * static input or request ownership changes. This is only an exact reuse key. */
export function nativeSyncStateHash(value: ContextSession | ContextArchiveHead | undefined): string {
  if (!value) return hashObject(null);
  const session = value.schemaVersion === 2 ? value.session : value;
  return hashObject({
    kernel: value.schemaVersion === 2 ? value.kernelRoot : value.state,
    epochs: session.epochs, mode: session.mode, config: session.config,
    accepted: session.accepted, pending: session.pending,
    windowTokens: session.windowTokens, outputReserveTokens: session.outputReserveTokens,
    inFlight: session.inFlight, liveMessageIds: session.liveMessageIds,
    nativeSurfaceSeqs: session.nativeSurfaceSeqs, deleted: session.deleted,
  });
}
