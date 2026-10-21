import { NexusError } from '../../ports/contracts.js';
import type { BlueprintNode, CheckPolicy, GatePolicy, ShapeDecision, Tier, ValidationIssue, VerificationKind, WorkflowBlueprint } from './types.js';
import { FRAMEWORK_IDS, GATE_LIBRARY, ROLE_IDS } from './catalog.js';
import { policyHash } from './util.js';

const PROTECTED_INVARIANTS = ['authorization', 'budget', 'idempotency', 'cancellation', 'credentials', 'evidence', 'no-recursive-fleet'];
export function validateBlueprint(blueprint: WorkflowBlueprint, options: {
  requiredProtectedGates?: string[]; allowedCapabilityIds?: readonly string[]; current?: WorkflowBlueprint;
} = {}): { valid: boolean; issues: ValidationIssue[]; topologicalOrder: string[]; hash: string } {
  const issues: ValidationIssue[] = [];
  const issue = (code: string, path: string, message: string): void => { issues.push({ code, path, message }); };
  if (blueprint.schemaVersion !== 1) issue('BLUEPRINT_SCHEMA_INVALID', 'schemaVersion', 'Unsupported blueprint schema');
  if (!blueprint.id || !Number.isInteger(blueprint.revision) || blueprint.revision < 1) issue('BLUEPRINT_SCHEMA_INVALID', 'id/revision', 'Stable identity and positive revision required');
  const nodes = new Map<string, BlueprintNode>();
  const gateIds = new Set(blueprint.gates.map(gate => gate.gateId));
  const roles = new Set(blueprint.roles.map(role => role.roleId));
  if (gateIds.size !== blueprint.gates.length) issue('BLUEPRINT_DUPLICATE_GATE', 'gates', 'Gate ids must be unique');
  if (roles.size !== blueprint.roles.length) issue('BLUEPRINT_DUPLICATE_ROLE', 'roles', 'Role ids must be unique');
  for (const [index, node] of blueprint.nodes.entries()) {
    if (nodes.has(node.id)) issue('BLUEPRINT_DUPLICATE_NODE', `nodes.${index}.id`, node.id);
    nodes.set(node.id, node);
    if (node.kind === 'gate' && !gateIds.has(node.ref)) issue('GATE_UNREGISTERED', `nodes.${index}.ref`, node.ref);
    if (node.kind === 'role' && !roles.has(node.ref)) issue('ROLE_UNREGISTERED', `nodes.${index}.ref`, node.ref);
    if (node.kind === 'framework' && !FRAMEWORK_IDS.includes(node.ref as typeof FRAMEWORK_IDS[number]) && !node.ref.startsWith('generated:')) issue('FRAMEWORK_UNREGISTERED', `nodes.${index}.ref`, node.ref);
  }
  for (const [index, gate] of blueprint.gates.entries()) {
    if (!GATE_LIBRARY.some(registered => registered.gateId === gate.gateId) && !gate.gateId.startsWith('custom:')) issue('GATE_UNREGISTERED', `gates.${index}`, gate.gateId);
    if (['G2', 'sweep', 'goal-check'].includes(gate.gateId) && gate.scope !== 'run') issue('GATE_SCOPE_INVALID', `gates.${index}.scope`, 'This gate is run scoped');
    if (gate.requiredRoles.some(role => !ROLE_IDS.includes(role as typeof ROLE_IDS[number]))) issue('ROLE_UNREGISTERED', `gates.${index}.requiredRoles`, gate.gateId);
    if (!Number.isInteger(gate.maxLoops) || gate.maxLoops < 0 || gate.maxLoops > blueprint.budgets.maxRepairRounds) issue('REPAIR_BUDGET_INVALID', `gates.${index}.maxLoops`, 'Cannot reset or exceed root repair budget');
    if (typeof gate.onFail !== 'string' && !nodes.has(gate.onFail.loopTo)) issue('FALLBACK_NODE_MISSING', `gates.${index}.onFail`, gate.onFail.loopTo);
    const checks = new Set<string>();
    for (const check of gate.checks) {
      if (checks.has(check.id)) issue('CHECK_DUPLICATE', `gates.${index}.checks`, check.id);
      checks.add(check.id);
    }
  }
  const required = options.requiredProtectedGates ?? (blueprint.releaseEligible ?
    blueprint.tier === 'FAST_PATH' ? [] : blueprint.tier === 'T0' ? ['G6', 'goal-check'] : ['G5', 'G6', 'goal-check'] : []);
  const protectedGates = new Set([...(options.current?.gates.filter(gate => gate.protected).map(gate => gate.gateId) ?? []), ...required]);
  for (const gateId of protectedGates) {
    const gate = blueprint.gates.find(item => item.gateId === gateId);
    if (!gate || !gate.protected || !blueprint.nodes.some(node => node.kind === 'gate' && node.ref === gateId)) issue('PROTECTED_GATE_REMOVED', 'gates', gateId);
    const previous = options.current?.gates.find(item => item.gateId === gateId);
    if (previous && gate) {
      if (previous.independent && !gate.independent) issue('PROTECTED_INDEPENDENCE_WEAKENED', 'gates', gateId);
      if (previous.checks.some(check => check.required && !gate.checks.some(next => next.id === check.id && next.required))) issue('PROTECTED_CHECK_REMOVED', 'gates', gateId);
    }
  }
  for (const invariant of [...PROTECTED_INVARIANTS, ...(options.current?.protectedInvariants ?? [])]) {
    if (!blueprint.protectedInvariants.includes(invariant)) issue('PROTECTED_INVARIANT_REMOVED', 'protectedInvariants', invariant);
  }
  for (const [index, role] of blueprint.roles.entries()) {
    if (!ROLE_IDS.includes(role.roleId as typeof ROLE_IDS[number]) && !role.roleId.startsWith('custom:')) issue('ROLE_UNREGISTERED', `roles.${index}.roleId`, role.roleId);
    if (options.allowedCapabilityIds && role.allowedCapabilityIds.some(capability => !options.allowedCapabilityIds!.includes(capability))) issue('CAPABILITY_ESCALATION', `roles.${index}.allowedCapabilityIds`, role.roleId);
    if (['reviewer', 'verifier', 'fresh-verifier', 'juror'].includes(role.roleId) && role.allowedCapabilityIds.some(capability => /(?:write|delete|publish|commit)/.test(capability))) issue('READ_ONLY_ROLE_CAPABILITY', `roles.${index}`, role.roleId);
    if (!Number.isInteger(role.executorPolicy.maxDepth) || role.executorPolicy.maxDepth < 0 ||
      (blueprint.budgets.maxDepth !== null && role.executorPolicy.maxDepth > blueprint.budgets.maxDepth)) issue('DEPTH_BUDGET_INVALID', `roles.${index}.executorPolicy`, role.roleId);
  }
  for (const [key, value] of Object.entries(blueprint.budgets)) {
    if (value !== null && (!Number.isInteger(value) || value < 0)) issue('BUDGET_INVALID', `budgets.${key}`, 'Use a nonnegative integer or explicit null for unlimited');
  }
  const successors = new Map<string, string[]>(), inDegree = new Map([...nodes.keys()].map(id => [id, 0]));
  for (const [index, edge] of blueprint.edges.entries()) {
    if (!nodes.has(edge.from) || !nodes.has(edge.to)) { issue('EDGE_NODE_MISSING', `edges.${index}`, `${edge.from}->${edge.to}`); continue; }
    if (edge.kind === 'dependency') {
      successors.set(edge.from, [...(successors.get(edge.from) ?? []), edge.to]);
      inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
    }
  }
  const ready = [...inDegree.entries()].filter(([, degree]) => degree === 0).map(([id]) => id).sort();
  const topologicalOrder: string[] = [];
  while (ready.length) {
    const id = ready.shift()!; topologicalOrder.push(id);
    for (const next of successors.get(id) ?? []) {
      const degree = inDegree.get(next)! - 1; inDegree.set(next, degree);
      if (degree === 0) { ready.push(next); ready.sort(); }
    }
  }
  if (topologicalOrder.length !== nodes.size) issue('DEPENDENCY_CYCLE', 'edges', 'Work dependencies must form a DAG; repair edges are separate');
  const completes = blueprint.nodes.filter(node => node.kind === 'complete');
  if (completes.length !== 1) issue('COMPLETE_EXIT_INVALID', 'nodes', 'Exactly one completion exit required');
  if (completes[0] && (successors.get(completes[0].id)?.length ?? 0) > 0) issue('COMPLETE_NOT_TERMINAL', 'nodes', completes[0].id);
  const reachable = (from: string, to: string, visited = new Set<string>()): boolean => {
    if (from === to) return true;
    if (visited.has(from)) return false;
    visited.add(from);
    return (successors.get(from) ?? []).some(next => reachable(next, to, visited));
  };
  for (const edge of blueprint.edges.filter(item => item.kind === 'failure')) {
    if (!reachable(edge.to, edge.from)) issue('FALLBACK_NOT_PREDECESSOR', 'edges', `${edge.from}->${edge.to}`);
  }
  if (completes[0]) {
    for (const node of blueprint.nodes) if (!reachable(node.id, completes[0].id)) issue('NODE_CANNOT_COMPLETE', 'nodes', node.id);
  }
  return { valid: issues.length === 0, issues, topologicalOrder, hash: policyHash(blueprint) };
}

