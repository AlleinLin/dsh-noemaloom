import { NexusError, type NexusServices } from '../../ports/contracts.js';
import type { ArtifactRef, Run, TaskNode } from './types.js';
import { hasDependencyPath, nodeInputSource } from './plan.js';
import { digest } from './util.js';

export interface WorkflowInput {
  binding: string;
  ref: ArtifactRef;
  content: string;
}

/** Resolve immutable same-run results; a reference never selects a different
 * run, session, workspace, pending activation, or a caller-supplied artifact. */
export async function resolveWorkflowInputs(
  services: Pick<NexusServices, 'store'>, run: Run, node: TaskNode,
): Promise<WorkflowInput[]> {
  const inputs: WorkflowInput[] = [];
  let bytes = Buffer.byteLength(node.prompt ?? '');
  for (const binding of node.inputRefs ?? []) {
    if (binding.startsWith('transcript:') || binding.startsWith('verdict:')) {
      throw new NexusError('SCOPE_MISMATCH', '独立角色禁止继承其他角色完整历史或盲评结论');
    }
    const sourceId = nodeInputSource(binding);
    let owned: ArtifactRef | undefined;
    if (sourceId !== undefined) {
      if (!['agent', 'prompt', 'synthesis'].includes(node.kind) || sourceId === node.id
          || !run.planSnapshot.nodes.some(source => source.id === sourceId)
          || !hasDependencyPath(sourceId, node.id, run.planSnapshot.edges)) {
        throw new NexusError('SCOPE_MISMATCH', '节点输入不属于本 Run 的上游依赖路径', { nodeId: node.id, sourceNodeId: sourceId });
      }
      const source = Object.hasOwn(run.nodeRuns, sourceId) ? run.nodeRuns[sourceId] : undefined;
      if (source?.state !== 'succeeded' || !source.resultRef || source.resultRef.nodeId !== sourceId) {
        throw new NexusError('DEPENDENCY_FAILED', '上游节点尚未成功提交结果', { nodeId: node.id, sourceNodeId: sourceId });
      }
      owned = run.artifacts.find(ref => ref.id === source.resultRef!.id && ref.nodeId === sourceId
        && ref.hash === source.resultRef!.hash && ref.bytes === source.resultRef!.bytes);
    } else {
      owned = run.artifacts.find(ref => ref.id === binding
        && run.planSnapshot.nodes.some(source => source.id === ref.nodeId));
    }
    if (!owned) throw new NexusError('SCOPE_MISMATCH', '输入产物没有本 Run 的正式引用', { nodeId: node.id });
    const stored = await services.store.get<{ content: string; hash: string; runId: string; nodeId: string }>('workflow-artifacts', owned.id);
    if (!stored || stored.value.runId !== run.id || stored.value.nodeId !== owned.nodeId) {
      throw new NexusError('SCOPE_MISMATCH', '输入产物属于其他 Run 或节点', { nodeId: node.id });
    }
    if (typeof stored.value.content !== 'string' || stored.value.hash !== owned.hash
        || digest(stored.value.content) !== owned.hash || Buffer.byteLength(stored.value.content) !== owned.bytes) {
      throw new NexusError('EVIDENCE_MISMATCH', '输入产物与本 Run 冻结的 hash/字节数不一致', { nodeId: node.id });
    }
    const content = stored.value.content;
    bytes += Buffer.byteLength(content) + Buffer.byteLength(`\n\n[Artifact ${owned.id} sha256=${owned.hash}]\n`);
    if (bytes > run.planSnapshot.budgets.maxInputBytes) {
      throw new NexusError('BUDGET_EXHAUSTED', '完整上游数据超出输入字节预算；未截断结果或发出模型请求');
    }
    inputs.push({ binding, ref: { ...owned }, content });
  }
  return inputs;
}
