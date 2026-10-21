import { NexusError } from '../../ports/contracts.js';

export interface AutonomyStep { id: string; title: string; description: string; dependsOn: string[]; acceptance: string[] }
export interface AutonomyEvidence {
  stepId: string; activationId: string; turnEndSeq?: number; evidenceRefs: number[];
  verdict: 'completed' | 'incomplete' | 'unknown'; inference: true; at: string;
}
export interface AutonomyPlan {
  id: string; sessionId: string; workspace: string; objective: string; steps: AutonomyStep[];
  status: 'proposed' | 'approved' | 'running' | 'paused' | 'rejected' | 'completed' | 'needs-review';
  planRevision: number; approvedRevision?: number; currentStep?: string;
  progress: { completed: number; total: number; rounds: number; maxRounds: number; stepStates: Record<string, 'pending' | 'running' | 'completed'> };
  evidence: AutonomyEvidence[]; reason?: string; source: 'model-inference' | 'user-edited';
  userEpoch: number; lastUserSeq: number; lastUserMessageId?: string; needsProposal: boolean; resumeFromStop?: boolean;
  approval?: { actor: 'connection-owner'; at: string; userEpoch: number };
  delivery?: { requestId: string; stepId: string; state: 'intent' | 'sent' | 'unknown'; startSeq: number; activationId?: string; terminal?: 'succeeded' };
  monitor: {
    state: 'idle' | 'started' | 'ready' | 'failed' | 'unknown';
    day: string; callsToday: number; lastCallAt: number; throughSeq: number;
    hash?: string; inputHash?: string; route?: string; kind?: 'plan' | 'verify'; token?: string; errorCode?: string;
  };
  createdAt: string; updatedAt: string;
}
const text = (value: unknown, max: number): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new NexusError('INVALID_ARGUMENT', '计划文本为空或超过长度上限');
  return value.trim();
};
export function validatePlan(value: unknown): { objective: string; steps: AutonomyStep[] } {
  const input = value as any;
  if (!input || typeof input !== 'object' || !Array.isArray(input.steps) || input.steps.length < 1 || input.steps.length > 12) {
    throw new NexusError('INVALID_ARGUMENT', '计划需要一至十二个步骤');
  }
  const steps: AutonomyStep[] = input.steps.map((step: any) => {
    if (!step || typeof step !== 'object' || typeof step.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(step.id)
      || !Array.isArray(step.dependsOn) || step.dependsOn.length > 11 || step.dependsOn.some((id: unknown) => typeof id !== 'string')
      || !Array.isArray(step.acceptance) || step.acceptance.length < 1 || step.acceptance.length > 6) {
      throw new NexusError('INVALID_ARGUMENT', '步骤标识、依赖或验收条件无效');
    }
    return { id: step.id, title: text(step.title, 160), description: text(step.description, 1200),
      dependsOn: [...new Set<string>(step.dependsOn)], acceptance: step.acceptance.map((item: unknown) => text(item, 600)) };
  });
  const byId = new Map(steps.map(step => [step.id, step]));
  if (byId.size !== steps.length || steps.some(step => step.dependsOn.some(id => id === step.id || !byId.has(id)))) {
    throw new NexusError('INVALID_ARGUMENT', '步骤标识重复、依赖不存在或依赖自身');
  }
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new NexusError('INVALID_ARGUMENT', '计划依赖存在循环');
    if (visited.has(id)) return;
    visiting.add(id); for (const dependency of byId.get(id)!.dependsOn) visit(dependency);
    visiting.delete(id); visited.add(id);
  };
  for (const step of steps) visit(step.id);
  return { objective: text(input.objective, 2400), steps };
}
export function parsePlan(text: string): ReturnType<typeof validatePlan> {
  try { return validatePlan(JSON.parse(text.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, ''))); }
  catch { throw new NexusError('INVALID_MODEL_OUTPUT', '模型计划不满足有界步骤、依赖或验收合同'); }
}
export function parseVerdict(text: string, allowed: Set<number>): Pick<AutonomyEvidence, 'verdict' | 'evidenceRefs'> {
  try {
    const value = JSON.parse(text.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, ''));
    if (!['completed', 'incomplete', 'unknown'].includes(value?.verdict) || !Array.isArray(value.evidenceRefs)
      || value.evidenceRefs.length > 20 || value.evidenceRefs.some((seq: unknown) => !Number.isSafeInteger(seq) || !allowed.has(Number(seq)))) throw new Error();
    return { verdict: value.verdict, evidenceRefs: [...new Set<number>(value.evidenceRefs)] };
  } catch { throw new NexusError('INVALID_MODEL_OUTPUT', '步骤核验必须引用本次提供的正式事件'); }
}
