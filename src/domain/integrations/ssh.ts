import { Client, type ConnectConfig, type SFTPWrapper, type VerifyCallback } from 'ssh2';
import { createServer, type Server, type Socket } from 'node:net';
import { readFile, readdir, realpath, stat, link, unlink } from 'node:fs/promises';
import { dirname, resolve, join, isAbsolute, relative } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { NexusError, requiredString, type NexusServices, type JsonRecord, type DispatchContext } from '../../ports/contracts.js';
import { workspacePath, sha256 } from '../files/paths.js';

export interface SshHost extends JsonRecord { id: string; hostname: string; port?: number; username: string; credentialRef?: string; hostKeyFingerprint?: string; proxyJump?: string[]; forwardAgent?: boolean; }
interface Pooled { client: Client; signature: string; closed: boolean; }
const object = (input: unknown): JsonRecord => input && typeof input === 'object' && !Array.isArray(input) ? input as JsonRecord : {};

export function createSshService(services: NexusServices) {
  const pool = new Map<string, Pooled>(), inflight = new Map<string, Promise<Client>>(), forwards = new Map<string, { server: Server; sockets: Set<Socket>; hostId: string; port: number }>();
  async function config(id: string) { const row = await services.store.get<SshHost>('connections', id); if (!row || row.value.type !== 'ssh') throw new NexusError('NOT_FOUND', 'SSH 主机不存在'); return row.value; }
  async function connect(id: string, context?: DispatchContext, chain: string[] = [], inheritedJumps?: string[]): Promise<Client> {
    if (chain.includes(id) || chain.length > 5) throw new NexusError('INVALID_ARGUMENT', 'SSH ProxyJump 循环或超过5跳');
    const host = await config(id), jumpIds = inheritedJumps ?? (Array.isArray(host.proxyJump) ? host.proxyJump : []), signature = sha256(JSON.stringify({ host, jumpIds })), existing = pool.get(id);
    if (existing && !existing.closed && existing.signature === signature) return existing.client;
    if (existing) existing.client.end();
    const pending = inflight.get(id); if (pending) return pending;
    const connecting = (async () => {
      const secret = host.credentialRef ? await services.host.secret(host.credentialRef) : undefined;
      let credentials: JsonRecord = {};
      if (secret) { try { credentials = object(JSON.parse(secret)); } catch { credentials = secret.includes('PRIVATE KEY') ? { privateKey: secret } : { password: secret }; } }
      if (!credentials.privateKey && !credentials.password && !credentials.agent) throw new NexusError('AUTH_REQUIRED', 'SSH 认证引用未配置', { credentialRef: host.credentialRef });
      const client = new Client();
      const options: ConnectConfig = {
        host: host.hostname, port: host.port ?? 22, username: host.username, readyTimeout: 15000,
        keepaliveInterval: 10000, keepaliveCountMax: 3, hostHash: 'sha256',
        hostVerifier: (fingerprint: string | Buffer, callback: VerifyCallback) => {
          const normalized = (typeof fingerprint === 'string' ? fingerprint : sha256(fingerprint)).replace(/^SHA256:/, '').toLowerCase();
          if (host.hostKeyFingerprint) { callback(normalized === host.hostKeyFingerprint.replace(/^SHA256:/, '').toLowerCase()); return; }
          void services.host.approve('connections.ssh.host-key', host.hostname, { hostId: id, fingerprint: normalized, sessionId: context?.sessionId }).then(async accepted => {
            if (accepted) { const current = await services.store.get<SshHost>('connections', id); if (current) await services.store.put('connections', id, { ...current.value, hostKeyFingerprint: normalized }, current.revision); }
            callback(accepted);
          }).catch(() => callback(false));
        },
        ...(typeof credentials.privateKey === 'string' ? { privateKey: credentials.privateKey } : {}),
        ...(typeof credentials.password === 'string' ? { password: credentials.password } : {}),
        ...(typeof credentials.passphrase === 'string' ? { passphrase: credentials.passphrase } : {}),
        ...(typeof credentials.agent === 'string' ? { agent: credentials.agent, agentForward: host.forwardAgent === true } : {}),
      };
      if (jumpIds.length) {
        const proxyId = jumpIds.at(-1)!;
        const jump = await connect(proxyId, context, [...chain, id], jumpIds.slice(0, -1));
        options.sock = await new Promise<Socket>((resolveSocket, reject) => jump.forwardOut('127.0.0.1', 0, host.hostname, host.port ?? 22, (error, stream) => error ? reject(error) : resolveSocket(stream as unknown as Socket)));
      }
      await new Promise<void>((resolveReady, reject) => { client.once('ready', resolveReady); client.once('error', reject); client.connect(options); });
      const entry = { client, signature, closed: false }; pool.set(id, entry);
      client.once('close', () => { entry.closed = true; services.emit('connections.ssh.closed', { id }); });
      if (context?.signal) context.signal.addEventListener('abort', () => { client.end(); entry.closed = true; }, { once: true });
      services.emit('connections.ssh.connected', { id, hostname: host.hostname });
      return client;
    })().finally(() => inflight.delete(id));
    inflight.set(id, connecting); return connecting;
  }
  async function sftp(client: Client): Promise<SFTPWrapper> { return new Promise((resolveSftp, reject) => client.sftp((error, value) => error ? reject(error) : resolveSftp(value))); }
  async function execute(id: string, command: string, params: JsonRecord, context?: DispatchContext) {
    if (command.includes('\0') || command.length > 65536) throw new NexusError('INVALID_ARGUMENT', 'SSH命令无效');
    if (!await services.host.approve('connections.ssh.exec', id, { command, sessionId: context?.sessionId })) throw new NexusError('PERMISSION_DENIED', 'SSH执行未获批准');
    const client = await connect(id, context), started = Date.now(), cap = Number(params.maxOutputBytes ?? 1024 * 1024), timeoutMs = Number(params.timeoutMs ?? 60000);
    if (!Number.isSafeInteger(cap) || cap < 1 || cap > 8 * 1024 * 1024 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000) throw new NexusError('INVALID_ARGUMENT', 'SSH 超时或输出预算无效');
    return new Promise<JsonRecord>((resolveExecution, reject) => {
      client.exec(command, (error, stream) => {
        if (error) { reject(new NexusError('SSH_EXEC_FAILED', 'SSH命令启动失败')); return; }
        let stdout = '', stderr = '', bytes = 0, truncated = false, cancelled = false;
        const append = (chunk: Buffer, kind: 'stdout' | 'stderr') => {
          const remaining = Math.max(0, cap - bytes), kept = chunk.subarray(0, remaining).toString('utf8'); bytes += chunk.length;
          if (kind === 'stdout') stdout += kept; else stderr += kept;
          if (bytes > cap) truncated = true;
          services.emit('connections.ssh.output', { hostId: id, sessionId: context?.sessionId, stream: kind, bytes: Buffer.byteLength(kept), truncated });
        };
        stream.on('data', (chunk: Buffer) => append(chunk, 'stdout')); stream.stderr.on('data', (chunk: Buffer) => append(chunk, 'stderr'));
        const cancel = () => { cancelled = true; stream.signal('TERM'); stream.close(); };
        const timer = setTimeout(cancel, timeoutMs); context?.signal?.addEventListener('abort', cancel, { once: true });
        stream.on('close', (exitCode: number | null, signal: string) => { clearTimeout(timer); context?.signal?.removeEventListener('abort', cancel); resolveExecution({ hostId: id, exitCode, signal, stdout, stderr, truncated, cancelled, durationMs: Date.now() - started }); });
        stream.on('error', reject);
        if (typeof params.stdin === 'string') stream.end(params.stdin);
      });
    });
  }
  return {
    connect,
    async dispatch(action: string, params: JsonRecord, context?: DispatchContext): Promise<unknown> {
      const id = typeof params.id === 'string' ? params.id : '';
      switch (action) {
        case 'connect': await connect(requiredString(params, 'id'), context); return { id, connected: true };
        case 'disconnect': await this.invalidate(id); return { id, connected: false };
        case 'exec': return execute(requiredString(params, 'id'), requiredString(params, 'command'), params, context);
        case 'test': { const client = await connect(requiredString(params, 'id'), context); return { id, connected: Boolean(client), authenticated: true, observedAt: new Date().toISOString() }; }
        case 'sftp': {
          const hostId = requiredString(params, 'id'), client = await connect(hostId, context), channel = await sftp(client), remotePath = requiredString(params, 'remotePath');
          if (/[\0\r\n]/.test(remotePath)) throw new NexusError('INVALID_ARGUMENT', '远端路径无效');
          try {
            if (params.operation === 'list') return { items: await new Promise((resolveItems, reject) => channel.readdir(remotePath, (error, list) => error ? reject(error) : resolveItems(list))) };
            if (!['upload', 'download', 'mkdir', 'remove', 'rename', 'stat'].includes(String(params.operation))) throw new NexusError('INVALID_ARGUMENT', 'SFTP operation 无效');
            if (params.operation === 'stat') return new Promise((resolveStat, reject) => channel.stat(remotePath, (error, info) => error ? reject(error) : resolveStat(info)));
            if (!await services.host.approve(`connections.ssh.sftp.${params.operation}`, hostId, { remotePath, localPath: params.localPath, sessionId: context?.sessionId })) throw new NexusError('PERMISSION_DENIED', 'SFTP操作未获批准');
            if (params.operation === 'mkdir') { await new Promise<void>((done, reject) => channel.mkdir(remotePath, error => error ? reject(error) : done())); return { effect: 'committed' }; }
            if (params.operation === 'remove') { await new Promise<void>((done, reject) => channel.unlink(remotePath, error => error ? reject(error) : done())); return { effect: 'committed' }; }
            if (params.operation === 'rename') { await new Promise<void>((done, reject) => channel.rename(remotePath, requiredString(params, 'destination'), error => error ? reject(error) : done())); return { effect: 'committed' }; }
            const localPath = await workspacePath(context?.workspaceRoot ?? services.workspaceRoot, params.localPath, params.operation === 'download');
            if (params.operation === 'download') { try { await stat(localPath); throw new NexusError('REVISION_CONFLICT', '下载目标已存在，请另选文件名'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
            const remoteInfo = await new Promise<{ size: number } | undefined>((done, reject) => channel.stat(remotePath, (error, info) => error ? ((error as {code?: number}).code === 2 ? done(undefined) : reject(error)) : done(info)));
            if (params.operation === 'upload' && remoteInfo && params.overwrite !== true) throw new NexusError('REVISION_CONFLICT', '远端目标已存在；默认不覆盖');
            if (params.operation === 'download' && (!remoteInfo || remoteInfo.size > 128 * 1024 * 1024)) throw new NexusError('RESOURCE_LIMIT', '下载文件不存在或超过128MiB预算');
            if (params.operation === 'upload' && (await stat(localPath)).size > 128 * 1024 * 1024) throw new NexusError('RESOURCE_LIMIT', '上传文件超过128MiB预算');
            const transferId = randomUUID();
            const temporary = `${localPath}.nexus-transfer-${transferId}.tmp`;
            try {
              await new Promise<void>((done, reject) => {
                const options = { concurrency: 8, chunkSize: 32768, step: (transferred: number, chunk: number, total: number) => services.emit('connections.sftp.progress', { transferId, hostId, transferred, total }) };
                const callback = (error?: Error | null) => error ? reject(new NexusError('SSH_TRANSFER_FAILED', 'SFTP传输失败')) : done();
                if (params.operation === 'upload') channel.fastPut(localPath, remotePath, options, callback);
                else channel.fastGet(remotePath, temporary, options, callback);
              });
              if (params.operation === 'download') { await link(temporary, localPath); await unlink(temporary); }
            } finally { if (params.operation === 'download') await unlink(temporary).catch(() => undefined); }
            return { transferId, hostId, remotePath, effect: 'committed' };
          } finally { channel.end(); }
        }
        case 'forward.start': {
          const hostId = requiredString(params, 'id'), destinationHost = requiredString(params, 'destinationHost'), destinationPort = Number(params.destinationPort), localPort = Number(params.localPort ?? 0);
          if (![destinationPort, localPort].every(port => Number.isInteger(port) && port >= 0 && port <= 65535) || destinationPort === 0) throw new NexusError('INVALID_ARGUMENT', '转发端口无效');
          if (!await services.host.approve('connections.ssh.forward', hostId, { destinationHost, destinationPort, localPort, listenAddress: '127.0.0.1', sessionId: context?.sessionId })) throw new NexusError('PERMISSION_DENIED', '端口转发未获批准');
          const client = await connect(hostId, context), sockets = new Set<Socket>();
          const server = createServer(socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); client.forwardOut('127.0.0.1', socket.remotePort ?? 0, destinationHost, destinationPort, (error, stream) => { if (error) { socket.destroy(); return; } socket.pipe(stream).pipe(socket); stream.on('error', () => socket.destroy()); socket.on('error', () => stream.close()); }); });
          await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(localPort, '127.0.0.1', done); });
          const address = server.address(), forwardId = randomUUID(), port = typeof address === 'object' && address ? address.port : localPort;
          forwards.set(forwardId, { server, sockets, hostId, port }); return { forwardId, hostId, listenAddress: '127.0.0.1', localPort: port, destinationHost, destinationPort };
        }
        case 'forward.list': return { items: [...forwards].map(([forwardId, value]) => ({ forwardId, hostId: value.hostId, localPort: value.port, connections: value.sockets.size })) };
        case 'forward.stop': { const forwardId = requiredString(params, 'forwardId'), value = forwards.get(forwardId); if (value) { for (const socket of value.sockets) socket.destroy(); value.server.close(); forwards.delete(forwardId); } return { forwardId, stopped: Boolean(value) }; }
        case 'cluster': {
          const ids = Array.isArray(params.ids) ? params.ids.filter(value => typeof value === 'string') as string[] : [];
          if (!ids.length || ids.length > 128) throw new NexusError('INVALID_ARGUMENT', 'cluster ids 须为1–128台');
          const concurrency = Number(params.concurrency ?? 8);
          if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new NexusError('INVALID_ARGUMENT', 'cluster concurrency 须为1–32');
          const command = requiredString(params, 'command'), items: unknown[] = new Array(ids.length); let cursor = 0;
          await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, async () => { for (;;) { const index = cursor++; if (index >= ids.length) return; try { items[index] = { id: ids[index], result: await execute(ids[index]!, command, params, context) }; } catch (error) { items[index] = { id: ids[index], error: { code: error instanceof NexusError ? error.code : 'SSH_FAILED' } }; } } }));
          return { items, concurrency };
        }
        default: throw new NexusError('ACTION_NOT_FOUND', `未知 SSH 操作: ${action}`);
      }
    },
    async invalidate(id: string) { const entry = pool.get(id); entry?.client.end(); pool.delete(id); for (const [forwardId, value] of forwards) if (value.hostId === id) { for (const socket of value.sockets) socket.destroy(); value.server.close(); forwards.delete(forwardId); } },
    async dispose() { for (const id of pool.keys()) await this.invalidate(id); },
  };
}

