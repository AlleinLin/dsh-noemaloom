import { BUNDLED_FRAMEWORK_TEXTS, BUNDLED_ROLE_ASSETS } from './assets-bundled.js';
import type { GatePolicy, Tier, VerificationKind } from './types.js';

export const ROLE_IDS = ['coordinator', 'planner', 'implementer', 'reviewer', 'verifier',
  'scope-coordinator', 'feature-coordinator', 'depth-prober', 'fresh-verifier', 'goal-checker', 'arbiter',
  'framework-generator', 'framework-validator', 'execharness-resolver', 'researcher', 'scoper', 'scribe',
  'sweep-coordinator', 'sweeper', 'synthesizer', 'janitor', 'juror', 'manager', 'preflight-probe', 're-anchor', 'intake'] as const;
export const FRAMEWORK_IDS = ['apply', 'backend-build', 'backend-fix', 'backend-implement', 'composition', 'docs',
  'frontend-build', 'frontend-fix', 'frontend-implement', 'frontend-review', 'generation', 'plan-design',
  'plan-research', 'plan-scope', 'polish', 'refactor'] as const;
export type FrameworkId = typeof FRAMEWORK_IDS[number];
export type RoleId = typeof ROLE_IDS[number];
export interface FrameworkAsset {
  id: FrameworkId;
  verificationKind: VerificationKind;
  requiredCapabilities: string[];
  applicableTiers: Tier[];
  suggestedRoles: RoleId[];
  doneCriteria: string[];
  sourcePath: string;
  license: 'MIT';
}
const kindFor = (id: FrameworkId): VerificationKind => id === 'apply' ? 'mechanical'
  : id === 'docs' || id.startsWith('plan-') ? 'docs'
  : id.startsWith('frontend-') || id === 'polish' ? 'visual' : 'code-behavior';
export const FRAMEWORK_CATALOG: readonly FrameworkAsset[] = FRAMEWORK_IDS.map((id): FrameworkAsset => ({
  id, verificationKind: kindFor(id),
  requiredCapabilities: id.startsWith('frontend-') || id === 'polish' ? ['files.read', 'browser.inspect'] :
    id === 'docs' || id.startsWith('plan-') ? ['files.read'] : ['files.read', 'execution.command'],
  applicableTiers: id === 'apply' || id === 'docs' ? ['T0', 'T1', 'T2', 'T3'] :
    id === 'composition' ? ['T2', 'T3'] : ['T1', 'T2', 'T3'],
  suggestedRoles: id === 'frontend-review' ? ['reviewer', 'fresh-verifier'] :
    id === 'plan-research' ? ['researcher', 'synthesizer'] : id === 'plan-scope' ? ['scoper'] :
    id === 'plan-design' ? ['planner', 'reviewer'] : ['implementer', 'reviewer', 'verifier'],
  doneCriteria: id.endsWith('-fix') ? ['unmodified baseline reproduction', 'falsifiable root cause', 'adversarial regression evidence'] :
    id === 'refactor' ? ['unchanged characterization oracle', 'behavior regression evidence'] :
    id === 'frontend-review' ? ['actual persona journey or explicit static degradation', 'DOM/render/console evidence', 'accessibility checks'] :
    id.startsWith('frontend-') || id === 'polish' ? ['real render and input/state flow', 'responsive and keyboard checks'] :
    id === 'docs' ? ['fact and link checks', 'examples verified where execution is required', 'all user goals covered'] :
    id === 'plan-research' ? ['at most three independent research topics', 'usable evidence table and decision'] :
    id === 'plan-design' ? ['real alternatives and tradeoffs', 'fresh verification of default failure assumptions'] :
    id === 'plan-scope' ? ['single executable ownership roadmap', 'explicit dependency and shared resource edges'] :
    ['typed inputs and outputs', 'error/auth/idempotency seam verification', 'matching real oracle evidence'],
  sourcePath: `assets/frameworks/${id}.md`, license: 'MIT',
}));
export interface RoleAsset {
  id: RoleId;
  name: string;
  description: string;
  systemPrompt: string;
  roleType: string;
  tools: string[];
}
/** Lazy source reader; source prompts are explanatory assets, not an authority or tool grant. */
export function readRoleAssets(): readonly RoleAsset[] {
  return structuredClone(BUNDLED_ROLE_ASSETS) as RoleAsset[];
}
export function readFrameworkText(id: FrameworkId): string {
  if (!FRAMEWORK_IDS.includes(id)) throw new Error('Unknown framework');
  const content = BUNDLED_FRAMEWORK_TEXTS[id];
  if (content === undefined) throw new Error('Framework asset missing');
  return content;
}
export const GATE_LIBRARY: readonly GatePolicy[] = [
  ['G0', 'baseline', 'node', ['implementer']],
  ['G1', 'plan', 'node', ['planner']],
  ['G2', 'ownership-roadmap', 'run', ['scoper', 'scope-coordinator']],
  ['G3.5', 'root-cause', 'node', ['depth-prober']],
  ['G4', 'implementation', 'lane', ['implementer']],
  ['G5', 'independent-review', 'lane', ['reviewer']],
  ['G6', 'independent-verification', 'lane', ['verifier', 'fresh-verifier']],
  ['G7', 'sign-off', 'run', ['juror', 'arbiter']],
  ['sweep', 'same-class-defects', 'run', ['sweeper']],
  ['goal-check', 'user-goal-coverage', 'run', ['goal-checker']],
].map(([gateId, kind, scope, requiredRoles]): GatePolicy => ({
  gateId: gateId as string, kind: kind as string, scope: scope as GatePolicy['scope'], requiredRoles: requiredRoles as string[],
  checks: [], requiredEvidenceLevels: ['observed'], onFail: 'block', maxLoops: 2,
  protected: ['G5', 'G6', 'goal-check'].includes(gateId as string),
  independent: ['G5', 'G6', 'G7'].includes(gateId as string),
}));

export function selectFramework(ids: readonly string[]): { status: 'match' | 'miss' | 'ambiguous'; matches: FrameworkAsset[] } {
  const matches = FRAMEWORK_CATALOG.filter(asset => ids.includes(asset.id));
  return { status: matches.length === 0 ? 'miss' : matches.length === 1 ? 'match' : 'ambiguous', matches };
}
