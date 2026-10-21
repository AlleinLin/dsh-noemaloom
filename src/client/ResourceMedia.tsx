import * as React from 'react';
import { useEffect, useRef, useState } from 'react';
import { isRecord, type Data, type ViewContext } from './types.js';

const MAX_FILES = 256;
const MAX_BYTES = 48 * 1024 * 1024;
const MAX_PIXELS = 32 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif']);
const VIDEO_TYPES = new Set(['video/mp4', 'video/webm']);
const MEDIA_PATH = /^[A-Za-z0-9._][A-Za-z0-9._/-]{0,239}$/;
const naturalOrder = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

interface Budget { files: number; bytes: number; pixels: number }
interface MediaAsset { blob: Blob; contentType: string }
interface Picture { source: CanvasImageSource; width: number; height: number }
interface PaintFrame { picture: Picture; x: number; y: number; width: number; height: number; duration: number }
interface PetScene { frames: PaintFrame[]; label: string }
interface BackgroundScene { kind: 'image' | 'video'; url?: string; picture?: Picture }
type Cleanup = () => void;

const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);
const aborted = () => new DOMException('媒体读取已取消', 'AbortError');
function release(cleanups: Cleanup[]) { for (let cleanup = cleanups.pop(); cleanup; cleanup = cleanups.pop()) cleanup(); }
function assertActive(signal: AbortSignal) { if (signal.aborted) throw aborted(); }
function relativePath(value: unknown): string {
  if (typeof value !== 'string' || !MEDIA_PATH.test(value) || value.includes('..') || value.includes('//') || value.endsWith('/')) throw new Error('媒体清单包含不安全路径');
  return value;
}
function positiveInteger(value: unknown, label: string, maximum = 16384): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > maximum) throw new Error(`${label} 无效`);
  return value;
}
function duration(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 16 && value <= 60_000 ? value : fallback;
}
function installedHashes(resource: Data): Data {
  if (!isRecord(resource.fileHashes)) throw new Error('资源没有已安装文件的校验清单');
  return resource.fileHashes;
}
function checkedHash(hashes: Data, path: string): string {
  const value = hashes[path];
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value)) throw new Error(`媒体未列入已安装校验清单：${path}`);
  return value.toLowerCase();
}
async function resourceGet(context: ViewContext, id: string, signal: AbortSignal): Promise<Data> {
  const resource = await context.api.call('resources', 'get', { id }, { signal, scope: context.scope });
  assertActive(signal);
  if (!isRecord(resource) || resource.id !== id) throw new Error('宿主返回了不匹配的媒体资源');
  installedHashes(resource);
  return resource;
}
async function assetRead(context: ViewContext, resource: Data, rawPath: unknown, signal: AbortSignal, budget: Budget): Promise<MediaAsset> {
  const path = relativePath(rawPath), expected = checkedHash(installedHashes(resource), path);
  if (++budget.files > MAX_FILES) throw new Error('媒体帧数超过本次显示预算');
  const response = await context.api.call('resources', 'asset.read', { id: resource.id, path }, { signal, scope: context.scope });
  assertActive(signal);
  if (!isRecord(response) || response.id !== resource.id || response.path !== path || typeof response.hash !== 'string' || response.hash.toLowerCase() !== expected) throw new Error('媒体响应与资源校验清单不匹配');
  if (typeof response.contentType !== 'string' || (!IMAGE_TYPES.has(response.contentType) && !VIDEO_TYPES.has(response.contentType))) throw new Error('媒体类型不支持');
  if (typeof response.bytes !== 'number' || !Number.isInteger(response.bytes) || response.bytes < 1 || response.bytes > 16 * 1024 * 1024 || budget.bytes + response.bytes > MAX_BYTES) throw new Error('媒体超过本次显示大小预算');
  if (typeof response.base64 !== 'string' || response.base64.length > Math.ceil(response.bytes / 3) * 4 + 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(response.base64)) throw new Error('媒体编码无效');
  const raw = atob(response.base64);
  if (raw.length !== response.bytes) throw new Error('媒体字节数与读取回执不匹配');
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index++) bytes[index] = raw.charCodeAt(index);
  if (globalThis.crypto?.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    assertActive(signal);
    const actual = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    if (actual !== expected) throw new Error('浏览器媒体哈希校验失败');
  }
  budget.bytes += bytes.byteLength;
  return { blob: new Blob([bytes], { type: response.contentType }), contentType: response.contentType };
}
function objectUrl(blob: Blob, cleanups: Cleanup[]): string {
  const url = URL.createObjectURL(blob);
  cleanups.push(() => URL.revokeObjectURL(url));
  return url;
}
function chargePixels(width: number, height: number, budget: Budget) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 16384 || height > 16384 || budget.pixels + width * height > MAX_PIXELS) throw new Error('媒体解码尺寸超过显示预算');
  budget.pixels += width * height;
}
async function pictureRead(asset: MediaAsset, signal: AbortSignal, budget: Budget, cleanups: Cleanup[], animated = false): Promise<Picture> {
  if (!IMAGE_TYPES.has(asset.contentType)) throw new Error('宠物帧必须为位图');
  // ImageBitmap decodes the first frame, including GIF/animated WebP, and never keeps animating.
  if (!animated && typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(asset.blob);
    if (signal.aborted) { bitmap.close(); throw aborted(); }
    cleanups.push(() => bitmap.close());
    chargePixels(bitmap.width, bitmap.height, budget);
    return { source: bitmap, width: bitmap.width, height: bitmap.height };
  }
  const image = new Image();
  const url = objectUrl(asset.blob, cleanups);
  await new Promise<void>((resolve, reject) => {
    let finished = false;
    const finish = (error?: unknown) => {
      if (finished) return;
      finished = true;
      image.onload = null; image.onerror = null;
      signal.removeEventListener('abort', cancel);
      error ? reject(error) : resolve();
    };
    const cancel = () => { image.src = ''; finish(aborted()); };
    image.onload = () => finish();
    image.onerror = () => finish(new Error('浏览器无法解码媒体'));
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel(); else image.src = url;
  });
  cleanups.push(() => { image.src = ''; });
  chargePixels(image.naturalWidth, image.naturalHeight, budget);
  return { source: image, width: image.naturalWidth, height: image.naturalHeight };
}
function fullFrame(picture: Picture, ms: number): PaintFrame {
  return { picture, x: 0, y: 0, width: picture.width, height: picture.height, duration: ms };
}
function verifiedManifest(resource: Data): Data | undefined {
  if (resource.petManifest === undefined) return undefined;
  const verification = resource.petManifestVerification;
  if (!isRecord(resource.petManifest) || !isRecord(verification) || verification.verified !== true || verification.path !== 'pet.json' || typeof verification.hash !== 'string' || verification.hash.toLowerCase() !== checkedHash(installedHashes(resource), 'pet.json')) throw new Error('宠物清单没有通过安装完整性校验');
  return resource.petManifest;
}
async function petRead(context: ViewContext, id: string, signal: AbortSignal, reduceMotion: boolean, cleanups: Cleanup[]): Promise<PetScene> {
  const resource = await resourceGet(context, id, signal);
  if (resource.kind !== 'pet') throw new Error('所选资源不是宠物');
  const manifest = verifiedManifest(resource), hashes = installedHashes(resource);
  const budget: Budget = { files: 0, bytes: 0, pixels: 0 };
  const label = String(manifest?.displayName ?? resource.name ?? '宠物');
  const renderer = manifest?.renderer ?? resource.renderer;
  if (renderer === 'sprite2d') {
    const sprite = manifest?.sprite2d;
    if (!isRecord(sprite) || !isRecord(sprite.cell) || !isRecord(sprite.tracks) || !Array.isArray(sprite.frames)) throw new Error('宠物图集缺少明确的单元尺寸或轨道清单');
    const width = positiveInteger(sprite.cell.width, '图集帧宽'), height = positiveInteger(sprite.cell.height, '图集帧高');
    const columns = positiveInteger(sprite.columns, '图集列数', MAX_FILES), atlasRows = positiveInteger(sprite.atlasRows, '图集行数', MAX_FILES);
    const trackNames = Array.isArray(resource.tracks) && resource.tracks.every((item: unknown) => typeof item === 'string') ? resource.tracks as string[] : Object.keys(sprite.tracks);
    const name = trackNames.includes('idle') ? 'idle' : trackNames[0], row = trackNames.indexOf(name);
    if (row < 0 || row >= atlasRows || sprite.frames.length !== atlasRows || trackNames.length !== atlasRows) throw new Error('宠物轨道与图集行数不匹配');
    const count = positiveInteger(sprite.frames[row], '图集轨道帧数', columns);
    const track = isRecord(sprite.tracks[name]) ? sprite.tracks[name] as Data : {};
    const durations = Array.isArray(track.durations) ? track.durations : [];
    const defaultMs = duration(sprite.defaultFrameMs, 100);
    const picture = await pictureRead(await assetRead(context, resource, sprite.spritesheetPath, signal, budget), signal, budget, cleanups);
    if (picture.width !== width * columns || picture.height !== height * atlasRows) throw new Error('图集实际尺寸与宠物清单不匹配');
    const frames = Array.from({ length: reduceMotion ? 1 : count }, (_, index) => ({ picture, x: index * width, y: row * height, width, height, duration: duration(durations[index], defaultMs) }));
    return { frames, label };
  }
  if (renderer === 'frames2d') {
    const frames2d = manifest?.frames2d;
    if (!isRecord(frames2d) || !isRecord(frames2d.tracks)) throw new Error('逐帧宠物缺少帧目录与轨道清单');
    const dir = relativePath(frames2d.dir), phases = isRecord(frames2d.phases) ? frames2d.phases : {};
    const trackName = typeof phases.idle === 'string' && isRecord(frames2d.tracks[phases.idle]) ? phases.idle : isRecord(frames2d.tracks.idle) ? 'idle' : Object.keys(frames2d.tracks)[0];
    if (!trackName || !/^[A-Za-z0-9_-]{1,128}$/.test(trackName)) throw new Error('宠物没有可显示的待机轨道');
    const prefix = `${dir}/${trackName}/`;
    const paths = Object.keys(hashes).filter(path => path.startsWith(prefix) && !path.slice(prefix.length).includes('/') && /\.(png|jpe?g|webp|gif|avif)$/i.test(path)).sort(naturalOrder.compare);
    if (!paths.length || paths.length > MAX_FILES) throw new Error('宠物待机轨道没有帧或超出显示预算');
    const track = frames2d.tracks[trackName];
    if (!isRecord(track)) throw new Error('宠物待机轨道格式无效');
    const durations = Array.isArray(track.durations) ? track.durations : [];
    const defaultMs = duration(frames2d.defaultFrameMs, 100), frames: PaintFrame[] = [];
    // Sequential reads avoid flooding the shared RPC connection or racing its cancellation.
    for (const [index, path] of (reduceMotion ? paths.slice(0, 1) : paths).entries()) {
      const picture = await pictureRead(await assetRead(context, resource, path, signal, budget), signal, budget, cleanups);
      const suffixMs = path.match(/_(\d+)\.[^.]+$/)?.[1];
      frames.push(fullFrame(picture, duration(durations[index], duration(suffixMs ? Number(suffixMs) : undefined, defaultMs))));
    }
    return { frames, label };
  }
  if (renderer === 'image' && isRecord(resource.media)) {
    const picture = await pictureRead(await assetRead(context, resource, resource.media.path, signal, budget), signal, budget, cleanups, !reduceMotion);
    return { frames: [fullFrame(picture, 100)], label };
  }
  throw new Error('此宠物缺少可验证的 sprite2d、frames2d 或图像资源');
}
async function backgroundRead(context: ViewContext, id: string, path: string, signal: AbortSignal, reduceMotion: boolean, cleanups: Cleanup[]): Promise<BackgroundScene> {
  const resource = await resourceGet(context, id, signal), budget: Budget = { files: 0, bytes: 0, pixels: 0 };
  const asset = await assetRead(context, resource, path, signal, budget);
  if (VIDEO_TYPES.has(asset.contentType)) return { kind: 'video', url: objectUrl(asset.blob, cleanups) };
  return { kind: 'image', picture: await pictureRead(asset, signal, budget, cleanups, !reduceMotion) };
}
function PetCanvas({ scene, reduceMotion }: { scene: PetScene; reduceMotion: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const element = canvas.current, painter = element?.getContext('2d');
    if (!element || !painter || !scene.frames.length) return;
    let frameId = 0, index = 0, deadline = 0;
    const paint = () => {
      const frame = scene.frames[index];
      const scale = Math.min(1, 144 / frame.width, 152 / frame.height);
      const width = Math.max(1, Math.round(frame.width * scale)), height = Math.max(1, Math.round(frame.height * scale));
      if (element.width !== width || element.height !== height) { element.width = width; element.height = height; }
      painter.clearRect(0, 0, width, height);
      painter.drawImage(frame.picture.source, frame.x, frame.y, frame.width, frame.height, 0, 0, width, height);
    };
    const tick = (now: number) => {
      if (!document.hidden) {
        if (now >= deadline) {
          index = (index + 1) % scene.frames.length;
          deadline = now + scene.frames[index].duration;
        }
        paint();
      } else deadline = now + scene.frames[index].duration;
      frameId = requestAnimationFrame(tick);
    };
    paint();
    if (!reduceMotion) { deadline = performance.now() + scene.frames[0].duration; frameId = requestAnimationFrame(tick); }
    return () => cancelAnimationFrame(frameId);
  }, [scene, reduceMotion]);
  return <canvas ref={canvas} role="img" aria-label={`${scene.label}${reduceMotion ? '，静态显示' : ''}`} style={{ display: 'block', maxWidth: 144, maxHeight: 152, objectFit: 'contain' }} />;
}
function Background({ scene, reduceMotion }: { scene: BackgroundScene; reduceMotion: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null), video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const element = canvas.current, picture = scene.picture;
    if (!element || !picture) return;
    // Keep the real aspect ratio while bounding the decorative canvas allocation.
    const scale = Math.min(1, 1920 / picture.width, 1080 / picture.height);
    element.width = Math.max(1, Math.round(picture.width * scale)); element.height = Math.max(1, Math.round(picture.height * scale));
    const painter = element.getContext('2d');
    let frameId = 0;
    const paint = () => {
      if (!document.hidden) {
        painter?.clearRect(0, 0, element.width, element.height);
        painter?.drawImage(picture.source, 0, 0, element.width, element.height);
      }
      if (!reduceMotion) frameId = requestAnimationFrame(paint);
    };
    paint();
    return () => cancelAnimationFrame(frameId);
  }, [scene, reduceMotion]);
  useEffect(() => {
    const element = video.current;
    if (!element) return;
    const sync = () => {
      if (reduceMotion || document.hidden) { element.pause(); if (reduceMotion && element.readyState >= 1 && element.currentTime !== 0) element.currentTime = 0; }
      else { void element.play().catch(() => { /* A paused decoration remains usable when autoplay is unavailable. */ }); }
    };
    element.addEventListener('loadeddata', sync);
    document.addEventListener('visibilitychange', sync);
    sync();
    return () => { element.pause(); element.removeEventListener('loadeddata', sync); document.removeEventListener('visibilitychange', sync); };
  }, [scene, reduceMotion]);
  const style: React.CSSProperties = { width: '100%', height: '100%', objectFit: 'cover', display: 'block' };
  return <div className="nexus-resource-background" aria-hidden="true" style={{ position: 'absolute', inset: 0, zIndex: 0, pointerEvents: 'none', overflow: 'hidden', opacity: 0.14 }}>
    {scene.kind === 'video' ? <video ref={video} src={scene.url} muted loop playsInline preload="auto" tabIndex={-1} style={style} /> : scene.picture ? <canvas ref={canvas} style={style} /> : <img src={scene.url} alt="" draggable={false} style={style} />}
  </div>;
}

