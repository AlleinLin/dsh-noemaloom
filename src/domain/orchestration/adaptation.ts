import type { ValidationIssue } from './types.js';
import { policyHash } from './util.js';

export type AdaptationKind = 'skill' | 'profile' | 'architecture-guideline' | 'role' | 'workflow-proposal' | 'tool' | 'hook';
export interface Adaptation {
  id: string;
  revision: number;
  kind: AdaptationKind;
  scope: 'user' | 'project';
  scopeId: string;
  canonicalName: string;
  status: 'proposed' | 'trial' | 'tentative' | 'active' | 'quarantined' | 'retired';
  author: 'learned' | 'user';
  content: string;
  sourceEvidenceRefs: string[];
  triggers: string[];
  exclusions: string[];
  expectedBenefit: string;
  risks: string[];
  regressionCases: string[];
  replacements: string[];
  commandSignatures: string[];
  requiredTokens: string[];
  protectedPreference?: boolean;
  safetyOrLicenseRule?: boolean;
  modifies: string[];
  review?: { diffReviewed: boolean; sourceVerified: boolean; sandboxVerified: boolean; permissionGranted: boolean };
}
export interface AdaptationApplication {
  id: string;
  adaptationId: string;
  revision: number;
  runId: string;
  nodeId: string;
  appliedAt: string;
  inputSnapshotHash: string;
  holdout: boolean;
  decisionRef: string;
}
export interface AdaptationEvaluation {
  applicationId: string;
  revision: number;
  outcome: 'helped' | 'hurt' | 'neutral' | 'unknown';
  evidenceRefs: string[];
  completedTask: boolean;
  userCorrectionRef?: string;
}
export interface AdaptationActivationOptions {
  explicit?: 'on' | 'off';
  environment?: 'on' | 'off';
  configured?: boolean;
  benchmark?: boolean;
  headless?: boolean;
  persistent?: boolean;
  projectTrusted?: boolean;
}
/** Pure activation check: callers must return before listing storage when this is false. */
export function isAdaptationActive(options: AdaptationActivationOptions): boolean {
  if (options.explicit === 'off' || options.environment === 'off') return false;
  if (options.explicit === 'on' || options.environment === 'on') return true;
  if (options.benchmark || options.headless || options.persistent === false) return false;
  return options.configured ?? false;
}
const PROTECTED_SURFACES = new Set(['dispatcher', 'tool-schemas', 'authorization', 'budget', 'idempotency',
  'cancellation', 'credentials', 'protected-gates', 'evidence', 'host-harness', 'active-run', 'user-goal', 'gate-verdict',
  'route-policy', 'model-policy', 'role-binding', 'tool-permissions', 'system-prompt', 'ownership']);
