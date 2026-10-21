import { EventEmitter } from 'node:events';
import type { Readable, Writable } from 'node:stream';

/** DAP and LSP share byte-counted framing. No line-based JSON assumptions. */
export class FramedProtocol extends EventEmitter {
  private bytes = Buffer.alloc(0);
  private sequence = 0;
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private history: any[] = [];
  private historyBytes = 0;
  private ended?: Error;
  private onData = (chunk: Buffer) => { try { this.consume(Buffer.from(chunk)); } catch (error) { this.close(error as Error); } };
  private onEnd = () => this.close(new Error('Adapter transport closed'));
  constructor(private input: Readable, private output: Writable, private kind: 'dap' | 'lsp' = 'dap') {
    super();
    input.on('data', this.onData); input.on('end', this.onEnd); input.on('error', this.onEnd);
    output.on('error', this.onEnd);
  }
  private consume(chunk: Buffer) {
    this.bytes = Buffer.concat([this.bytes, chunk]);
    if (this.bytes.length > 20 * 1024 * 1024) throw new Error('Adapter frame exceeds 20 MiB');
    for (;;) {
      const header = this.bytes.indexOf('\r\n\r\n');
      if (header < 0) { if (this.bytes.length > 8192) throw new Error('Adapter header exceeds budget'); return; }
      if (header > 8192) throw new Error('Adapter header exceeds budget');
      const match = /^Content-Length: (\d+)$/im.exec(this.bytes.subarray(0, header).toString('ascii'));
      const length = Number(match?.[1]);
      if (!match || !Number.isSafeInteger(length) || length < 0 || length > 16 * 1024 * 1024) throw new Error('Invalid adapter Content-Length');
      if (this.bytes.length < header + 4 + length) return;
      const value = JSON.parse(this.bytes.subarray(header + 4, header + 4 + length).toString('utf8'));
      this.bytes = this.bytes.subarray(header + 4 + length);
      const response = this.kind === 'dap' ? value.type === 'response' : value.id !== undefined && !value.method;
      if (response) {
        const id = this.kind === 'dap' ? value.request_seq : value.id, pending = this.pending.get(id);
        if (pending) {
          this.pending.delete(id); clearTimeout(pending.timer);
          if (value.success === false || value.error) pending.reject(new Error(String(value.message ?? value.error?.message ?? 'Adapter request failed')));
          else pending.resolve(this.kind === 'dap' ? value.body ?? {} : value.result);
        }
      } else {
        this.history.push(value); this.historyBytes += Buffer.byteLength(JSON.stringify(value));
        while (this.history.length > 128 || this.historyBytes > 1024 * 1024) this.historyBytes -= Buffer.byteLength(JSON.stringify(this.history.shift()));
        this.emit('message', value);
      }
    }
  }
  send(value: any) {
    if (this.ended) throw this.ended;
    const body = Buffer.from(JSON.stringify(value), 'utf8');
    this.output.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
  }
  request(command: string, args: any = {}, timeoutMs = 30000): Promise<any> {
    if (this.ended) return Promise.reject(this.ended);
    if (this.pending.size >= 64) return Promise.reject(new Error('Adapter pending request budget exceeded'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${command} timed out after ${timeoutMs} ms`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send(this.kind === 'dap' ? { seq: id, type: 'request', command, arguments: args }
          : { jsonrpc: '2.0', id, method: command, params: args });
      } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error as Error); }
    });
  }
  notify(method: string, params: any) { this.send({ jsonrpc: '2.0', method, params }); }
  respond(request: any, body?: any, error?: string) {
    this.send(this.kind === 'dap'
      ? { seq: ++this.sequence, type: 'response', request_seq: request.seq, command: request.command, success: !error, body, ...(error ? { message: error } : {}) }
      : { jsonrpc: '2.0', id: request.id, ...(error ? { error: { code: -32603, message: error } } : { result: body ?? null }) });
  }
  waitFor(predicate: (message: any) => boolean, timeoutMs = 30000): Promise<any> {
    const observed = this.history.find(predicate);
    if (observed) return Promise.resolve(observed);
    if (this.ended) return Promise.reject(this.ended);
    return new Promise((resolve, reject) => {
      const finish = (error?: Error, value?: any) => { clearTimeout(timer); this.off('message', listener); this.off('closed', closed); error ? reject(error) : resolve(value); };
      const listener = (message: any) => { if (predicate(message)) finish(undefined, message); };
      const closed = (error: Error) => finish(error);
      const timer = setTimeout(() => finish(new Error('Adapter event timed out')), timeoutMs);
      this.on('message', listener); this.on('closed', closed);
    });
  }
  close(error = new Error('Adapter connection disposed')) {
    if (this.ended) return; this.ended = error;
    this.input.off('data', this.onData); this.input.off('end', this.onEnd); this.input.off('error', this.onEnd); this.output.off('error', this.onEnd);
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear(); this.history = []; this.historyBytes = 0; this.bytes = Buffer.alloc(0); this.emit('closed', error);
  }
}
