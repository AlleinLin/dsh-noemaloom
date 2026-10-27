import { Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session';
import { NexusError } from '../ports/contracts.js';
import { nativeCompactionFor } from './compaction-binding.js';
import type { HostContext } from './types.js';

function provider(ctx: HostContext, agent: any) {
  const bound = nativeCompactionFor(agent), direct = agent.ctx?.get?.('compaction');
  return bound ?? (direct?.selfCompaction ? direct : ctx.get('nexusCompactionMaintenance'));
}
/** Native subagents release their Agent at natural idle. Reading the sidebar
 * does not recreate one. Read a detached official Session for status; acquire
 * an official, prompt-free maintenance handle only for an explicit UI write.
 * The persistence writer lock arbitrates races with native continuation. */
export async function contextMaintenance(ctx: HostContext, sessionId: string, action: 'status' | 'compact',
  requestId: unknown, signal: AbortSignal, actorId?: string) {
  signal.throwIfAborted();
  const agents = ctx.get('agents');
  const run = async (agent: any) => {
    const owner = provider(ctx, agent);
    if (!owner?.contextStatus || !owner?.selfCompaction) throw new NexusError('CTX_NATIVE_PROVIDER_UNAVAILABLE', '统一压缩后端尚未就绪，请稍后重试');
    if (action === 'status') return owner.contextStatus(agent, signal);
    if (actorId !== 'connection-owner') throw new NexusError('PERMISSION_DENIED', '此入口只接受用户手动压缩；模型请调用 compact_context');
    if (agent.status !== 'idle') throw new NexusError('CTX_NATIVE_BUSY', '子代理仍在执行，自动压缩将在下次请求前检查；手动操作未停止任务');
    return owner.selfCompaction(agent, { action: 'compact', requestId }, signal);
  };
  const live = agents?.get?.(sessionId);
  if (live) return run(live);
  if (actorId !== 'connection-owner') throw new NexusError('PERMISSION_DENIED', '读取或维护已释放的子代理需要用户界面权限');
  const snapshot = await ctx.get('sessionQuery')?.readSession?.(SessionId(sessionId), signal);
  if (!snapshot || snapshot.session?.id !== sessionId || !Array.isArray(snapshot.events)) {
    throw new NexusError('SESSION_NOT_LIVE', '未找到可核验的原生子代理历史');
  }
  if (snapshot.session.origin !== 'subagent') throw new NexusError('SESSION_NOT_LIVE', '普通会话请先打开后维护');
  signal.throwIfAborted();
  const inherited = snapshot.inheritedEventCount ?? (snapshot.session.isSeeded ? undefined : 0);
  if (!Number.isSafeInteger(inherited) || inherited < 0 || inherited > snapshot.events.length) {
    throw new NexusError('HOST_CONTRACT_UNSUPPORTED', '宿主未提供准确的子代理继承边界，未猜测或修改历史');
  }
  const detached = Session.create(SessionId(sessionId), snapshot.events, snapshot.session,
    SessionLogOffset(inherited), ctx.get('sessions')?.messageProjections ?? []);
  const selection = ctx.get('sessionProjections')?.stateOf?.(detached, 'modelSelection');
  const previous = detached.requestHeader()?.config;
  const descriptor = snapshot.events.findLast((event: any) => event.type === 'subagent/descriptor')?.data;
  const selected = selection?.pending ?? selection?.lastUsed;
  const options = selected && previous && (selected.provider !== previous.provider || selected.model !== previous.model)
    ? { ...selected } : { ...(descriptor?.agentProvider && descriptor.agentModel
      ? { provider: descriptor.agentProvider, model: descriptor.agentModel } : {}), ...previous, ...selected };
  if (action === 'status') return run({ id: sessionId, session: detached, options, status: 'idle' });
  signal.throwIfAborted();
  const current = agents.get(sessionId);
  if (current) return run(current);
  if (typeof agents.resume !== 'function') throw new NexusError('HOST_CAPABILITY_UNAVAILABLE', '宿主缺少原生历史维护接口');
  let handle: any;
  try {
    handle = await agents.resume({ resumeSessionId: SessionId(sessionId), agentOptions: options, signal,
      ...(agents.get(snapshot.session.parentSession) ? { parentAgent: agents.get(snapshot.session.parentSession) } : {}) });
  } catch (error) {
    signal.throwIfAborted();
    throw new NexusError('CTX_NATIVE_BUSY', '子代理历史的维护句柄暂不可用；可能正在恢复或由其他操作持有。未启动模型、未取消任务',
      { cause: (error as any)?.code ?? 'native-resume-unavailable' });
  }
  try { return { ...await run(handle.agent), maintenanceOnly: true }; }
  finally { await handle.dispose(); }
}
