import assert from 'node:assert/strict';
import test from 'node:test';
import { atomicReplace } from '../src/domain/storage/atomic-replace.js';

const busy = () => Object.assign(new Error('sharing violation'), { code: 'EPERM' });

test('Windows replacement retains the same paths and rechecks its lease after each sharing violation', async () => {
  const log: unknown[] = [];
  let attempts = 0;
  await atomicReplace('same-record.tmp', 'committed.json', { async assertOwned() { log.push('owned'); } }, {
    platform: 'win32',
    async rename(source, destination) { log.push([source, destination]); if (++attempts < 3) throw busy(); },
    async delay(ms) { log.push(ms); },
  });
  assert.deepEqual(log, ['owned', ['same-record.tmp', 'committed.json'], 8,
    'owned', ['same-record.tmp', 'committed.json'], 16, 'owned', ['same-record.tmp', 'committed.json']]);
});

test('replacement does not retry after lease loss, a permanent error, or exhaustion', async () => {
  const lost = Object.assign(new Error('lease lost'), { code: 'LEASE_LOST' });
  let checks = 0, attempts = 0;
  await assert.rejects(atomicReplace('temporary', 'record', { async assertOwned() { if (++checks > 1) throw lost; } }, {
    platform: 'win32', async rename() { attempts++; throw busy(); }, async delay() {},
  }), error => error === lost);
  assert.equal(attempts, 1);
  for (const [platform, code, expected] of [['linux', 'EPERM', 1], ['win32', 'ENOSPC', 1], ['win32', 'EBUSY', 9]] as const) {
    attempts = 0;
    const error = Object.assign(new Error('failure'), { code });
    await assert.rejects(atomicReplace('temporary', 'record', { async assertOwned() {} }, {
      platform, async rename() { attempts++; throw error; }, async delay() {},
    }), candidate => candidate === error);
    assert.equal(attempts, expected);
  }
});
