export interface ProcessOptions {
  signal?: AbortSignal; timeoutMs: number; maxOutputBytes?: number;
  cwd?: string; env?: NodeJS.ProcessEnv; label?: string;
}
export interface ProcessResult { stdout: string; stderr: string; exitCode: number | null }
export type ProcessRunner = (command: string, args: readonly string[], options: ProcessOptions) => Promise<ProcessResult>;
export const runProcess: ProcessRunner = async () => {
  throw new Error('Nexus ExecutionBroker must be supplied by the provider host');
};
