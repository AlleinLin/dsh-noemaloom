import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import vm from 'node:vm';
import { existsSync } from 'node:fs';

const exec = promisify(execFile);
const script = resolve(existsSync('scripts/session-rescue.mjs') ? 'scripts/session-rescue.mjs' : 'session-rescue.mjs');
const session = 'session-rescue-fixture';
async function fixture(owner = { status: 'reconciliation-required', phase: 'decision-started' }) {
  const root = await mkdtemp(join(tmpdir(), 'nexus-rescue-test-'));
  const packageRoot = join(root, 'package'), dataRoot = join(root, 'data');
  await mkdir(join(packageRoot, 'lib'), { recursive: true });
  await mkdir(join(dataRoot, 'database'), { recursive: true });
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: '@local/dsh-nexus', version: '0.1.0', engines: { dsh: '0.2.1-rc.2' } }));
  // The fixture exercises the inserted runtime code, including dynamic dispatch.
  const source = `import { BasicCompactionEngine } from "@deepseek-ai/dsh-compaction-basic";
class Fixture extends BasicCompactionEngine {
  async compactIfNeeded(agent, trigger, signal) {
    return this.withLane(agent, "autonomous", () => "nexus");
  }
}`;
  await writeFile(join(packageRoot, 'lib/compaction.js'), source);
  const db = new DatabaseSync(join(dataRoot, 'database/nexus.sqlite'));
  db.exec('CREATE TABLE nexus_records(collection TEXT,id TEXT,revision INTEGER,value TEXT,updated_at TEXT,deleted INTEGER DEFAULT 0)');
  db.prepare('INSERT INTO nexus_records VALUES(?,?,?,?,?,0)').run('context.nativeOwners', 'owner', 1, JSON.stringify({ sessionId: session, ...owner }), '');
  db.prepare('INSERT INTO nexus_records VALUES(?,?,?,?,?,0)').run('__nexus_operation_receipts_v1', 'receipt', 1,
    JSON.stringify({ requestId: `native:${session}:native/propose:fixture`, state: 'finished', traceId: 'trace_fixture',
      response: { ok: false, data: { prompt: 'PRIVATE_CONTENT_MUST_NOT_EXPORT' }, error: { code: 'INTERNAL', message: 'failure',
        details: { domainCode: 'CTX_DECISION_INVALID', prompt: 'PRIVATE_CONTENT_MUST_NOT_EXPORT' } } } }), '');
  db.close();
  return {
    root, source, file: join(packageRoot, 'lib/compaction.js'), output: join(root, 'report.json'),
    run: mode => exec(process.execPath, [script, mode, packageRoot, dataRoot, session, join(root, 'report.json')]),
    close: () => rm(root, { recursive: true, force: true }),
  };
}
test('rescue is session scoped, preserves receipts, handles overflow through the host, and undoes exactly', async () => {
  const f = await fixture();
  try {
    await f.run('inspect');
    const reportText = await readFile(f.output, 'utf8');
    assert.equal(reportText.includes('PRIVATE_CONTENT_MUST_NOT_EXPORT'), false);
    assert.equal(JSON.parse(reportText).failedReceipts[0].domainCode, 'CTX_DECISION_INVALID');
    await f.run('apply');
    const patched = await readFile(f.file, 'utf8');
    const sandbox = { overflowCalls: 0, regionCalls: 0, nexusCalls: 0 };
    const Fixture = vm.runInNewContext(`
      class BasicCompactionEngine {
        async compactIfNeeded(agent, trigger, signal) {
          overflowCalls++;
          return this.compactRegion(1, 3, agent, signal);
        }
        async compactRegion(start, end, agent, signal) {
          regionCalls++;
          return this.regionDependencies();
        }
      }
      ${patched.replace(/^import[^\n]+\n/, '')}
      Fixture;
    `, sandbox);
    const instance = new Fixture();
    instance.nativeContext = {};
    instance.config = {};
    instance.regionDependencies = () => 'official-host-result';
    instance.withLane = () => { sandbox.nexusCalls++; return 'nexus'; };
    assert.equal(await instance.compactIfNeeded({ id: session }, 'pressure'), null);
    assert.equal(sandbox.nexusCalls, 0);
    assert.equal(await instance.compactIfNeeded({ id: session }, 'context-overflow'), 'official-host-result');
    assert.equal(sandbox.overflowCalls, 1);
    assert.equal(sandbox.regionCalls, 1);
    assert.equal(await instance.compactIfNeeded({ id: 'session-other' }, 'pressure'), 'nexus');
    await f.run('apply');
    assert.equal(await readFile(f.file, 'utf8'), patched, 'repeat apply is idempotent');
    await f.run('undo');
    assert.equal(await readFile(f.file, 'utf8'), f.source, 'undo restores exact bytes');
    const db = new DatabaseSync(join(f.root, 'data/database/nexus.sqlite'), { readOnly: true });
    assert.equal(JSON.parse(db.prepare("SELECT value FROM nexus_records WHERE collection='context.nativeOwners'").get().value).status, 'reconciliation-required');
    db.close();
  } finally { await f.close(); }
});
test('a possibly started official replacement refuses rescue without changing the package', async () => {
  const f = await fixture({ status: 'reconciliation-required', phase: 'official-started' });
  try {
    await assert.rejects(f.run('apply'), /host replacement may have started/);
    assert.equal(await readFile(f.file, 'utf8'), f.source);
  } finally { await f.close(); }
});
