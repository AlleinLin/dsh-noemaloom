import { mkdir, writeFile, readFile, mkdtemp, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { environment } from '../tests/helpers.mjs';
import { HostFiles } from '../src/host-files.mjs';

const cleanups = [];
const env = await environment({ after: fn => cleanups.push(fn) }, { config: { cacheTtlMs: 30000 } });
const { root, ctx, execute } = env;
const rounds = 9;
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
async function measure(operation, n = rounds) {
  const times = [];
  for (let i = 0; i < n; i++) {
    const start = performance.now(); await operation(); times.push(performance.now() - start);
  }
  return { medianMs: +median(times).toFixed(3), minMs: +Math.min(...times).toFixed(3), samples: n };
}
const rows = [];
try {
  await mkdir(path.join(root, 'src'));
  const payload = 'public class Sample { string value = "search-needle"; }\n'.repeat(80);
  for (let start = 0; start < 512; start += 16) {
    await Promise.all(Array.from({ length: 16 }, (_, i) =>
      writeFile(path.join(root, 'src', `file-${start + i}.cs`), payload)));
  }
  const providerRead = async () => {
    const target = await ctx.fs.resolve('src/file-42.cs', { cwd: root });
    await ctx.fs.stat(target); return ctx.fs.readText(target);
  };
  rows.push({ name: 'provider resolve+stat+read (no plugin cache)', ...await measure(providerRead) });
  await execute('read', { file_path: 'src/file-42.cs' });
  rows.push({ name: 'Forge read, warm bounded cache', ...await measure(() => execute('read', { file_path: 'src/file-42.cs' })) });
  rows.push({ name: 'Forge read fresh=true', ...await measure(() => execute('read', { file_path: 'src/file-42.cs', fresh: true })) });
  const validating = new HostFiles(ctx, { ttlMs: 1, watch: false });
  await validating.read({ file_path: 'src/file-42.cs' }, { agent: env.agent, signal: new AbortController().signal });
  rows.push({ name: 'Forge expired read, unchanged metadata validation', ...await measure(async () => {
    for (const entry of validating.cache.values()) entry.at = -Infinity;
    return validating.read({ file_path: 'src/file-42.cs' }, { agent: env.agent, signal: new AbortController().signal });
  }) });
  validating.dispose();
  let sequence = 0;
  rows.push({ name: 'provider atomic write, 4 KiB', ...await measure(async () => {
    const target = await ctx.fs.resolve('provider-write.txt', { cwd: root });
    return ctx.fs.writeText(target, `${sequence++}\n${payload}`);
  }) });
  rows.push({ name: 'Forge atomic write, 4 KiB, same host durability', ...await measure(() =>
    execute('write', { file_path: 'forge-write.txt', content: `${sequence++}\n${payload}` })) });
  rows.push({ name: 'glob cold enumeration, 512 files', ...await measure(() => execute('glob', { pattern: '**/*.cs', fresh: true })) });
  await execute('glob', { pattern: '**/*.cs' });
  rows.push({ name: 'glob identical warm result, 512 files', ...await measure(() => execute('glob', { pattern: '**/*.cs' })) });
  rows.push({ name: 'grep fresh=true, global 20-match cap', ...await measure(() => execute('grep', { pattern: 'search-needle', limit: 20, fresh: true })) });
  await execute('grep', { pattern: 'search-needle', limit: 20 });
  rows.push({ name: 'grep identical warm query', ...await measure(() => execute('grep', { pattern: 'search-needle', limit: 20 })) });
  const coldShell = await measure(() => execute('pwsh', { command: 'Write-Output 42', session_mode: 'isolated' }), 5);
  rows.push({ name: 'pwsh official managed isolated executor', ...coldShell });
  const startup = performance.now(); await execute('pwsh', { command: 'Write-Output 42' });
  rows.push({ name: 'pwsh first resident call', medianMs: +(performance.now() - startup).toFixed(3), samples: 1 });
  rows.push({ name: 'pwsh warm resident call', ...await measure(() => execute('pwsh', { command: 'Write-Output 42' })) });
  const simulated = [];
  for (const latencyMs of [5, 20]) {
    const originals = new Map();
    for (const method of ['resolve', 'stat', 'readText', 'readBytes']) {
      originals.set(method, ctx.fs[method]);
      ctx.fs[method] = async function (...args) { await delay(latencyMs); return originals.get(method).apply(this, args); };
    }
    try {
      await execute('forge_status', { clear_cache: true });
      const baseline = await measure(providerRead, 5);
      await execute('read', { file_path: 'src/file-42.cs' });
      const warm = await measure(() => execute('read', { file_path: 'src/file-42.cs' }), 5);
      simulated.push({ injectedDelayPerProviderCallMs: latencyMs, callsDelayed: ['resolve', 'stat', 'readText', 'readBytes'],
        baseline, warmCache: warm, medianRatio: +(baseline.medianMs / Math.max(.001, warm.medianMs)).toFixed(1) });
    } finally { for (const [key, value] of originals) ctx.fs[key] = value; }
  }
  const report = {
    measuredAt: new Date().toISOString(), platform: process.platform, arch: process.arch,
    os: `${os.type()} ${os.release()}`, node: process.version, cpus: os.availableParallelism(),
    fixture: { files: 512, bytesPerFile: Buffer.byteLength(payload), ignored: 'none' },
    methodology: 'Single process, sequential medians; no cold OS cache flushing. Warm tests use watch=false and TTL=30000 ms. Fresh glob can include ripgrep enumeration and a separate Node glob-filter process; fresh grep uses ripgrep. Shell uses actual rc.2 subprocess and PowerShell executors. Simulated delays cover provider resolve/stat/readText/readBytes calls: the baseline uses readText and Forge uses bounded readBytes. Delays do not model individual Windows I/O/filter callbacks.',
    limitations: 'This development machine is not the company work machine. Does not measure WMI/minifilter counts or prove any end-to-end speedup there. Shell resident path requires danger-full-access. Cold and unique searches still read disk.',
    results: rows, simulated, counters: await execute('forge_status', {}),
  };
  await mkdir('docs', { recursive: true });
  await writeFile('docs/benchmark.json', JSON.stringify(report, null, 2) + '\n');
  const table = rows.map(row => `| ${row.name} | ${row.medianMs} | ${row.samples} |`).join('\n');
  await writeFile('docs/BENCHMARK.md', `# 可复现基准\n\n环境：${report.os} / ${report.arch} / Node ${report.node}，采样时间 ${report.measuredAt}。\n\n${report.methodology}\n\n| 操作 | 中位数 ms | 次数 |\n|---|---:|---:|\n${table}\n\n## 高延迟敏感性实验\n\n${simulated.map(row => `- 每次 provider resolve/stat/readText/readBytes 人为增加 ${row.injectedDelayPerProviderCallMs}ms：基线 readText ${row.baseline.medianMs}ms，Forge 有界 readBytes 路径的热缓存 ${row.warmCache.medianMs}ms。`).join('\n')}\n\n这只是可控延迟实验，不是公司机器、WMI 或安全过滤器的实测。缓存命中减少的是调用次数；首次读取、唯一查询和写入仍要经过系统过滤器。Shell 常驻只在完整访问模式启用。TTL=30000、watch=false 是本次热缓存测量配置，交付默认 TTL=1000、watch=true。\n\n运行：\`npm run benchmark\`。完整记录见 benchmark.json。\n`);
  console.log(JSON.stringify(report, null, 2));
} finally { for (const cleanup of cleanups.reverse()) await cleanup(); }