export function compileBlueprint(blueprint: WorkflowBlueprint, shape: ShapeDecision): {
  snapshot: WorkflowBlueprint; snapshotHash: string; order: string[]; spawnAllowed: boolean; assuranceGaps: string[];
} {
  if (shape.blocked) throw new NexusError('TASK_CONTRACT_INCOMPLETE', 'Ownership 合同尚未完整。', shape.reasons);
  const validation = validateBlueprint(blueprint);
  if (!validation.valid) throw new NexusError('BLUEPRINT_INVALID', '蓝图未通过执行前校验。', validation.issues);
  // Structured clone prevents later UI edits from mutating the accepted snapshot.
  const snapshot = structuredClone(blueprint);
  return { snapshot, snapshotHash: validation.hash, order: validation.topologicalOrder,
    spawnAllowed: shape.allowSpawn, assuranceGaps: [...shape.assuranceGaps] };
}

/** Blank checks remain unverified. The delivery-contract compiler supplies actual configured oracles. */
export function createBuiltinBlueprint(input: {
  id: string; tier: Exclude<Tier, 'FAST_PATH'>; verificationKind: VerificationKind;
  gateChecks?: Partial<Record<string, CheckPolicy[]>>; debug?: boolean; designFork?: boolean;
}): WorkflowBlueprint {
  const gateIds = [
    ...(input.debug ? ['G0', 'G3.5'] : []),
    ...(input.designFork ? ['G1'] : []),
    ...(['T2', 'T3'].includes(input.tier) ? ['G2'] : []),
    'G4', ...(input.tier !== 'T0' ? ['G5'] : []), 'G6',
    ...(input.tier === 'T3' ? ['sweep'] : []), 'goal-check',
  ];
  const gates = gateIds.map(gateId => {
    const base = GATE_LIBRARY.find(gate => gate.gateId === gateId)!;
    return { ...structuredClone(base), checks: structuredClone(input.gateChecks?.[gateId] ?? []),
      independent: input.tier === 'T0' ? false : base.independent,
      protected: ['G5', 'G6', 'goal-check'].includes(gateId) };
  });
  const nodes: BlueprintNode[] = gates.map(gate => ({ id: `gate:${gate.gateId}`, kind: 'gate', ref: gate.gateId,
    ...(gate.scope === 'lane' ? { laneId: 'integrated' } : {}) }));
  nodes.push({ id: 'complete', kind: 'complete', ref: 'complete' });
  return { schemaVersion: 1, id: input.id, revision: 1, tier: input.tier, nodes, roles: [], gates,
    edges: nodes.slice(0, -1).map((node, index) => ({ from: node.id, to: nodes[index + 1]!.id, kind: 'dependency' })),
    protectedInvariants: [...PROTECTED_INVARIANTS],
    budgets: { maxConcurrent: 4, maxNodes: 24, maxDepth: 4, maxModelCalls: 60, maxRetries: 2, maxRepairRounds: 2 },
    sourceRefs: [`nexus:chapter12/${input.verificationKind}`, 'metis:8b1eda95afea3592e08a315e29dc7746ee57ca25'],
    releaseEligible: true };
}

