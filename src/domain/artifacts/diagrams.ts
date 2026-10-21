import { NexusError } from '../../ports/contracts.js';
import { XMLValidator } from 'fast-xml-parser';
import { object, number } from '../quality/shared.js';

export const SVG_TYPES = ['context', 'use-case', 'flow', 'state', 'sequence', 'ER', 'components', 'wireframe'] as const;
export interface DiagramNode { id: string; label: string; x?: number; y?: number; kind?: string; width?: number; height?: number; fields?: string[] }
export interface DiagramEdge { id?: string; from: string; to: string; label?: string; kind?: string }
export interface DiagramIR { type: string; title: string; description?: string; nodes: DiagramNode[]; edges: DiagramEdge[]; width?: number; height?: number; theme?: string }
export const esc = (text: unknown): string => String(text ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');

export function validateDiagram(value: unknown): DiagramIR {
  const ir = object(value);
  if (!(SVG_TYPES as readonly string[]).includes(String(ir.type))) throw new NexusError('IR_INVALID', '未知 SVG 图类型');
  if (typeof ir.title !== 'string' || !ir.title.trim() || ir.title.length > 512 || !Array.isArray(ir.nodes) || !Array.isArray(ir.edges)) throw new NexusError('IR_INVALID', '图表缺少 title/nodes/edges');
  if (ir.nodes.length > 500 || ir.edges.length > 2000) throw new NexusError('BUDGET_EXHAUSTED', '图表节点或边超限');
  const ids = new Set<string>();
  for (const entry of ir.nodes) {
    const node = object(entry);
    if (typeof node.id !== 'string' || !/^[\w.-]{1,128}$/.test(node.id) || ids.has(node.id) || typeof node.label !== 'string' || !node.label.trim() || node.label.length > 512) throw new NexusError('IR_INVALID', '节点 ID 必须唯一且具有受限标签');
    ids.add(node.id);
    if (node.x !== undefined) number(node.x, 0, 0, 20000);
    if (node.y !== undefined) number(node.y, 0, 0, 20000);
    if (node.fields !== undefined && (!Array.isArray(node.fields) || node.fields.some(field => typeof field !== 'string' || field.length > 256))) throw new NexusError('IR_INVALID', '实体 fields 无效');
  }
  for (const entry of ir.edges) {
    const edge = object(entry);
    if (!ids.has(String(edge.from)) || !ids.has(String(edge.to)) || (edge.label !== undefined && (typeof edge.label !== 'string' || edge.label.length > 512))) throw new NexusError('IR_INVALID', '边端点不存在或标签无效');
  }
  return ir as unknown as DiagramIR;
}

/** Original equivalent implementation; unverified qiudeng SVG submodule assets are deliberately not redistributed. */
export function renderSvg(value: unknown, theme = 'light'): string {
  const ir = validateDiagram(value);
  const sequence = ir.type === 'sequence';
  const columns = Math.min(sequence ? 8 : 4, Math.max(1, ir.nodes.length));
  const width = number(ir.width, Math.max(640, columns * 250 + 80), 320, 20000);
  const height = number(ir.height, sequence ? Math.max(420, 170 + ir.edges.length * 65) : Math.max(340, Math.ceil(ir.nodes.length / columns) * 170 + 130), 240, 20000);
  const dark = theme === 'dark';
  const paint = { background: dark ? '#20201f' : '#faf9f6', card: dark ? '#30302e' : '#ffffff', text: dark ? '#eeede8' : '#242422', muted: dark ? '#a4a49a' : '#65655d', line: dark ? '#a9a99a' : '#73736a', accent: dark ? '#dfac8a' : '#9c5f3f' };
  const nodes = ir.nodes.map((node, index) => ({ ...node, x: node.x ?? (40 + (index % columns) * ((width - 80) / columns)), y: node.y ?? (95 + Math.floor(index / columns) * 170), width: node.width ?? 195, height: node.height ?? 80 }));
  const byId = new Map(nodes.map(node => [node.id, node]));
  const pieces = [`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="diagram-title diagram-desc"><title id="diagram-title">${esc(ir.title)}</title><desc id="diagram-desc">${esc(ir.description ?? `${ir.type} diagram; editable source is stored separately`)}</desc><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="${paint.line}"/></marker></defs><rect width="${width}" height="${height}" fill="${paint.background}"/><text x="32" y="44" fill="${paint.text}" font-family="system-ui,'Microsoft YaHei','Noto Sans CJK SC',sans-serif" font-size="22" font-weight="600">${esc(ir.title)}</text>`];
  for (const [index, edge] of ir.edges.entries()) {
    const from = byId.get(edge.from)!;
    const to = byId.get(edge.to)!;
    const x1 = from.x + from.width / 2;
    const x2 = to.x + to.width / 2;
    const y1 = sequence ? 180 + index * 65 : from.y + from.height / 2;
    const y2 = sequence ? y1 : to.y + to.height / 2;
    const same = from.id === to.id;
    const d = same ? `M ${x1} ${y1} c 85 -55 85 55 0 30` : `M ${x1} ${y1} L ${x2} ${y2}`;
    pieces.push(`<g id="edge-${esc(edge.id ?? index)}"><path d="${d}" fill="none" stroke="${paint.line}" stroke-width="1.7" ${edge.kind === 'optional' ? 'stroke-dasharray="6 4"' : ''} marker-end="url(#arrow)"/><text x="${same ? x1 + 65 : (x1 + x2) / 2}" y="${(y1 + y2) / 2 - 9}" fill="${paint.muted}" text-anchor="middle" font-family="system-ui,'Microsoft YaHei',sans-serif" font-size="13">${esc(edge.label)}</text></g>`);
  }
  for (const node of nodes) {
    const cx = node.x + node.width / 2;
    const cy = node.y + node.height / 2;
    const attrs = `fill="${paint.card}" stroke="${paint.line}" stroke-width="1.5"`;
    pieces.push(`<g id="node-${esc(node.id)}">`);
    if (sequence) pieces.push(`<rect x="${node.x}" y="${node.y}" width="${node.width}" height="${node.height}" rx="8" ${attrs}/><path d="M${cx} ${node.y + node.height} V${height - 28}" stroke="${paint.line}" stroke-dasharray="5 5"/>`);
    else if (ir.type === 'use-case' && node.kind === 'actor') pieces.push(`<circle cx="${cx}" cy="${node.y + 15}" r="12" fill="none" stroke="${paint.line}"/><path d="M${cx} ${node.y + 27}v30m-25-18h50m-25 18l-20 22m20-22l20 22" stroke="${paint.line}" fill="none"/>`);
    else if (ir.type === 'use-case') pieces.push(`<ellipse cx="${cx}" cy="${cy}" rx="${node.width / 2}" ry="${node.height / 2}" ${attrs}/>`);
    else if (ir.type === 'flow' && node.kind === 'decision') pieces.push(`<path d="M${cx} ${node.y} L${node.x + node.width} ${cy} L${cx} ${node.y + node.height} L${node.x} ${cy} Z" ${attrs}/>`);
    else if (ir.type === 'state' && ['initial', 'terminal'].includes(node.kind ?? '')) pieces.push(`<circle cx="${cx}" cy="${cy}" r="18" fill="${paint.accent}" stroke="${paint.line}" stroke-width="${node.kind === 'terminal' ? 6 : 1}"/>`);
    else {
      pieces.push(`<rect x="${node.x}" y="${node.y}" width="${node.width}" height="${node.height}" rx="${ir.type === 'state' ? 22 : 7}" ${attrs}/>`);
      if (ir.type === 'ER') pieces.push(`<path d="M${node.x} ${node.y + 30}h${node.width}" stroke="${paint.line}"/>`);
      if (ir.type === 'components') pieces.push(`<rect x="${node.x - 5}" y="${node.y + 17}" width="15" height="13" ${attrs}/><rect x="${node.x - 5}" y="${node.y + 42}" width="15" height="13" ${attrs}/>`);
      if (ir.type === 'wireframe') pieces.push(`<path d="M${node.x} ${node.y + 20}h${node.width}" stroke="${paint.line}"/><circle cx="${node.x + 10}" cy="${node.y + 10}" r="3" fill="${paint.muted}"/>`);
    }
    const labelY = ir.type === 'use-case' && node.kind === 'actor' ? node.y + node.height + 20 : ir.type === 'ER' ? node.y + 21 : cy + 5;
    pieces.push(`<text x="${cx}" y="${labelY}" fill="${paint.text}" text-anchor="middle" font-family="system-ui,'Microsoft YaHei','Noto Sans CJK SC',sans-serif" font-size="14">${esc(node.label)}</text>`);
    if (ir.type === 'ER') (node.fields ?? []).slice(0, 8).forEach((field, index) => pieces.push(`<text x="${node.x + 12}" y="${node.y + 49 + index * 18}" fill="${paint.muted}" font-family="system-ui,'Microsoft YaHei',sans-serif" font-size="12">${esc(field)}</text>`));
    pieces.push('</g>');
  }
  pieces.push('</svg>');
  return pieces.join('');
}

export function validateSvg(svg: string): { safe: boolean; errors: string[]; outline: boolean; validation: Record<string, string> } {
  const errors: string[] = [];
  if (XMLValidator.validate(svg) !== true) errors.push('SVG XML 结构无效');
  if (!/^\s*(?:<\?xml[^?]*\?>\s*)?<svg\b/.test(svg) || !/<\/svg>\s*$/.test(svg)) errors.push('缺少 standalone SVG root');
  if (/<!DOCTYPE|<!ENTITY|<\s*(?:script|foreignObject|iframe|object|embed|image)\b/i.test(svg)) errors.push('禁止实体、执行内容、foreignObject 与栅格资源');
  if (/\bon[a-z]+\s*=|(?:href|src)\s*=\s*["'](?!#)|url\(\s*["']?(?!#)|@import|@font-face/i.test(svg)) errors.push('禁止事件、外链、外部字体与 CSS 资源');
  if (!/<title\b/.test(svg) || !/<desc\b/.test(svg) || !/\bviewBox\s*=/.test(svg)) errors.push('缺少 title/desc/viewBox');
  // Tags are deliberately allowlisted. XML well-formedness is separately checked by the host renderer.
  const allowed = new Set(['svg', 'title', 'desc', 'defs', 'marker', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'g', 'text', 'tspan', 'use', 'clipPath', 'linearGradient', 'radialGradient', 'stop']);
  const stack: string[] = [];
  for (const token of svg.matchAll(/<\/?([A-Za-z][\w:-]*)\b[^>]*>/g)) {
    const name = token[1]!;
    if (!allowed.has(name)) errors.push(`未知 SVG 标签 ${name}`);
    if (token[0].startsWith('</')) { if (stack.pop() !== name) errors.push('SVG 标签嵌套无效'); }
    else if (!token[0].endsWith('/>')) stack.push(name);
  }
  if (stack.length) errors.push('SVG 标签未闭合');
  return { safe: !errors.length, errors: [...new Set(errors)], outline: !/<(?:text|tspan|image)\b/i.test(svg), validation: { structural: errors.length ? 'failed' : 'passed', semantic: 'not_run', browser: 'not_run', secondRenderer: 'not_run', CJKFallback: 'not_run', CSSDisabled: 'presentation-attributes-present' } };
}
