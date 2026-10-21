import type { Context } from '@deepseek-ai/cordis';

export const name: string;
export const inject: readonly string[];
export const RULE_CANDIDATES: readonly string[];
export const HOOK_MARKER: string;
export function effectiveHook(original: string): string;
export function initializeProcedures(ctx: Context, cwd: string, signal?: AbortSignal): Promise<string[]>;
export function installProceduresHook(ctx: Context, cwd: string, signal?: AbortSignal): Promise<{ filename: string; changed: boolean }>;
export function apply(ctx: Context): void;
declare const plugin: { name: typeof name; inject: typeof inject; apply: typeof apply };
export default plugin;