export function guardAdaptation(candidate: Adaptation, options: {
  previous?: Adaptation;
  trustedProject: boolean;
  currentScope: { kind: 'user' | 'project'; id: string };
  allowedCapabilityIds?: readonly string[];
}): { accepted: boolean; issues: ValidationIssue[]; needsExplicitReview: boolean } {
  const issues: ValidationIssue[] = [];
  const add = (code: string, path: string, message: string): void => { issues.push({ code, path, message }); };
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    add('ADAPTATION_SCHEMA_INVALID', '', 'Adaptation must be a record');
    return { accepted: false, issues, needsExplicitReview: false };
  }
  for (const key of ['id', 'scopeId', 'canonicalName', 'content', 'expectedBenefit'] as const) {
    if (typeof candidate[key] !== 'string' || !candidate[key].trim() || candidate[key].length > (key === 'content' ? 60000 : 4096)) {
      add('ADAPTATION_SCHEMA_INVALID', key, 'A bounded nonempty string is required');
    }
  }
  for (const key of ['sourceEvidenceRefs', 'triggers', 'exclusions', 'risks', 'regressionCases',
    'replacements', 'commandSignatures', 'requiredTokens', 'modifies'] as const) {
    if (!Array.isArray(candidate[key]) || candidate[key].length > 256 ||
      candidate[key].some(value => typeof value !== 'string' || !value.trim() || value.length > 4096)) {
      add('ADAPTATION_SCHEMA_INVALID', key, 'A bounded array of nonempty strings is required');
    }
  }
  if (!['skill', 'profile', 'architecture-guideline', 'role', 'workflow-proposal', 'tool', 'hook'].includes(candidate.kind) ||
    !['user', 'project'].includes(candidate.scope) || !['learned', 'user'].includes(candidate.author) ||
    !['proposed', 'trial', 'tentative', 'active', 'quarantined', 'retired'].includes(candidate.status)) {
    add('ADAPTATION_SCHEMA_INVALID', 'kind/scope/author/status', 'Unknown adaptation discriminant');
  }
  if (candidate.review !== undefined && (!candidate.review || typeof candidate.review !== 'object' ||
    ['diffReviewed', 'sourceVerified', 'sandboxVerified', 'permissionGranted'].some(key =>
      typeof candidate.review?.[key as keyof NonNullable<Adaptation['review']>] !== 'boolean'))) {
    add('ADAPTATION_SCHEMA_INVALID', 'review', 'Review fields must be booleans');
  }
  for (const key of ['protectedPreference', 'safetyOrLicenseRule'] as const) {
    if (candidate[key] !== undefined && typeof candidate[key] !== 'boolean') add('ADAPTATION_SCHEMA_INVALID', key, 'Expected boolean');
  }
  if (issues.length) return { accepted: false, issues, needsExplicitReview: false };
  for (const surface of candidate.modifies) if (PROTECTED_SURFACES.has(surface)) add('ADAPTATION_PROTECTED_SURFACE', 'modifies', surface);
  const authorityOverride = /(?:hide|remove|disable|bypass|skip|ignore|overwrite|隐藏|移除|禁用|绕过|跳过|忽略|覆盖)[^\n.。]{0,100}(?:nexus_(?:workflow|agents|quality|review|files|artifact)|authorization|protected.gate|budget|credential|权限|授权|质量门|预算|凭据)/i;
  const reverseOverride = /(?:authorization|protected.gate|budget|credential|权限|授权|质量门|预算|凭据)[^\n.。]{0,60}(?:bypass|disabled|ignored|绕过|禁用|忽略)/i;
  if (authorityOverride.test(candidate.content) || reverseOverride.test(candidate.content)) add('ADAPTATION_AUTHORITY_OVERRIDE', 'content', 'Candidate proposes to alter a protected runtime policy');
  if (candidate.scope === 'project' && !options.trustedProject) add('UNTRUSTED_PROJECT', 'scope', 'Project adaptations require trust');
  if (options.currentScope.kind === 'project' && (candidate.scope !== 'project' || candidate.scopeId !== options.currentScope.id)) add('SCOPE_ESCALATION', 'scope', 'Project learning cannot change user/global scope');
  if (!candidate.sourceEvidenceRefs.length || !candidate.triggers.length || !candidate.expectedBenefit.trim() || !candidate.regressionCases.length) add('ADAPTATION_EVIDENCE_INCOMPLETE', 'sourceEvidenceRefs', 'Evidence, triggers, benefit and regressions required');
  if (!candidate.content.trim() || !Number.isInteger(candidate.revision) || candidate.revision < 1) add('ADAPTATION_SCHEMA_INVALID', 'content/revision', 'Nonempty content and positive revision required');
  if (candidate.requiredTokens.some(token => !candidate.content.includes(token))) add('REQUIRED_COMMAND_TOKEN_REMOVED', 'content', 'A required flag or literal is missing');
  if (options.previous) {
    if (candidate.id !== options.previous.id || candidate.revision !== options.previous.revision + 1) add('ADAPTATION_REVISION_CONFLICT', 'revision', 'Updates must increment the same identity once');
    for (const token of options.previous.requiredTokens) if (!candidate.content.includes(token)) add('REQUIRED_COMMAND_TOKEN_REMOVED', 'content', token);
    if (options.previous.protectedPreference && !candidate.protectedPreference) add('EXPLICIT_PREFERENCE_WEAKENED', 'protectedPreference', candidate.id);
    if (options.previous.safetyOrLicenseRule && !candidate.safetyOrLicenseRule) add('SAFETY_RULE_WEAKENED', 'safetyOrLicenseRule', candidate.id);
  }
  const executable = candidate.kind === 'tool' || candidate.kind === 'hook';
  if (executable && (!candidate.review?.diffReviewed || !candidate.review.sourceVerified ||
    !candidate.review.sandboxVerified || !candidate.review.permissionGranted)) add('EXECUTABLE_ADAPTATION_REVIEW_REQUIRED', 'review', 'Code, source, sandbox and explicit permission required');
  // References are data: merely writing a capability name never grants it.
  if (options.allowedCapabilityIds) {
    const capabilities = candidate.modifies.filter(item => item.startsWith('capability:')).map(item => item.slice(11));
    for (const capability of capabilities) if (!options.allowedCapabilityIds.includes(capability)) add('CAPABILITY_ESCALATION', 'modifies', capability);
  }
  return { accepted: !issues.length, issues, needsExplicitReview: executable ||
    (options.previous !== undefined && options.previous.commandSignatures.join('\n') !== candidate.commandSignatures.join('\n')) };
}

