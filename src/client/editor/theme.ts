import type { editor } from 'monaco-editor';
import { claudeThemeTokens } from '../native-theme-tokens.js';

export const EDITOR_THEME = 'nexus-native';
type ThemeEditor = Pick<typeof editor, 'defineTheme' | 'setTheme'>;
const subscriptions = new WeakMap<Document, { refs: number; sync(): void; dispose(): void }>();

/** Monaco requires hex colors; host tokens may contain rgb(), color-mix(), etc. */
function hexColor(value: string, fallback: string, context: CanvasRenderingContext2D | null): string {
  const hex = /^#([\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.exec(value)?.[1];
  if (hex) return `#${hex.length < 5 ? [...hex].map(char => char + char).join('') : hex}`;
  if (!context || !value.trim()) return fallback;
  context.clearRect(0, 0, 1, 1);
  context.fillStyle = fallback;
  context.fillStyle = value; // Invalid CSS colors leave the fallback in place.
  context.fillRect(0, 0, 1, 1);
  const rgba = [...context.getImageData(0, 0, 1, 1).data];
  return `#${rgba.slice(0, rgba[3] === 255 ? 3 : 4).map(channel => channel.toString(16).padStart(2, '0')).join('')}`;
}

/** One subscription for all native tabs and diff panes, using DSH's body tokens. */
export function watchEditorTheme(monaco: ThemeEditor, doc: Document = document): () => void {
  let subscription = subscriptions.get(doc);
  if (!subscription) {
    const view = doc.defaultView!;
    const canvas = doc.createElement('canvas'); canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    let lastKey = '';
    const sync = () => {
      const root = doc.documentElement, body = doc.body;
      const style = view.getComputedStyle(body ?? root);
      const markedDark = body?.hasAttribute('data-ds-dark-theme')
        || root.hasAttribute('data-ds-dark-theme')
        || [body, root].some(element => element?.classList.contains('dark') || element?.dataset.theme === 'dark');
      const background = hexColor(style.getPropertyValue('--dsw-alias-bg-base').trim(),
        claudeThemeTokens[markedDark ? 'dark' : 'light']['--dsw-alias-bg-base'], context);
      // The rendered palette is authoritative, including third-party host skins.
      const channels = [1, 3, 5].map(offset => parseInt(background.slice(offset, offset + 2), 16) / 255);
      const dark = channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722 < .5;
      const defaults = claudeThemeTokens[dark ? 'dark' : 'light'];
      const color = (token: keyof typeof defaults) =>
        hexColor(style.getPropertyValue(token).trim(), defaults[token], context);
      const foreground = color('--dsw-alias-label-primary');
      const accent = color('--dsw-alias-brand-primary');
      const layer = color('--dsw-alias-bg-layer-1');
      const border = color('--dsw-alias-border-l2');
      const definition: editor.IStandaloneThemeData = {
        base: dark ? 'vs-dark' : 'vs', inherit: true, rules: [],
        colors: {
          'editor.background': background,
          'editor.foreground': foreground,
          'editorGutter.background': background,
          'editorLineNumber.foreground': color('--dsw-alias-label-tertiary'),
          'editorLineNumber.activeForeground': foreground,
          'editorCursor.foreground': accent,
          'editor.selectionBackground': dark ? '#6f4b3d' : '#ead7ca',
          'editor.inactiveSelectionBackground': dark ? '#4c3d36' : '#ede2d8',
          'editor.lineHighlightBackground': color('--dsw-alias-bg-layer-2'),
          'editor.lineHighlightBorder': '#00000000',
          'editorOverviewRuler.background': background,
          'minimap.background': background,
          'editorWidget.background': layer,
          'editorWidget.foreground': foreground,
          'editorWidget.border': border,
          'editorHoverWidget.background': layer,
          'editorHoverWidget.foreground': foreground,
          'editorHoverWidget.border': border,
          'input.background': background,
          'input.foreground': foreground,
          'input.border': border,
          'focusBorder': accent,
          'button.background': accent,
          'button.foreground': background,
          'list.activeSelectionBackground': color('--dsw-alias-accent-soft'),
          'list.activeSelectionForeground': foreground,
          'list.hoverBackground': color('--dsw-alias-interactive-bg-hover'),
          'scrollbarSlider.background': color('--dsw-alias-scrollbar-bg-l2'),
          'scrollbarSlider.hoverBackground': color('--dsw-alias-scrollbar-hover-l2'),
          'diffEditorGutter.insertedLineBackground': dark ? '#4c8a4538' : '#4c8a4524',
          'diffEditorGutter.removedLineBackground': dark ? '#bf615138' : '#bf615124',
          'diffEditor.insertedLineBackground': dark ? '#4c8a4528' : '#4c8a451a',
          'diffEditor.removedLineBackground': dark ? '#bf615128' : '#bf61511a',
          'diffEditor.insertedTextBackground': dark ? '#4c8a4548' : '#4c8a4530',
          'diffEditor.removedTextBackground': dark ? '#bf615148' : '#bf615130',
          'diffEditor.diagonalFill': border,
          'diffEditor.unchangedRegionBackground': layer,
          'diffEditor.unchangedRegionForeground': foreground,
          'diffEditor.unchangedCodeBackground': background,
        },
      };
      const key = JSON.stringify(definition);
      if (key === lastKey) return;
      monaco.defineTheme(EDITOR_THEME, definition);
      monaco.setTheme(EDITOR_THEME);
      lastKey = key;
    };
    const observer = new view.MutationObserver(sync);
    const attributes = { attributes: true, attributeFilter: ['class', 'data-theme', 'data-ds-dark-theme', 'style'] };
    observer.observe(doc.documentElement, attributes);
    if (doc.body) observer.observe(doc.body, attributes);
    // Skin insertion/removal changes inherited tokens without changing body attributes.
    view.addEventListener('nexus:theme', sync);
    subscription = { refs: 0, sync, dispose() {
      observer.disconnect();
      view.removeEventListener('nexus:theme', sync);
      subscriptions.delete(doc);
    } };
    subscriptions.set(doc, subscription);
  }
  subscription.refs++;
  subscription.sync(); // Before createEditor/createDiffEditor: no initial white flash.
  const retained = subscription;
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    if (--retained.refs === 0) retained.dispose();
  };
}
