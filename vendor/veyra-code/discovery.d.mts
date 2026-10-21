export function cbmProjectName(root: string): string;
export function resolveSafeRepoPath(root: string, path: string): string | null;
export function discoverRepository(root: string, options?: Record<string, unknown>): unknown[];
export function sanitizeCodeContent(content: string): string;