export const LEAF_DELIVERABLE_KINDS = ['code-change', 'new-build', 'data-pipeline', 'infra-apply',
  'ml-eval', 'research', 'docs', 'perf', 'migration'] as const;
export const LEAF_ACCEPTANCE_KINDS = ['unit-coverage', 'test-set-flip', 'metric-threshold', 'dry-run-diff', 'receipts'] as const;
export const LEAF_TARGET_LOCI = ['in-repo', 'external-system'] as const;
const REQUIRED_LEAF_GATES = ['G1', 'G4', 'G5', 'G6', 'goal-check'] as const;
const LEAF_INVARIANTS = ['no-fabricated-evidence', 'report-blocked', 'no-permission-expansion', 'no-recursive-fleet'];
const GENERATED_METHOD_SOURCES = [
  'metis:8b1eda95afea3592e08a315e29dc7746ee57ca25/agents/codex/skills/metis/frameworks/generation.md',
  'license:src/domain/orchestration/assets/LICENSE', 'notice:src/domain/orchestration/assets/NOTICE.md',
];
export interface LeafAxes {
  deliverableKind: typeof LEAF_DELIVERABLE_KINDS[number];
  acceptanceKind: typeof LEAF_ACCEPTANCE_KINDS[number];
  targetLocus: typeof LEAF_TARGET_LOCI[number];
}
export interface GeneratedLeaf {
  id: string;
  axes: LeafAxes;
  mission: string;
  inputs: string[];
  ownedPaths: string[];
  gates: string[];
  acceptanceCriteria: string[];
  failureEdges: { from: string; to: string }[];
  terminalStates: string[];
  harnessRef: string;
  sourceRefs: string[];
  invariants: string[];
  verificationKind: VerificationKind;
  datasetRef?: string;
  baselineRef?: string;
  oracleChecks: CheckPolicy[];
}
export interface GeneratedLeafInput {
  axes: LeafAxes; mission: string; inputs: string[]; ownedPaths: string[]; acceptanceCriteria: string[];
  harnessRef: string; datasetRef?: string; baselineRef?: string; sourceRefs?: string[];
  oracleChecks?: CheckPolicy[];
}
const LEAF_INPUT_FIELDS = ['axes', 'mission', 'inputs', 'ownedPaths', 'acceptanceCriteria', 'harnessRef',
  'datasetRef', 'baselineRef', 'sourceRefs', 'oracleChecks'];
