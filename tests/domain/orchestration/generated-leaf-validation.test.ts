import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { compileBlueprint, createBuiltinBlueprint, generatedLeafBlueprint, generateFrameworkLeaf,
  LEAF_ACCEPTANCE_KINDS, LEAF_DELIVERABLE_KINDS, LEAF_TARGET_LOCI, validateBlueprint, validateGeneratedLeaf,
} from '../../../src/domain/orchestration/index.js';
import type { GeneratedLeaf, GeneratedLeafInput, LeafAxes, ShapeDecision } from '../../../src/domain/orchestration/index.js';

function input(overrides: Partial<GeneratedLeafInput> = {}): GeneratedLeafInput {
  return { axes: { deliverableKind: 'code-change', acceptanceKind: 'test-set-flip', targetLocus: 'in-repo' },
    mission: 'Reject a replayed operation', inputs: ['fixture:replayed-request'], ownedPaths: ['src/request.ts'],
    acceptanceCriteria: ['A repeated idempotency key never repeats the effect'], harnessRef: 'host:authorized-test',
    sourceRefs: ['fixture:request-contract'],
    oracleChecks: [{ id: 'replay-regression', kind: 'command', required: true, expectedExit: 0 }], ...overrides };
}
function leaf(): GeneratedLeaf { return generateFrameworkLeaf(input()); }
function hasIssue(value: unknown, issue: string): void {
  const result = validateGeneratedLeaf(value, 1);
  assert.equal(result.valid, false);
  assert.ok(result.issues.includes(issue), `${issue}: ${result.issues.join(', ')}`);
}

test('MMR-083 generated axis enums are closed and identity ignores property insertion order', () => {
  assert.deepEqual(LEAF_DELIVERABLE_KINDS, ['code-change', 'new-build', 'data-pipeline', 'infra-apply',
    'ml-eval', 'research', 'docs', 'perf', 'migration']);
  assert.deepEqual(LEAF_ACCEPTANCE_KINDS, ['unit-coverage', 'test-set-flip', 'metric-threshold', 'dry-run-diff', 'receipts']);
  assert.deepEqual(LEAF_TARGET_LOCI, ['in-repo', 'external-system']);
  const reordered: LeafAxes = { targetLocus: 'in-repo', acceptanceKind: 'test-set-flip', deliverableKind: 'code-change' };
  assert.equal(generateFrameworkLeaf(input({ axes: reordered })).id, leaf().id);
  assert.equal(leaf().id, 'generated:code-change-test-set-flip-in-repo');
  hasIssue({ ...leaf(), id: 'generated:unrelated-permission-grant' }, 'LEAF_SIGNATURE_INVALID');
});

test('MMR-085 runtime leaf validation reports malformed objects instead of throwing', () => {
  for (const malformed of [null, undefined, true, 42, 'leaf', [], {}, new Date(0),
    { ...leaf(), axes: null }, { ...leaf(), inputs: null }, { ...leaf(), acceptanceCriteria: {} },
    { ...leaf(), oracleChecks: [null] }, { ...leaf(), failureEdges: [null] },
    { ...leaf(), invariants: null }, { ...leaf(), terminalStates: {} }]) {
    assert.doesNotThrow(() => validateGeneratedLeaf(malformed, 1));
    assert.equal(validateGeneratedLeaf(malformed, 1).valid, false);
  }
});

test('MMR-085 generator rejects malformed runtime input with a named contract error', () => {
  for (const malformed of [null, undefined, 0, [], {}, { ...input(), inputs: null },
    { ...input(), acceptanceCriteria: {} }, { ...input(), sourceRefs: [null] },
    { ...input(), oracleChecks: [undefined] }]) {
    assert.throws(() => generateFrameworkLeaf(malformed as unknown as GeneratedLeafInput),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'GENERATED_LEAF_INPUT_INVALID');
  }
});

test('MMR-085 axes reject unknown, omitted and extra fields without an implicit backend fallback', () => {
  for (const axes of [
    { deliverableKind: 'unknown', acceptanceKind: 'test-set-flip', targetLocus: 'in-repo' },
    { deliverableKind: 'code-change', acceptanceKind: 'execute-anything', targetLocus: 'in-repo' },
    { deliverableKind: 'code-change', acceptanceKind: 'test-set-flip', targetLocus: 'unknown' },
    { deliverableKind: 'code-change', acceptanceKind: 'test-set-flip' },
    { ...leaf().axes, allowSpawn: true },
  ]) {
    hasIssue({ ...leaf(), axes }, 'AXES_INVALID');
    assert.throws(() => generateFrameworkLeaf(input({ axes: axes as LeafAxes })),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'GENERATED_LEAF_INPUT_INVALID');
  }
});

