/**
 * Host implementations are mounted as formal Loader entries through generated
 * package subpaths, not by imperatively applying them inside the Nexus host.
 * This keeps settings entry IDs, remote discovery, injection, restart and
 * teardown under the desktop Loader's authority.
 */
export const ORIGINAL_HOST_ENTRY_PREFIX = 'dsh-noemaloom/original/';

export const ORIGINAL_HOST_IDS = [
  'better-sidebar', 'context', 'better-display', 'mnemon',
  'task-board', 'git-graph', 'usage', 'agency-agents',
  'agency-agents-remote', 'turn-rewind', 'codinput', 'thoughtdag', 'synapse',
  'superpowers', 'ponytail', 'openspec', 'karpathy',
  'motion-ui', 'cross-session-approval', 'computer-use',
] as const;
