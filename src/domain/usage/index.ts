import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { NexusError, requiredString, recordParams, type NexusModule, type NexusServices, type JsonRecord } from '../../ports/contracts.js';
import { normalizeUsage, type NormalizedUsage } from './normalize.js';
import { validateAccountConfig, resolveAccountSpec, queryAccount } from '../../adapters/models/accounts/index.js';
import { sha256 } from '../files/paths.js';

interface Price extends JsonRecord {
  id: string; provider: string; model: string; currency: string; effectiveAt: string;
  inputPerMillion: string; outputPerMillion: string; cacheReadPerMillion: string; cacheWritePerMillion: string;
}
interface Attempt extends JsonRecord {
  attemptId: string; logicalCallId: string; sessionId: string; provider: string; model: string;
  usage: NormalizedUsage; usageRevision: number; inherited: boolean;
}
interface AccountListItem extends JsonRecord {
  id: string; revision: number; family?: unknown; credentialConfigured: boolean; snapshot: JsonRecord | null;
}
function decimal(value: unknown): bigint {
  if (typeof value !== 'string' || !/^\d+(?:\.\d{1,12})?$/.test(value)) throw new NexusError('INVALID_ARGUMENT', '价格须为最多12位小数的非负十进制字符串');
  const [whole = '0', fraction = ''] = value.split('.');
  return BigInt(whole) * 10n ** 12n + BigInt(fraction.padEnd(12, '0'));
}
function cost(usage: NormalizedUsage, price: Price): string | null {
  if (usage.status !== 'reported') return null;
  const amount = BigInt(usage.uncachedInputTokens!) * decimal(price.inputPerMillion) + BigInt(usage.outputTokens!) * decimal(price.outputPerMillion) + BigInt(usage.cacheReadTokens!) * decimal(price.cacheReadPerMillion) + BigInt(usage.cacheWriteTokens!) * decimal(price.cacheWritePerMillion);
  const units = amount / 1_000_000n;
  return `${units / 10n ** 12n}.${(units % 10n ** 12n).toString().padStart(12, '0')}`;
}
const record = (input: unknown): JsonRecord => input && typeof input === 'object' && !Array.isArray(input) ? input as JsonRecord : {};

