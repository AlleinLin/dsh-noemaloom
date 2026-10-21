import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { relative, resolve } from 'node:path';
import type { NexusServices } from '../../ports/contracts.js';
import type { Finding } from '../orchestration/types.js';
import type { GateReviewEvidence, GateReviewMission, Run, TaskNode } from './types.js';
import { digest, safePath } from './util.js';

const REVIEW_ROLES = new Set(['reviewer', 'verifier', 'fresh-verifier', 'juror', 'arbiter', 'goal-checker', 'framework-validator']);
export const requiresReviewReport = (node: TaskNode): boolean => REVIEW_ROLES.has(node.orchestration?.candidateRole ?? node.role ?? '');
const sameSet = (actual: unknown, expected: string[]): boolean => Array.isArray(actual) && actual.every(item => typeof item === 'string') &&
  actual.length === expected.length && new Set(actual).size === actual.length && [...actual].sort().every((item, index) => item === [...expected].sort()[index]);
const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** Freeze subjects, actual workspace bytes and oracle contract before asking the independent actor. */
export async function freezeReviewMission(services: NexusServices, run: Run, reviewer: TaskNode): Promise<GateReviewMission> {
  const workspaceRoot = reviewer.cwd ?? services.workspaceRoot;
  const ancestors = new Set<string>();
  const pending = [reviewer.id];
  while (pending.length) {
    const target = pending.pop();
    for (const edge of run.planSnapshot.edges.filter(edge => edge.to === target)) {
      if (!ancestors.has(edge.from)) { ancestors.add(edge.from); pending.push(edge.from); }
    }
  }
  const inferredAuthors = run.planSnapshot.nodes.filter(node => ancestors.has(node.id) && ['implementer', 'author'].includes(node.role ?? '')).map(node => node.id);
  const subjectNodeIds = [...new Set(reviewer.orchestration?.authorNodeIds ?? inferredAuthors)].filter(id => id !== reviewer.id).sort();
  const expectedArtifacts: GateReviewMission['expectedArtifacts'] = [];
  const unavailableEvidence: string[] = [];
  const scope = new Set<string>();
  let readBytes = 0;
  const seenFiles = new Set<string>();
  const addFile = async (path: string, nodeId: string): Promise<void> => {
    const full = safePath(workspaceRoot, path);
    safePath(workspaceRoot, await realpath(full));
    const info = await stat(full);
    if (info.isDirectory()) {
      const entries = await readdir(full, { withFileTypes: true });
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.isSymbolicLink()) { unavailableEvidence.push(`symlink:${relative(workspaceRoot, resolve(full, entry.name))}`); continue; }
        await addFile(resolve(full, entry.name), nodeId);
      }
      return;
    }
    if (!info.isFile() || info.size > 32 * 1024 * 1024 || readBytes + info.size > 64 * 1024 * 1024 || seenFiles.size >= 2048) throw new Error('review snapshot exceeds file budget');
    const ref = `file:${relative(workspaceRoot, full).replaceAll('\\', '/')}`;
    if (seenFiles.has(ref)) return;
    seenFiles.add(ref);
    const bytes = await readFile(full); readBytes += bytes.length;
    expectedArtifacts.push({ ref, hash: createHash('sha256').update(bytes).digest('hex'), nodeId, kind: 'file' });
  };
  if (!subjectNodeIds.length) unavailableEvidence.push('subject-baseline-missing');
  for (const id of subjectNodeIds) {
    const subject = run.planSnapshot.nodes.find(node => node.id === id), runtime = run.nodeRuns[id];
    if (!subject || runtime?.state !== 'succeeded' || !runtime.resultRef) { unavailableEvidence.push(`subject-result-missing:${id}`); continue; }
    if (runtime.actorId === run.nodeRuns[reviewer.id]?.actorId) unavailableEvidence.push(`subject-actor-collision:${id}`);
    const artifact = runtime.resultRef;
    const stored = await services.store.get<{ content: string; hash: string; runId: string; nodeId: string }>('workflow-artifacts', artifact.id);
    if (!stored || stored.value.runId !== run.id || stored.value.nodeId !== id || stored.value.hash !== artifact.hash || digest(stored.value.content) !== artifact.hash) unavailableEvidence.push(`subject-artifact-invalid:${id}`);
    else expectedArtifacts.push({ ref: artifact.id, hash: artifact.hash, nodeId: id, kind: 'artifact' });
    for (const claim of subject.writeClaims ?? []) {
      scope.add(claim);
      if (claim.startsWith('resource:') || claim.startsWith('service:')) continue;
      try { await addFile(claim, id); } catch { unavailableEvidence.push(`scope-unavailable:${claim}`); }
    }
  }
  const gates = run.planSnapshot.nodes.filter(node => node.kind === 'gate' && (node.orchestration?.subjectNodeId === reviewer.id ||
    node.checks?.some(check => check.kind === 'independence' && check.subjectNodeId === reviewer.id)));
  for (const gate of gates) for (const check of gate.checks ?? []) {
    if (check.path) {
      scope.add(check.path);
      try { await addFile(check.path, subjectNodeIds[0] ?? 'missing'); } catch { unavailableEvidence.push(`oracle-file-unavailable:${check.path}`); }
    }
  }
  expectedArtifacts.sort((a, b) => a.ref.localeCompare(b.ref));
  const oracleChecks = gates.flatMap(gate => (gate.checks ?? []).map((check, index) => ({ ref: `${gate.id}:${check.id ?? `check-${index + 1}`}`, definition: structuredClone(check) })))
    .filter(check => check.definition.kind !== 'independence').sort((a, b) => a.ref.localeCompare(b.ref));
  const oracleIds = [...new Set(oracleChecks.map(check => check.ref))].sort();
  const candidateSnapshotHash = digest({ subjectNodeIds, expectedArtifacts, scope: [...scope].sort() });
  const contractHash = digest({ planHash: run.planHash, gates: gates.map(gate => ({ id: gate.id, policy: gate.orchestration?.gatePolicy, checks: gate.checks })) });
  const mission = {
    schemaVersion: 1 as const, runId: run.id, planHash: run.planHash, reviewerNodeId: reviewer.id,
    reviewerActorId: run.nodeRuns[reviewer.id]!.actorId, subjectNodeIds, candidateSnapshotHash, contractHash,
    expectedArtifacts, scope: [...scope].sort(), oracleIds, oracleChecks, unavailableEvidence: [...new Set(unavailableEvidence)].sort(),
  };
  return { ...mission, missionHash: digest(mission) };
}

