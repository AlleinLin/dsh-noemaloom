import { posix } from 'node:path';
import type { OwnershipSurface, ShapeDecision, TaskShape, Tier } from './types.js';

function normalizePath(value: string, sensitive: boolean): string {
  const normalized = posix.normalize(value.replaceAll('\\', '/')).replace(/\/+$/, '');
  return sensitive ? normalized : normalized.toLocaleLowerCase('en-US');
}
function contains(first: string, second: string): boolean {
  return first === second || second.startsWith(`${first}/`);
}
/** Host resolves junctions/symlinks and authorization first; this compares the frozen canonical claims. */
export function ownershipOverlaps(surfaces: readonly OwnershipSurface[], caseSensitive = false): ShapeDecision['overlaps'] {
  const conflicts: ShapeDecision['overlaps'] = [];
  for (let first = 0; first < surfaces.length; first++) {
    for (let second = first + 1; second < surfaces.length; second++) {
      const a = surfaces[first]!, b = surfaces[second]!;
      const resources = new Set(a.resources.filter(resource => b.resources.includes(resource)));
      for (const aPath of a.paths) for (const bPath of b.paths) {
        const normalizedA = normalizePath(aPath, caseSensitive), normalizedB = normalizePath(bPath, caseSensitive);
        if (contains(normalizedA, normalizedB) || contains(normalizedB, normalizedA)) resources.add(`path:${aPath}|${bPath}`);
      }
      if (resources.size) conflicts.push({ first: a.id, second: b.id, resources: [...resources].sort() });
    }
  }
  return conflicts;
}

export function classifyTaskShape(shape: TaskShape): ShapeDecision {
  const overlaps = ownershipOverlaps(shape.surfaces, shape.caseSensitivePaths);
  const reasons: string[] = [];
  const facts = [...(shape.unresolvedRequiredFacts ?? [])];
  const ids = new Set<string>();
  for (const surface of shape.surfaces) {
    if (ids.has(surface.id)) facts.push(`duplicate-surface:${surface.id}`);
    ids.add(surface.id);
    if (!surface.validated) facts.push(`unvalidated-ownership:${surface.id}`);
    if (surface.paths.length === 0 && surface.resources.length === 0) facts.push(`empty-ownership:${surface.id}`);
    if (surface.paths.some(path => !/^(?:[a-zA-Z]:[\\/]|\/|\\\\)/.test(path))) facts.push(`noncanonical-path:${surface.id}`);
  }
  for (const dependency of shape.dependencies) {
    if (!ids.has(dependency.from) || !ids.has(dependency.to)) facts.push(`unknown-dependency:${dependency.from}:${dependency.to}`);
  }
  let tier: Tier;
  if (!shape.executionRequested) { tier = 'FAST_PATH'; reasons.push('NO_EXECUTION_REQUESTED'); }
  else if (shape.fullySpecified && !shape.designFork && shape.lowImpact) { tier = 'T0'; reasons.push('SPECIFIED_LOW_IMPACT_CHANGE'); }
  else if (shape.surfaces.length <= 1) { tier = 'T1'; reasons.push('SINGLE_OWNERSHIP_SURFACE'); }
  else if (overlaps.length || shape.dependencies.length) { tier = 'T2'; reasons.push(overlaps.length ? 'SHARED_MUTABLE_OWNERSHIP' : 'ORDERED_DEPENDENCIES'); }
  else if (shape.surfaces.every(surface => surface.validated && surface.ready)) { tier = 'T3'; reasons.push('DISJOINT_READY_SURFACES'); }
  else { tier = 'T2'; reasons.push('MULTI_SURFACE_NOT_PARALLEL_READY'); }
  if (shape.executionRequested && shape.surfaces.length === 0 && tier !== 'T0') facts.push('missing-ownership-surface');
  const allowSpawn = shape.allowAgents !== false && !['FAST_PATH', 'T0'].includes(tier);
  return { tier, blocked: shape.executionRequested && facts.length > 0,
    reasons: [...reasons, ...facts.map(fact => `CONTRACT_FACT_REQUIRED:${fact}`)], overlaps,
    overlays: shape.defectInvestigation ? ['debug'] : [], allowSpawn,
    assuranceGaps: shape.allowAgents === false && !['FAST_PATH', 'T0'].includes(tier) ? ['INDEPENDENT_ACTOR_UNAVAILABLE_ROOT_OWNED_STEPS'] : [] };
}

export function reassessParallelFrontier(shape: TaskShape, dispatchedSurfaceIds: readonly string[]):
  { action: 'continue' | 'revise-to-T2'; pauseSurfaceIds: string[]; preserveSurfaceIds: string[] } {
  const conflicts = ownershipOverlaps(shape.surfaces, shape.caseSensitivePaths);
  const affected = new Set(conflicts.flatMap(conflict => [conflict.first, conflict.second]));
  return {
    action: conflicts.length ? 'revise-to-T2' : 'continue',
    pauseSurfaceIds: [...affected].filter(id => !dispatchedSurfaceIds.includes(id)),
    preserveSurfaceIds: dispatchedSurfaceIds.filter(id => !affected.has(id)),
  };
}

const RECURSIVE_ROLES = new Set(['coordinator', 'scope-coordinator', 'feature-coordinator', 'manager', 'sweep-coordinator']);
export function validateSpawnPolicy(input: {
  roleId: string; ordinaryExpert: boolean; logicalDepth: number; requestedChildDepth: number;
  maxDepth: number; blueprintAllows: boolean; hostAllows: boolean; userAllows: boolean;
  inheritedRootRunId?: string; inheritedAuthorizationRef?: string; budgetReservationId?: string;
}): string[] {
  const reasons: string[] = [];
  if (input.ordinaryExpert || !RECURSIVE_ROLES.has(input.roleId) || input.logicalDepth >= 4) reasons.push('TERMINAL_ROLE_CANNOT_SPAWN');
  if (!input.blueprintAllows || !input.hostAllows || !input.userAllows) reasons.push('RECURSION_NOT_AUTHORIZED');
  if (input.requestedChildDepth !== input.logicalDepth + 1 || input.requestedChildDepth > input.maxDepth) reasons.push('MAX_LOGICAL_DEPTH_EXCEEDED');
  if (!input.inheritedRootRunId || !input.inheritedAuthorizationRef || !input.budgetReservationId) reasons.push('CHILD_INHERITANCE_INCOMPLETE');
  return reasons;
}