/** Put directly inside the positioned Nexus shell; keep business panels above its background. */
export function ResourceMedia({ context, config }: { context: ViewContext; config: Data }) {
  const generation = React.useSyncExternalStore(context.api.subscribe, context.api.getGeneration, context.api.getGeneration);
  const [hidden, setHidden] = useState({ pet: false, background: false });
  const [pet, setPet] = useState<PetScene>(), [background, setBackground] = useState<BackgroundScene>();
  const [petError, setPetError] = useState(''), [backgroundError, setBackgroundError] = useState('');
  const petId = config.petEnabled === true && typeof config.petId === 'string' ? config.petId : '';
  const backgroundAsset = config.backgroundEnabled === true && isRecord(config.backgroundAsset) ? config.backgroundAsset : undefined;
  const backgroundId = typeof backgroundAsset?.id === 'string' ? backgroundAsset.id : '';
  const backgroundPath = typeof backgroundAsset?.path === 'string' ? backgroundAsset.path : '';
  const reduceMotion = config.reduceMotion !== false;
  const sessionId = context.scope.sessionId, workspaceId = context.scope.workspaceId;
  const [systemReduceMotion, setSystemReduceMotion] = useState(() => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches);
  const effectiveReduceMotion = reduceMotion || systemReduceMotion;
  useEffect(() => {
    if (typeof matchMedia === 'undefined') return;
    const query = matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setSystemReduceMotion(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  useEffect(() => { setHidden({ pet: false, background: false }); }, [sessionId]);
  useEffect(() => {
    const controller = new AbortController(), cleanups: Cleanup[] = [];
    setPet(undefined); setPetError('');
    if (petId && !hidden.pet) void petRead(context, petId, controller.signal, effectiveReduceMotion, cleanups).then(scene => {
      if (!controller.signal.aborted) setPet(scene);
    }).catch(error => { release(cleanups); if (!controller.signal.aborted) setPetError(messageOf(error)); });
    return () => { controller.abort(); release(cleanups); };
  }, [context.api, generation, petId, hidden.pet, effectiveReduceMotion, sessionId, workspaceId, context.refreshToken, config.revision]);
  useEffect(() => {
    const controller = new AbortController(), cleanups: Cleanup[] = [];
    setBackground(undefined); setBackgroundError('');
    if (backgroundId && backgroundPath && !hidden.background) void backgroundRead(context, backgroundId, backgroundPath, controller.signal, effectiveReduceMotion, cleanups).then(scene => {
      if (!controller.signal.aborted) setBackground(scene);
    }).catch(error => { release(cleanups); if (!controller.signal.aborted) setBackgroundError(messageOf(error)); });
    return () => { controller.abort(); release(cleanups); };
  }, [context.api, generation, backgroundId, backgroundPath, hidden.background, effectiveReduceMotion, sessionId, workspaceId, context.refreshToken, config.revision]);
  const showPet = Boolean(petId) && !hidden.pet, showBackground = Boolean(backgroundId && backgroundPath) && !hidden.background;
  if (!showPet && !showBackground) return null;
  return <>
    {showBackground && background && <Background scene={background} reduceMotion={effectiveReduceMotion} />}
    <aside className="nexus-resource-pet" aria-label="本会话装饰媒体" style={{ position: 'relative', zIndex: 1, alignSelf: 'end', justifySelf: 'end', maxWidth: 176, padding: 8, pointerEvents: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
      {showPet && pet && <PetCanvas scene={pet} reduceMotion={effectiveReduceMotion} />}
      {(showPet && petError || showBackground && backgroundError) && <span role="status" style={{ fontSize: 12, color: 'var(--nexus-text-muted)', overflowWrap: 'anywhere' }}>{petError || backgroundError}</span>}
      {showPet && <button type="button" onClick={() => setHidden(value => ({ ...value, pet: true }))} style={{ pointerEvents: 'auto', fontSize: 12 }} aria-label="在本会话隐藏宠物">隐藏宠物</button>}
      {showBackground && <button type="button" onClick={() => setHidden(value => ({ ...value, background: true }))} style={{ pointerEvents: 'auto', fontSize: 12 }} aria-label="在本会话隐藏背景">隐藏背景</button>}
    </aside>
  </>;
}
