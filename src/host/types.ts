/** Structural rc.2 seam: optional services are queried, never assumed active. */
export interface HostContext {
  get(name: string): any;
  on(name: string, callback: (...args: any[]) => any, options?: any): any;
  effect(factory: () => any, label?: string): any;
  provide(name: string, value: any): () => void;
  emit?(name: string, ...args: any[]): any;
  logger?: { info(...args: any[]): void; warn(...args: any[]): void; error(...args: any[]): void };
  connection: { fetch: { register(route: {
    path: string; methods: string[]; requestBody: 'buffered';
    fetch(request: Request): Promise<Response>;
  }): () => Promise<void> } };
}

export interface NexusConfig {
  dataDir?: string;
  workspaceRoot?: string;
  maxRequestBytes?: number;
  maxOutputBytes?: number;
  modelWindowTokens?: number;
  /** User-configured exact role routing; no ambient provider fallback. */
  modelRoutes?: Record<string, { provider: string; model: string; reasoningEffort?: string; credentialScope?: string }>;
}