test('MMR-085 regeneration has exactly two attempts and malformed attempts never reset the budget', () => {
  const invalid = { ...leaf(), gates: ['not-registered'] };
  assert.equal(validateGeneratedLeaf(invalid, 1).status, 'regenerate');
  assert.equal(validateGeneratedLeaf(invalid, 2).status, 'OUT_OF_SCOPE');
  assert.equal(validateGeneratedLeaf(leaf(), 2).status, 'valid');
  for (const generationAttempt of [0, -1, 3, 1.5, NaN, Infinity, '1', undefined]) {
    const result = validateGeneratedLeaf(leaf(), generationAttempt);
    assert.equal(result.valid, false);
    assert.equal(result.status, 'OUT_OF_SCOPE');
    assert.ok(result.issues.includes('GENERATION_ATTEMPT_INVALID'));
  }
});

test('MMR-085 mission, inputs, acceptance, harness and source refs must remain nonempty', () => {
  for (const [key, value, issue] of [
    ['mission', '  ', 'MISSION_EMPTY'], ['inputs', [], 'INPUTS_INVALID'],
    ['inputs', [''], 'INPUTS_INVALID'], ['ownedPaths', [null], 'OWNED_PATHS_INVALID'],
    ['acceptanceCriteria', [], 'ACCEPTANCE_EMPTY'], ['acceptanceCriteria', [' '], 'ACCEPTANCE_EMPTY'],
    ['harnessRef', ' ', 'EXECUTION_HARNESS_MISSING'], ['sourceRefs', [], 'SOURCE_REFS_INVALID'],
    ['sourceRefs', [' '], 'SOURCE_REFS_INVALID'],
  ] as const) hasIssue({ ...leaf(), [key]: value }, issue);
  const sparse = Array<string>(1);
  hasIssue({ ...leaf(), inputs: sparse }, 'INPUTS_INVALID');
  const external = generateFrameworkLeaf(input({ axes: { deliverableKind: 'research', acceptanceKind: 'receipts',
    targetLocus: 'external-system' }, ownedPaths: [], oracleChecks: [] }));
  assert.equal(validateGeneratedLeaf(external, 1).valid, true, 'read-only research can own no local path');
});

test('MMR-085 every generated descriptor retains source and license provenance when sourceRefs is omitted or empty', () => {
  for (const sourceRefs of [undefined, []]) {
    const value = generateFrameworkLeaf(input({ sourceRefs }));
    assert.equal(validateGeneratedLeaf(value, 1).valid, true);
    assert.ok(value.sourceRefs.some(ref => ref.startsWith('metis:8b1eda95afea3592e08a315e29dc7746ee57ca25/')));
    assert.ok(value.sourceRefs.includes('license:src/domain/orchestration/assets/LICENSE'));
    assert.ok(value.sourceRefs.includes('notice:src/domain/orchestration/assets/NOTICE.md'));
  }
});

test('MMR-085 protected gates are mandatory, registered, unique and ordered before the unique completion exit', () => {
  for (const required of ['G1', 'G4', 'G5', 'G6', 'goal-check']) {
    hasIssue({ ...leaf(), gates: leaf().gates.filter(gate => gate !== required) }, `GATE_REQUIRED:${required}`);
  }
  hasIssue({ ...leaf(), gates: [...leaf().gates, 'unknown'] }, 'GATE_UNREGISTERED');
  hasIssue({ ...leaf(), gates: ['G1', 'G4', 'G5', 'G6', 'G6', 'goal-check'] }, 'GATE_DUPLICATE');
  hasIssue({ ...leaf(), gates: ['G1', 'G5', 'G4', 'G6', 'goal-check'] }, 'GATE_SEQUENCE_INVALID');
  hasIssue({ ...leaf(), gates: [...leaf().gates, 'G7'] }, 'GATE_SEQUENCE_INVALID');
  for (const terminalStates of [[], ['complete', 'complete'], ['DONE']]) {
    hasIssue({ ...leaf(), terminalStates }, 'COMPLETE_EXIT_INVALID');
  }
});

test('MMR-085 failure edges must name a declared predecessor and have one deterministic target', () => {
  for (const failureEdges of [
    [{ from: 'G6', to: 'unknown' }], [{ from: 'unknown', to: 'G4' }],
    [{ from: 'G4', to: 'G6' }], [{ from: 'G6', to: 'G6' }], [{ from: 'complete', to: 'G4' }],
  ]) hasIssue({ ...leaf(), failureEdges }, 'FALLBACK_NOT_PREDECESSOR');
  hasIssue({ ...leaf(), failureEdges: [{ from: 'G6', to: 'G4' }, { from: 'G6', to: 'G1' }] }, 'FAILURE_EDGE_AMBIGUOUS');
  hasIssue({ ...leaf(), failureEdges: [{ from: 'G6', to: 'G4' }, { from: 'G6', to: 'G4' }] }, 'FAILURE_EDGE_DUPLICATE');
  assert.equal(validateGeneratedLeaf({ ...leaf(), failureEdges: [{ from: 'G6', to: 'G4' }] }, 1).valid, true);
});

