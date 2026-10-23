import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { connectCdpPipe, launchValidationBrowser } from '../scripts/desktop-browser.mjs';

function childProcess() {
  const child = new EventEmitter();
  Object.assign(child, { exitCode: null, signalCode: null, stdout: new PassThrough(), stderr: new PassThrough(),
    stdio: [null, null, null, new PassThrough(), new PassThrough()],
    kill() { this.exitCode = 1; this.emit('exit', 1, null); },
  });
  return child;
}

test('CDP pipe retains split UTF-8 frames and routes interleaved session events and responses', async t => {
  const child = childProcess();
  const connection = connectCdpPipe(child);
  t.after(() => connection.close());
  const events = [];
  connection.onEvent((method, params, sessionId) => events.push({ method, params, sessionId }));
  const first = connection.call('Runtime.evaluate', { expression: '1' }, { sessionId: 'page-a' });
  const request = JSON.parse(child.stdio[3].read().toString().replace(/\0$/, ''));
  assert.equal(request.sessionId, 'page-a');
  const second = connection.call('Browser.getVersion');
  const other = JSON.parse(child.stdio[3].read().toString().replace(/\0$/, ''));
  const event = Buffer.from(JSON.stringify({ method: 'Runtime.consoleAPICalled', params: { text: '界面' }, sessionId: 'page-b' }) + '\0');
  const cut = event.indexOf(Buffer.from('界')) + 1;
  child.stdio[4].write(event.subarray(0, cut));
  child.stdio[4].write(Buffer.concat([event.subarray(cut),
    Buffer.from(JSON.stringify({ id: other.id, result: { product: 'test' } }) + '\0'
      + JSON.stringify({ id: request.id, result: { value: 1 } }) + '\0')]));
  assert.deepEqual(await second, { product: 'test' });
  assert.deepEqual(await first, { value: 1 });
  assert.deepEqual(events, [{ method: 'Runtime.consoleAPICalled', params: { text: '界面' }, sessionId: 'page-b' }]);
});

test('CDP pipe reports process exit immediately and rejects future commands', async t => {
  const child = childProcess(), connection = connectCdpPipe(child);
  t.after(() => connection.close());
  const command = connection.call('Browser.getVersion');
  child.emit('exit', 7, null);
  await assert.rejects(command, /code=7/);
  await assert.rejects(connection.call('Target.createTarget'), /code=7/);
});

test('CDP pipe reports protocol errors and timeouts without leaving pending requests', async t => {
  const child = childProcess(), connection = connectCdpPipe(child);
  t.after(() => connection.close());
  const command = connection.call('Page.navigate');
  const request = JSON.parse(child.stdio[3].read().toString().replace(/\0$/, ''));
  child.stdio[4].write(JSON.stringify({ id: request.id, error: { message: 'Navigation refused' } }) + '\0');
  await assert.rejects(command, /Navigation refused/);
  await assert.rejects(connection.call('Runtime.enable', {}, { timeoutMs: 10 }), /Runtime.enable/);
  const malformed = connection.call('Runtime.evaluate');
  child.stdio[4].write('invalid-json\0');
  await assert.rejects(malformed, /Invalid Chromium CDP/);
});

test('browser startup failures preserve stderr and the exit code instead of a generic file timeout', async () => {
  const child = childProcess();
  const result = launchValidationBrowser({
    executable: 'isolated-fixture', directory: 'isolated-profile', url: 'about:blank',
    spawnProcess(_executable, args, options) {
      assert(args.includes('--remote-debugging-pipe'));
      assert(!args.some(arg => arg.startsWith('--remote-debugging-port')));
      assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe', 'pipe', 'pipe']);
      setImmediate(() => {
        child.stderr.write('Browser startup was refused');
        child.exitCode = 23;
        child.emit('exit', 23, null);
      });
      return child;
    },
  });
  await assert.rejects(result, error => {
    assert.match(error.message, /code=23/);
    assert.match(error.message, /Browser startup was refused/);
    return true;
  });
});
