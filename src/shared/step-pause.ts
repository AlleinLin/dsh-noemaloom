/**
 * Adapted from dsh-step-pause 0.3.0 (MIT), commit eeb93a7.
 * Full source identity and license: notices/step-pause/.
 */
export const STEP_PAUSE_FEATURE = 'step-pause';
export const STEP_PAUSE_PRODUCER = 'plugin:@local/dsh-nexus' as const;
/** Debug-visible notices remain synthetic, even when rendered as a user bubble. */
export function isStepProgressMessage(message: any): boolean {
  return message?.source?.meta?.producer === STEP_PAUSE_PRODUCER && message.source.meta.purpose === 'step-progress';
}
export function isHumanInputMessage(message: any): boolean {
  return message?.source?.kind === 'user' && !isStepProgressMessage(message);
}
export const STEP_PAUSE_DEFAULT_PROMPT = [
  '[自动 · 步骤进度 · 第 {{step}} 步（每 {{every}} 步一次）]',
  '在不改变原任务约束与输出格式的前提下，直接在对话正文里用 5–10 行说明当前进度，然后立刻继续原任务：',
  '1. 正在做什么：当前任务与所处步骤',
  '2. 已完成什么：本轮已完成的动作或产出',
  '3. 接下来做什么：下一步计划',
  '4. 卡点：需要用户决策或补充信息的地方（没有就写「无」）',
  '',
  '不要为本次汇报新建或修改文档、计划文件，不要停下来等待确认。',
  '原任务的权限、审批、取消和输出格式约束始终有效；若格式不允许进度正文，继续遵守原格式。',
].join('\n');

export interface StepPauseOptions {
  enabled: boolean;
  everyNSteps: number;
  maxReportsPerTurn: number;
  prompt: string;
  showPromptInChat: boolean;
  mainAgentOnly: boolean;
}
export const STEP_PAUSE_DEFAULTS: Readonly<StepPauseOptions> = Object.freeze({
  enabled: true, everyNSteps: 10, maxReportsPerTurn: 0,
  prompt: STEP_PAUSE_DEFAULT_PROMPT, showPromptInChat: false, mainAgentOnly: true,
});
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Persisted scope overlays stay sparse; omitted fields keep live inheritance. */
export function validateStepPauseConfig(value: unknown): string | undefined {
  const config = record(value), defaults = record(config.defaults);
  if (Object.keys(defaults).some(key => !['everyNSteps', 'maxReportsPerTurn', 'prompt', 'showPromptInChat', 'mainAgentOnly'].includes(key))) return '步骤进度设置包含未知字段';
  for (const key of ['showPromptInChat', 'mainAgentOnly']) {
    if (defaults[key] !== undefined && typeof defaults[key] !== 'boolean') return `${key} 必须为布尔值`;
  }
  for (const [key, min, max] of [['everyNSteps', 1, 500], ['maxReportsPerTurn', 0, 1000]] as const) {
    const number = defaults[key];
    if (number !== undefined && (typeof number !== 'number' || !Number.isSafeInteger(number) || number < min || number > max)) return `${key} 须为 ${min}–${max} 的整数`;
  }
  if (defaults.prompt !== undefined && (typeof defaults.prompt !== 'string' || !defaults.prompt.trim() || defaults.prompt.length > 8000)) return '进度提示词须为1至8000字符';
}

export function resolveStepPauseOptions(effective: unknown): StepPauseOptions {
  const config = record(effective);
  const error = validateStepPauseConfig(config);
  if (error) throw new Error(error);
  return { ...STEP_PAUSE_DEFAULTS, ...record(config.defaults), enabled: config.enabled !== false } as StepPauseOptions;
}

export function renderStepPausePrompt(template: string, values: { step: number; every: number; turn: number }): string {
  return template.replace(/\{\{\s*(step|every|turn)\s*\}\}/g, (_, key: keyof typeof values) => String(values[key]));
}
