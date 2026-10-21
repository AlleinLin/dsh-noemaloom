import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { FramedProtocol } from '../src/host/debug/protocol.js';

const frame = (value: any) => { const body = Buffer.from(JSON.stringify(value)); return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]); };
test('DAP framing counts UTF-8 bytes across every possible byte boundary', async () => {
  const input = new PassThrough(), output = new PassThrough(), protocol = new FramedProtocol(input, output);
  const waiting = protocol.waitFor(value => value.event === 'output');
  for (const byte of frame({ type: 'event', event: 'output', body: { output: '中😀文' } })) input.write(Buffer.from([byte]));
  assert.equal((await waiting).body.output, '中😀文'); protocol.close();
});
test('DAP response matching and reverse runInTerminal requests preserve argv arrays', async () => {
  const input = new PassThrough(), output = new PassThrough();
  const client = new FramedProtocol(input, output), server = new FramedProtocol(output, input);
  server.on('message', request => { if (request.type === 'request') server.respond(request, { echoed: request.arguments }); });
  client.on('message', request => { if (request.type === 'request') client.respond(request, { processId: 91, argv: request.arguments.args }); });
  assert.deepEqual(await client.request('scopes', { frameId: 4 }), { echoed: { frameId: 4 } });
  assert.deepEqual(await server.request('runInTerminal', { args: ['node', 'a b.js'] }), { processId: 91, argv: ['node', 'a b.js'] });
  client.close(); server.close();
});
test('LSP numeric ids use the same bounded byte protocol', async () => {
  const input = new PassThrough(), output = new PassThrough();
  const client = new FramedProtocol(input, output, 'lsp'), server = new FramedProtocol(output, input, 'lsp');
  server.on('message', request => server.respond(request, { capabilities: { executeCommandProvider: true } }));
  assert.deepEqual(await client.request('initialize'), { capabilities: { executeCommandProvider: true } });
  client.close(); server.close();
});
test('invalid lengths and malformed JSON close the protocol and reject pending requests', async () => {
  for (const bytes of [Buffer.from('Content-Length: 20000000\r\n\r\n'), Buffer.from('Content-Length: 1\r\n\r\n{'), Buffer.from(`X:${'a'.repeat(8200)}\r\nContent-Length: 2\r\n\r\n{}`)]) {
    const input = new PassThrough(), protocol = new FramedProtocol(input, new PassThrough());
    const rejected = assert.rejects(protocol.request('initialize'), /Content-Length|JSON|header|property name/i);
    input.write(bytes); await rejected; protocol.close();
  }
});
test('timeouts and the pending request budget are finite and disposal settles every waiter', async () => {
  const protocol = new FramedProtocol(new PassThrough(), new PassThrough());
  await assert.rejects(protocol.request('slow', {}, 5), /timed out/);
  const pending = Array.from({ length: 64 }, () => protocol.request('waiting').catch(error => error));
  await assert.rejects(protocol.request('over-budget'), /budget/);
  const closed = assert.rejects(protocol.waitFor(() => false), /disposed/);
  protocol.close(); await closed;
  assert((await Promise.all(pending)).every(value => value instanceof Error));
});
