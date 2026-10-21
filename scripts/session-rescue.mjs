import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// This tool never opens or edits session logs. Run through the adjacent PS1.
const [mode, packageRoot, dataRoot, sessionId, output] = process.argv.slice(2);
if (!['inspect', 'apply', 'undo'].includes(mode) || !/^session-[a-zA-Z0-9-]+$/.test(sessionId ?? '')) {
  throw new Error('Expected inspect|apply|undo, package directory, Nexus data directory, session ID, output JSON.');
}
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const marker = `// nexus-session-rescue:${sessionId}`;
const anchor = '  async compactIfNeeded(agent, trigger, signal) {';
// Pressure checks must not prevent this session from continuing. On a real
// provider overflow, delegate to the installed host's original implementation,
// including its original range selection, summarizer and durable replacement.
// Bind compactRegion explicitly: dynamic dispatch must not re-enter Nexus.
const insertion = `
    ${marker}
    if (agent.id === ${JSON.stringify(sessionId)}) {
      if (trigger === "pressure") return null;
      const original = BasicCompactionEngine.prototype;
      return original.compactIfNeeded.call({
        ctx: this.nativeContext,
        config: this.config,
        compactRegion: (...args) => original.compactRegion.apply(this, args)
      }, agent, trigger, signal);
    }
`;
const file = join(resolve(packageRoot), 'lib', 'compaction.js');
const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
if (manifest.name !== '@local/dsh-nexus' || manifest.engines?.dsh !== '0.2.1-rc.2') {
  throw new Error('This rescue tool only supports the Nexus package for Desktop 0.2.1-rc.2.');
}
const bytes = await readFile(file);
const text = bytes.toString('utf8');
if (text.split(anchor).length !== 2 || !text.includes('import { BasicCompactionEngine } from "@deepseek-ai/dsh-compaction-basic"')) {
  throw new Error('Installed compactor has a different implementation; no files were changed.');
}
const scrub = value => String(value ?? '')
  .replace(/\b(?:sk-[\w-]{16,}|eyJ[\w-]+\.[\w-]+\.[\w-]+)\b/g, '[redacted]')
  .replace(/(?:Bearer\s+)[^\s"']+/gi, 'Bearer [redacted]')
  .replace(/[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/][^\\/\s"']+/gi, '<user-home>')
  .slice(0, 1500);
const report = {
  schemaVersion: 1, sessionId, mode, generatedAt: new Date().toISOString(),
  beforeSha256: digest(bytes), installedVersion: manifest.version,
  owners: [], failedReceipts: [], databaseRead: false,
  sessionLogsRead: false, sessionLogsModified: false, databaseModified: false,
};
// Whitelist metadata, never export model inputs, outputs, credentials or the DB.
const database = join(resolve(dataRoot), 'database', 'nexus.sqlite');
let db;
try {
  db = new DatabaseSync(database, { readOnly: true });
  db.exec('PRAGMA busy_timeout=3000');
  const owners = db.prepare("SELECT revision,value FROM nexus_records WHERE collection='context.nativeOwners' AND deleted=0 AND json_extract(value,'$.sessionId')=?").all(sessionId);
  report.owners = owners.map(row => {
    const value = JSON.parse(row.value);
    return Object.fromEntries(['operationId', 'status', 'phase', 'kind', 'proposalId', 'hostCompactionId', 'errorCode', 'startedAt', 'updatedAt']
      .filter(key => value[key] !== undefined).map(key => [key, value[key]]));
  });
  const receipts = db.prepare("SELECT value FROM nexus_records WHERE collection='__nexus_operation_receipts_v1' AND deleted=0 AND instr(json_extract(value,'$.requestId'),?)=1 ORDER BY updated_at DESC LIMIT 40").all(`native:${sessionId}:`);
  report.failedReceipts = receipts.map(row => JSON.parse(row.value))
    .filter(value => value.response?.ok === false || value.state !== 'finished')
    .map(value => ({
      requestId: value.requestId, state: value.state, startedAt: value.startedAt,
      traceId: value.traceId, code: value.response?.error?.code,
      message: scrub(value.response?.error?.message),
      domainCode: value.response?.error?.details?.domainCode,
      cause: scrub(value.response?.error?.details?.cause ?? value.response?.error?.details?.domainDetails?.cause),
    }));
  report.databaseRead = true;
} catch (error) {
  report.databaseError = scrub(error.message);
} finally {
  db?.close();
}
if (mode === 'apply') {
  if (!report.databaseRead) throw new Error('Cannot inspect the lane receipt. Use -Mode inspect with the actual -NexusDataDirectory.');
  if (report.owners.some(owner => owner.status !== 'released'
      && (owner.hostCompactionId || !['preparing', 'decision-started', 'proposal-prepared'].includes(owner.phase)))) {
    await writeFile(output, JSON.stringify(report, null, 2) + '\n');
    throw new Error('A host replacement may have started. Export the inspection JSON for reconciliation; no files were changed.');
  }
  const otherRescue = text.match(/\/\/ nexus-session-rescue:([^\r\n]+)/);
  if (otherRescue && otherRescue[1] !== sessionId) throw new Error('Another session rescue is installed. Undo it before changing targets.');
  if (text.includes(marker) && !text.includes(insertion)) throw new Error('Existing rescue differs; no files were changed.');
  const next = text.includes(insertion) ? text : text.replace(anchor, anchor + insertion);
  if (next !== text) await writeFile(file, next);
  report.status = 'SESSION_RESCUE_INSTALLED';
  report.afterSha256 = digest(Buffer.from(next));
} else if (mode === 'undo') {
  if (text.includes(marker) && !text.includes(insertion)) throw new Error('Existing rescue differs; no files were changed.');
  const next = text.replace(insertion, '');
  if (next !== text) await writeFile(file, next);
  report.status = 'SESSION_RESCUE_REMOVED';
  report.afterSha256 = digest(Buffer.from(next));
} else {
  report.status = 'INSPECTION_EXPORTED';
  report.rescueInstalled = text.includes(marker);
}
await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ status: report.status, sessionId, report: output, databaseModified: false, sessionLogsModified: false }));
