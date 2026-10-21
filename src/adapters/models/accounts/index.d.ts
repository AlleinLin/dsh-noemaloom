export function validateAccountConfig(raw?: unknown): { monitors: Record<string, Record<string, unknown>> };
export function resolveAccountSpec(provider: Record<string, unknown>, config?: unknown): Record<string, unknown>;
export function queryAccount(spec: unknown, credentials: { resolve(reference: string): Promise<unknown> }, deps?: unknown): Promise<Record<string, unknown>>;
export function createAccountService(options: unknown): {
  get(id: string, options?: {force?: boolean}): Promise<Record<string, unknown> | null>;
  refreshAll(): Promise<Record<string, unknown>[]>;
  providerViews(): Promise<Record<string, unknown>[]>;
  cached(id: string): Record<string, unknown> | null;
};