test('MMR-085 generated methods cannot extend agents, tools or executor permissions', () => {
  for (const [key, value] of Object.entries({
    agents: ['admin'], tools: ['shell'], toolPermissions: { publish: true }, permissions: ['write:anywhere'],
    allowedCapabilityIds: ['files.delete'], roles: [], executorPolicy: { allowRecursive: true },
    allowSpawn: true, allowAgents: true, allowRecursive: true, agentOptions: {}, agentPreset: 'full-access',
  })) {
    hasIssue({ ...leaf(), [key]: value }, 'PERMISSION_EXPANSION');
    assert.throws(() => generateFrameworkLeaf({ ...input(), [key]: value } as GeneratedLeafInput),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'GENERATED_LEAF_INPUT_INVALID');
  }
  for (const invariant of leaf().invariants) {
    hasIssue({ ...leaf(), invariants: leaf().invariants.filter(item => item !== invariant) }, `INVARIANT_MISSING:${invariant}`);
  }
});

test('MMR-084 metric oracle checks require finite typed thresholds and a matching fixed dataset', () => {
  const value = generateFrameworkLeaf(input({ axes: { deliverableKind: 'ml-eval', acceptanceKind: 'metric-threshold',
    targetLocus: 'in-repo' }, datasetRef: 'fixture:held-out-v1',
    oracleChecks: [{ id: 'held-out-f1', kind: 'metric', required: true, datasetRef: 'fixture:held-out-v1',
      metric: { operator: '>=', threshold: 0.85, tolerance: 0.001 } }] }));
  assert.equal(validateGeneratedLeaf(value, 1).valid, true);
  hasIssue({ ...value, datasetRef: undefined }, 'METRIC_DATASET_MISSING');
  hasIssue({ ...value, datasetRef: 'different-dataset' }, 'METRIC_THRESHOLD_ORACLE_MISSING');
  for (const metric of [null, [], { operator: '>=', threshold: NaN }, { operator: '>=', threshold: Infinity },
    { operator: '>=', threshold: '0.85' }, { operator: 'unknown', threshold: 0.85 },
    { operator: '>=', threshold: 0.85, tolerance: -1 }]) {
    assert.equal(validateGeneratedLeaf({ ...value, oracleChecks: [{ ...value.oracleChecks[0], metric }] }, 1).valid, false);
  }
  hasIssue({ ...value, oracleChecks: [{ ...value.oracleChecks[0], required: false }] }, 'METRIC_THRESHOLD_ORACLE_MISSING');
});

test('MMR-085 malformed oracle records, duplicate check IDs and nested permission grants are rejected', () => {
  for (const oracleChecks of [null, {}, [null], [undefined], [{ id: 'a', kind: 'unknown', required: true }],
    [{ id: 'a', kind: 'command', required: 'true' }], [{ id: 'a', kind: 'command', required: true, expectedExit: Infinity }],
    [{ id: 'a', kind: 'artifact', required: true, artifactRef: '' }]]) {
    assert.equal(validateGeneratedLeaf({ ...leaf(), oracleChecks }, 1).valid, false);
    assert.throws(() => generateFrameworkLeaf({ ...input(), oracleChecks } as unknown as GeneratedLeafInput));
  }
  hasIssue({ ...leaf(), oracleChecks: [leaf().oracleChecks[0], leaf().oracleChecks[0]] }, 'CHECK_DUPLICATE:replay-regression');
  hasIssue({ ...leaf(), oracleChecks: [{ ...leaf().oracleChecks[0], permissions: ['publish'] }] }, 'PERMISSION_EXPANSION');
});

test('MMR-088 performance leaf retains the prior baseline requirement', () => {
  const value = generateFrameworkLeaf(input({ axes: { deliverableKind: 'perf', acceptanceKind: 'receipts', targetLocus: 'in-repo' } }));
  hasIssue(value, 'PERF_BASELINE_MISSING');
  assert.ok(value.acceptanceCriteria.some(item => item.includes('fixed measurement environment')));
  assert.equal(validateGeneratedLeaf({ ...value, baselineRef: 'fixture:before-change' }, 1).valid, true);
});