export function reviewInstructions(mission: GateReviewMission): string {
  return [
    '宿主冻结的独立审查合同如下。subjectNodeIds 是被审作者；reviewerNodeId 是你自己的独立 actor。',
    JSON.stringify(mission),
    '只返回一个完整 JSON 对象，不要 Markdown。字段：schemaVersion:1，missionHash，candidateSnapshotHash，contractHash，subjectNodeIds，verdict:"pass"|"fail"|"needs-review"，reviewedArtifacts:[{ref,hash}]，reviewedOracleIds:[string]，findings:[{id,priority:0|1|2|3,trigger,evidenceRefs:[string],path?}]。',
    '使用只读工具读取 scope 内候选源码和原始文件证据；file: 引用给出工作区相对路径，hash 是实际文件字节的 SHA-256。artifact 引用仅用于作者产物溯源，作者自述不构成测试或 oracle 证明。不得读取前审结论或完整对话作为盲评依据。',
    '身份、hash、覆盖集合须与上述合同完全相同。发现缺陷或证据不足须 fail/needs-review。finding 必须引用合同内原始证据；不可自行宣布问题已解决。模型结论只是证据，宿主另行执行 oracle 决定质量门。',
  ].join('\n');
}

/** No prose inference, model-declared expected set, or model-declared resolution is trusted. */
export function validateReviewReport(text: string, mission: GateReviewMission): Omit<GateReviewEvidence, 'mission' | 'reportRef'> {
  const reasons = [...mission.unavailableEvidence.map(reason => `REVIEW_EVIDENCE_UNAVAILABLE:${reason}`)];
  let report: Record<string, unknown> | undefined;
  try { report = record(JSON.parse(text)); } catch { /* Invalid JSON stays invalid evidence. */ }
  const findings: Finding[] = [];
  if (!report) reasons.push('REVIEW_STRUCTURED_REPORT_REQUIRED');
  else {
    if (report.schemaVersion !== 1 || !['pass', 'fail', 'needs-review'].includes(String(report.verdict))) reasons.push('REVIEW_SCHEMA_INVALID');
    for (const key of ['missionHash', 'candidateSnapshotHash', 'contractHash'] as const) if (report[key] !== mission[key]) reasons.push(`REVIEW_SNAPSHOT_MISMATCH:${key}`);
    if (!sameSet(report.subjectNodeIds, mission.subjectNodeIds)) reasons.push('REVIEW_SUBJECT_MISMATCH');
    if (!sameSet(report.reviewedOracleIds, mission.oracleIds)) reasons.push('REVIEW_ORACLE_COVERAGE_MISMATCH');
    const artifacts = Array.isArray(report.reviewedArtifacts) ? report.reviewedArtifacts.map(record) : [];
    if (artifacts.some(item => !item) || artifacts.length !== mission.expectedArtifacts.length ||
      !sameSet(artifacts.map(item => item?.ref), mission.expectedArtifacts.map(item => item.ref)) ||
      artifacts.some(item => mission.expectedArtifacts.find(expected => expected.ref === item?.ref)?.hash !== item?.hash)) reasons.push('REVIEW_ARTIFACT_COVERAGE_MISMATCH');
    if (!Array.isArray(report.findings)) reasons.push('REVIEW_FINDINGS_REQUIRED');
    else for (const [index, raw] of report.findings.entries()) {
      const finding = record(raw);
      const refs = finding?.evidenceRefs;
      const allowedRefs = mission.expectedArtifacts.map(item => item.ref);
      if (!finding || ![0, 1, 2, 3].includes(finding.priority as number) || typeof finding.trigger !== 'string' || !finding.trigger.trim() ||
        !Array.isArray(refs) || !refs.length || refs.some(ref => typeof ref !== 'string' || !allowedRefs.includes(ref)) ||
        ('resolved' in finding && finding.resolved !== false)) { reasons.push(`REVIEW_FINDING_INVALID:${index}`); continue; }
      findings.push({ id: `${mission.reviewerNodeId}:${typeof finding.id === 'string' ? finding.id : index}`, priority: finding.priority as Finding['priority'],
        resolved: false, trigger: finding.trigger, evidenceRefs: refs as string[], path: typeof finding.path === 'string' ? finding.path : undefined });
    }
  }
  const valid = reasons.length === 0;
  const verdict = !valid ? 'needs-review' : report!.verdict === 'fail' || findings.some(finding => finding.priority <= 1) ? 'fail' : report!.verdict === 'pass' ? 'pass' : 'needs-review';
  return { valid, verdict, reasons, findings };
}
