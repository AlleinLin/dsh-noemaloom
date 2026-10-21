/**
 * Adapted from dsh-synapse 0.4.2 index.js WorkspaceStore session projection.
 * MIT (see LICENSE). Durable hidden sessions, child-before-parent repair,
 * callId tool pairing, and idempotent source turns are retained. Persistence
 * is supplied by Nexus CAS store rather than a second workspaces.json writer.
 */
import type { CanonicalSession, GraphEdge, GraphNode, GraphSnapshot } from '../../domain/graph/types.js';
import { hash, sha256 } from '../thoughtdag/graph.js';

export function projectSession(graph: GraphSnapshot, session: CanonicalSession, nextId: () => string): { added: number; changed: number; mapping: Record<string, string> } {
  const mapping: Record<string, string> = {};
  let added = 0, changed = 0;
  let previous: GraphNode | undefined;
  for (const turn of session.turns) {
    let node = graph.nodes.find(item => item.sourceSessionId === session.id && item.sourceTurnId === turn.id);
    if (node) {
      mapping[turn.id] = node.id;
      if (node.source?.contentHash !== turn.contentHash) {
        changed++;
        if (!node.mirrorEdited) {
          const versionId = nextId();
          node.versions.push({ id: versionId, nodeId: node.id, previousId: node.activeVersionId, text: turn.answer, providerId: session.agent,
            modelId: 'source-recorded', contextPlanId: '', inputHash: turn.contentHash, createdAt: new Date().toISOString(),
            status: turn.complete ? 'complete' : 'partial', stale: false, staleCauses: [], usageRequestIds: [], sourceRevisionSet: {} });
          node.question = turn.question;
          node.answerVersionIds.push(versionId);
          node.activeVersionId = versionId;
          node.source = { ...node.source!, revision: session.revision, contentHash: turn.contentHash };
          node.semanticRevision = hash({ question: node.question, versionId, contentHash: turn.contentHash });
        } else {
          for (const version of node.versions) version.stale = true;
        }
      }
    } else {
      const id = nextId(), versionId = nextId();
      node = {
        id, graphId: graph.id, kind: 'conversation', question: turn.question, answerVersionIds: [versionId], activeVersionId: versionId,
        versions: [{ id: versionId, nodeId: id, text: turn.answer, providerId: session.agent, modelId: 'source-recorded', contextPlanId: '',
          inputHash: turn.contentHash, createdAt: turn.timestamp ?? session.importedAt, status: turn.complete ? 'complete' : 'partial',
          stale: false, staleCauses: [], usageRequestIds: [], sourceRevisionSet: {} }],
        source: { kind: 'session', sourceId: session.sourceId, sessionId: session.id, turnId: turn.id, binding: 'live',
          revision: session.revision, contentHash: turn.contentHash },
        sourceSessionId: session.id, sourceTurnId: turn.id, attachmentIds: [], excludedAttachmentIds: [], includedAttachmentIds: [],
        archived: false, semanticRevision: sha256(turn.contentHash), x: previous?.x ?? 80, y: (previous?.y ?? -180) + 260,
        highlights: [], createdAt: turn.timestamp ?? session.importedAt,
      };
      graph.nodes.push(node); added++; mapping[turn.id] = node.id;
    }
    const parent = turn.parentTurnId
      ? graph.nodes.find(item => item.sourceSessionId === session.id && item.sourceTurnId === turn.parentTurnId)
      : previous;
    if (parent && parent.id !== node.id && !graph.edges.some(edge => edge.from === parent.id && edge.to === node!.id && edge.kind === 'conversation')) {
      graph.edges.push({ id: nextId(), graphId: graph.id, from: parent.id, to: node.id, kind: 'conversation', contextMode: 'full', order: 0 });
    }
    previous = node;
  }
  // Native Pi/Claude trees can name a parent turn that arrives later.
  for (const turn of session.turns) if (turn.parentTurnId && mapping[turn.id] && mapping[turn.parentTurnId]) {
    const from = mapping[turn.parentTurnId], to = mapping[turn.id];
    if (!graph.edges.some(edge => edge.from === from && edge.to === to)) {
      graph.edges.push({ id: nextId(), graphId: graph.id, from, to, kind: 'conversation', contextMode: 'full', order: 0 } satisfies GraphEdge);
    }
  }
  return { added, changed, mapping };
}