export function adaptationSignature(adaptation: Pick<Adaptation, 'kind' | 'canonicalName' | 'scope' | 'scopeId' | 'commandSignatures'>): string {
  return policyHash({ kind: adaptation.kind, name: adaptation.canonicalName.trim().toLowerCase(),
    scope: adaptation.scope, scopeId: adaptation.scopeId, commandSignatures: [...adaptation.commandSignatures].sort() });
}
/** Deterministic per session/turn split, without withholding explicit preferences or safety rules. */
export function isTrialHoldout(adaptation: Adaptation, input: {
  sessionId: string; turnId: string; holdoutPercent?: number;
}): boolean {
  if (adaptation.protectedPreference || adaptation.safetyOrLicenseRule || adaptation.status === 'active' ||
    adaptation.author === 'user' || !['trial', 'tentative'].includes(adaptation.status)) return false;
  const percent = Math.max(0, Math.min(100, input.holdoutPercent ?? 15));
  const bucket = Number.parseInt(policyHash([adaptation.id, input.sessionId, input.turnId]).slice(0, 8), 16) / 0x100000000;
  return bucket * 100 < percent;
}
/** `load` is deliberately lazy: off must not read adaptation directories or alter the baseline. */
export function selectAdaptations(input: {
  activation: AdaptationActivationOptions;
  load: () => readonly Adaptation[];
  sessionId: string;
  turnId: string;
  scope: { kind: 'user' | 'project'; id: string };
  userScopeId?: string;
  holdoutPercent?: number;
}): { applied: Adaptation[]; heldOut: Adaptation[]; baselineUnchanged: boolean } {
  if (!isAdaptationActive(input.activation)) return { applied: [], heldOut: [], baselineUnchanged: true };
  const applied: Adaptation[] = [], heldOut: Adaptation[] = [];
  for (const adaptation of input.load()) {
    if (!adaptation || typeof adaptation !== 'object' || typeof adaptation.id !== 'string') continue;
    if (!['active', 'trial', 'tentative'].includes(adaptation.status)) continue;
    if (adaptation.scope === 'user' && adaptation.scopeId !==
      (input.scope.kind === 'user' ? input.scope.id : input.userScopeId)) continue;
    if (adaptation.scope === 'project' && (!input.activation.projectTrusted ||
      input.scope.kind !== 'project' || adaptation.scopeId !== input.scope.id)) continue;
    if (isTrialHoldout(adaptation, input)) heldOut.push(adaptation); else applied.push(adaptation);
  }
  return { applied, heldOut, baselineUnchanged: applied.length === 0 };
}

