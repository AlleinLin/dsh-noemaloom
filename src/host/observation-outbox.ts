import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { JsonRecord } from '../ports/contracts.js';

export type ObservationKind = 'usage' | 'context';
interface PendingObservation { version: 1; kind: ObservationKind; facts: JsonRecord }
interface ObservationExecution {
  /** The actual operation, including any older revision it must wait for. */
  operation: Promise<void>;
  /** One shared, bounded wait; timing out never releases operation ownership. */
  promise: Promise<void>;
}
const LIMIT = 512;
const strings = new Set([
  'attemptId', 'logicalCallId', 'runId', 'nodeId', 'sessionId', 'provider', 'model', 'role',
  'startedAt', 'finishedAt', 'completedAt', 'status', 'source', 'providerHttpAttempts',
  'dispatchStartedAt', 'firstTextAt', 'ttftState', 'ttftSource', 'firstReasoningAt',
  'providerRequestId', 'providerRequestIdSource', 'purpose', 'lane', 'planId', 'completion',
]);
const numbers = new Set([
  'inputBytes', 'maxOutputTokens', 'usageRevision', 'admissionWaitMs', 'ttftMs', 'timeToFirstReasoningMs',
]);
function numericUsage(value: unknown, depth = 0): JsonRecord | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 2) return;
  const result: JsonRecord = {};
  for (const [key, item] of Object.entries(value).slice(0, 32)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key)) continue;
    if (typeof item === 'number' && Number.isFinite(item) && item >= 0) result[key] = item;
    else if (item && typeof item === 'object') {
      const child = numericUsage(item, depth + 1);
      if (child) result[key] = child;
    }
  }
  return result;
}
/** Persist only accounting metadata; no prompts, tool arguments, credentials or errors. */
function receipt(kind: ObservationKind, facts: JsonRecord): PendingObservation {
  const clean: JsonRecord = {};
  for (const [key, value] of Object.entries(facts)) {
    if (strings.has(key) && typeof value === 'string') clean[key] = value.slice(0, 512);
    if (numbers.has(key) && typeof value === 'number' && Number.isFinite(value)) clean[key] = value;
  }
  const usage = numericUsage(facts.usage);
  if (usage) clean.usage = usage;
  if (!clean.attemptId || !clean.logicalCallId) throw new Error('Observation identity missing');
  return { version: 1, kind, facts: clean };
}
function identity(job: PendingObservation) {
  return createHash('sha256').update(JSON.stringify([
    job.kind, job.facts.logicalCallId, job.facts.attemptId, job.facts.planId ?? '',
  ])).digest('hex');
}

/**
 * Only idempotent usage.record/context.complete operations can be retried here.
 * This queue never reissues a model call, compression decision or replacement.
 * The original attempt IDs survive; every bookkeeping dispatch gets a fresh ID
 * so a cached failed dispatcher receipt cannot poison a later accounting retry.
 */
