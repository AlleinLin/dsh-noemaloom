import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { SqliteStore } from '../src/domain/storage/sqlite.js';

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('store call remained pending after worker death')), 2000);
    })]);
  } finally { clearTimeout(timer); }
}

for (const code of [0, 1]) test(`worker exit ${code} rejects current and future calls rather than stranding a lane`, async () => {
  const worker = new Worker(`
    const {parentPort}=require('node:worker_threads');
    parentPort.on('message', message => process.exit(${code}));
    parentPort.postMessage({ready:true});
  `, { eval: true });
  const store = new SqliteStore(worker);
  await store.ready;
  await assert.rejects(bounded(store.list('active')), /worker.*退出/);
  await assert.rejects(bounded(store.get('next', 'id')), /worker.*退出/);
  await assert.rejects(bounded(store.close()), /worker.*退出/);
});

test('a clean worker exit before ready rejects initialization', async () => {
  const worker = new Worker('process.exit(0)', { eval: true });
  const store = new SqliteStore(worker);
  await assert.rejects(bounded(store.ready), /就绪前退出/);
});

test('close owns one RPC and refuses new work while waiting for its receipt', async () => {
  const worker = new Worker(`
    const {parentPort}=require('node:worker_threads');
    parentPort.on('message', message => {
      if (message.operation !== 'close') throw new Error('work admitted after close');
      setTimeout(()=>{parentPort.postMessage({id:message.id,ok:true,result:true});parentPort.close()},30);
    });
    parentPort.postMessage({ready:true});
  `, { eval: true });
  const store = new SqliteStore(worker);
  await store.ready;
  const first = store.close();
  assert.equal(store.close(), first);
  await assert.rejects(store.put('late', 'id', {}), /正在关闭/);
  await bounded(first);
});
