import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, mkdir, open, rename, lstat, stat, realpath, rm } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { NexusError, recordParams, type Capability, type DispatchContext, type JsonRecord, type NexusModule, type NexusRequest, type NexusServices, type StoredRecord } from '../../ports/contracts.js';
import { safeRequest, publicUrl } from '../../adapters/search/network.js';
import { within, workspacePath } from '../files/paths.js';
import { bundledSkinCatalog } from './market-catalog.js';
import { createSkillResources } from './skills.js';

const MARKET_ORIGIN = 'https://dsh-market.com';
const K_CATALOG = 'https://raw.githubusercontent.com/kingOfSoySauce/dsh-skin-market/main/data/catalog.json';
const MAX_ASSET_FILE = 200 * 1024 * 1024;
const MAX_ASSET_TOTAL = 512 * 1024 * 1024;
const CATALOG_TTL = 5 * 60_000;
const KINDS = ['skin', 'pet', 'plugin', 'preset'] as const;
type MarketKind = typeof KINDS[number];
const manifestNames: Record<MarketKind, string> = { skin: 'skins', pet: 'pets', plugin: 'plugins', preset: 'presets' };
const plain = (value: unknown): value is JsonRecord => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const textName = (value: unknown, fallback = '') => typeof value === 'string' ? value : plain(value) ? String(value.zh ?? value.en ?? fallback) : fallback;

interface MarketItem extends JsonRecord {
  id: string; marketId: string; kind: MarketKind; name: string; description: string;
  source: string; catalogSource: 'remote' | 'cache' | 'bundled'; catalog: 'K' | 'W';
  files?: string[]; manifestHash: string;
}
interface CatalogSnapshot { items: MarketItem[]; source: string; checkedAt: string | null; updatedAt: string | null; warnings: string[]; manifestHash: string }
interface Appearance extends JsonRecord {
  themeId: string | null; mode: string; density: string; fontSize: number;
  reduceMotion: boolean; readingMode: boolean; glass: boolean; backgroundEnabled: boolean;
  petEnabled: boolean; petId: string | null; backgroundAsset: JsonRecord | null; tokens: Record<string, string>;
}
const DEFAULT_APPEARANCE: Appearance = {
  themeId: null, mode: 'host', density: 'comfortable', fontSize: 14,
  reduceMotion: true, readingMode: false, glass: false, backgroundEnabled: false,
  petEnabled: false, petId: null, backgroundAsset: null, tokens: {},
};
const TOKEN_KEYS = new Set(['--nexus-bg', '--nexus-surface', '--nexus-surface-raised', '--nexus-surface-muted', '--nexus-sidebar', '--nexus-text', '--nexus-text-muted', '--nexus-text-faint', '--nexus-muted', '--nexus-border', '--nexus-accent', '--nexus-accent-hover', '--nexus-accent-soft', '--nexus-selected', '--nexus-danger', '--nexus-success', '--nexus-warning', '--nexus-info', '--nexus-focus', '--nexus-radius', '--nexus-font-size']);
const COLOR = /^(?:#[0-9a-f]{3,8}|(?:rgb|rgba|hsl|hsla)\([0-9.,% /+-]+\)|[a-z]{3,24})$/i;
const NPM_SPEC = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@[0-9A-Za-z][0-9A-Za-z._-]*)?$/;
const THEME_TOKEN_MAP: Record<string, string> = {
  '--dsw-alias-bg-base': '--nexus-bg', '--dsw-alias-bg-layer-1': '--nexus-surface',
  '--dsw-alias-bg-layer-2': '--nexus-surface-raised', '--dsw-alias-bg-layer-3': '--nexus-surface-muted',
  '--dsw-alias-bg-module-platform': '--nexus-sidebar', '--dsw-alias-bg-multi-select': '--nexus-selected',
  '--dsw-alias-brand-primary': '--nexus-accent', '--dsw-alias-brand-text': '--nexus-text',
  '--dsw-alias-text-primary': '--nexus-text', '--dsw-alias-text-secondary': '--nexus-text-muted',
  '--dsw-alias-text-tertiary': '--nexus-text-faint', '--dsw-alias-border-l2': '--nexus-border',
  '--dsw-alias-button-primary-fill': '--nexus-accent', '--dsw-alias-button-primary-hover': '--nexus-accent-hover',
  '--aion-bg': '--nexus-bg', '--aion-surface': '--nexus-surface', '--aion-text': '--nexus-text',
  '--aion-text-muted': '--nexus-text-muted', '--aion-border': '--nexus-border', '--aion-accent': '--nexus-accent',
};