const LEAF_FIELDS = [...LEAF_INPUT_FIELDS, 'id', 'gates', 'failureEdges', 'terminalStates', 'invariants', 'verificationKind'];
const PERMISSION_FIELDS = new Set(['agents', 'tools', 'toolPermissions', 'permissions', 'allowedCapabilityIds',
  'roles', 'executorPolicy', 'allowSpawn', 'allowAgents', 'allowRecursive', 'agentOptions', 'agentPreset']);
const leafRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' &&
  !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const leafText = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const leafStrings = (value: unknown, nonEmpty = false): value is string[] =>
  Array.isArray(value) && (!nonEmpty || value.length > 0) && [...value].every(leafText);
function leafFields(value: Record<string, unknown>, allowed: readonly string[], issues: string[], path: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) {
    issues.push(`FIELD_UNSUPPORTED:${path}${key}`);
    if (PERMISSION_FIELDS.has(key)) issues.push('PERMISSION_EXPANSION');
  }
}
function leafAxesValid(value: unknown): value is LeafAxes {
  if (!leafRecord(value) || Object.keys(value).length !== 3 ||
    !Object.keys(value).every(key => ['deliverableKind', 'acceptanceKind', 'targetLocus'].includes(key))) return false;
  return LEAF_DELIVERABLE_KINDS.includes(value.deliverableKind as LeafAxes['deliverableKind']) &&
    LEAF_ACCEPTANCE_KINDS.includes(value.acceptanceKind as LeafAxes['acceptanceKind']) &&
    LEAF_TARGET_LOCI.includes(value.targetLocus as LeafAxes['targetLocus']);
}
function generatedLeafId(axes: LeafAxes): string {
  // Field order in user JSON must never change the identity.
  return `generated:${axes.deliverableKind}-${axes.acceptanceKind}-${axes.targetLocus}`;
}
function leafChecksValid(value: unknown, issues: string[]): value is CheckPolicy[] {
  if (!Array.isArray(value)) { issues.push('ORACLE_CHECKS_INVALID'); return false; }
  const start = issues.length, ids = new Set<string>();
  for (const [index, check] of [...value].entries()) {
    if (!leafRecord(check)) { issues.push(`ORACLE_CHECK_INVALID:${index}`); continue; }
    leafFields(check, ['id', 'kind', 'required', 'expectedExit', 'artifactRef', 'nonEmpty', 'expectedHash',
      'datasetRef', 'metric'], issues, `oracleChecks.${index}.`);
    if (!leafText(check.id) || typeof check.kind !== 'string' || !['command', 'artifact', 'metric', 'review', 'goal'].includes(check.kind) ||
      typeof check.required !== 'boolean') issues.push(`ORACLE_CHECK_INVALID:${index}`);
    if (leafText(check.id)) {
      if (ids.has(check.id)) issues.push(`CHECK_DUPLICATE:${check.id}`);
      ids.add(check.id);
    }
    if (check.expectedExit !== undefined && !Number.isInteger(check.expectedExit)) issues.push(`ORACLE_CHECK_INVALID:${index}`);
    if (check.nonEmpty !== undefined && typeof check.nonEmpty !== 'boolean') issues.push(`ORACLE_CHECK_INVALID:${index}`);
    for (const key of ['artifactRef', 'expectedHash', 'datasetRef']) {
      if (check[key] !== undefined && !leafText(check[key])) issues.push(`ORACLE_CHECK_INVALID:${index}`);
    }
    if (check.metric !== undefined) {
      if (!leafRecord(check.metric)) { issues.push(`METRIC_ORACLE_INVALID:${index}`); continue; }
      leafFields(check.metric, ['operator', 'threshold', 'tolerance'], issues, `oracleChecks.${index}.metric.`);
      if (typeof check.metric.operator !== 'string' || !['>=', '<=', '==', '>', '<'].includes(check.metric.operator) ||
        typeof check.metric.threshold !== 'number' || !Number.isFinite(check.metric.threshold) ||
        (check.metric.tolerance !== undefined && (typeof check.metric.tolerance !== 'number' ||
          !Number.isFinite(check.metric.tolerance) || check.metric.tolerance < 0))) issues.push(`METRIC_ORACLE_INVALID:${index}`);
    }
    if (check.kind === 'metric' && (!leafText(check.datasetRef) || !leafRecord(check.metric))) issues.push(`METRIC_ORACLE_INVALID:${index}`);
  }
  return start === issues.length;
}
function leafInputIssues(value: Record<string, unknown>, issues: string[], generated = false): void {
  leafFields(value, generated ? LEAF_FIELDS : LEAF_INPUT_FIELDS, issues, '');
  if (!leafAxesValid(value.axes)) issues.push('AXES_INVALID');
  if (!leafText(value.mission)) issues.push('MISSION_EMPTY');
  if (!leafStrings(value.inputs, true)) issues.push('INPUTS_INVALID');
  // Read-only research or an external target may legitimately own no local paths.
  if (!leafStrings(value.ownedPaths)) issues.push('OWNED_PATHS_INVALID');
  if (!leafStrings(value.acceptanceCriteria, true)) issues.push('ACCEPTANCE_EMPTY');
  if (!leafText(value.harnessRef)) issues.push('EXECUTION_HARNESS_MISSING');
  for (const key of ['datasetRef', 'baselineRef']) {
    if (value[key] !== undefined && !leafText(value[key])) issues.push(`${key === 'datasetRef' ? 'DATASET' : 'BASELINE'}_REF_INVALID`);
  }
  if ((generated || value.sourceRefs !== undefined) && !leafStrings(value.sourceRefs, generated)) issues.push('SOURCE_REFS_INVALID');
  if (generated || value.oracleChecks !== undefined) leafChecksValid(value.oracleChecks, issues);
}
export function generateFrameworkLeaf(input: GeneratedLeafInput): GeneratedLeaf {
  const issues: string[] = [];
  if (!leafRecord(input)) issues.push('LEAF_INPUT_INVALID');
  else leafInputIssues(input, issues);
  if (issues.length) throw new NexusError('GENERATED_LEAF_INPUT_INVALID', '生成框架输入不符合受控 schema。', [...new Set(issues)]);
  const criteria = [...input.acceptanceCriteria];
  if (input.axes.deliverableKind === 'data-pipeline') criteria.push('Idempotent replay and duplicate input oracle');
  if (['infra-apply', 'migration'].includes(input.axes.deliverableKind)) criteria.push('Dry-run diff and effect authorization before apply');
  if (input.axes.deliverableKind === 'perf') criteria.push('Before/after metric with fixed measurement environment and samples');
  return { id: generatedLeafId(input.axes), axes: { deliverableKind: input.axes.deliverableKind,
    acceptanceKind: input.axes.acceptanceKind, targetLocus: input.axes.targetLocus },
    mission: input.mission, inputs: [...input.inputs], ownedPaths: [...input.ownedPaths],
    gates: [...REQUIRED_LEAF_GATES], acceptanceCriteria: criteria, harnessRef: input.harnessRef,
    failureEdges: [{ from: 'G6', to: 'G4' }], terminalStates: ['complete'],
    sourceRefs: [...new Set([...GENERATED_METHOD_SOURCES, ...(input.sourceRefs ?? [])])], invariants: [...LEAF_INVARIANTS],
    ...(input.datasetRef === undefined ? {} : { datasetRef: input.datasetRef }),
    ...(input.baselineRef === undefined ? {} : { baselineRef: input.baselineRef }),
    oracleChecks: structuredClone(input.oracleChecks ?? []),
    verificationKind: input.axes.deliverableKind === 'docs' || input.axes.deliverableKind === 'research' ? 'docs' :
      input.axes.acceptanceKind === 'metric-threshold' ? 'data' : 'code-behavior' };
}
export function validateGeneratedLeaf(leaf: unknown, generationAttempt: unknown): {
  valid: boolean; status: 'valid' | 'regenerate' | 'OUT_OF_SCOPE'; issues: string[];
} {
  const issues: string[] = [];
  const validAttempt = Number.isInteger(generationAttempt) && (generationAttempt === 1 || generationAttempt === 2);
  if (!validAttempt) issues.push('GENERATION_ATTEMPT_INVALID');
  if (!leafRecord(leaf)) issues.push('LEAF_SCHEMA_INVALID');
  else {
    leafInputIssues(leaf, issues, true);
    if (!leafText(leaf.id) || (leafAxesValid(leaf.axes) && leaf.id !== generatedLeafId(leaf.axes))) issues.push('LEAF_SIGNATURE_INVALID');
    if (typeof leaf.verificationKind !== 'string' ||
      !['code-behavior', 'visual', 'docs', 'data', 'service', 'mechanical'].includes(leaf.verificationKind)) issues.push('VERIFICATION_KIND_INVALID');
    if (!leafStrings(leaf.gates, true)) issues.push('GATES_INVALID');
    else {
      if (leaf.gates.some(id => !GATE_LIBRARY.some(gate => gate.gateId === id))) issues.push('GATE_UNREGISTERED');
      if (new Set(leaf.gates).size !== leaf.gates.length) issues.push('GATE_DUPLICATE');
      for (const gateId of REQUIRED_LEAF_GATES) if (!leaf.gates.includes(gateId)) issues.push(`GATE_REQUIRED:${gateId}`);
      if (REQUIRED_LEAF_GATES.some((gateId, index) => index > 0 &&
        (leaf.gates as string[]).indexOf(gateId) <= (leaf.gates as string[]).indexOf(REQUIRED_LEAF_GATES[index - 1])) ||
        leaf.gates.at(-1) !== 'goal-check') issues.push('GATE_SEQUENCE_INVALID');
    }
    if (!leafStrings(leaf.terminalStates) || leaf.terminalStates.length !== 1 || leaf.terminalStates[0] !== 'complete') issues.push('COMPLETE_EXIT_INVALID');
    if (!leafStrings(leaf.invariants)) issues.push('INVARIANTS_INVALID');
    for (const invariant of LEAF_INVARIANTS) {
      if (!leafStrings(leaf.invariants) || !leaf.invariants.includes(invariant)) issues.push(`INVARIANT_MISSING:${invariant}`);
    }
    if (!Array.isArray(leaf.failureEdges)) issues.push('FAILURE_EDGES_INVALID');
    else {
      const edges = new Set<string>(), failureTargets = new Map<string, string>();
      for (const [index, edge] of [...leaf.failureEdges].entries()) {
        if (!leafRecord(edge) || !leafText(edge.from) || !leafText(edge.to)) { issues.push(`FAILURE_EDGE_INVALID:${index}`); continue; }
        leafFields(edge, ['from', 'to'], issues, `failureEdges.${index}.`);
        const key = `${edge.from}:${edge.to}`;
        if (edges.has(key)) issues.push('FAILURE_EDGE_DUPLICATE');
        edges.add(key);
        if (failureTargets.has(edge.from) && failureTargets.get(edge.from) !== edge.to) issues.push('FAILURE_EDGE_AMBIGUOUS');
        failureTargets.set(edge.from, edge.to);
        if (!leafStrings(leaf.gates) || leaf.gates.indexOf(edge.to) < 0 ||
          leaf.gates.indexOf(edge.from) <= leaf.gates.indexOf(edge.to)) issues.push('FALLBACK_NOT_PREDECESSOR');
      }
    }
    if (leafAxesValid(leaf.axes)) {
      if (leaf.axes.acceptanceKind === 'metric-threshold') {
        if (!leafText(leaf.datasetRef)) issues.push('METRIC_DATASET_MISSING');
        if (!Array.isArray(leaf.oracleChecks) || !leaf.oracleChecks.some(check => leafRecord(check) &&
          check.kind === 'metric' && check.required === true && leafText(leaf.datasetRef) &&
          check.datasetRef === leaf.datasetRef && leafRecord(check.metric) &&
          typeof check.metric.threshold === 'number' && Number.isFinite(check.metric.threshold))) issues.push('METRIC_THRESHOLD_ORACLE_MISSING');
      }
      if (leaf.axes.deliverableKind === 'perf' && !leafText(leaf.baselineRef)) issues.push('PERF_BASELINE_MISSING');
    }
  }
  return { valid: !issues.length, status: !issues.length ? 'valid' :
    validAttempt && generationAttempt === 1 ? 'regenerate' : 'OUT_OF_SCOPE', issues: [...new Set(issues)] };
}

