import { NexusError, type HostAttemptMetadata, type HostAttemptReceipt } from '../../ports/contracts.js';
import type { Run, UsageAttempt } from './types.js';
import { digest } from './util.js';
import { normalizeUsage } from '../usage/normalize.js';

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const count = (value: unknown): value is number => finite(value) && Number.isSafeInteger(value);
const admissionHash = (meta: HostAttemptMetadata): string => digest({
  logicalCallId: meta.logicalCallId, attemptId: meta.attemptId, runId: meta.runId, nodeId: meta.nodeId,
  sessionId: meta.sessionId, provider: meta.provider, model: meta.model, startedAt: meta.startedAt,
  inputBytes: meta.inputBytes, inputTokens: meta.inputTokens, inputTokensUpperBound: meta.inputTokensUpperBound,
  maxOutputTokens: meta.maxOutputTokens, costUpperBound: meta.costUpperBound, costCurrency: meta.costCurrency,
  source: meta.source, providerHttpAttempts: meta.providerHttpAttempts,
});
const totalTokens = (attempt: UsageAttempt): number | null => {
  const usage = attempt.usage;
  const normalized = normalizeUsage(usage, attempt.provider);
  if (normalized.status === 'invalid') return null;
  if (count(usage?.totalTokens)) return usage.totalTokens;
  return normalized.providerTotal ?? (normalized.providerPromptTotal !== null && normalized.outputTokens !== null ? normalized.providerPromptTotal + normalized.outputTokens : null);
};
const cost = (attempt: UsageAttempt): number | null => finite(attempt.usage?.cost) ? attempt.usage.cost : finite(attempt.usage?.totalCost) ? attempt.usage.totalCost : null;
const knownSum = (values: (number | null)[]): number | null => values.length && values.every(value => value !== null) ? values.reduce<number>((sum, value) => sum + value!, 0) : null;
const limit = (value: number | undefined, used: number, dimension: string): void => {
  if (value !== undefined && used > value) throw new NexusError('BUDGET_EXHAUSTED', `${dimension}预算不足`, { limit: value, reserved: used, boundary: 'llm-runtime-stream' });
};
const capability = (dimension: string): never => { throw new NexusError('HOST_CAPABILITY_UNAVAILABLE', `宿主缺少可证明的${dimension}上界，不能承诺硬预算`, { boundary: 'llm-runtime-stream' }); };

/** A projection of the host's physical runtime attempts, mutated inside the scheduler's Run CAS. */
export function admitAttempt(run: Run, nodeId: string, meta: HostAttemptMetadata): boolean {
  if (!meta.logicalCallId || !meta.attemptId || !count(meta.inputBytes) || !Number.isFinite(Date.parse(meta.startedAt)) ||
    meta.runId !== run.id || meta.nodeId !== nodeId || meta.source !== 'llm-runtime-stream') throw new NexusError('MODEL_PROTOCOL_INVALID', '宿主 attempt metadata 无效或 Run/node 归属不符');
  const metadataHash = admissionHash(meta);
  const existing = run.usage.attempts.find(attempt => attempt.logicalCallId === meta.logicalCallId && attempt.attemptId === meta.attemptId);
  if (existing) {
    if (existing.nodeId !== nodeId || existing.admissionHash !== metadataHash) throw new NexusError('EVIDENCE_MISMATCH', '物理 attempt 身份被重复用于不同请求');
    return false;
  }
  const node = run.nodeRuns[nodeId];
  if (run.cancellationRequested || !node || !['starting', 'running'].includes(node.state)) throw new NexusError('CANCELLED', 'Run 或节点已停止，拒绝新的物理 attempt');
  const budget = run.planSnapshot.budgets;
  if (Date.now() - Date.parse(run.startedAt) > budget.maxWallMs || (budget.deadline && Date.now() > Date.parse(budget.deadline))) throw new NexusError('BUDGET_EXHAUSTED', '物理 attempt 超过 Run 时间预算');
  limit(budget.maxModelCalls, run.usage.modelCalls + 1, '运行时模型尝试');
  limit(budget.maxInputBytes, run.usage.inputBytes + meta.inputBytes, '模型输入字节');
  const inputBound = count(meta.inputTokensUpperBound) ? meta.inputTokensUpperBound : undefined;
  const outputBound = count(meta.maxOutputTokens) ? meta.maxOutputTokens : undefined;
  const costBound = finite(meta.costUpperBound) ? meta.costUpperBound : undefined;
  const tokenBudget = typeof budget.maxTokens === 'number' ? { total: budget.maxTokens } : budget.maxTokens;
  if (budget.hardOrAdvisory !== 'advisory') {
    const inputLimits = tokenBudget?.input !== undefined || tokenBudget?.total !== undefined;
    const outputLimits = tokenBudget?.output !== undefined || tokenBudget?.total !== undefined;
    if (inputLimits && inputBound === undefined) capability('输入 token');
    if (outputLimits && outputBound === undefined) capability('输出 token');
    const sumBounds = (field: 'inputTokensUpperBound' | 'maxOutputTokens' | 'costUpperBound', next: number | undefined): number => {
      if (next === undefined || run.usage.attempts.some(attempt => attempt[field] === undefined)) capability(field);
      return run.usage.attempts.reduce((sum, attempt) => sum + attempt[field]!, next!);
    };
    if (tokenBudget?.input !== undefined) limit(tokenBudget.input, sumBounds('inputTokensUpperBound', inputBound), '输入 token');
    if (tokenBudget?.output !== undefined) limit(tokenBudget.output, sumBounds('maxOutputTokens', outputBound), '输出 token');
    if (tokenBudget?.total !== undefined) limit(tokenBudget.total, sumBounds('inputTokensUpperBound', inputBound) + sumBounds('maxOutputTokens', outputBound), '总 token');
    if (budget.maxCost !== undefined) limit(budget.maxCost, sumBounds('costUpperBound', costBound), '费用');
  }
  run.usage.attempts.push({
    logicalCallId: meta.logicalCallId, attemptId: meta.attemptId, nodeId, sessionId: meta.sessionId,
    provider: meta.provider, model: meta.model, startedAt: meta.startedAt, observed: false, status: 'admitted',
    source: 'llm-runtime-stream', providerHttpAttempts: 'opaque', inputBytes: meta.inputBytes, inputTokensUpperBound: inputBound,
    maxOutputTokens: outputBound, costUpperBound: costBound, admissionHash: metadataHash,
  });
  run.usage.modelCalls++;
  run.usage.inputBytes += meta.inputBytes;
  refreshUsage(run);
  return true;
}