export class ObservationOutbox {
  private readonly pending = new Map<string, PendingObservation>();
  private timer?: ReturnType<typeof setInterval>;
  private replay?: Promise<void>;
  private stopped = false;
  private loaded?: Promise<void>;
  private serial = Promise.resolve();
  private readonly executing = new Map<string, Map<string, ObservationExecution>>();
  private readonly active = new Set<Promise<void>>();
  constructor(
    private readonly directory: () => string,
    private readonly execute: (kind: ObservationKind, facts: JsonRecord, dispatchId: string) => Promise<void>,
    private readonly warn: (code: string, facts?: JsonRecord) => void,
    private readonly deadlineMs = 5000,
  ) {
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1) throw new RangeError('Observation deadline must be a positive integer');
  }

  private load(): Promise<void> {
    return this.loaded ??= (async () => {
      await mkdir(this.directory(), { recursive: true, mode: 0o700 });
      const names = (await readdir(this.directory())).filter(name => /^[a-f0-9]{64}\.json$/.test(name));
      for (const name of names.slice(0, LIMIT)) {
        try {
          const text = await readFile(join(this.directory(), name), 'utf8');
          if (text.length > 32768) throw new Error('Oversized observation');
          const value = JSON.parse(text);
          if (value.version !== 1 || !['usage', 'context'].includes(value.kind)) throw new Error('Invalid observation');
          const job = receipt(value.kind, value.facts);
          if (`${identity(job)}.json` !== name) throw new Error('Observation identity mismatch');
          this.pending.set(identity(job), job);
        } catch { this.warn('OBSERVATION_RECEIPT_INVALID'); }
      }
      if (names.length > LIMIT) this.warn('OBSERVATION_OUTBOX_FULL', { limit: LIMIT });
    })().catch(error => { this.loaded = undefined; throw error; });
  }
  async start(): Promise<void> {
    try { await this.load(); }
    catch { this.warn('OBSERVATION_OUTBOX_UNAVAILABLE'); return; }
    if (this.stopped || this.timer) return;
    this.timer = setInterval(() => { void this.retry(); }, 30000);
    this.timer.unref?.();
    void this.retry();
  }
  private perform(job: PendingObservation, facts = job.facts, prefix = 'observation'): Promise<void> {
    const id = identity(job);
    const revisions = this.executing.get(id) ?? new Map<string, ObservationExecution>();
    const fingerprint = createHash('sha256').update(JSON.stringify(job.facts)).digest('hex');
    const current = revisions.get(fingerprint);
    if (current) return current.promise;
    const prior = [...revisions.values()].at(-1);
    // Queue revisions behind the real operation, not its bounded wait. An
    // executor can ignore its cooperative AbortSignal and remain pending after
    // the deadline; neither observe() nor retry() may overlap that accounting.
    const operation = (prior?.operation.catch(() => undefined) ?? Promise.resolve())
      .then(() => {
        if (this.stopped) throw new Error('Observation recovery stopped');
        return this.execute(job.kind, facts, `${prefix}:${randomUUID()}`);
      });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const promise = Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('Observation execution deadline exceeded')), this.deadlineMs);
      }),
    ]).finally(() => { if (timeout) clearTimeout(timeout); });
    const entry = { operation, promise };
    revisions.set(fingerprint, entry);
    this.executing.set(id, revisions);
    // Only actual settlement clears the entry. Keeping a timed-out operation
    // registered prevents periodic retries from duplicating an unknown effect.
    void operation.finally(() => {
      if (revisions.get(fingerprint) === entry) revisions.delete(fingerprint);
      if (revisions.size === 0 && this.executing.get(id) === revisions) this.executing.delete(id);
    }).catch(() => undefined);
    return promise;
  }
  observe(kind: ObservationKind, facts: JsonRecord): Promise<void> {
    const operation = this.observeNow(kind, facts);
    this.active.add(operation);
    void operation.finally(() => this.active.delete(operation)).catch(() => undefined);
    return operation;
  }
  private async observeNow(kind: ObservationKind, facts: JsonRecord): Promise<void> {
    let job: PendingObservation;
    try { job = receipt(kind, facts); }
    catch { this.warn('OBSERVATION_RECEIPT_INVALID'); return; }
    try {
      if (this.stopped) throw new Error('Observation recovery stopped');
      // Successful observations do not add filesystem traffic.
      const previous = this.pending.get(identity(job));
      await this.perform(job, facts);
      if (previous) {
        const remove = this.serial.then(async () => {
          if (this.pending.get(identity(job)) !== previous) return;
          await unlink(join(this.directory(), `${identity(job)}.json`));
          this.pending.delete(identity(job));
        });
        this.serial = remove.catch(() => undefined);
        // Cleanup failure must not turn a successful new receipt into a failed
        // old observation. Downstream attempts remain revision-idempotent.
        await remove.catch(() => undefined);
      }
      return;
    } catch { this.warn('OBSERVATION_DEFERRED', { kind, attemptId: facts.attemptId, sessionId: facts.sessionId, logicalCallId: facts.logicalCallId }); }
    try {
      const save = this.serial.then(async () => {
        await this.load();
        const id = identity(job);
        if (!this.pending.has(id) && this.pending.size >= LIMIT) {
          this.warn('OBSERVATION_OUTBOX_FULL', { limit: LIMIT, attemptId: facts.attemptId });
          return;
        }
        const path = join(this.directory(), `${id}.json`);
        const temporary = `${path}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, JSON.stringify(job), { mode: 0o600, flag: 'wx' });
          await rename(temporary, path);
          this.pending.set(id, job);
        } finally { await unlink(temporary).catch(() => undefined); }
      });
      this.serial = save.catch(() => undefined);
      await save;
    } catch { this.warn('OBSERVATION_RECEIPT_UNSAVED', { kind, attemptId: facts.attemptId, sessionId: facts.sessionId, logicalCallId: facts.logicalCallId }); }
  }
  retry(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return this.replay ??= (async () => {
      try { await this.load(); await this.serial; }
      catch { this.warn('OBSERVATION_OUTBOX_UNAVAILABLE'); return; }
      // Bound each pass and parallelism; never block a running task on recovery.
      const jobs = [...this.pending].slice(0, 16);
      for (let i = 0; i < jobs.length && !this.stopped; i += 4) {
        await Promise.all(jobs.slice(i, i + 4).map(async ([id, job]) => {
          try {
            await this.perform(job, job.facts, 'observation-recovery');
            const remove = this.serial.then(async () => {
              // Serialize replacement and removal across the filesystem await.
              if (this.pending.get(id) !== job) return;
              await unlink(join(this.directory(), `${id}.json`));
              this.pending.delete(id);
            });
            this.serial = remove.catch(() => undefined);
            await remove;
          } catch { /* Keep the durable receipt for a later accounting-only pass. */ }
        }));
      }
    })().finally(() => { this.replay = undefined; });
  }
  async dispose(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await Promise.allSettled([...this.active, ...(this.replay ? [this.replay] : [])]);
    await this.serial;
  }
  status() {
    return { pendingReceipts: this.pending.size, activeObservations: this.active.size, limit: LIMIT, replaysModels: false };
  }
}
