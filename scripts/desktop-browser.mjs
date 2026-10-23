// Validation only. A private CDP pipe belongs to this child process; no TCP
// debugging endpoint, DevToolsActivePort file or existing browser is consulted.
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { join } from 'node:path';

export function connectCdpPipe(child, { commandTimeoutMs = 15000 } = {}) {
  const writable = child.stdio[3], readable = child.stdio[4];
  const pending = new Map(), listeners = new Set();
  const decoder = new StringDecoder('utf8');
  let sequence = 0, buffered = '', failure;
  function fail(error) {
    if (failure) return;
    failure = error;
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    pending.clear();
  }
  child.on('error', error => fail(new Error(`Chromium launch failed: ${error.message}`, { cause: error })));
  child.on('exit', (code, signal) => fail(new Error(`Chromium exited before validation completed: code=${code}, signal=${signal}`)));
  for (const stream of [readable, writable]) {
    stream.on('error', error => fail(new Error(`Chromium CDP pipe failed: ${error.message}`, { cause: error })));
    stream.on('close', () => fail(new Error('Chromium CDP pipe closed before validation completed')));
  }
  readable.on('data', bytes => {
    buffered += decoder.write(bytes);
    let boundary;
    while ((boundary = buffered.indexOf('\0')) >= 0) {
      const frame = buffered.slice(0, boundary);
      buffered = buffered.slice(boundary + 1);
      if (!frame) continue;
      let result;
      try { result = JSON.parse(frame); }
      catch (error) { fail(new Error('Invalid Chromium CDP pipe response', { cause: error })); return; }
      if (result.method) {
        for (const listener of listeners) listener(result.method, result.params, result.sessionId);
        continue;
      }
      const waiter = pending.get(result.id);
      if (!waiter) continue;
      pending.delete(result.id);
      clearTimeout(waiter.timer);
      if (result.error) waiter.reject(new Error(result.error.message));
      else waiter.resolve(result.result);
    }
  });
  return {
    onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    call(method, params = {}, { sessionId, timeoutMs = commandTimeoutMs } = {}) {
      if (failure) return Promise.reject(failure);
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Chromium CDP timed out after ${timeoutMs}ms: ${method}`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        writable.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0',
          error => { if (error) fail(error); });
      });
    },
    close() {
      fail(new Error('Chromium validation connection closed'));
      listeners.clear();
      writable.destroy();
      readable.destroy();
    },
  };
}

export async function launchValidationBrowser({
  executable, directory, url, startupTimeoutMs = 30000, spawnProcess = spawn,
}) {
  const child = spawnProcess(executable, [
    '--headless=new', '--disable-gpu', '--disable-extensions',
    '--disable-background-networking', '--disable-component-update', '--disable-sync',
    '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${join(directory, 'browser')}`, '--remote-debugging-pipe',
    '--allow-file-access-from-files', 'about:blank',
  ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'] });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', bytes => { output = (output + bytes.toString()).slice(-16000); });
  }
  const connection = connectCdpPipe(child);
  let closing;
  const close = () => closing ??= (async () => {
    const exited = child.exitCode !== null || child.signalCode !== null;
    let timer;
    const stopped = exited ? Promise.resolve() : new Promise(resolveExit => {
      child.once('exit', resolveExit);
      timer = setTimeout(() => { child.kill(); resolveExit(); }, 3000);
    });
    if (!exited) await connection.call('Browser.close', {}, { timeoutMs: 2000 }).catch(() => {});
    await stopped;
    clearTimeout(timer);
    connection.close();
  })();
  try {
    // Readiness is a protocol response, rather than the appearance of a file.
    const version = await connection.call('Browser.getVersion', {}, { timeoutMs: startupTimeoutMs });
    const { targetId } = await connection.call('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await connection.call('Target.attachToTarget', { targetId, flatten: true });
    const call = (method, params = {}) => connection.call(method, params, { sessionId });
    await call('Page.enable');
    await call('Page.navigate', { url });
    return {
      version, close,
      cdp: {
        call,
        onEvent(listener) {
          return connection.onEvent((method, params, source) => {
            if (source === sessionId) listener(method, params);
          });
        },
        async evaluate(expression) {
          const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
          if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
          return result.result.value;
        },
      },
    };
  } catch (error) {
    await close();
    throw new Error(`Isolated Chromium startup failed (${executable}): ${error.message}\nExit: code=${child.exitCode}, signal=${child.signalCode}\nBrowser output:\n${output || '(none)'}`,
      { cause: error });
  }
}