export function settleAttempt(run: Run, nodeId: string, receipt: HostAttemptReceipt): boolean {
  const attempt = run.usage.attempts.find(item => item.logicalCallId === receipt.logicalCallId && item.attemptId === receipt.attemptId);
  if (!attempt || attempt.nodeId !== nodeId) throw new NexusError('EVIDENCE_MISMATCH', '宿主结算没有已准入的 Run/node attempt');
  if (admissionHash(receipt) !== attempt.admissionHash) throw new NexusError('EVIDENCE_MISMATCH', '宿主结算的 attempt 身份或准入 metadata 被改变');
  if (!Number.isFinite(Date.parse(receipt.finishedAt)) || !['reported', 'unreported', 'failed', 'cancelled'].includes(receipt.status)) throw new NexusError('MODEL_PROTOCOL_INVALID', '宿主 attempt receipt 无效');
  const revision = receipt.usageRevision ?? 0;
  if (!count(revision)) throw new NexusError('MODEL_PROTOCOL_INVALID', 'usageRevision 必须为非负整数');
  const settlementHash = digest(receipt);
  if (attempt.settlementHash) {
    if (revision < (attempt.usageRevision ?? 0) || settlementHash === attempt.settlementHash) return false;
    if (revision === (attempt.usageRevision ?? 0) && !(attempt.status === 'unreported' && receipt.status === 'reported')) throw new NexusError('EVIDENCE_MISMATCH', '同版 attempt receipt 相互矛盾');
  }
  attempt.status = receipt.status;
  attempt.observed = receipt.status === 'reported';
  attempt.finishedAt = receipt.finishedAt;
  attempt.usage = receipt.usage;
  attempt.usageRevision = revision;
  attempt.settlementHash = settlementHash;
  attempt.receipt = structuredClone(receipt);
  refreshUsage(run);
  return true;
}

export function refreshUsage(run: Run): void {
  const attempts = run.usage.attempts;
  run.usage.totalTokens = knownSum(attempts.map(totalTokens));
  run.usage.cost = knownSum(attempts.map(cost));
  run.usage.complete = attempts.length > 0 && attempts.every(attempt => attempt.status === 'reported' && !!attempt.finishedAt) && run.usage.totalTokens !== null && run.usage.cost !== null;
}

/** Observed overages remain a failure even if a host's promised bound was wrong. */
export function observedBudgetViolation(run: Run): NexusError | undefined {
  const budget = run.planSnapshot.budgets;
  if (budget.hardOrAdvisory === 'advisory') return undefined;
  const tokenBudget = typeof budget.maxTokens === 'number' ? { total: budget.maxTokens } : budget.maxTokens;
  const input = run.usage.attempts.reduce((sum, attempt) => sum + (normalizeUsage(attempt.usage, attempt.provider).providerPromptTotal ?? 0), 0);
  const output = run.usage.attempts.reduce((sum, attempt) => sum + (normalizeUsage(attempt.usage, attempt.provider).outputTokens ?? 0), 0);
  // These are observed lower bounds used only to reject overages; visible totals
  // remain null whenever any attempt is unknown.
  const tokenFloor = run.usage.attempts.reduce((sum, attempt) => sum + (totalTokens(attempt) ?? 0), 0);
  const costFloor = run.usage.attempts.reduce((sum, attempt) => sum + (cost(attempt) ?? 0), 0);
  const exceeded = (tokenBudget?.total !== undefined && tokenFloor > tokenBudget.total) ||
    (tokenBudget?.input !== undefined && input > tokenBudget.input) ||
    (tokenBudget?.output !== undefined && output > tokenBudget.output) ||
    (budget.maxCost !== undefined && costFloor > budget.maxCost);
  return exceeded ? new NexusError('BUDGET_EXHAUSTED', '宿主实测用量超过硬预算', { boundary: 'llm-runtime-stream' }) : undefined;
}
