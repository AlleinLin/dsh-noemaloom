import { watchEditorTheme } from '../../src/client/editor/theme.js';
import { claudeThemeCss } from '../../src/client/native-theme-tokens.js';

async function run() {
  const check = (value: unknown, message: string) => { if (!value) throw new Error(message); };
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  const skin = document.createElement('style');
  skin.dataset.nexusNativeTheme = 'claude'; skin.textContent = claudeThemeCss;
  document.body.append(skin);
  // Reproduce the host: html remains light while the native body theme is dark.
  document.documentElement.style.setProperty('--dsw-alias-bg-base', '#faf9f5');
  document.body.setAttribute('data-ds-dark-theme', '');
  let current: any, definitions = 0;
  const monaco = { defineTheme(_name: string, data: any) { current = data; definitions++; }, setTheme() {} };
  const first = watchEditorTheme(monaco);
  const second = watchEditorTheme(monaco);
  check(definitions === 1, 'Split editors should share a theme subscription');
  check(current.base === 'vs-dark', 'The body-only host dark marker must select dark Monaco syntax');
  check(current.colors['editor.background'] === '#262624', 'Dark DSH must never open a white editor');
  check(current.colors['editor.foreground'] === '#f0eee6', 'The editor must read inherited body text tokens');
  check(current.colors['editorGutter.background'] === '#262624', 'Line numbers must share the editor background');
  check(current.colors['editorWidget.background'] === '#30302e', 'Find and hover widgets must stay dark');
  check(current.colors['diffEditor.unchangedCodeBackground'] === '#262624', 'Diff unchanged areas must stay dark');
  const dark = current;

  document.body.removeAttribute('data-ds-dark-theme'); await tick();
  check(current.base === 'vs', 'Switching body to light should update all editors without reopening');
  check(current.colors['editor.background'] === '#faf9f5', 'Light editor must match DSH cream');
  document.body.setAttribute('data-ds-dark-theme', ''); await tick();
  check(current.base === 'vs-dark', 'Switching back to dark should update existing diff panes');

  first(); first();
  document.body.style.setProperty('--dsw-alias-bg-base', 'rgb(32, 33, 34)', 'important');
  document.body.style.setProperty('--dsw-alias-brand-primary', '#d97', 'important'); await tick();
  check(current.colors['editor.background'] === '#202122', 'RGB host tokens must not fall back to light');
  check(current.colors['editorCursor.foreground'] === '#dd9977', 'Short hex host tokens must be supported');
  check(current.base === 'vs-dark', 'Closing one tab must keep theme updates for other tabs');
  const before = definitions;
  const child = document.createElement('span'); child.style.color = 'red'; document.body.append(child);
  child.style.color = 'blue'; await tick();
  check(definitions === before, 'Editor DOM mutations must not cause theme rebuilds');

  document.body.removeAttribute('style');
  skin.remove();
  window.dispatchEvent(new Event('nexus:theme'));
  check(current.colors['editor.background'] === '#faf9f5', 'Skin removal should reread host tokens');
  check(current.base === 'vs', 'Monaco base must agree with the actual palette');
  document.body.append(skin);
  window.dispatchEvent(new Event('nexus:theme'));
  check(current.colors['editor.background'] === '#262624', 'Skin activation should resync without body mutation');
  for (const [key, value] of Object.entries(current.colors))
    check(/^#[\da-f]{6}([\da-f]{2})?$/i.test(value as string), `Invalid Monaco hex color: ${key}`);
  second();
  const stoppedAt = definitions;
  document.body.removeAttribute('data-ds-dark-theme'); await tick();
  check(definitions === stoppedAt, 'Closing the last editor must detach theme listeners');
  const reopened = watchEditorTheme(monaco);
  check(current.base === 'vs', 'Reopening should read the latest theme after unsubscribe');
  reopened();
  return { ok: true, darkBackground: dark.colors['editor.background'], definitions };
}
run().then(result => {
  document.documentElement.dataset.nexusFixture = btoa(JSON.stringify(result));
}, error => {
  document.documentElement.dataset.nexusFixture = btoa(JSON.stringify({ ok: false, error: String(error) }));
});