/** One-off descriptors carry policy only. Shape admission remains the sole authority to permit spawn. */
export function generatedLeafBlueprint(leaf: GeneratedLeaf, shapeTier: Tier = 'T1'): WorkflowBlueprint {
  const validation = validateGeneratedLeaf(leaf, 2);
  if (!validation.valid) throw new NexusError('GENERATED_LEAF_INVALID', '生成框架未通过执行前校验。', validation);
  if (!['T0', 'T1', 'T2', 'T3'].includes(shapeTier)) throw new NexusError('GENERATED_LEAF_TIER_INVALID', '非执行路径不能编译生成框架。');
  const builtin = createBuiltinBlueprint({ id: leaf.id, tier: shapeTier as Exclude<Tier, 'FAST_PATH'>,
    verificationKind: leaf.verificationKind });
  const gateIds = [...leaf.gates];
  if (builtin.gates.some(gate => gate.gateId === 'G2') && !gateIds.includes('G2')) gateIds.splice(gateIds.indexOf('G1'), 0, 'G2');
  if (builtin.gates.some(gate => gate.gateId === 'sweep') && !gateIds.includes('sweep')) gateIds.splice(gateIds.indexOf('goal-check'), 0, 'sweep');
  const gates = gateIds.map(gateId => {
    const registered = structuredClone(GATE_LIBRARY.find(gate => gate.gateId === gateId)!);
    return { ...registered, protected: registered.protected || REQUIRED_LEAF_GATES.includes(gateId as typeof REQUIRED_LEAF_GATES[number]),
      checks: gateId === 'G6' ? structuredClone(leaf.oracleChecks) : [] };
  });
  // G4 is the single implementation actor. A second executable framework node would duplicate its effects.
  const nodes: BlueprintNode[] = gates.map(gate => ({ id: `gate:${gate.gateId}`, kind: 'gate', ref: gate.gateId,
    ...(gate.scope === 'lane' ? { laneId: 'integrated' } : {}),
    ...(gate.gateId === 'G4' ? { acceptanceCriteria: [leaf.mission, ...leaf.acceptanceCriteria] } : {}) }));
  nodes.push({ id: 'complete', kind: 'complete', ref: 'complete' });
  const edges: WorkflowBlueprint['edges'] = nodes.slice(0, -1).map((node, index) => ({
    from: node.id, to: nodes[index + 1].id, kind: 'dependency',
  }));
  for (const edge of leaf.failureEdges) edges.push({ from: `gate:${edge.from}`, to: `gate:${edge.to}`, kind: 'failure' });
  for (const gate of gates) {
    const failure = leaf.failureEdges.filter(edge => edge.from === gate.gateId);
    if (failure.length > 1) throw new NexusError('GENERATED_LEAF_INVALID', '每个质量门只能声明一个确定回退目标。', { gateId: gate.gateId });
    if (failure[0]) gate.onFail = { loopTo: `gate:${failure[0].to}` };
  }
  const blueprint: WorkflowBlueprint = { ...builtin, nodes, gates, edges, roles: [],
    protectedInvariants: [...new Set([...builtin.protectedInvariants, ...leaf.invariants])],
    sourceRefs: [...new Set([...builtin.sourceRefs, leaf.id, ...leaf.sourceRefs, `harness:${leaf.harnessRef}`])] };
  const compiled = validateBlueprint(blueprint, { requiredProtectedGates: [...REQUIRED_LEAF_GATES] });
  if (!compiled.valid) throw new NexusError('GENERATED_LEAF_INVALID', '生成框架蓝图不满足执行约束。', compiled.issues);
  return blueprint;
}