test('MMR-083 generated blueprint retains one implementation, protected sequence, actual checks and bounded repair', () => {
  const value = leaf(), before = structuredClone(value), blueprint = generatedLeafBlueprint(value);
  assert.deepEqual(value, before);
  assert.equal(validateBlueprint(blueprint).valid, true);
  assert.deepEqual(blueprint.nodes.map(node => node.ref), ['G1', 'G4', 'G5', 'G6', 'goal-check', 'complete']);
  assert.deepEqual(blueprint.nodes.find(node => node.ref === 'G4')!.acceptanceCriteria, [value.mission, ...value.acceptanceCriteria]);
  assert.equal(blueprint.nodes.filter(node => node.ref === 'G4').length, 1);
  assert.equal(blueprint.nodes.filter(node => node.kind === 'framework').length, 0);
  assert.deepEqual(blueprint.gates.find(gate => gate.gateId === 'G6')!.checks, value.oracleChecks);
  assert.ok(blueprint.gates.filter(gate => gate.gateId !== 'G6').every(gate => gate.checks.length === 0));
  assert.deepEqual(blueprint.gates.find(gate => gate.gateId === 'G6')!.onFail, { loopTo: 'gate:G4' });
  assert.ok(blueprint.edges.some(edge => edge.kind === 'failure' && edge.from === 'gate:G6' && edge.to === 'gate:G4'));
  const builtin = createBuiltinBlueprint({ id: 'comparison', tier: 'T1', verificationKind: value.verificationKind });
  assert.deepEqual(blueprint.budgets, builtin.budgets);
  assert.ok(builtin.protectedInvariants.every(invariant => blueprint.protectedInvariants.includes(invariant)));
  assert.ok(value.invariants.every(invariant => blueprint.protectedInvariants.includes(invariant)));
  assert.ok(blueprint.sourceRefs.includes(value.id));
  assert.ok(blueprint.sourceRefs.includes(`harness:${value.harnessRef}`));
  blueprint.gates.find(gate => gate.gateId === 'G6')!.checks[0].id = 'edited-after-compile';
  assert.deepEqual(value, before, 'compiled policy never aliases the archived leaf');
});

test('MMR-029/090 generated T0 policy never erases independent gates or grants spawn itself', () => {
  const blueprint = generatedLeafBlueprint(leaf(), 'T0');
  for (const gateId of ['G5', 'G6']) {
    const gate = blueprint.gates.find(item => item.gateId === gateId)!;
    assert.equal(gate.independent, true);
    assert.equal(gate.protected, true);
  }
  assert.deepEqual(blueprint.roles, []);
  const shape: ShapeDecision = { tier: 'T0', blocked: false, reasons: [], overlaps: [], overlays: [],
    allowSpawn: false, assuranceGaps: ['Independent execution unavailable'] };
  assert.equal(compileBlueprint(blueprint, shape).spawnAllowed, false);
  assert.throws(() => generatedLeafBlueprint(leaf(), 'FAST_PATH'),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'GENERATED_LEAF_TIER_INVALID');
  assert.throws(() => generatedLeafBlueprint({ ...leaf(), gates: ['G4'] }),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'GENERATED_LEAF_INVALID');
});

test('MMR-083 generated execution preserves shape-specific ownership and sweep gates', () => {
  for (const tier of ['T2', 'T3'] as const) {
    const blueprint = generatedLeafBlueprint(leaf(), tier);
    assert.equal(validateBlueprint(blueprint).valid, true);
    assert.ok(blueprint.gates.some(gate => gate.gateId === 'G2'));
    assert.ok(blueprint.nodes.findIndex(node => node.ref === 'G2') < blueprint.nodes.findIndex(node => node.ref === 'G4'));
    if (tier === 'T3') {
      assert.ok(blueprint.gates.some(gate => gate.gateId === 'sweep'));
      assert.ok(blueprint.nodes.findIndex(node => node.ref === 'G6') < blueprint.nodes.findIndex(node => node.ref === 'sweep'));
      assert.ok(blueprint.nodes.findIndex(node => node.ref === 'sweep') < blueprint.nodes.findIndex(node => node.ref === 'goal-check'));
    }
    const builtin = createBuiltinBlueprint({ id: 'comparison', tier, verificationKind: 'code-behavior' });
    assert.deepEqual(blueprint.budgets, builtin.budgets);
  }
});

test('MMR-083 generation owns a detached immutable input snapshot', () => {
  const supplied = input(), value = generateFrameworkLeaf(supplied), before = structuredClone(value);
  supplied.axes.targetLocus = 'external-system';
  supplied.inputs.push('later');
  supplied.ownedPaths.push('outside');
  supplied.acceptanceCriteria.push('changed');
  supplied.sourceRefs!.push('later');
  supplied.oracleChecks![0].id = 'changed';
  assert.deepEqual(value, before);
});
