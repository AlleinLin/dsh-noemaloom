import type { ActionDraft, Data } from './types.js';
import { isRecord } from './types.js';
import { ClientError } from './transport.js';

/** Only these context operations return before the domain resolves a session. */
export function contextActionRequiresSession(action: string): boolean {
  return action !== 'overview' && action !== 'list';
}

export function contextViewPrerequisites(value: string | undefined, tab: string) {
  const sessionId = value?.trim() ?? '';
  const hasSession = sessionId.length > 0;
  const params: Data = hasSession ? { sessionId } : {};
  const action = tab === 'cache' ? 'cache/report' : tab === 'prefix' ? 'wire/diff' : tab === 'epochs' ? 'epochs/get' : tab === 'policy' ? 'policy/get' : 'status';
  return {
    sessionId, hasSession, params,
    queries: {
      overview: { action: 'overview', params: {}, enabled: !hasSession },
      status: { action: 'status', params, enabled: hasSession },
      detail: { action, params, enabled: hasSession && action !== 'status' },
    },
  };
}

/** Shared by the page controls and the full operation shelf. */
export function contextActionDraft(draft: ActionDraft, value: string | undefined): ActionDraft | undefined {
  if (draft.domain !== 'context' || !contextActionRequiresSession(draft.action)) return draft;
  const sessionId = value?.trim();
  if (!sessionId) return undefined;
  return { ...draft, params: { ...draft.params, sessionId } };
}

export function recoveryWorkspaceNotice(error: unknown): string | undefined {
  const knownCode = error instanceof ClientError && error.code === 'STATE_WORKSPACE_OVERLAP';
  const legacyCode = isRecord(error) && isRecord(error.details) && error.details.domainCode === 'STATE_WORKSPACE_OVERLAP';
  if (!knownCode && !legacyCode) return undefined;
  return '当前工作区与恢复状态目录重叠，文件恢复暂不可用；请在宿主打开独立项目目录后重试。';
}

export function recoveryMessageBoundaries(snapshot: Data | undefined, sessionId: string) {
  if (!sessionId || snapshot?.sessionId !== sessionId || !Array.isArray(snapshot.events)) return [];
  return snapshot.events.filter((event: Data) => event.type === 'user/message' && event.directUser === true
    && event.injected !== true && Number.isSafeInteger(event.seq) && event.seq >= 0)
    .map((event: Data) => ({
      seq: event.seq as number,
      label: `#${event.seq} · ${(Array.isArray(event.content) ? event.content : [])
        .filter((block: Data) => block.type === 'text' && typeof block.text === 'string')
        .map((block: Data) => block.text).join(' ').replace(/\s+/g, ' ').slice(0, 100) || '用户消息'}`,
    }));
}