function safeAssetId(kind: MarketKind, id: string) {
  if (!(kind === 'preset' ? /^[a-z0-9][a-z0-9-]{0,127}$/ : /^[a-z0-9][a-z0-9._-]{0,127}$/i).test(id)) throw new NexusError('INVALID_ARGUMENT', '市场资源 id 无效');
}
function safeRel(value: string) {
  if (!/^[A-Za-z0-9._][A-Za-z0-9._\-/]{0,239}$/.test(value) || value.includes('..') || value.includes('//') || value.endsWith('/') || value.split('/').some(part => !part || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new NexusError('SCOPE_MISMATCH', '市场资源文件路径不安全');
  return value;
}
function normalizeKind(value: unknown): MarketKind | undefined {
  const kind = value === 'theme' ? 'skin' : value;
  if (kind === undefined || kind === 'all') return undefined;
  if (!KINDS.includes(kind as MarketKind)) throw new NexusError('INVALID_ARGUMENT', '资源类型必须为 skin/theme、pet、plugin 或 preset');
  return kind as MarketKind;
}
function mediaMatches(bytes: Buffer, suffix: string) {
  if (suffix === '.png') return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (suffix === '.jpg' || suffix === '.jpeg') return bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (suffix === '.gif') return /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'));
  if (suffix === '.webp') return bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  if (suffix === '.avif') return bytes.length >= 16 && bytes.subarray(4, 8).toString('ascii') === 'ftyp' && /avif|avis/.test(bytes.subarray(8, 64).toString('ascii'));
  if (suffix === '.mp4') return bytes.length >= 12 && bytes.subarray(4, 8).toString('ascii') === 'ftyp';
  if (suffix === '.webm') return bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  return false;
}
function values(result: unknown): JsonRecord[] {
  if (Array.isArray(result)) return result.filter(plain);
  if (plain(result)) for (const key of ['items', 'agents', 'installed', 'presets', 'models']) if (Array.isArray(result[key])) return (result[key] as unknown[]).filter(plain);
  return [];
}
function checkFiles(raw: JsonRecord): string[] | undefined {
  if (raw.files === undefined) return undefined;
  if (!Array.isArray(raw.files) || raw.files.length === 0 || raw.files.length > 2000 || raw.files.some(file => typeof file !== 'string')) throw new NexusError('FORMAT_UNSUPPORTED', '市场文件清单无效');
  const files = raw.files.map(value => safeRel(String(value)));
  if (new Set(files.map(file => file.toLowerCase())).size !== files.length) throw new NexusError('FORMAT_UNSUPPORTED', '市场文件路径重复或大小写冲突');
  return files;
}
function normalizeW(value: unknown, kind: MarketKind, source: 'remote' | 'cache' | 'bundled'): CatalogSnapshot {
  if (!plain(value) || !Array.isArray(value.items) || value.items.length > 10000) throw new NexusError('FORMAT_UNSUPPORTED', 'W 市场目录格式无效');
  const manifestHash = hash(JSON.stringify(value)), seen = new Set<string>();
  const items = value.items.map((raw: unknown): MarketItem => {
    if (!plain(raw) || typeof raw.id !== 'string') throw new NexusError('FORMAT_UNSUPPORTED', '市场条目缺少 id');
    safeAssetId(kind, raw.id);
    if (seen.has(raw.id)) throw new NexusError('FORMAT_UNSUPPORTED', '市场目录包含重复 id');
    seen.add(raw.id);
    const files = checkFiles(raw);
    if (kind !== 'plugin' && !files) throw new NexusError('FORMAT_UNSUPPORTED', '资产条目缺少真实文件清单');
    const name = textName(raw.name ?? raw.displayName, raw.id);
    return {
      ...raw, id: `W:${kind}:${raw.id}`, marketId: raw.id, kind, name,
      description: textName(raw.description ?? raw.tagline), source: 'W目录 · dsh-market.com',
      catalogSource: source, catalog: 'W', manifestHash, files,
      version: raw.version ?? null, pinnedRevision: raw.version ?? manifestHash,
      license: raw.license ?? null, assetLicense: raw.attribution ?? raw.licenseNotice ?? null,
      compatibility: raw.compatibility ?? { status: 'unknown', requirements: raw.requirements ?? null },
      statistics: { downloads: raw.downloads ?? null, installs: raw.installs ?? null, likes: raw.likes ?? null },
      preview: raw.preview ?? raw.previews ?? null,
    };
  });
  return { items, source, checkedAt: null, updatedAt: typeof value.generated === 'string' ? value.generated : typeof value.generatedAt === 'string' ? value.generatedAt : null, warnings: [], manifestHash };
}
function normalizeK(value: unknown, source: 'remote' | 'cache' | 'bundled'): CatalogSnapshot {
  if (!plain(value) || value.schemaVersion !== 1 || typeof value.generatedAt !== 'string' || !Number.isFinite(Date.parse(value.generatedAt)) || !Array.isArray(value.skins) || value.skins.length > 5000) throw new NexusError('FORMAT_UNSUPPORTED', 'K 皮肤目录格式无效');
  const manifestHash = hash(JSON.stringify(value)), seen = new Set<string>();
  const items = value.skins.map((raw: unknown): MarketItem => {
    if (!plain(raw) || typeof raw.id !== 'string' || typeof raw.package !== 'string' || !NPM_SPEC.test(raw.package) || typeof raw.repo !== 'string'
      || !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/.test(raw.repo) || !plain(raw.install)
      || typeof raw.install.commit !== 'string' || !/^[a-f0-9]{40}$/.test(raw.install.commit) || typeof raw.install.target !== 'string') throw new NexusError('FORMAT_UNSUPPORTED', 'K 目录条目或固定版本无效');
    const repo = raw.repo.replace(/^https:\/\/github\.com\//, '').replace(/\/$/, '');
    const suffix = typeof raw.subpath === 'string' ? `&path:${safeRel(raw.subpath)}` : '';
    if (raw.install.target !== `github:${repo}#${raw.install.commit}${suffix}` || seen.has(raw.id)) throw new NexusError('FORMAT_UNSUPPORTED', 'K 目录固定提交不匹配或 id 重复');
    seen.add(raw.id);
    return {
      ...raw, id: `K:skin:${raw.id}`, marketId: raw.id, kind: 'skin', name: textName(raw.name, raw.id),
      description: textName(raw.description), source: 'K目录 · dsh-skin-market', catalog: 'K', catalogSource: source, manifestHash,
      version: raw.install.version ?? null, pinnedRevision: raw.install.commit,
      license: plain(raw.license) ? raw.license.code ?? null : raw.license ?? null,
      assetLicense: plain(raw.license) ? raw.license.notice ?? null : null,
      compatibility: raw.compatibility ?? { status: 'unknown' },
      upstreamReview: raw.review ?? null, upstreamHealth: raw.health ?? null,
      statistics: { downloads: raw.downloads ?? null, installs: raw.installs ?? null, likes: raw.likes ?? null, stars: raw.starsSnapshot ?? null },
    };
  });
  return { items, source, checkedAt: null, updatedAt: value.generatedAt, warnings: [], manifestHash };
}
function safeTokenValue(value: string) {
  if (value.length > 512 || /[^A-Za-z0-9#%.,()_+\-*/ \t\r\n]/.test(value) || /(?:url|expression|attr|image-set|paint|element)\s*\(/i.test(value)) return false;
  const functions = [...value.matchAll(/([A-Za-z-]+)\s*\(/g)].map(match => match[1]);
  if (functions.some(name => !['rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch', 'color', 'color-mix', 'light-dark', 'calc', 'min', 'max', 'clamp', 'var'].includes(name.toLowerCase()))) return false;
  if ([...value.matchAll(/var\(\s*(--[\w-]+)/g)].some(match => !match[1].startsWith('--nexus-'))) return false;
  return true;
}
function tokensOf(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!plain(value) || Object.keys(value).length > 2000) throw new NexusError('INVALID_ARGUMENT', '主题 tokens 必须为受限映射');
  const tokens: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    const name = key.startsWith('--nexus-') ? key : `--nexus-${key}`;
    if ((!TOKEN_KEYS.has(name) && !/^--nexus-theme-[A-Za-z0-9_-]{1,100}$/.test(name)) || typeof raw !== 'string'
      || !(/^--nexus-(?:radius|font-size)$/.test(name) ? /^(?:[0-9]|[1-3][0-9])(?:\.[0-9])?px$/.test(raw) : safeTokenValue(raw))) throw new NexusError('INVALID_ARGUMENT', `主题 token ${key} 不是允许的安全值`);
    tokens[name] = raw;
  }
  return tokens;
}
/** Only custom properties are projected; source selectors, scripts and network URLs never enter the document. */
function stylesheetTokens(input: string, mode: string) {
  if (input.length > 2 * 1024 * 1024) throw new NexusError('RESOURCE_LIMIT', '主题 CSS 超过 2 MiB');
  const css = input.replace(/\/\*[\s\S]*?\*\//g, ''), selected: Record<string, string> = {};
  const dark = mode === 'dark', namespace = (name: string) => `--nexus-theme-${name.replace(/^--/, '')}`;
  const walk = (body: string, inheritedDark: boolean | undefined, depth: number) => {
    if (depth > 8) throw new NexusError('RESOURCE_LIMIT', 'CSS 嵌套过深');
    let cursor = 0;
    while (cursor < body.length) {
      const start = body.indexOf('{', cursor);
      if (start < 0) break;
      const selector = body.slice(cursor, start).trim();
      let end = start + 1, level = 1, quote = '';
      for (; end < body.length && level; end++) {
        const char = body[end];
        if (quote) { if (char === '\\') end++; else if (char === quote) quote = ''; continue; }
        if (char === '"' || char === "'") { quote = char; continue; }
        if (char === '{') level++; else if (char === '}') level--;
      }
      if (level) throw new NexusError('FORMAT_UNSUPPORTED', 'CSS 存在未闭合规则');
      const content = body.slice(start + 1, end - 1);
      cursor = end;
      if (selector.startsWith('@')) {
        if (/^@(?:media|supports|layer)\b/i.test(selector)) {
          const condition = /prefers-color-scheme\s*:\s*dark/i.test(selector) ? true : /prefers-color-scheme\s*:\s*light/i.test(selector) ? false : inheritedDark;
          if (condition === undefined || condition === dark) walk(content, condition, depth + 1);
        }
        continue;
      }
      if (!/:root|:host|data-theme|\.dark|\.light/i.test(selector)) continue;
      const ruleDark = /(?:data-theme\s*=\s*["']?dark|\.dark\b)/i.test(selector);
      const ruleLight = /(?:data-theme\s*=\s*["']?light|\.light\b)/i.test(selector);
      if (ruleDark && !dark || ruleLight && dark || inheritedDark !== undefined && inheritedDark !== dark) continue;
      for (const match of content.matchAll(/(--[A-Za-z0-9_-]{1,100})\s*:\s*([^;{}]+)(?:;|$)/g)) {
        const key = match[1], raw = match[2].trim().replace(/\s*!important\s*$/i, '');
        const value = raw.replace(/var\(\s*(--[A-Za-z0-9_-]+)/g, (_all, variable: string) => `var(${namespace(variable)}`);
        if (safeTokenValue(value)) selected[namespace(key)] = value;
      }
    }
  };
  walk(css, undefined, 0);
  const tokens: Record<string, string> = { ...selected, '--nexus-theme-dsw-skin-scrim': '1' };
  for (const [original, target] of Object.entries(THEME_TOKEN_MAP)) if (selected[namespace(original)]) tokens[target] = `var(${namespace(original)})`;
  for (const key of TOKEN_KEYS) {
    const source = namespace(key);
    if (selected[source]) tokens[key] = `var(${source})`;
  }
  return tokensOf(tokens);
}
function appearance(value: JsonRecord, prior: Appearance = DEFAULT_APPEARANCE): Appearance {
  const next = { ...DEFAULT_APPEARANCE, tokens: { ...prior.tokens } } as Appearance;
  for (const key of Object.keys(DEFAULT_APPEARANCE)) next[key] = prior[key];
  for (const key of ['themeId', 'petId']) if (value[key] !== undefined) {
    if (value[key] !== null && typeof value[key] !== 'string') throw new NexusError('INVALID_ARGUMENT', `${key} 必须为资源 id 或 null`);
    next[key] = value[key];
  }
  if (value.mode !== undefined) {
    if (!['host', 'light', 'dark', 'contrast'].includes(String(value.mode))) throw new NexusError('INVALID_ARGUMENT', '外观模式无效');
    next.mode = String(value.mode);
  }
  if (value.density !== undefined) {
    if (!['comfortable', 'compact'].includes(String(value.density))) throw new NexusError('INVALID_ARGUMENT', '密度无效');
    next.density = String(value.density);
  }
  if (value.fontSize !== undefined) {
    if (typeof value.fontSize !== 'number' || value.fontSize < 12 || value.fontSize > 24) throw new NexusError('INVALID_ARGUMENT', '字号须在 12–24 之间');
    next.fontSize = value.fontSize;
  }
  for (const key of ['reduceMotion', 'readingMode', 'glass', 'backgroundEnabled', 'petEnabled']) if (value[key] !== undefined) {
    if (typeof value[key] !== 'boolean') throw new NexusError('INVALID_ARGUMENT', `${key} 必须为布尔值`);
    next[key] = value[key];
  }
  if (value.tokens !== undefined) next.tokens = tokensOf(value.tokens);
  if (value.backgroundAsset !== undefined) {
    if (value.backgroundAsset !== null && (!plain(value.backgroundAsset) || typeof value.backgroundAsset.id !== 'string' || typeof value.backgroundAsset.path !== 'string')) throw new NexusError('INVALID_ARGUMENT', '背景必须为已安装资源的 id/path');
    next.backgroundAsset = value.backgroundAsset as JsonRecord | null;
  }
  if (next.petEnabled && !next.petId) throw new NexusError('INVALID_ARGUMENT', '启用宠物前须明确选择已安装资源');
  if (next.backgroundEnabled && !next.backgroundAsset) throw new NexusError('INVALID_ARGUMENT', '启用背景前须选择已安装资源');
  return next;
}
function themeCss(value: Appearance) {
  const tokens = { ...value.tokens, '--nexus-font-size': `${value.fontSize}px` };
  return `.nexus-shell{${Object.entries(tokens).map(([key, val]) => `${key}:${val}`).join(';')}}`;
}

export function createResourcesModule(services: NexusServices): NexusModule {
  const skills = createSkillResources(services);
  const catalogs = new Map<string, CatalogSnapshot>();
  const refreshing = new Map<string, Promise<CatalogSnapshot>>();
  const lastChecked = new Map<string, number>();
  const assetLocks = new Map<string, Promise<unknown>>();
  const resourceRoot = join(services.dataDir, 'resources');

  async function serial<T>(id: string, task: () => Promise<T>) {
    const previous = assetLocks.get(id) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    assetLocks.set(id, next);
    try { return await next; } finally { if (assetLocks.get(id) === next) assetLocks.delete(id); }
  }
  async function catalog(key: string, force: boolean, context?: DispatchContext): Promise<CatalogSnapshot> {
    if (!force && catalogs.has(key) && Date.now() - (lastChecked.get(key) ?? 0) < CATALOG_TTL) return catalogs.get(key)!;
    if (refreshing.has(key)) return refreshing.get(key)!;
    const run = (async () => {
      const kind = key === 'K' ? undefined : key as MarketKind;
      const url = key === 'K' ? K_CATALOG : `${MARKET_ORIGIN}/manifest/${manifestNames[kind!]}.json`;
      const normalize = (data: unknown, source: 'remote' | 'cache' | 'bundled') => key === 'K' ? normalizeK(data, source) : normalizeW(data, kind!, source);
      const checkedAt = new Date().toISOString(), warnings: string[] = [];
      const cached = await services.store.get<JsonRecord>('resourceCatalogCache', key);
      let snapshot: CatalogSnapshot | undefined;
      try {
        const response = await safeRequest(url, { headers: { accept: 'application/json', 'accept-encoding': 'identity' }, maxBytes: 8 * 1024 * 1024, timeoutMs: 15000, signal: context?.signal ?? services.signal });
        if (new URL(response.url).origin !== new URL(url).origin) throw new NexusError('SCOPE_MISMATCH', '目录重定向改变来源');
        const data: unknown = JSON.parse(response.body);
        snapshot = normalize(data, 'remote');
        if (cached && typeof cached.value.updatedAt === 'string' && snapshot.updatedAt && Date.parse(snapshot.updatedAt) < Date.parse(cached.value.updatedAt)) throw new NexusError('REVISION_CONFLICT', '远程目录时间早于已经验证的缓存');
        await services.store.put('resourceCatalogCache', key, { data, hash: hash(response.body), dataHash: hash(JSON.stringify(data)), updatedAt: snapshot.updatedAt, checkedAt, origin: new URL(url).origin }, cached?.revision ?? 0);
      } catch (error) {
        (context?.signal ?? services.signal)?.throwIfAborted();
        warnings.push(`远程目录不可用: ${errorText(error)}`);
        if (cached) try {
          if (cached.value.origin !== new URL(url).origin) throw new Error('缓存来源不匹配');
          if (cached.value.dataHash !== hash(JSON.stringify(cached.value.data))) throw new Error('缓存内容摘要不匹配');
          snapshot = normalize(cached.value.data, 'cache');
        } catch (cacheError) { warnings.push(`缓存目录被拒绝: ${errorText(cacheError)}`); }
        if (!snapshot) {
          if (key === 'K') snapshot = normalize(bundledSkinCatalog, 'bundled');
          else {
            try {
              if (!services.packageRoot) throw new Error('未提供安装包根');
              const data = JSON.parse(await readFile(join(services.packageRoot, 'assets', 'market', `${manifestNames[kind!]}.json`), 'utf8'));
              snapshot = normalize(data, 'bundled');
            } catch (bundledError) {
              warnings.push(`内置 ${kind} 目录不可用: ${errorText(bundledError)}`);
              snapshot = { items: [], source: 'unavailable', checkedAt, updatedAt: null, warnings: [], manifestHash: '' };
            }
          }
        }
      }
      snapshot = { ...snapshot, checkedAt, warnings };
      catalogs.set(key, snapshot); lastChecked.set(key, Date.now());
      return snapshot;
    })();
    refreshing.set(key, run);
    try { return await run; } finally { refreshing.delete(key); }
  }
  async function marketSearch(params: JsonRecord, context?: DispatchContext) {
    const kind = normalizeKind(params.kind), snapshots = await Promise.all(['K', ...KINDS.filter(item => !kind || item === kind)].map(key => catalog(key, params.refresh === true, context)));
    const query = String(params.query ?? '').trim().toLocaleLowerCase();
    const items = snapshots.flatMap(snapshot => snapshot.items).filter(item => (!kind || item.kind === kind)
      && (!params.catalog || params.catalog === item.catalog)
      && (!query || JSON.stringify([item.name, item.description, item.author, item.tags, item.marketId, item.package]).toLocaleLowerCase().includes(query)));
    const sort = String(params.sort ?? 'rank');
    if (!['rank', 'name', 'updated', 'downloads', 'installs', 'likes', 'stars'].includes(sort)) throw new NexusError('INVALID_ARGUMENT', '市场排序字段无效');
    items.sort((a, b) => {
      if (sort === 'name') return a.name.localeCompare(b.name);
      if (sort === 'updated') return String(b.updatedAt ?? b.version ?? '').localeCompare(String(a.updatedAt ?? a.version ?? ''));
      if (['downloads', 'installs', 'likes', 'stars'].includes(sort)) {
        const av = plain(a.statistics) ? a.statistics[sort] : null, bv = plain(b.statistics) ? b.statistics[sort] : null;
        if (typeof av !== 'number' && typeof bv === 'number') return 1;
        if (typeof av === 'number' && typeof bv !== 'number') return -1;
        if (typeof av === 'number' && typeof bv === 'number') return bv - av;
      }
      return Number(a.rank ?? a.featuredRank ?? 10000) - Number(b.rank ?? b.featuredRank ?? 10000) || a.name.localeCompare(b.name);
    });
    const offset = params.cursor === undefined ? 0 : Number(params.cursor);
    const limit = params.limit === undefined ? 200 : Number(params.limit);
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 1000) throw new NexusError('INVALID_ARGUMENT', '分页无效');
    const nextCursor = offset + limit < items.length ? String(offset + limit) : null;
    return {
      items: items.slice(offset, offset + limit), total: items.length, nextCursor, truncated: nextCursor !== null,
      catalogs: snapshots.map(snapshot => ({ source: snapshot.source, checkedAt: snapshot.checkedAt, updatedAt: snapshot.updatedAt, manifestHash: snapshot.manifestHash, count: snapshot.items.length, warnings: snapshot.warnings })),
      warnings: snapshots.flatMap(snapshot => snapshot.warnings),
      statisticsDefinitions: { downloads: '远端明确报告的下载次数', installs: '远端明确报告的安装次数', likes: '远端明确报告的喜欢次数', stars: 'GitHub 星标快照，不等于安装量', missing: 'null 表示未报告' },
    };
  }
  async function marketItem(params: JsonRecord, context?: DispatchContext) {
    const id = typeof params.id === 'string' ? params.id : typeof params.marketId === 'string' ? params.marketId : '';
    if (!id) throw new NexusError('INVALID_ARGUMENT', '必须提供市场条目 id');
    const match = /^(K|W):(skin|pet|plugin|preset):(.+)$/.exec(id);
    const kind = match ? match[2] as MarketKind : normalizeKind(params.kind);
    const origin = match?.[1] ?? params.catalog;
    const keys = origin === 'K' ? ['K'] : origin === 'W' ? kind ? [kind] : [...KINDS] : ['K', ...(kind ? [kind] : KINDS)];
    const snapshots = await Promise.all(keys.map(key => catalog(key, false, context)));
    const found = snapshots.flatMap(item => item.items).filter(item => item.id === id || item.marketId === id);
    if (!found.length) throw new NexusError('NOT_FOUND', '资源不在已验证目录中');
    if (found.length !== 1) throw new NexusError('INVALID_ARGUMENT', '市场 id 重复，请指定 K/W 和资源类型');
    return found[0];
  }
  async function managerSpec(item: MarketItem) {
    if (item.catalog === 'K') {
      const install = item.install as JsonRecord;
      // Fixed commit and subpath were already checked by normalizeK.
      return String(install.target);
    }
    const spec = typeof item.npm === 'string' ? item.npm : typeof item.repo === 'string' ? item.repo : '';
    if (NPM_SPEC.test(spec)) return spec;
    if (/^https:\/\/[A-Za-z0-9]/.test(spec) && !/[\s\x00-\x1f\x7f]/.test(spec)) {
      const url = new URL(spec);
      if (url.protocol === 'https:' && !url.username && !url.password && url.hostname) { await publicUrl(spec); return spec; }
    }
    throw new NexusError('PERMISSION_DENIED', '目录插件来源必须为 npm 包或无认证 HTTPS 仓库');
  }
  async function installed(id: string) {
    const record = await services.store.get<JsonRecord>('resources', id);
    if (!record) throw new NexusError('NOT_FOUND', '资源尚未安装');
    return record;
  }
  async function safeInstalledPath(record: StoredRecord<JsonRecord>, rel: string) {
    if (typeof record.value.path !== 'string' || !within(resourceRoot, resolve(record.value.path))) throw new NexusError('INTEGRITY_FAILED', '资源安装路径无效');
    return workspacePath(resourceRoot, relative(resourceRoot, join(record.value.path, safeRel(rel))));
  }
  async function verifyAsset(record: StoredRecord<JsonRecord>) {
    const files = plain(record.value.fileHashes) ? record.value.fileHashes : {};
    const results: JsonRecord[] = [];
    for (const [rel, expected] of Object.entries(files)) {
      try {
        const path = await safeInstalledPath(record, rel), info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_ASSET_FILE) throw new Error('资源不是受限普通文件');
        const actual = hash(await readFile(path));
        results.push({ path: rel, expected, actual, status: actual === expected ? 'verified' : 'modified' });
      } catch (error) { results.push({ path: rel, status: 'failed', message: errorText(error) }); }
    }
    return { verified: results.length > 0 && results.every(item => item.status === 'verified'), items: results, observedAt: new Date().toISOString() };
  }
  async function installMarket(request: NexusRequest, context?: DispatchContext) {
    const params = request.params ?? {}, item = await marketItem(params, context);
    const queueId = request.requestId ?? randomUUID();
    const phase = async (state: string, extra: JsonRecord = {}) => {
      const row = await services.store.get<JsonRecord>('resourceInstallQueue', queueId);
      await services.store.put('resourceInstallQueue', queueId, { id: item.id, state, observedAt: new Date().toISOString(), ...extra }, row?.revision ?? 0);
      services.emit('resources.install.progress', { queueId, id: item.id, state, ...extra });
    };
    return serial(item.id, async () => {
      await phase('preparing');
      try {
        if (item.kind === 'plugin' || item.catalog === 'K') {
          const spec = await managerSpec(item);
          const inspection = await services.host.sessions('extensions.inspect', { spec });
          if (params.dryRun !== false) {
            await phase('preview');
            return { effect: 'preview', item, spec, inspection, writer: 'official-plugin-manager', enabled: false, compatibility: 'host-inspection', changesProfile: true };
          }
          if (plain(inspection) && (inspection.compatible === false || inspection.status === 'incompatible')) throw new NexusError('HOST_CONTRACT_UNSUPPORTED', '宿主预检判定插件不兼容', inspection);
          await phase('host-manager-applying');
          const result = await services.host.sessions('extensions.install', { spec, enabled: false, requestId: request.requestId });
          const previous = await services.store.get<JsonRecord>('resources', item.id);
          const saved = await services.store.put('resources', item.id, { ...item, enabled: false, state: 'installed-disabled', writer: 'official-plugin-manager', spec, inspection, installResult: result, installedAt: new Date().toISOString() }, previous?.revision ?? 0);
          await phase('completed', { writer: 'official-plugin-manager', activationVerified: false });
          return { ...saved.value, revision: saved.revision, effect: 'committed', result, activationVerified: false };
        }
        safeAssetId(item.kind, item.marketId);
        if (!item.files?.length) throw new NexusError('FORMAT_UNSUPPORTED', '市场资产缺少文件计划');
        const directory = join(resourceRoot, manifestNames[item.kind], item.marketId);
        await mkdir(resourceRoot, { recursive: true });
        await workspacePath(resourceRoot, relative(resourceRoot, directory), true);
        const exists = await lstat(directory).then(() => true).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return false; });
        if (exists || await services.store.get('resources', item.id)) throw new NexusError('REVISION_CONFLICT', '资源已存在；默认不覆盖，请先显式移除');
        const plan = item.files.map(rel => ({ path: rel, url: `${MARKET_ORIGIN}/assets/${manifestNames[item.kind]}/${encodeURIComponent(item.marketId)}/${rel.split('/').map(encodeURIComponent).join('/')}` }));
        if (params.dryRun !== false) {
          await phase('preview');
          return { effect: 'preview', item, destination: directory, files: plan, overwrite: false, activation: item.kind === 'preset' ? 'inert-preset-library' : 'installed-disabled' };
        }
        await mkdir(dirname(directory), { recursive: true });
        await workspacePath(resourceRoot, relative(resourceRoot, dirname(directory)));
        const stage = join(dirname(directory), `.nexus-download-${randomUUID()}`);
        await mkdir(stage);
        let committed = false, total = 0;
        const hashes: Record<string, string> = {};
        try {
          await phase('downloading', { totalFiles: plan.length, completedFiles: 0 });
          for (const [index, entry] of plan.entries()) {
            (context?.signal ?? services.signal)?.throwIfAborted();
            const response = await safeRequest(entry.url, { headers: { 'accept-encoding': 'identity' }, timeoutMs: 30000, maxBytes: MAX_ASSET_FILE, maxRedirects: 0, signal: context?.signal ?? services.signal });
            if (new URL(response.url).origin !== MARKET_ORIGIN) throw new NexusError('SCOPE_MISMATCH', '资产下载改变来源');
            total += response.bytes.length;
            if (total > MAX_ASSET_TOTAL) throw new NexusError('RESOURCE_LIMIT', '资源总下载超过 512 MiB');
            const actualHash = hash(response.bytes), declared = plain(item.hashes) ? item.hashes[entry.path] : plain(item.integrity) ? item.integrity[entry.path] : undefined;
            if (typeof declared === 'string' && declared.replace(/^sha256[:=-]?/, '') !== actualHash) throw new NexusError('INTEGRITY_FAILED', `资源 ${entry.path} 哈希与目录声明不符`);
            hashes[entry.path] = actualHash;
            const target = join(stage, entry.path);
            await mkdir(dirname(target), { recursive: true });
            const handle = await open(target, 'wx', 0o600);
            try { await handle.writeFile(response.bytes); await handle.sync(); } finally { await handle.close(); }
            await phase('downloading', { totalFiles: plan.length, completedFiles: index + 1, bytes: total });
          }
          await phase('verifying', { bytes: total });
          const provenance = { schemaVersion: 1, source: MARKET_ORIGIN, kind: item.kind, id: item.marketId, manifestHash: item.manifestHash, version: item.version ?? null, files: hashes, installedAt: new Date().toISOString(), license: item.license ?? null };
          const handle = await open(join(stage, 'dsh-market.provenance.json'), 'wx', 0o600);
          try { await handle.writeFile(JSON.stringify(provenance, null, 2)); await handle.sync(); } finally { await handle.close(); }
          if (await lstat(directory).then(() => true).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return false; })) throw new NexusError('REVISION_CONFLICT', '下载期间目标已出现');
          await phase('applying');
          await rename(stage, directory); committed = true;
          const record = await services.store.put('resources', item.id, { ...item, path: directory, enabled: false, state: item.kind === 'preset' ? 'inert-preset-library' : 'installed-disabled', fileHashes: hashes, provenance, installedAt: provenance.installedAt, writer: 'nexus-assets', bytes: total }, 0);
          const verification = await verifyAsset(record);
          if (!verification.verified) throw new NexusError('INTEGRITY_FAILED', '安装后读取验证失败', { verification, directory, committed: true });
          await phase('completed', { bytes: total, files: plan.length, enabled: false });
          services.emit('resources.changed', { id: item.id, enabled: false });
          return { ...record.value, revision: record.revision, effect: 'committed', verification, activationVerified: false };
        } finally { if (!committed && within(resourceRoot, stage)) await rm(stage, { recursive: true, force: true }); }
      } catch (error) { await phase('failed', { error: errorText(error) }); throw error; }
    });
  }
  async function appearanceConfig() {
    const saved = await services.store.get<Appearance>('appearance', 'current');
    const value = saved?.value ?? DEFAULT_APPEARANCE;
    return { ...value, revision: saved?.revision ?? 0, css: themeCss(value), scope: 'nexus-plugin', defaultExtrasOff: true };
  }
  async function importMedia(request: NexusRequest, context?: DispatchContext) {
    const params = request.params ?? {};
    if (!['pet', 'background'].includes(String(params.kind))) throw new NexusError('INVALID_ARGUMENT', '自定义媒体类型必须为 pet 或 background');
    const kind = String(params.kind), workspace = context?.workspaceRoot ?? services.workspaceRoot;
    let bytes: Buffer, filename: string, source: string;
    if (typeof params.path === 'string' && params.path.trim()) {
      let path: string;
      if (isAbsolute(params.path) && !within(resolve(workspace), resolve(params.path))) {
        path = await realpath(params.path);
        if (!await services.host.approve('resources.import.media', path, { kind, readOnly: true, explicitSource: params.path })) throw new NexusError('PERMISSION_DENIED', '自定义媒体来源未获宿主授权');
      } else path = await workspacePath(workspace, params.path);
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024 * 1024) throw new NexusError('RESOURCE_LIMIT', '媒体须为不超过 64 MiB 的普通文件');
      bytes = await readFile(path); filename = basename(path); source = path;
    } else if (typeof params.base64 === 'string' && typeof params.filename === 'string') {
      if (params.base64.length > 24 * 1024 * 1024 || !/^[A-Za-z0-9+/=\s]*$/.test(params.base64)) throw new NexusError('RESOURCE_LIMIT', '浏览器媒体超过上传预算或编码无效');
      bytes = Buffer.from(params.base64, 'base64'); filename = params.filename; source = 'browser-upload';
    } else throw new NexusError('INVALID_ARGUMENT', '须提供 path 或 base64/filename');
    const suffix = extname(filename).toLowerCase();
    const mime: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif', '.mp4': 'video/mp4', '.webm': 'video/webm' };
    if (!mime[suffix] || kind === 'pet' && !mime[suffix].startsWith('image/')) throw new NexusError('FORMAT_UNSUPPORTED', '宠物仅支持位图；背景支持位图或视频，不载入 HTML/SVG/脚本');
    if (!bytes.length) throw new NexusError('INVALID_ARGUMENT', '媒体为空');
    if (!mediaMatches(bytes, suffix)) throw new NexusError('FORMAT_UNSUPPORTED', '媒体文件头与声明格式不符');
    const digest = hash(bytes), mediaName = `media${suffix}`;
    const localId = typeof params.id === 'string' ? params.id : digest.slice(0, 24);
    if (!/^[a-z0-9][a-z0-9._-]{0,100}$/i.test(localId)) throw new NexusError('INVALID_ARGUMENT', '自定义媒体 id 无效');
    const id = `custom:${kind}:${localId}`, directory = join(resourceRoot, 'custom', kind, localId);
    return serial(id, async () => {
      await mkdir(resourceRoot, { recursive: true });
      await workspacePath(resourceRoot, relative(resourceRoot, directory), true);
      if (await services.store.get('resources', id) || await lstat(directory).then(() => true).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return false; })) throw new NexusError('REVISION_CONFLICT', '同名自定义媒体已存在，默认不覆盖');
      const preview = { id, kind, source: 'user-selected', name: typeof params.name === 'string' ? params.name : filename, fileHashes: { [mediaName]: digest }, media: { path: mediaName, contentType: mime[suffix] }, renderer: kind === 'pet' ? 'image' : undefined, enabled: false, bytes: bytes.length, license: params.license ?? null, state: 'installed-disabled', path: directory };
      if (params.dryRun !== false) return { ...preview, effect: 'preview', sourcePath: source };
      await mkdir(dirname(directory), { recursive: true });
      await workspacePath(resourceRoot, relative(resourceRoot, dirname(directory)));
      const stage = join(dirname(directory), `.nexus-media-${randomUUID()}`);
      await mkdir(stage);
      let committed = false;
      try {
        const handle = await open(join(stage, mediaName), 'wx', 0o600);
        try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
        if (await lstat(directory).then(() => true).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return false; })) throw new NexusError('REVISION_CONFLICT', '导入期间目标已存在');
        await rename(stage, directory); committed = true;
        const record = await services.store.put('resources', id, { ...preview, writer: 'nexus-assets', installedAt: new Date().toISOString(), provenance: { source: 'user-selected', originalFilename: filename, files: preview.fileHashes, importedAt: new Date().toISOString() } }, 0);
        const verification = await verifyAsset(record);
        if (!verification.verified) throw new NexusError('INTEGRITY_FAILED', '媒体导入后读取验证失败', verification);
        services.emit('resources.changed', { id, kind, enabled: false });
        return { ...record.value, revision: record.revision, effect: 'committed', verification, optInRequired: true };
      } finally { if (!committed && within(resourceRoot, stage)) await rm(stage, { recursive: true, force: true }); }
    });
  }
  async function themeCandidate(params: JsonRecord) {
    const config = await appearanceConfig();
    let fields = plain(params.config) ? params.config : params;
    if (typeof params.id === 'string') {
      const record = await installed(params.id);
      if (record.value.kind !== 'skin') throw new NexusError('INVALID_ARGUMENT', '试穿目标必须为皮肤');
      if (record.value.writer === 'official-plugin-manager') throw new NexusError('HOST_CONTRACT_UNSUPPORTED', '此皮肤为完整宿主插件；用启用操作交给官方管理器，不将脚本注入 Nexus 预览');
      const verification = await verifyAsset(record);
      if (!verification.verified) throw new NexusError('INTEGRITY_FAILED', '皮肤资源被修改或缺失，不能应用', verification);
      let metadata: JsonRecord = {};
      if (plain(record.value.fileHashes) && record.value.fileHashes['skin.json']) {
        try { metadata = JSON.parse(await readFile(await safeInstalledPath(record, 'skin.json'), 'utf8')); }
        catch { throw new NexusError('FORMAT_UNSUPPORTED', 'skin.json 无效'); }
      }
      const accent = typeof metadata.accent === 'string' && COLOR.test(metadata.accent) ? { '--nexus-accent': metadata.accent } : {};
      const providedTokens = plain(metadata.tokens) ? metadata.tokens : plain(metadata.nexus) && plain(metadata.nexus.tokens) ? metadata.nexus.tokens : undefined;
      let fromStylesheet: Record<string, string> = {};
      const contributes = plain(metadata.contributes) ? metadata.contributes : {};
      const stylesheet = typeof contributes.stylesheet === 'string' ? contributes.stylesheet : 'skin.css';
      if (plain(record.value.fileHashes) && record.value.fileHashes[stylesheet]) {
        fromStylesheet = stylesheetTokens(await readFile(await safeInstalledPath(record, stylesheet), 'utf8'), String(fields.mode ?? config.mode));
      }
      fields = { ...fields, themeId: params.id, tokens: { ...accent, ...fromStylesheet, ...tokensOf(providedTokens), ...tokensOf(fields.tokens) } };
    }
    const next = appearance(fields, config as Appearance);
    if (next.petEnabled && next.petId) {
      const pet = await installed(next.petId);
      if (pet.value.kind !== 'pet') throw new NexusError('INVALID_ARGUMENT', 'petId 不是宠物资源');
      if (!(await verifyAsset(pet)).verified) throw new NexusError('INTEGRITY_FAILED', '宠物文件校验失败');
    }
    if (next.backgroundEnabled && next.backgroundAsset) {
      const asset = await installed(String(next.backgroundAsset.id));
      const path = String(next.backgroundAsset.path);
      if (!/\.(png|jpe?g|webp|gif|avif|mp4|webm)$/i.test(path) || !plain(asset.value.fileHashes) || !asset.value.fileHashes[path]) throw new NexusError('INVALID_ARGUMENT', '背景须为已校验的图像或视频资产');
      await safeInstalledPath(asset, path);
    }
    return next;
  }
  async function themes(request: NexusRequest, context?: DispatchContext) {
    const params = request.params ?? {};
    if (request.action === 'themes.config') return appearanceConfig();
    if (request.action === 'themes.list') {
      const items = (await services.store.list<JsonRecord>('resources')).filter(row => row.value.kind === 'skin' || row.value.kind === 'pet');
      return { items: items.map(row => ({ ...row.value, id: row.id, revision: row.revision })), config: await appearanceConfig() };
    }
    if (request.action === 'themes.preview') {
      const candidate = await themeCandidate(params);
      const current = await appearanceConfig(), previewId = `preview_${randomUUID()}`;
      const expiresAt = Date.now() + 15 * 60_000;
      await services.store.put('resourceThemePreviews', previewId, { candidate, baseRevision: current.revision, expiresAt, actorId: context?.actorId ?? 'host-owner' }, 0);
      return { effect: 'preview', previewId, expiresAt: new Date(expiresAt).toISOString(), config: candidate, css: themeCss(candidate), scope: 'nexus-plugin', hostProfileChanged: false };
    }
    const current = await services.store.get<Appearance>('appearance', 'current');
    const expected = request.expectedRevision ?? params.expectedRevision;
    if (typeof expected !== 'number' || expected !== (current?.revision ?? 0)) throw new NexusError('REVISION_CONFLICT', '应用或还原外观必须携带当前修订号', { revision: current?.revision ?? 0 });
    let candidate: Appearance;
    if (request.action === 'themes.revert') {
      if (params.reset === true) candidate = { ...DEFAULT_APPEARANCE, tokens: {} };
      else {
        const previous = await services.store.get<Appearance>('appearance', 'previous');
        if (!previous) throw new NexusError('NOT_FOUND', '没有可还原的上一项外观配置');
        candidate = previous.value;
      }
    } else if (typeof params.previewId === 'string') {
      const preview = await services.store.get<JsonRecord>('resourceThemePreviews', params.previewId);
      if (!preview || Number(preview.value.expiresAt) < Date.now()) throw new NexusError('NOT_FOUND', '试穿已过期');
      if (preview.value.baseRevision !== expected || preview.value.actorId !== (context?.actorId ?? 'host-owner')) throw new NexusError('REVISION_CONFLICT', '试穿基础配置或所属用户已变化');
      candidate = appearance(preview.value.candidate as JsonRecord);
    } else candidate = await themeCandidate(params);
    const prior = await services.store.get<Appearance>('appearance', 'previous');
    await services.store.put('appearance', 'previous', current?.value ?? DEFAULT_APPEARANCE, prior?.revision ?? 0);
    const saved = await services.store.put('appearance', 'current', candidate, expected);
    services.emit('resources.theme.changed', { ...candidate, revision: saved.revision, css: themeCss(candidate) });
    return { ...candidate, revision: saved.revision, css: themeCss(candidate), effect: 'committed', scope: 'nexus-plugin' };
  }
  async function list(request: NexusRequest, context?: DispatchContext) {
    const params = request.params ?? {}, kind = String(params.kind ?? 'all'), warnings: string[] = [];
    const rows: JsonRecord[] = [];
    if (kind === 'all' || kind === 'skill') {
      const result = await skills.scan(context); rows.push(...result.items);
      warnings.push(...result.issues.map(item => `${item.source}: ${String(item.message ?? item.code)}`));
    }
    for (const record of await services.store.list<JsonRecord>('resources')) if (kind === 'all' || record.value.kind === (kind === 'theme' ? 'skin' : kind)) rows.push({ ...record.value, id: record.id, revision: record.revision, updatedAt: record.updatedAt });
    for (const [domain, targetKind] of [['agents', 'agent'], ['presets', 'preset']] as const) if (kind === 'all' || kind === targetKind) {
      try {
        const result = await services.invoke(domain, { action: 'list', params: {} }, context);
        rows.push(...values(result).map(row => ({ ...row, kind: targetKind, source: row.source ?? 'Nexus', resourceDomain: domain })));
      } catch (error) { warnings.push(`${targetKind}: ${errorText(error)}`); }
    }
    const query = String(params.query ?? '').toLocaleLowerCase(), filtered = query ? rows.filter(row => JSON.stringify(row).toLocaleLowerCase().includes(query)) : rows;
    const offset = request.cursor ? Number(request.cursor) : 0, limit = request.limit ?? 200;
    if (!Number.isInteger(offset) || offset < 0) throw new NexusError('INVALID_ARGUMENT', '分页游标无效');
    return { items: filtered.slice(offset, offset + limit), total: filtered.length, nextCursor: offset + limit < filtered.length ? String(offset + limit) : null, warnings };
  }
  async function get(request: NexusRequest, context?: DispatchContext) {
    const params = request.params ?? {}, id = String(params.id ?? request.target?.id ?? '');
    if (id.startsWith('skill:') || params.kind === 'skill') return skills.get({ ...params, id: id || undefined }, context);
    if (params.kind === 'agent' || id.startsWith('persona:')) return services.invoke('agents', { ...request, action: 'get', params: { ...params, id } }, context);
    if (params.kind === 'preset' && !id.startsWith('W:')) return services.invoke('presets', { ...request, action: 'get', params: { ...params, id } }, context);
    const row = await services.store.get<JsonRecord>('resources', id);
    if (row) {
      if (row.value.kind === 'pet' && plain(row.value.fileHashes) && typeof row.value.fileHashes['pet.json'] === 'string') {
        const path = await safeInstalledPath(row, 'pet.json'), info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 512 * 1024) throw new NexusError('RESOURCE_LIMIT', '宠物清单须为不超过 512 KiB 的普通文件');
        const bytes = await readFile(path), actual = hash(bytes);
        if (bytes.length > 512 * 1024) throw new NexusError('RESOURCE_LIMIT', '宠物清单超过 512 KiB');
        if (actual !== row.value.fileHashes['pet.json']) throw new NexusError('INTEGRITY_FAILED', '宠物清单已被修改');
        let petManifest: unknown;
        try { petManifest = JSON.parse(bytes.toString('utf8')); }
        catch { throw new NexusError('FORMAT_UNSUPPORTED', 'pet.json 不是有效 JSON'); }
        if (!plain(petManifest) || Object.getPrototypeOf(petManifest) !== Object.prototype) throw new NexusError('FORMAT_UNSUPPORTED', 'pet.json 须为普通对象');
        return { ...row.value, id: row.id, revision: row.revision, updatedAt: row.updatedAt, petManifest, petManifestVerification: { verified: true, path: 'pet.json', hash: actual, bytes: bytes.length } };
      }
      return { ...row.value, id: row.id, revision: row.revision, updatedAt: row.updatedAt };
    }
    return marketItem({ ...params, id }, context);
  }
  async function toggleResource(request: NexusRequest, enabled: boolean, context?: DispatchContext) {
    const params = request.params ?? {}, id = String(params.id ?? request.target?.id ?? '');
    if (id.startsWith('skill:') || params.kind === 'skill') return skills.toggle({ ...request, params: { ...params, id } }, enabled, context);
    const row = await installed(id);
    if (request.expectedRevision !== undefined && request.expectedRevision !== row.revision) throw new NexusError('REVISION_CONFLICT', '资源修订已变化', { revision: row.revision });
    if (row.value.writer === 'official-plugin-manager') {
      const entries = values(await services.host.sessions('extensions.list', {}));
      const entry = entries.find(item => item.id === params.entryId || item.entryId === params.entryId || item.name === row.value.package || item.spec === row.value.spec || plain(item.source) && item.source.spec === row.value.spec);
      const entryId = entry?.entryId ?? entry?.id;
      if (typeof entryId !== 'string') throw new NexusError('NOT_FOUND', '宿主未返回此资源的实际 plugin entryId');
      const result = await services.host.sessions(enabled ? 'extensions.activate' : 'extensions.dispose', { entryId });
      const saved = await services.store.put('resources', id, { ...row.value, enabled, state: enabled ? 'enabled' : 'disabled', activationResult: result }, request.expectedRevision ?? row.revision);
      return { ...saved.value, revision: saved.revision, result };
    }
    if (row.value.kind === 'preset') {
      const verification = await verifyAsset(row);
      if (enabled && !verification.verified) throw new NexusError('INTEGRITY_FAILED', '市场预设组合文件校验失败', verification);
      const permissions = new Set(context?.permissions ?? []);
      const presetId = `market.${String(row.value.marketId).replace(/[^a-z0-9_.-]/gi, '_')}`;
      let result: unknown;
      if (enabled) {
        const preview = await services.invoke('presets', { action: 'import.preview', params: { resourceId: id, persistent: true } }, context) as JsonRecord;
        if (!await services.host.approve('resources.preset.activate', id, {
          resourceRevision: row.revision, manifestHash: row.value.manifestHash, fileHashes: row.value.fileHashes,
          planId: preview.id, digest: preview.digest, definition: preview.definition,
        })) throw new NexusError('PERMISSION_DENIED', '此具体预设组合未获宿主授权');
        const imported = await services.store.get('imported-presets', presetId);
        permissions.add('presets.import.apply'); permissions.add('presets.import.activate');
        result = await services.invoke('presets', {
          action: 'import.apply', requestId: `${request.requestId}:preset-enable`,
          expectedRevision: imported?.revision ?? 0,
          params: { planId: preview.id, digest: preview.digest },
        }, { ...context, permissions });
      } else {
        const imported = await services.store.get('imported-presets', presetId);
        if (!imported) result = { id: presetId, unregistered: false, alreadyDisabled: true };
        else {
          if (!await services.host.approve('resources.preset.disable', id, { resourceRevision: row.revision, presetId, importedRevision: imported.revision })) throw new NexusError('PERMISSION_DENIED', '注销此预设未获宿主授权');
          permissions.add('presets.import.remove');
          result = await services.invoke('presets', {
            action: 'import.remove', requestId: `${request.requestId}:preset-disable`,
            expectedRevision: imported.revision, params: { id: presetId },
          }, { ...context, permissions });
        }
      }
      const saved = await services.store.put('resources', id, { ...row.value, enabled, state: enabled ? 'preset-registered' : 'inert-preset-library', presetId, activationResult: result }, request.expectedRevision ?? row.revision);
      services.emit('resources.changed', { id, enabled, presetId });
      return { ...saved.value, revision: saved.revision, result, existingSessionsUnchanged: true };
    }
    const verification = await verifyAsset(row);
    if (enabled && !verification.verified) throw new NexusError('INTEGRITY_FAILED', '资源完整性验证失败', verification);
    const config = await appearanceConfig(), fields: JsonRecord = { ...config };
    if (row.value.kind === 'pet') { fields.petId = enabled ? id : null; fields.petEnabled = enabled; }
    if (row.value.kind === 'background') {
      const media = plain(row.value.media) ? row.value.media : undefined;
      if (!media || typeof media.path !== 'string') throw new NexusError('FORMAT_UNSUPPORTED', '背景资源缺少媒体路径');
      fields.backgroundAsset = enabled ? { id, path: media.path } : null;
      fields.backgroundEnabled = enabled;
    }
    if (row.value.kind === 'skin') {
      if (enabled) Object.assign(fields, await themeCandidate({ id }));
      else { fields.themeId = null; fields.tokens = {}; }
    }
    await serial('appearance', () => themes({ ...request, action: 'themes.apply', expectedRevision: config.revision, params: { config: fields } }, context));
    const saved = await services.store.put('resources', id, { ...row.value, enabled, state: enabled ? 'enabled' : 'disabled' }, request.expectedRevision ?? row.revision);
    services.emit('resources.changed', { id, enabled });
    return { ...saved.value, revision: saved.revision, verification };
  }
  async function removeResource(request: NexusRequest, context?: DispatchContext) {
    const params = request.params ?? {}, id = String(params.id ?? request.target?.id ?? '');
    if (id.startsWith('skill:') || params.kind === 'skill') return skills.remove({ ...request, params: { ...params, id } }, context);
    return serial(id, async () => {
      const row = await installed(id), expected = request.expectedRevision ?? params.expectedRevision;
      if (expected !== row.revision) throw new NexusError('REVISION_CONFLICT', '删除必须携带当前资源版本', { revision: row.revision });
      if (row.value.enabled) throw new NexusError('REVISION_CONFLICT', '先禁用资源再移除');
      if (row.value.writer === 'official-plugin-manager') {
        const name = typeof row.value.package === 'string' ? row.value.package : typeof row.value.npm === 'string' ? row.value.npm.replace(/(@[^/]+)?@[^@]+$/, '$1') : '';
        if (!name || !NPM_SPEC.test(name)) throw new NexusError('INVALID_ARGUMENT', '需要宿主报告的确切包名，不能猜测仓库依赖名称');
        const result = await services.host.sessions('extensions.uninstall', { name });
        await services.store.remove('resources', id, row.revision);
        return { id, effect: 'committed', writer: 'official-plugin-manager', result };
      }
      const path = String(row.value.path ?? '');
      if (!within(resourceRoot, resolve(path)) || path === resourceRoot) throw new NexusError('SCOPE_MISMATCH', '资源目录不在插件数据边界内');
      await workspacePath(resourceRoot, relative(resourceRoot, path));
      const destination = join(resourceRoot, '.trash', `${Date.now()}-${randomUUID()}-${basename(path)}`);
      await mkdir(dirname(destination), { recursive: true });
      await rename(path, destination);
      await services.store.remove('resources', id, row.revision);
      await services.store.put('resourceTrash', randomUUID(), { id, originalPath: path, path: destination, movedAt: new Date().toISOString(), fileHashes: row.value.fileHashes });
      return { id, effect: 'committed', trashed: true, destination };
    });
  }

  const readActions: Record<string, string> = {
    list: '浏览全部资源和同名技能来源', get: '按需读取资源详情与正文', health: '检查格式、引用、来源与实际安装文件',
    'skills.list': '列出各作用域技能和遮蔽关系', 'skills.get': '读取技能正文、未知元数据及基础修订', 'models.list': '读取宿主真实模型能力和路由目录',
    'market.search': '搜索 K/W 在线、验证缓存与内置目录', 'market.get': '读取市场来源、许可、固定版本和实际文件计划',
    'market.queue': '读取真实资源安装进度', 'themes.list': '列出已安装皮肤与宠物', 'themes.config': '读取当前插件外观配置',
    'asset.read': '读取已安装且哈希匹配的媒体资源', 'agents.list': '浏览代理来源', 'agents.get': '读取代理 persona',
  };
  const writeActions: Record<string, string> = {
    import: '预检并导入技能、宠物或背景资源', enable: '明确启用已安装资源', disable: '明确禁用资源', remove: '将可写资源移入产品废纸篓',
    'asset.import': '预检并导入用户选择的位图宠物或媒体背景，默认关闭',
    'skills.create': '在选定作用域创建技能', 'skills.edit': '以 CAS 修改描述、适用场景和正文', 'skills.write': '以 CAS 保存技能完整 frontmatter',
    'skills.import': '逐项预检和原子导入技能及附属文件', 'skills.enable': '启用技能模型调用', 'skills.disable': '停用技能模型调用',
    'skills.remove': '以当前修订将技能指令移入废纸篓', 'skills.provider.set': '修改 Nexus provider 可调用视图开关',
    'market.refresh': '刷新并验证远程目录与缓存', 'market.install': '先预检，再通过正式管理器或实际下载安装',
    'market.install.queue': '逐条执行安装队列并在首失败处停止',
    'themes.preview': '生成独立限时试穿，不更改当前配置', 'themes.apply': 'CAS 应用安全的插件范围外观配置', 'themes.revert': 'CAS 还原上一项或默认外观',
  };
  const capabilities: Capability[] = [
    ...Object.entries(readActions).map(([action, description]) => ({ action, description })),
    ...Object.entries(writeActions).map(([action, description]) => ({ action, description, mutating: true })),
  ];
  return {
    id: 'resources', capabilities,
    async dispatch(request, context) {
      const params = recordParams(request);
      if (!params.id && request.target?.id) params.id = request.target.id;
      switch (request.action) {
        case 'list': return list(request, context);
        case 'get': return get(request, context);
        case 'skills.list': return skills.scan(context);
        case 'skills.get': return skills.get(params, context);
        case 'skills.create': return skills.create(request, context);
        case 'skills.edit': case 'skills.write': return skills.write(request, context);
        case 'import': return params.kind === 'pet' || params.kind === 'background' ? importMedia(request, context) : skills.importSkills(request, context);
        case 'skills.import': return skills.importSkills(request, context);
        case 'asset.import': return importMedia(request, context);
        case 'skills.enable': return skills.toggle(request, true, context);
        case 'skills.disable': return skills.toggle(request, false, context);
        case 'skills.provider.set': return skills.providerSet(request, context);
        case 'skills.remove': return skills.remove(request, context);
        case 'enable': return serial(`toggle:${String(params.id ?? '')}`, () => toggleResource(request, true, context));
        case 'disable': return serial(`toggle:${String(params.id ?? '')}`, () => toggleResource(request, false, context));
        case 'remove': return removeResource(request, context);
        case 'models.list': return services.host.sessions('models.list', params);
        case 'agents.list': case 'agents.get': return services.invoke('agents', { ...request, action: request.action.slice(7) }, context);
        case 'market.search': return marketSearch({ ...params, cursor: request.cursor ?? params.cursor, limit: params.limit ?? request.limit ?? 200 }, context);
        case 'market.get': return marketItem(params, context);
        case 'market.refresh': {
          const kind = normalizeKind(params.kind);
          const keys = params.catalog === 'K' ? ['K'] : kind ? [kind] : ['K', ...KINDS];
          return { items: await Promise.all(keys.map(key => catalog(key, true, context))) };
        }
        case 'market.install': return installMarket(request, context);
        case 'market.queue': return { items: await services.store.list('resourceInstallQueue') };
        case 'market.install.queue': {
          if (!Array.isArray(params.items) || !params.items.length || params.items.length > 100) throw new NexusError('INVALID_ARGUMENT', '队列必须为 1–100 个资源');
          const items: JsonRecord[] = [];
          for (let index = 0; index < params.items.length; index++) {
            const item = params.items[index];
            if (!plain(item)) throw new NexusError('INVALID_ARGUMENT', '队列条目必须为对象');
            try { items.push({ index, status: 'completed', result: await installMarket({ ...request, requestId: `${request.requestId}:queue:${index}`, params: { ...item, dryRun: params.dryRun } }, context) }); }
            catch (error) { return { items: [...items, { index, status: 'failed', message: errorText(error) }], stoppedAt: index, remaining: params.items.slice(index + 1), complete: false }; }
          }
          return { items, complete: true };
        }
        case 'themes.list': case 'themes.config': case 'themes.preview': return themes(request, context);
        case 'themes.apply': case 'themes.revert': return serial('appearance', () => themes(request, context));
        case 'asset.read': {
          const row = await installed(String(params.id ?? '')), rel = safeRel(String(params.path ?? ''));
          if (!plain(row.value.fileHashes) || typeof row.value.fileHashes[rel] !== 'string') throw new NexusError('PERMISSION_DENIED', '文件不在已安装资源清单');
          const path = await safeInstalledPath(row, rel), info = await lstat(path);
          if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 * 1024) throw new NexusError('RESOURCE_LIMIT', '预览媒体超过 16 MiB 或不是普通文件');
          const bytes = await readFile(path), actual = hash(bytes);
          if (actual !== row.value.fileHashes[rel]) throw new NexusError('INTEGRITY_FAILED', '媒体已被修改');
          const mime: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif', '.mp4': 'video/mp4', '.webm': 'video/webm' };
          const contentType = mime[extname(path).toLowerCase()];
          if (!contentType) throw new NexusError('FORMAT_UNSUPPORTED', '仅允许惰性图像和视频，不执行 HTML、SVG 或脚本');
          if (!mediaMatches(bytes, extname(path).toLowerCase())) throw new NexusError('FORMAT_UNSUPPORTED', '媒体文件头与扩展名不符');
          return { id: row.id, path: rel, contentType, bytes: bytes.length, hash: actual, base64: bytes.toString('base64') };
        }
        case 'health': {
          const skillHealth = await skills.health(context), assets: JsonRecord[] = [];
          for (const row of await services.store.list<JsonRecord>('resources')) {
            assets.push({ id: row.id, kind: row.value.kind, ...(row.value.writer === 'nexus-assets' ? await verifyAsset(row) : { verified: null, reason: 'activation and package integrity belong to the official Plugin Manager' }) });
          }
          return { skills: skillHealth, assets, observedAt: new Date().toISOString(), healthy: skillHealth.healthy === false || assets.some(item => item.verified === false) ? false : null, unverifiedIsNotHealthy: true };
        }
        default: throw new NexusError('NOT_FOUND', `未知资源操作: ${request.action}`);
      }
    },
  };
}

/** Pure validation boundary exported for deterministic catalog/CSS verification. */
export const resourceValidation = { normalizeW, normalizeK, tokensOf, stylesheetTokens };
