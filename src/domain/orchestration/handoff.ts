import { NexusError } from '../../ports/contracts.js';
import type { ModelRef } from './types.js';
import { policyHash } from './util.js';

export interface ContextBlock {
  id: string;
  kind: 'summary' | 'artifact-ref' | 'text' | 'signed-thinking' | 'reasoning' | 'encrypted' | 'redacted' | 'provider-native';
  content: string;
  protocol?: string;
  version: string;
  sourceHash: string;
}
export interface HandoffManifest {
  fromPartition: string;
  toPartition: string;
  missionRef: string;
  contractRef: string;
  checkpointRef: string;
  artifactRefs: string[];
  unresolved: string[];
  authorizationRefs: string[];
  excludedContent: { id: string; reason: string; sourceHash: string }[];
  blocks: ContextBlock[];
  hash: string;
}
export function createHandoffManifest(input: {
  from: ModelRef; to: ModelRef; fromPartition: string; toPartition: string;
  missionRef: string; contractRef: string; checkpointRef: string; artifactRefs: string[];
  unresolved: string[]; authorizationRefs: string[]; blocks: ContextBlock[];
  maxSummaryBytes: number; allowSameProtocolContinuity: boolean;
}): HandoffManifest {
  if (!input.missionRef || !input.contractRef || !input.checkpointRef || !input.authorizationRefs.length) {
    throw new NexusError('HANDOFF_INCOMPLETE', 'Handoff 必须保留任务、合同、checkpoint 和授权引用。');
  }
  if (!Number.isFinite(input.maxSummaryBytes) || input.maxSummaryBytes <= 0) {
    throw new NexusError('HANDOFF_SUMMARY_LIMIT', 'Handoff 摘要上限必须是正数。');
  }
  const sameProtocol = input.from.providerRouteId === input.to.providerRouteId &&
    input.from.endpointIdentity === input.to.endpointIdentity && input.from.protocol === input.to.protocol &&
    input.from.credentialScopeId === input.to.credentialScopeId;
  const continuity = sameProtocol && input.allowSameProtocolContinuity;
  const blocks: ContextBlock[] = [], excludedContent: HandoffManifest['excludedContent'] = [];
  let summaryBytes = 0;
  for (const block of input.blocks) {
    if (!block.version || !block.sourceHash) throw new NexusError('HANDOFF_SOURCE_UNVERSIONED', 'Handoff 内容必须含原文版本和hash。', { id: block.id });
    if (continuity && (block.protocol === undefined || block.protocol === input.to.protocol)) {
      blocks.push({ ...block }); continue;
    }
    if (block.kind !== 'summary' && block.kind !== 'artifact-ref') {
      excludedContent.push({ id: block.id, reason: 'CROSS_PROTOCOL_MINIMUM_CONTEXT_ONLY', sourceHash: block.sourceHash }); continue;
    }
    if (block.kind === 'summary') {
      summaryBytes += Buffer.byteLength(block.content, 'utf8');
      if (summaryBytes > input.maxSummaryBytes) throw new NexusError('HANDOFF_SUMMARY_LIMIT', '语义摘要超出上限；必须重新生成受限摘要，不能静默截断。');
    }
    blocks.push({ ...block });
  }
  if (!continuity && !blocks.some(block => block.kind === 'summary')) throw new NexusError('HANDOFF_SUMMARY_MISSING', '跨协议切换需要已验证的最小语义摘要。');
  const manifest = { fromPartition: input.fromPartition, toPartition: input.toPartition,
    missionRef: input.missionRef, contractRef: input.contractRef, checkpointRef: input.checkpointRef,
    artifactRefs: [...input.artifactRefs], unresolved: [...input.unresolved], authorizationRefs: [...input.authorizationRefs],
    excludedContent, blocks };
  return { ...manifest, hash: policyHash(manifest) };
}
