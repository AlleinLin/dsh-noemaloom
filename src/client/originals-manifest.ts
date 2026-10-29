/** Fixed upstream implementations selected for the integrated desktop build. */
export interface OriginalDefinition {
  id: string;
  packageName: string;
  version: string;
  role: 'sidebar' | 'conversation' | 'memory' | 'workspace' | 'settings' | 'canvas' | 'input';
  client: boolean;
  vendor?: string;
  revision?: string;
}

export const ORIGINAL_PLUGINS: readonly OriginalDefinition[] = [
  { id: 'better-sidebar', packageName: 'dsh-better-sidebar', version: '0.28.2', role: 'sidebar', client: true },
  { id: 'context', packageName: 'dsh-context', version: '0.78.0', role: 'conversation', client: true },
  { id: 'better-display', packageName: 'dsh-better-display', version: '0.3.9', role: 'conversation', client: true },
  { id: 'mnemon', packageName: 'dsh-mnemon', version: '0.5.36', role: 'memory', client: true },
  { id: 'task-board', packageName: '@linxin666/dsh-client-ui-task-board', version: '0.4.12', role: 'workspace', client: true },
  { id: 'git-graph', packageName: '@linxin666/dsh-client-ui-git-graph', version: '0.4.12', role: 'sidebar', client: true },
  { id: 'usage', packageName: '@linxin666/dsh-usage', version: '0.4.12', role: 'settings', client: true },
  { id: 'agency-agents', packageName: '@michengai/dsh-agency-agents', version: '1.2.18', role: 'settings', client: true },
  { id: 'turn-rewind', packageName: '@anionex/dsh-turn-rewind', version: '0.3.11', role: 'conversation', client: true },
  { id: 'codinput', packageName: 'dsh-codinput', version: '0.3.6', role: 'input', client: true, vendor: 'vendor/codinput', revision: '2d951e2d742cdf7776a57bff24996f806a6b015a' },
  { id: 'superpowers', packageName: '@wenaixi/dsh-superpower', version: '8.0.0', role: 'settings', client: true },
  { id: 'ponytail', packageName: '@wenaixi/dsh-ponytail', version: '5.6.2', role: 'settings', client: true },
  { id: 'openspec', packageName: '@dragon-talon/dsh-openspec', version: '0.4.0', role: 'workspace', client: false },
  { id: 'karpathy', packageName: 'dsh-karpathy-methodology', version: '0.1.0', role: 'workspace', client: false },
  { id: 'ops', packageName: 'dsh-ops', version: '0.4.4', role: 'settings', client: true },
  { id: 'motion-ui', packageName: 'dsh-motion-ui', version: '0.8.8', role: 'conversation', client: true },
  { id: 'cross-session-approval', packageName: 'dsh-cross-session-approval', version: '0.3.10', role: 'workspace', client: false },
  { id: 'computer-use', packageName: '@local/dsh-computer-use', version: '1.40.3', role: 'input', client: true, vendor: 'vendor/computer-use', revision: 'db4c44f9a3534118dbe2138c01b0dc156c9c2f8e' },
  // These original SPA hosts are reused by original-canvases.tsx. Their old
  // body-level overlay clients are deliberately not executed.
  { id: 'thoughtdag', packageName: 'dsh-thoughtdag', version: '0.5.26', role: 'canvas', client: false },
  { id: 'synapse', packageName: 'dsh-synapse', version: '0.5.5', role: 'canvas', client: false },
];

export interface OriginalFactoryRegistration {
  id: string;
  packageName: string;
  version: string;
  requires: readonly string[];
  factory(require: (specifier: string) => any): OriginalClientModule;
}

export interface OriginalClientModule {
  name?: string;
  inject?: readonly string[] | Record<string, unknown>;
  apply?: (ctx: any, config?: any) => any;
  [key: string]: unknown;
}
