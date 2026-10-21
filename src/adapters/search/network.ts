import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { isIP } from 'node:net';
import { gunzipSync, inflateSync, brotliDecompressSync } from 'node:zlib';
import { NexusError } from '../../ports/contracts.js';
import { isPrivateAddress } from '../models/accounts/accounts.js';

const MAX_BYTES = 2 * 1024 * 1024;
export interface NetworkGrant { origin: string; addresses: string[]; }
export async function publicUrl(input: string, grant?: NetworkGrant) {
  if (/[\x00-\x20\x7f]/.test(input) || /%(?![0-9a-f]{2})/i.test(input)) throw new NexusError('INVALID_ARGUMENT', 'URL 包含无效编码或控制字符');
  let url: URL;
  try { url = new URL(input); } catch { throw new NexusError('INVALID_ARGUMENT', '无效 URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new NexusError('PERMISSION_DENIED', '仅允许无认证信息的 HTTP(S) URL');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true, verbatim: true });
  const explicitlyGranted = grant?.origin === url.origin && addresses.length > 0 && addresses.every(entry => grant.addresses.includes(entry.address));
  if (!explicitlyGranted && (host === 'localhost' || host.endsWith('.localhost') || isPrivateAddress(host) || !addresses.length || addresses.some(entry => isPrivateAddress(entry.address)))) throw new NexusError('PERMISSION_DENIED', 'DNS 包含内部或特殊地址');
  return { url, address: addresses[0]! };
}

/** DNS is checked once and its approved address is pinned into this request. */
export async function safeRequest(input: string, options: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal; timeoutMs?: number; maxRedirects?: number; maxBytes?: number; networkGrant?: NetworkGrant } = {}): Promise<{ body: string; bytes: Buffer; headers: IncomingHttpHeaders; url: string }> {
  const target = await publicUrl(input, options.networkGrant);
  const maxBytes = options.maxBytes ?? MAX_BYTES;
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 200 * 1024 * 1024) throw new NexusError('INVALID_ARGUMENT', '网络响应预算无效');
  options.signal?.throwIfAborted();
  const response = await new Promise<{ body: Buffer; headers: IncomingHttpHeaders; status: number }>((resolve, reject) => {
    const transport = target.url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = transport(target.url, {
      method: options.method ?? 'GET', headers: { accept: 'application/json,text/plain,text/html', 'accept-encoding': 'gzip,deflate,br', ...options.headers },
      signal: options.signal, timeout: options.timeoutMs ?? 15000,
      lookup: (_host, _opts, callback) => callback(null, target.address.address, target.address.family),
    }, res => {
      const parts: Buffer[] = []; let size = 0;
      res.on('data', (chunk: Buffer) => { size += chunk.length; if (size > maxBytes) { req.destroy(new NexusError('RESOURCE_LIMIT', '网络压缩响应超过预算')); return; } parts.push(chunk); });
      res.on('error', reject);
      res.on('end', () => {
        try {
          const compressed = Buffer.concat(parts), encoding = res.headers['content-encoding'];
          const body = encoding === 'gzip' ? gunzipSync(compressed, { maxOutputLength: maxBytes }) : encoding === 'deflate' ? inflateSync(compressed, { maxOutputLength: maxBytes }) : encoding === 'br' ? brotliDecompressSync(compressed, { maxOutputLength: maxBytes }) : compressed;
          if (body.length > maxBytes) throw new NexusError('RESOURCE_LIMIT', '网络展开响应超过预算');
          resolve({ body, headers: res.headers, status: res.statusCode ?? 0 });
        } catch (error) { reject(error); }
      });
    });
    req.on('timeout', () => req.destroy(new NexusError('TIMEOUT', '网络请求超时')));
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
  if (response.status >= 300 && response.status < 400 && response.headers.location) {
    const redirects = options.maxRedirects ?? 3;
    if (redirects <= 0) throw new NexusError('NETWORK_ERROR', '重定向超过上限');
    const next = new URL(response.headers.location, target.url);
    const headers = { ...options.headers };
    if (next.origin !== target.url.origin) for (const key of Object.keys(headers)) if (/authorization|cookie|api-key|x-api-key/i.test(key)) delete headers[key];
    return safeRequest(next.href, { ...options, headers, maxRedirects: redirects - 1 });
  }
  if (response.status < 200 || response.status >= 300) throw new NexusError(response.status === 401 || response.status === 403 ? 'AUTH_REQUIRED' : response.status === 429 ? 'RATE_LIMITED' : 'NETWORK_ERROR', `远端返回 HTTP ${response.status}`, { status: response.status, retryAfter: response.headers['retry-after'] });
  return { body: response.body.toString('utf8'), bytes: response.body, headers: response.headers, url: target.url.href };
}