export function createUsageModule(services: NexusServices): NexusModule {
  const flights = new Map<string, Promise<unknown>>();
  const ledgerLocks = new Map<string, Promise<void>>();
  const backoff = new Map<string, { failures: number; until: number }>();
  let timer: ReturnType<typeof setInterval> | undefined;
  async function prices() { return (await services.store.list<Price>('usagePrices')).map(row => row.value); }
  async function selectedPrice(provider: string, model: string, at: string) { return (await prices()).filter(row => row.provider === provider && row.model === model && row.effectiveAt <= at).sort((a, b) => b.effectiveAt.localeCompare(a.effectiveAt))[0]; }
  async function accountRefresh(id: string) {
    const pending = flights.get(id); if (pending) return pending;
    const run = (async () => {
      const saved = await services.store.get<JsonRecord>('usageAccounts', id);
      if (!saved) throw new NexusError('NOT_FOUND', '账户配置不存在');
      const config = validateAccountConfig({ monitors: { [id]: saved.value.monitor } });
      const spec = resolveAccountSpec({ id, displayName: saved.value.displayName ?? id, apiKeyEnv: saved.value.credentialRef, baseURL: saved.value.baseURL }, config);
      const result = await queryAccount(spec, { resolve: reference => services.host.secret(reference) }, { allowLocalAuth: saved.value.allowLocalAuth === true });
      if (result.status === 'ok') backoff.delete(id);
      else {
        const failures = (backoff.get(id)?.failures ?? 0) + 1;
        backoff.set(id, { failures, until: Date.now() + Math.min(3600000, 300000 * 2 ** Math.min(failures - 1, 4)) * (0.9 + Math.random() * 0.2) });
      }
      const previous = await services.store.get<JsonRecord>('usageAccountSnapshots', id);
      const stale = result.status !== 'ok' && previous?.value.status === 'ok';
      const next = stale ? { ...previous.value, status: result.status, fetchedAt: result.fetchedAt, lastSuccessAt: previous.value.fetchedAt, stale: true, error: result.reason } : result;
      await services.store.put('usageAccountSnapshots', id, next, previous?.revision ?? 0);
      services.emit('usage.account.changed', { id, status: next.status, stale });
      return next;
    })().finally(() => flights.delete(id));
    flights.set(id, run); return run;
  }
  async function refreshConfigured() {
    const configs = await services.store.list<JsonRecord>('usageAccounts');
    return Promise.allSettled(configs.filter(row => row.value.enabled !== false && (backoff.get(row.id)?.until ?? 0) <= Date.now()).map(row => accountRefresh(row.id)));
  }
  // A timer owns all account refreshes. It never requests a model or reads a key
  // before an account has been explicitly configured through the host.
  queueMicrotask(() => { void refreshConfigured().catch(() => undefined); timer = setInterval(() => { void refreshConfigured().catch(() => undefined); }, 300_000); timer.unref?.(); });
  return {
    id: 'usage',
    capabilities: ['record', 'list', 'summary', 'live', 'estimate', 'prices.list', 'prices.save', 'accounts.list', 'accounts.save', 'accounts.remove', 'accounts.refresh', 'export'].map(action => ({ action, description: `统一用量 ${action}`, mutating: /record|save|remove|refresh|estimate/.test(action) })),
    async dispatch(request, context) {
      const params = recordParams(request);
      if (context?.scopeLevel === 'session' && params.sessionId && params.sessionId !== context.sessionId) throw new NexusError('PERMISSION_DENIED', '只能读取当前会话用量');
      const visible = (row: { value: Attempt }) => context?.scopeLevel === 'session' ? row.value.sessionId === context.sessionId :
        context?.scopeLevel === 'workspace' ? typeof row.value.workspaceRoot === 'string' && resolve(row.value.workspaceRoot).toLowerCase() === resolve(context.workspaceRoot ?? services.workspaceRoot).toLowerCase() : true;
      switch (request.action) {
        case 'record': {
          const logicalCallId = requiredString(params, 'logicalCallId'), attemptId = requiredString(params, 'attemptId'), id = `${logicalCallId}:${attemptId}`;
          const priorLock = ledgerLocks.get(id) ?? Promise.resolve();
          let release!: () => void;
          const held = new Promise<void>(done => { release = done; });
          const tail = priorLock.then(() => held); ledgerLocks.set(id, tail);
          await priorLock;
          try {
          const previous = await services.store.get<Attempt>('usageAttempts', id);
          const usageRevision = typeof params.usageRevision === 'number' && Number.isSafeInteger(params.usageRevision) ? params.usageRevision : previous ? previous.value.usageRevision + 1 : 1;
          if (previous && usageRevision <= previous.value.usageRevision) return previous;
          const usage = normalizeUsage(params.usage, String(params.provider ?? previous?.value.provider ?? ''), typeof params.source === 'string' ? params.source : undefined, params.isFinal !== false);
          if (previous && JSON.stringify({ ...previous.value.usage, receivedAt: '' }) === JSON.stringify({ ...usage, receivedAt: '' }) && previous.value.status === params.status) return previous;
          const provider = String(params.provider ?? previous?.value.provider ?? 'unknown'), model = String(params.model ?? previous?.value.model ?? 'unknown'), at = String(params.startedAt ?? previous?.value.startedAt ?? new Date().toISOString());
          const tariff = await selectedPrice(provider, model, at), calculatedCostDecimal = tariff ? cost(usage, tariff) : null;
          const value: Attempt = {
            ...previous?.value, ledgerSchemaVersion: 1, ledgerOriginId: 'dsh-nexus', ...params,
            attemptId, logicalCallId, sessionId: String(params.sessionId ?? previous?.value.sessionId ?? context?.sessionId ?? 'unscoped'),
            workspaceRoot: context?.scopeLevel === 'global' ? previous?.value.workspaceRoot : context?.workspaceRoot ?? previous?.value.workspaceRoot,
            requestId: params.requestId ?? logicalCallId, provider, model, usage, usageRevision,
            inherited: params.inherited === true, startedAt: at, role: params.role ?? previous?.value.role ?? 'main',
            tariffId: tariff?.id ?? null, currency: tariff?.currency ?? null, calculatedCostDecimal,
            costStatus: calculatedCostDecimal === null ? 'unknown' : 'calculated', rawUsage: params.usage ?? null,
            settlementRevision: (Number(previous?.value.settlementRevision) || 0) + 1, semanticsVersion: 'nexus.usage.v1',
          };
          const saved = await services.store.put('usageAttempts', id, value, previous?.revision ?? 0);
          services.emit('ledger.attempt.changed', { logicalCallId, attemptId, revision: saved.revision, status: usage.status });
          return saved;
          } finally { release(); if (ledgerLocks.get(id) === tail) ledgerLocks.delete(id); }
        }
        case 'list': case 'export': {
          const rows = (await services.store.list<Attempt>('usageAttempts')).filter(visible).filter(row => (!params.sessionId || row.value.sessionId === params.sessionId) && (!params.provider || row.value.provider === params.provider) && (!params.model || row.value.model === params.model) && (!params.since || String(row.value.startedAt) >= String(params.since)) && (!params.until || String(row.value.startedAt) <= String(params.until)));
          return { items: rows.sort((a, b) => String(b.value.startedAt).localeCompare(String(a.value.startedAt))), count: rows.length, source: 'usage-ledger', semanticsVersion: 'nexus.usage.v1' };
        }
        case 'summary': {
          const rows = (await services.store.list<Attempt>('usageAttempts')).filter(visible).filter(row => !row.value.inherited && (!params.sessionId || row.value.sessionId === params.sessionId) && (!params.provider || row.value.provider === params.provider) && (!params.model || row.value.model === params.model) && (!params.since || String(row.value.startedAt) >= String(params.since)) && (!params.until || String(row.value.startedAt) <= String(params.until))).map(row => row.value);
          const reported = rows.filter(row => row.usage.status === 'reported');
          const totals = { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
          for (const row of reported) for (const field of Object.keys(totals) as (keyof typeof totals)[]) totals[field] += row.usage[field] ?? 0;
          const money = new Map<string, bigint>();
          for (const row of rows) if (typeof row.calculatedCostDecimal === 'string' && typeof row.currency === 'string') money.set(row.currency, (money.get(row.currency) ?? 0n) + decimal(row.calculatedCostDecimal));
          const prompt = totals.uncachedInputTokens + totals.cacheReadTokens + totals.cacheWriteTokens;
          return { attempts: rows.length, reportedAttempts: reported.length, unreportedAttempts: rows.filter(row => row.usage.status === 'unreported').length, invalidAttempts: rows.filter(row => row.usage.status === 'invalid').length, totals: reported.length ? totals : null, cacheHitShare: prompt ? totals.cacheReadTokens / prompt : null, reportedCoverage: rows.length ? reported.length / rows.length : null, costs: [...money].map(([currency, units]) => ({ currency, amount: `${units / 10n ** 12n}.${(units % 10n ** 12n).toString().padStart(12, '0')}`, status: 'calculated' })), unknownCosts: rows.filter(row => row.calculatedCostDecimal === null).length, noData: rows.length === 0 };
        }
        case 'estimate': {
          const id = requiredString(params, 'attemptId'), charsPerToken = params.charsPerToken ?? 3.5;
          if (typeof charsPerToken !== 'number' || !Number.isFinite(charsPerToken) || charsPerToken < 1 || charsPerToken > 10) throw new NexusError('INVALID_ARGUMENT', 'charsPerToken 必须为1–10的有限数');
          const text = requiredString(params, 'text'), estimate = Math.ceil(text.length / charsPerToken);
          return services.store.put('usageEstimates', id, { attemptId: id, sessionId: context?.sessionId ?? params.sessionId, tokens: estimate, method: 'character-density', charsPerToken, source: 'estimated', observedAt: new Date().toISOString() });
        }
        case 'live': {
          const rows = (await services.store.list<Attempt>('usageAttempts')).filter(visible).filter(row => row.value.sessionId === (params.sessionId ?? context?.sessionId)).map(row => row.value);
          const latest = rows.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))[0];
          if (!latest) return { source: 'missing', tokensPerSecond: null, observedAt: null };
          const elapsed = typeof latest.completedAt === 'string' ? Date.parse(latest.completedAt) - Date.parse(String(latest.startedAt)) : null;
          return { source: latest.usage.status, usage: latest.usage, tokensPerSecond: elapsed && elapsed > 0 && latest.usage.outputTokens !== null ? latest.usage.outputTokens / (elapsed / 1000) : null, rateScope: 'last-step', observedAt: latest.completedAt ?? latest.startedAt, attemptId: latest.attemptId };
        }
        case 'prices.list': return { items: await prices() };
        case 'prices.save': {
          const id = typeof params.id === 'string' ? params.id : randomUUID(), price = { ...params, id } as Price;
          for (const name of ['provider', 'model', 'currency', 'effectiveAt', 'source']) requiredString(params, name);
          if (!Number.isFinite(Date.parse(price.effectiveAt))) throw new NexusError('INVALID_ARGUMENT', '价格生效时间无效');
          for (const name of ['inputPerMillion', 'outputPerMillion', 'cacheReadPerMillion', 'cacheWritePerMillion'] as const) decimal(price[name]);
          return services.store.put('usagePrices', id, price, request.expectedRevision);
        }
        case 'accounts.list': {
          const configs = await services.store.list<JsonRecord>('usageAccounts'), snapshots = await services.store.list<JsonRecord>('usageAccountSnapshots');
          const items = await Promise.all(configs.map(async (row): Promise<AccountListItem> => ({ id: row.id, revision: row.revision, ...row.value, credentialConfigured: typeof row.value.credentialRef === 'string' ? Boolean(await services.host.secret(row.value.credentialRef)) : false, snapshot: snapshots.find(item => item.id === row.id)?.value ?? null })));
          const families = new Set<string>(); return { items: items.filter(row => { const family = String(row.family ?? row.id); if (families.has(family)) return false; families.add(family); return true; }), adapters: ['deepseek-balance', 'openrouter-balance', 'moonshot-balance', 'zai-balance', 'new-api', 'sub2api', 'sub2api-auth', 'general', 'opencode-go', 'zai-token-plan', 'kimi-token-plan', 'minimax-token-plan', 'declarative'] };
        }
        case 'accounts.save': {
          const id = requiredString(params, 'id');
          if (Object.keys(params).some(key => /^(apiKey|password|cookie|token|secret)$/i.test(key))) throw new NexusError('INVALID_ARGUMENT', '账户配置只接受宿主凭据引用');
          const monitor: JsonRecord = { ...record(params.monitor), adapter: params.adapter ?? record(params.monitor).adapter, credentialRef: params.credentialRef };
          if (monitor.allowProxySynthetic === true) throw new NexusError('PERMISSION_DENIED', '代理合成DNS地址需由受核验宿主网络能力配置，不能通过账户表单启用');
          if (monitor.allowPrivateNetwork === true) {
            const origin = new URL(requiredString({ baseURL: monitor.usageBaseURL ?? params.baseURL }, 'baseURL'));
            const addresses = await lookup(origin.hostname.replace(/^\[|\]$/g, ''), { all: true, verbatim: true });
            if (!await services.host.approve('usage.accounts.private-network', origin.origin, { addresses: addresses.map(row => row.address), sessionId: context?.sessionId })) throw new NexusError('PERMISSION_DENIED', '账户自托管网络未获批准');
            monitor.approvedOrigin = origin.origin; monitor.approvedAddresses = addresses.map(row => row.address);
          }
          validateAccountConfig({ monitors: { [id]: monitor } });
          return services.store.put('usageAccounts', id, { ...params, monitor }, request.expectedRevision);
        }
        case 'accounts.remove': return { removed: await services.store.remove('usageAccounts', requiredString(params, 'id'), request.expectedRevision) };
        case 'accounts.refresh': return accountRefresh(requiredString(params, 'id'));
        default: throw new NexusError('ACTION_NOT_FOUND', `未知用量操作: ${request.action}`);
      }
    },
    dispose() { if (timer) clearInterval(timer); },
  };
}
