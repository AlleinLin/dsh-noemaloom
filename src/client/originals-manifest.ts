/** Fixed upstream implementations selected for the integrated desktop build. */
export interface OriginalDefinition {
  id: string;
  packageName: string;
  version: string;
  role: 'sidebar' | 'conversation' | 'memory' | 'workspace' | 'settings' | 'canvas';
  client: boolean;
}

export const ORIGINAL_PLUGINS: readonly OriginalDefinition[] = [
  { id: 'better-sidebar', packageName: 'dsh-better-sidebar', version: '0.28.0', role: 'sidebar', client: true },
  { id: 'context', packageName: 'dsh-context', version: '0.73.3', role: 'conversation', client: true },
  { id: 'better-display', packageName: 'dsh-better-display', version: '0.3.8', role: 'conversation', client: true },
  { id: 'mnemon', packageName: 'dsh-mnemon', version: '0.5.32', role: 'memory', client: true },
  { id: 'task-board', packageName: '@linxin666/dsh-client-ui-task-board', version: '0.4.7', role: 'workspace', client: true },
  { id: 'git-graph', packageName: '@linxin666/dsh-client-ui-git-graph', version: '0.4.7', role: 'sidebar', client: true },
  { id: 'usage', packageName: '@linxin666/dsh-usage', version: '0.4.7', role: 'settings', client: true },
  { id: 'agency-agents', packageName: '@michengai/dsh-agency-agents', version: '1.2.7', role: 'settings', client: true },
  { id: 'turn-rewind', packageName: '@anionex/dsh-turn-rewind', version: '0.3.10', role: 'conversation', client: true },
  // These original SPA hosts are reused by original-canvases.tsx. Their old
  // body-level overlay clients are deliberately not executed.
  { id: 'thoughtdag', packageName: 'dsh-thoughtdag', version: '0.5.21', role: 'canvas', client: false },
  { id: 'synapse', packageName: 'dsh-synapse', version: '0.4.2', role: 'canvas', client: false },
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
