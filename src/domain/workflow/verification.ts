import { readFile, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { DispatchContext, JsonRecord, NexusServices } from '../../ports/contracts.js';
import { NexusError } from '../../ports/contracts.js';
import type { Oracle, Run, TaskNode } from './types.js';
import { safePath } from './util.js';

export interface CheckResult { id: string; kind: string; status: 'passed' | 'failed' | 'unverified' | 'not_applicable'; evidence: unknown; }
/**
 * Host-owned oracles. A model's PASS/VERIFIED prose is never an execution receipt.
 * Evidence is generated here from a process, file digest, typed metric or actor identity.
 */
export async function verifyChecks(services: NexusServices, checks: Oracle[], run: Run, node: TaskNode, context: DispatchContext): Promise<CheckResult[]> {
  if (checks.length === 0) return [{ id: 'empty', kind: 'none', status: 'unverified', evidence: { reason: '没有可执行检查，不能视为通过' } }];
  const output: CheckResult[] = [];
  const workspaceRoot = context.workspaceRoot ?? node.cwd ?? services.workspaceRoot;
  for (let i = 0; i < checks.length; i++) {
    const check = checks[i]!;
    const id = check.id ?? `check-${i + 1}`;
    try {
      if (check.kind === 'command') {
        if (!check.command || !Array.isArray(check.args)) throw new NexusError('INVALID_ARGUMENT', '命令 oracle 需要 command 和结构化 args');
        const result = await services.executor.run(check.command, check.args, { cwd: node.cwd ?? workspaceRoot, timeoutMs: check.timeoutMs ?? 120000, signal: context.signal });
        output.push({ id, kind: check.kind, status: result.exitCode === (check.expectedExitCode ?? 0) && !result.cancelled ? 'passed' : 'failed', evidence: result });
      } else if (check.kind === 'file' || check.kind === 'json' || check.kind === 'metric') {
        if (!check.path) throw new NexusError('INVALID_ARGUMENT', '文件 oracle 缺少 path');
        const path = safePath(workspaceRoot, check.path);
        safePath(workspaceRoot, await realpath(path));
        const info = await stat(path);
        if (!info.isFile() || info.size > 32 * 1024 * 1024) throw new NexusError('BUDGET_EXHAUSTED', '检查文件不是普通文件或超过 32 MiB');
        const data = await readFile(path), hash = createHash('sha256').update(data).digest('hex');
        let passed = !(check.nonEmpty && data.length === 0) && (!check.sha256 || hash === check.sha256);
        let observed: unknown;
        if (check.kind !== 'file') {
          const parsed: unknown = JSON.parse(data.toString('utf8'));
          const segments = (check.jsonPath ?? check.metric ?? '').split('.').filter(Boolean);
          observed = segments.reduce<unknown>((current, part) => current !== null && typeof current === 'object' ? (current as JsonRecord)[part] : undefined, parsed);
          if ('equals' in check) passed &&= JSON.stringify(observed) === JSON.stringify(check.equals);
          if (check.min !== undefined) passed &&= typeof observed === 'number' && Number.isFinite(observed) && (check.minExclusive ? observed > check.min : observed >= check.min);
          if (check.max !== undefined) passed &&= typeof observed === 'number' && Number.isFinite(observed) && (check.maxExclusive ? observed < check.max : observed <= check.max);
          if (check.kind === 'metric' && check.min === undefined && check.max === undefined && !('equals' in check)) throw new NexusError('INVALID_ARGUMENT', 'metric oracle 必须有阈值');
        }
        output.push({ id, kind: check.kind, status: passed ? 'passed' : 'failed', evidence: { path, bytes: data.length, sha256: hash, observed, datasetRef: check.datasetRef } });
      } else if (check.kind === 'artifact') {
        const artifact = run.artifacts.find(a => a.id === check.artifactId);
        if (!artifact) throw new NexusError('NOT_FOUND', '产物引用不存在');
        const row = await services.store.get<{ content: string }>('workflow-artifacts', artifact.id);
        const data = row?.value.content;
        const passed = data !== undefined && (!check.nonEmpty || data.trim().length > 0) && (!check.sha256 || check.sha256 === artifact.hash) && createHash('sha256').update(data).digest('hex') === artifact.hash;
        output.push({ id, kind: check.kind, status: passed ? 'passed' : 'failed', evidence: { artifact, integrityChecked: true } });
      } else if (check.kind === 'independence') {
        const current = run.nodeRuns[check.subjectNodeId ?? node.orchestration?.subjectNodeId ?? node.id]!;
        const predecessors = [...(check.authorNodeIds ?? node.orchestration?.authorNodeIds ?? []), ...(check.reviewerNodeIds ?? node.orchestration?.priorReviewerNodeIds ?? [])].map(ref => run.nodeRuns[ref]);
        const actorDistinct = predecessors.every(other => other && other.actorId !== current.actorId);
        const contextClean = !node.inputRefs?.some(ref => ref.startsWith('verdict:') || ref.startsWith('transcript:'));
        const currentModel = current.observedRoute?.model;
        const differentModel = !check.requireDifferentModel || (!!currentModel && predecessors.every(other => !!other?.observedRoute?.model && other.observedRoute.model !== currentModel));
        output.push({ id, kind: check.kind, status: actorDistinct && contextClean && differentModel && predecessors.length > 0 ? 'passed' : 'failed', evidence: { actorDistinct, contextClean, differentModel, actorId: current.actorId, predecessorCount: predecessors.length } });
      } else throw new NexusError('INVALID_ARGUMENT', `未知 oracle ${String(check.kind)}`);
    } catch (error) {
      output.push({ id, kind: check.kind, status: 'failed', evidence: { code: error instanceof NexusError ? error.code : 'CHECK_FAILED', message: error instanceof Error ? error.message : String(error) } });
    }
  }
  return output;
}
