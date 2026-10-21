import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NexusError, type NexusServices } from '../../../ports/contracts.js';
import { sha256 } from '../../../domain/quality/shared.js';

export const ARCHIFY_TYPES = ['architecture', 'workflow', 'sequence', 'dataflow', 'lifecycle', 'erd', 'class', 'tree', 'timeline', 'waterfall'] as const;
export async function findAssetsRoot(services?: NexusServices): Promise<string> {
  if (services?.packageRoot) {
    const directory = path.join(services.packageRoot, 'assets');
    if (await fs.stat(path.join(directory, 'methods')).then(stat => stat.isDirectory(), () => false)) return directory;
  }
  for (const candidate of [new URL('../../../../assets/', import.meta.url), new URL('../assets/', import.meta.url), new URL('../../assets/', import.meta.url)]) {
    const directory = fileURLToPath(candidate);
    if (await fs.stat(path.join(directory, 'methods')).then(stat => stat.isDirectory(), () => false)) return directory;
  }
  throw new NexusError('NOT_FOUND', '插件方法与绘图资产目录不存在');
}

export async function renderArchify(services: NexusServices, directory: string, diagramType: string, ir: Record<string, unknown>, signal?: AbortSignal): Promise<{ html: string; receipt: Record<string, unknown> }> {
  if (!(ARCHIFY_TYPES as readonly string[]).includes(diagramType)) throw new NexusError('IR_INVALID', '未知 Archify 图类型');
  const assetRoot = await findAssetsRoot(services);
  const source = structuredClone(ir);
  const meta = source.meta && typeof source.meta === 'object' ? source.meta as Record<string, unknown> : {};
  if (meta.output !== undefined) delete meta.output;
  // The adapter owns all filesystem outputs and never enables repository/evidence auto-reading.
  if (JSON.stringify(source).length > 4 * 1024 * 1024) throw new NexusError('BUDGET_EXHAUSTED', '图表 IR 超过预算');
  const prohibited = (value: unknown): void => {
    if (typeof value === 'string' && (/<(?:script|iframe|foreignObject)\b/i.test(value) || /(?:javascript:|file:\/\/|https?:\/\/)/i.test(value))) throw new NexusError('PREVIEW_DENIED', '图表数据不得包含脚本或外部资源地址');
    if (value && typeof value === 'object') for (const [key, entry] of Object.entries(value)) {
      if (['__proto__', 'constructor', 'prototype', 'brandMark', 'brandMarks', 'sourcePath', 'repositoryEvidence'].includes(key)) throw new NexusError('PREVIEW_DENIED', '图表数据包含外部读取/未授权品牌资源字段', { key });
      prohibited(entry);
    }
  };
  prohibited(source);
  await fs.mkdir(directory, { recursive: true });
  const input = path.join(directory, 'input.json');
  const output = path.join(directory, 'rendered.html');
  await fs.writeFile(input, JSON.stringify(source, null, 2), { flag: 'wx' });
  const renderer = path.join(assetRoot, 'diagrams/archify/renderers', diagramType, `render-${diagramType}.mjs`);
  const result = await services.executor.run(process.execPath, [renderer, input, output], { cwd: directory, signal, timeoutMs: 120000, maxOutputBytes: 1024 * 1024, env: { ARCHIFY_REPO_ROOT: '', ARCHIFY_DIAGNOSTIC_FORMAT: 'json' } });
  if (result.cancelled) throw new NexusError('CANCELLED', '图表渲染已取消');
  if (result.exitCode !== 0 || result.truncated) throw new NexusError('LAYOUT_INVALID', 'Archify 确定性 schema/布局/渲染未通过', { exitCode: result.exitCode, diagnostic: result.stderr.slice(0, 16384), sourcePreserved: true });
  const html = await fs.readFile(output, 'utf8');
  if (Buffer.byteLength(html) > 16 * 1024 * 1024) throw new NexusError('BUDGET_EXHAUSTED', '图表输出超限');
  if (/<(?:iframe|object|embed|foreignObject)\b|(?:src|href)\s*=\s*["'](?:https?:|file:|\/\/)/i.test(html)) throw new NexusError('PREVIEW_DENIED', '渲染结果包含外部或宿主访问资源');
  return { html, receipt: { renderer: 'Archify', diagramType, inputHash: sha256(source), outputHash: sha256(html), executable: process.execPath, rendererPath: renderer, exitCode: result.exitCode, durationMs: result.durationMs, schema: 'passed', layout: 'passed', browserVisualReview: 'not_run', sandbox: 'allow-scripts (without allow-same-origin)', sourceNotice: 'assets/diagrams/archify/LICENSE' } };
}