/** Import is explicit, bounded and produces a preview; secrets never enter it. */
export async function importSshConfig(path: string): Promise<{ hosts: JsonRecord[]; skipped: JsonRecord[]; files: string[] }> {
  const visited = new Set<string>(), hosts: JsonRecord[] = [], skipped: JsonRecord[] = [], base = dirname(path);
  async function expand(spec: string): Promise<string[]> {
    const full = spec === '~' ? homedir() : spec.startsWith('~/') ? join(homedir(), spec.slice(2)) : isAbsolute(spec) ? spec : resolve(base, spec);
    if (!/[*?]/.test(full)) return [full];
    const directory = dirname(full), pattern = new RegExp(`^${full.slice(directory.length + 1).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
    return (await readdir(directory).catch(() => [])).filter(name => pattern.test(name)).sort().map(name => join(directory, name));
  }
  async function lines(file: string, depth: number): Promise<string[]> {
    if (depth > 16) { skipped.push({ path: file, reason: 'include-depth' }); return []; }
    let key: string; try { key = await realpath(file); } catch { skipped.push({ path: file, reason: 'not-found' }); return []; }
    if (visited.has(key)) return [];
    visited.add(key); const info = await stat(key); if (info.size > 1024 * 1024) throw new NexusError('RESOURCE_LIMIT', 'SSH配置文件超过1MiB');
    const result: string[] = [];
    for (const line of (await readFile(key, 'utf8')).split(/\r?\n/)) {
      const match = /^\s*Include\s+(.+)$/i.exec(line);
      if (!match) { result.push(line); continue; }
      for (const value of match[1]!.match(/"[^"]+"|'[^']+'|\S+/g) ?? []) for (const included of await expand(value.replace(/^['"]|['"]$/g, ''))) result.push(...await lines(included, depth + 1));
    }
    return result;
  }
  let active: JsonRecord[] = [];
  for (const line of await lines(path, 0)) {
    const match = /^\s*([A-Za-z0-9_-]+)\s+(.+?)\s*$/.exec(line); if (!match || line.trimStart().startsWith('#')) continue;
    const name = match[1]!.toLowerCase(), value = match[2]!;
    if (name === 'host') { const patterns = value.split(/\s+/); active = []; for (const pattern of patterns) { if (/[*?!]/.test(pattern)) { skipped.push({ name: pattern, reason: 'wildcard' }); continue; } const item = { id: `ssh-${sha256(pattern).slice(0, 16)}`, type: 'ssh', name: pattern, hostname: pattern, username: '', port: 22, forwardAgent: false }; active.push(item); hosts.push(item); } continue; }
    if (name === 'match') { skipped.push({ name: value, reason: 'conditional-match' }); active = []; continue; }
    for (const item of active) {
      if (name === 'hostname') item.hostname = value;
      else if (name === 'user') item.username = value;
      else if (name === 'port') item.port = Number(value);
      else if (name === 'identityfile') item.identityFile = value;
      else if (name === 'proxyjump') item.proxyJumpAliases = value.split(',');
      else if (name === 'proxycommand') item.proxyCommand = value;
      else if (name === 'forwardagent') item.forwardAgent = value.toLowerCase() === 'yes';
    }
  }
  for (const item of hosts) if (Array.isArray(item.proxyJumpAliases)) item.proxyJump = item.proxyJumpAliases.map(alias => hosts.find(candidate => candidate.name === alias)?.id ?? `ssh-${sha256(String(alias)).slice(0, 16)}`);
  return { hosts, skipped, files: [...visited] };
}
