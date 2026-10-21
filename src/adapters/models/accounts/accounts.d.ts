export function isPrivateAddress(address: string): boolean;
export function validateAccountConfig(raw?: unknown): { monitors: Record<string, Record<string, unknown>> };
export function resolveAccountSpec(provider: Record<string, unknown>, config?: unknown): Record<string, unknown>;
export function queryAccount(spec: unknown, credentials: { resolve(reference: string): Promise<unknown> }, deps?: unknown): Promise<Record<string, unknown>>;
