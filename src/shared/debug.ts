export type DebugLanguage = 'node' | 'python' | 'java' | 'csharp' | 'rust';
export type DebugPhase = 'preparing' | 'starting' | 'running' | 'stopped' | 'terminated' | 'failed';
export interface DebugBreakpoint { line: number; column?: number; condition?: string; hitCondition?: string; logMessage?: string }
export interface DebugScope { sessionId: string; workspaceRoot: string }
export interface DebugEvent { cursor: number; event: string; body: any }
export interface DebugSnapshot {
  id: string; sessionId: string; phase: DebugPhase; language: DebugLanguage;
  generation: number; capabilities: Record<string, any>; exitCode?: number;
  stopped?: { reason: string; threadId?: number; allThreadsStopped?: boolean };
  failure?: { phase: string; message: string };
}
export interface DebugLaunch {
  name?: string; type?: string; request?: 'launch' | 'attach'; program?: string; cwd?: string;
  args?: string[]; env?: Record<string, string | null>; [key: string]: any;
}
export interface DebugCommand {
  action: string; params: Record<string, any>; scope: DebugScope;
}