export function evaluateAdaptationPromotion(input: {
  adaptation: Adaptation;
  applications: readonly AdaptationApplication[];
  evaluations: readonly AdaptationEvaluation[];
  regressionPassed: boolean;
  alreadyPromoted?: boolean;
}): { action: 'promote' | 'quarantine' | 'retain' | 'already-active'; helped: number; hurt: number;
  evaluated: number; successRate: number | null; reasons: string[] } {
  const owned = new Map(input.applications.filter(application => application.adaptationId === input.adaptation.id &&
    application.revision === input.adaptation.revision && !application.holdout).map(application => [application.id, application]));
  const latest = new Map<string, AdaptationEvaluation>();
  for (const evaluation of input.evaluations) {
    if (!owned.has(evaluation.applicationId) || !evaluation.completedTask || !evaluation.evidenceRefs.length) continue;
    const previous = latest.get(evaluation.applicationId);
    if (!previous || evaluation.revision > previous.revision) latest.set(evaluation.applicationId, evaluation);
  }
  const values = [...latest.values()], helped = values.filter(value => value.outcome === 'helped').length;
  const hurt = values.filter(value => value.outcome === 'hurt').length;
  const evaluated = values.filter(value => value.outcome !== 'unknown').length;
  const base = { helped, hurt, evaluated, successRate: evaluated ? helped / evaluated : null };
  if ((['tool', 'hook'].includes(input.adaptation.kind) && hurt > 0) || hurt >= 2) return { ...base, action: 'quarantine', reasons: ['HARM_THRESHOLD_REACHED_KEEP_NEGATIVE_EVIDENCE'] };
  if (input.adaptation.status === 'active' || input.alreadyPromoted) return { ...base, action: 'already-active', reasons: ['IDEMPOTENT_PROMOTION'] };
  if (['quarantined', 'retired'].includes(input.adaptation.status)) return { ...base, action: 'retain', reasons: ['EXPLICIT_REACTIVATION_REQUIRED'] };
  if (helped >= 3 && hurt === 0 && input.regressionPassed) return { ...base, action: 'promote', reasons: ['THREE_HELPED_ZERO_HURT_REGRESSIONS_PASSED'] };
  return { ...base, action: 'retain', reasons: [evaluated ? 'TRIAL_EVIDENCE_INSUFFICIENT' : 'NOT_EVALUATED', ...(input.regressionPassed ? [] : ['REGRESSION_NOT_PASSED'])] };
}

export function checkAdaptationCapacity(input: {
  current: readonly Adaptation[]; candidate: Adaptation; maxLearnedSkills?: number;
}): { allowed: boolean; action: 'insert' | 'update' | 'propose-replace-retire'; protectedIds: string[] } {
  const scope = input.current.filter(item => item.scope === input.candidate.scope && item.scopeId === input.candidate.scopeId);
  const protectedIds = scope.filter(item => item.author === 'user').map(item => item.id);
  const occupiesLearnedSlot = (item: Adaptation): boolean =>
    item.kind === 'skill' && item.author === 'learned' && !['retired', 'quarantined'].includes(item.status);
  // A user's same-name skill is protected source material, not an existing
  // learned slot. Identity/signature matching must not let a learned proposal
  // overwrite it or bypass the learned-skill budget.
  if (input.candidate.author === 'learned' && scope.some(item => item.id === input.candidate.id && item.author === 'user')) {
    return { allowed: false, action: 'propose-replace-retire', protectedIds };
  }
  const sameAuthor = scope.filter(item => item.author === input.candidate.author);
  const existing = sameAuthor.find(item => item.id === input.candidate.id) ??
    sameAuthor.find(item => adaptationSignature(item) === adaptationSignature(input.candidate));
  const count = scope.filter(occupiesLearnedSlot).length;
  if (input.candidate.kind === 'skill' && input.candidate.author === 'learned'
    && count >= (input.maxLearnedSkills ?? 30) && (!existing || !occupiesLearnedSlot(existing))) {
    return { allowed: false, action: 'propose-replace-retire', protectedIds };
  }
  if (existing) return { allowed: true, action: 'update', protectedIds };
  return { allowed: true, action: 'insert', protectedIds };
}
export function canScheduleLearning(input: {
  active: boolean; userTyping: boolean; highPriorityTask: boolean; dailyCallsUsed: number;
  dailyCallBudget?: number; requestedTokens: number; maxTokensPerCall?: number;
  signal: 'user-correction' | 'repeated-failure' | 'successful-recovery' | 'gated-completion' | 'user-save' | 'tool-error';
}): { allowed: boolean; reason: string } {
  if (!input.active) return { allowed: false, reason: 'ADAPTATION_OFF' };
  if (input.userTyping || input.highPriorityTask) return { allowed: false, reason: 'FOREGROUND_PRIORITY' };
  if (input.signal === 'tool-error') return { allowed: false, reason: 'TOOL_ERROR_IS_NOT_USER_CORRECTION' };
  if (input.dailyCallsUsed >= (input.dailyCallBudget ?? 8)) return { allowed: false, reason: 'DAILY_CALL_BUDGET_EXHAUSTED' };
  if (!Number.isFinite(input.requestedTokens) || input.requestedTokens <= 0 || input.requestedTokens > (input.maxTokensPerCall ?? 6000)) return { allowed: false, reason: 'LEARNER_TOKEN_BUDGET_EXCEEDED' };
  return { allowed: true, reason: 'LOCAL_SIGNAL_ACCEPTED_RESERVE_SHARED_LEDGER_BUDGET' };
}
