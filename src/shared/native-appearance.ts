export interface NativeAppearance {
  sidebarBrandText: string;
  sidebarBrandColor: string;
  homeTitle: string | null;
  homeBadgeEnabled: boolean;
  homeBadgeText: string | null;
}
export const NATIVE_APPEARANCE_DEFAULTS: Readonly<NativeAppearance> = Object.freeze({
  sidebarBrandText: 'deepseek', sidebarBrandColor: '#c66a4a',
  homeTitle: null, homeBadgeEnabled: true, homeBadgeText: null,
});
export function validateNativeAppearance(value: Record<string, any>): string | undefined {
  for (const [key, limit] of [['sidebarBrandText', 128], ['homeTitle', 512], ['homeBadgeText', 80]] as const) {
    const text = value[key];
    if (text === undefined || text === null && key !== 'sidebarBrandText') continue;
    if (typeof text !== 'string' || !text.trim() || text.length > limit || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(text)) {
      return `${key} 须为1–${limit}字符的文本`;
    }
  }
  if (value.sidebarBrandColor !== undefined && (typeof value.sidebarBrandColor !== 'string'
    || !/^#[0-9a-f]{6}$/i.test(value.sidebarBrandColor))) return '品牌颜色须为六位十六进制颜色，如 #c66a4a';
  if (value.homeBadgeEnabled !== undefined && typeof value.homeBadgeEnabled !== 'boolean') return '首页徽标开关须为布尔值';
}
export function nativeAppearance(value: Record<string, any> = {}): NativeAppearance {
  const result = { ...NATIVE_APPEARANCE_DEFAULTS };
  for (const key of Object.keys(result) as Array<keyof NativeAppearance>) {
    if (value[key] !== undefined && !validateNativeAppearance({ [key]: value[key] })) (result as any)[key] = value[key];
  }
  return result;
}
