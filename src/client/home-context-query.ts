import type { Data, NexusScope } from './types.js';

/** The home screen can inspect a workspace before a session has been selected. */
export function homeContextQuery(scope: NexusScope): { action: 'overview' | 'status'; params: Data } {
  const sessionId = typeof scope.sessionId === 'string' ? scope.sessionId.trim() : '';
  return sessionId ? { action: 'status', params: { sessionId } } : { action: 'overview', params: {} };
}
