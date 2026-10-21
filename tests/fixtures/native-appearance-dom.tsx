import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { NativeBrandName, NativeHeroBrand } from '../../src/client/NativeBrand.js';
import { NativeAppearanceControls } from '../../src/client/NativeAppearanceControls.js';
import { ContextCompactionSettings } from '../../src/client/ContextCompactionSettings.js';
import { previewNativeAppearance, saveNativeAppearance } from '../../src/client/native-appearance.js';
import { NATIVE_APPEARANCE_DEFAULTS } from '../../src/shared/native-appearance.js';

function expect(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function element(selector: string) {
  const value = document.querySelector<HTMLElement>(selector);
  expect(value, `Missing fixture element: ${selector}`); return value;
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const roots: ReturnType<typeof createRoot>[] = [];
function mount(selector: string, node: React.ReactNode) {
  const root = createRoot(element(selector)); roots.push(root);
  flushSync(() => root.render(node)); return root;
}
function OfficialName({ nativeLabel }: { nativeLabel: string }) {
  return <span data-official-wordmark={nativeLabel}>Original DeepSeek wordmark <small>HARNESS</small></span>;
}
function AppearanceForm() {
  const [draft, update] = React.useState<Record<string, any>>({ ...NATIVE_APPEARANCE_DEFAULTS, sidebarBrandText: 'A custom brand' });
  return <NativeAppearanceControls draft={draft} update={value => update(old => ({ ...old, ...value }))} />;
}
const api: any = {
  subscribe: () => () => {}, getGeneration: () => 0,
  async call(domain: string, action: string) {
    if (domain === 'scope' && action === 'settings') return {
      local: { revision: 0, config: {} }, layers: [], effective: { enabled: true, defaults: { thresholdPercent: 80 } },
    };
    if (domain === 'context' && action === 'models/list') return { items: [{
      provider: 'local-directory', model: 'a-long-summary-model-name', capabilities: { contextWindow: { value: 1000000 } },
    }] };
    throw new Error(`Unexpected local fixture action: ${domain}/${action}`);
  },
};

async function run() {
  const bodyFont = getComputedStyle(document.body).fontFamily;
  flushSync(() => saveNativeAppearance(NATIVE_APPEARANCE_DEFAULTS));
  const hero = mount('#hero-mark', <NativeHeroBrand />);
  mount('#sidebar-wordmark', <NativeBrandName nativeComponent={OfficialName} nativeLabel="preserved" />);
  await settle();
  expect(element('#original-title').style.display !== 'none', 'Default hero title must remain native');
  expect(element('#sidebar-wordmark [data-official-wordmark]').dataset.officialWordmark === 'preserved', 'Default sidebar must reuse the official component and props');
  expect(element('#sidebar-wordmark').textContent?.match(/HARNESS/g)?.length === 1, 'Official wordmark already owns HARNESS');
  const custom = { homeTitle: 'Custom home title', homeBadgeText: 'Custom badge', sidebarBrandText: 'Custom sidebar' };
  flushSync(() => previewNativeAppearance(custom));
  await settle();
  expect(element('#hero-headline [data-nexus-home-title]').textContent === custom.homeTitle, 'Hero title must preview through the real mark slot wrapper');
  expect(element('#hero-headline [data-nexus-home-badge]').textContent === custom.homeBadgeText, 'Hero badge must preview through the real mark slot wrapper');
  expect(element('#original-title').style.display === 'none', 'Native title must be hidden only while the custom seat exists');
  expect(element('#unrelated-headline').textContent?.includes('Unrelated native title'), 'Other headlines must remain unchanged');
  expect(!document.querySelector('#sidebar-wordmark [data-official-wordmark]'), 'Custom text must use its own seat');
  expect(element('#sidebar-wordmark [data-nexus-sidebar-brand-text]').textContent === custom.sidebarBrandText, 'Custom sidebar text must render literally');
  flushSync(() => { saveNativeAppearance(custom); previewNativeAppearance(); });
  await settle();
  expect(element('#hero-headline [data-nexus-home-title]').textContent === custom.homeTitle, 'Saved title must survive preview dismissal');
  flushSync(() => previewNativeAppearance({ ...custom, homeBadgeEnabled: false }));
  expect(element('#original-badge').style.display === 'none' && !document.querySelector('[data-nexus-home-badge]'), 'Disabled hero badge must reserve no text seat');
  flushSync(() => { saveNativeAppearance(NATIVE_APPEARANCE_DEFAULTS); previewNativeAppearance(); });
  await settle();
  expect(element('#sidebar-wordmark [data-official-wordmark]'), 'Restoring default text must restore the official wordmark');
  expect(element('#original-title').style.display !== 'none' && element('#original-badge').style.display !== 'none', 'Defaults must restore the native title and badge');
  expect(!document.querySelector('[data-nexus-home-title]'), 'Default title must remove the custom seat');
  flushSync(() => previewNativeAppearance(custom));
  flushSync(() => hero.unmount());
  expect(element('#original-title').style.display !== 'none', 'Unmount must restore the original native title');
  expect(!document.querySelector('[data-nexus-home-title]'), 'Unmount must remove portal seats');
  flushSync(() => previewNativeAppearance());

  for (const id of ['direct-header-pane', 'wrapped-header-pane']) {
    const pane = element(`#${id}`), header = element(`#${id} header`), root = element(`#${id} [data-phase]`);
    const scroll = element(`#${id} [data-conversation-scroll]`);
    expect(getComputedStyle(header).position === 'sticky', `${id}: header must be sticky across either slot shape`);
    expect(getComputedStyle(root).minHeight === '0px' && getComputedStyle(root).overflow === 'hidden', `${id}: root must constrain its own scrollport`);
    const before = header.getBoundingClientRect().top;
    scroll.scrollTop = 500; await settle();
    expect(scroll.scrollTop > 0, `${id}: fixture history must actually scroll`);
    expect(Math.abs(header.getBoundingClientRect().top - before) < 1, `${id}: scrolling history must leave header in place`);
    expect(header.getBoundingClientRect().bottom <= scroll.getBoundingClientRect().top + 1, `${id}: header must reserve space above history`);
    expect(pane.scrollHeight <= pane.clientHeight + 1, `${id}: history must not overflow the pane`);
  }
  for (const id of ['direct-child-pane', 'wrapped-child-pane']) {
    const nav = element(`#${id} [data-nexus-subagent-views]`), scroll = element(`#${id} [data-conversation-scroll]`);
    expect(getComputedStyle(nav).position === 'sticky' && getComputedStyle(nav).flexShrink === '0', `${id}: child view strip must remain sticky and retain its height`);
    expect(element(`#${id} .host_viewArea`).getBoundingClientRect().top >= nav.getBoundingClientRect().bottom - 1, `${id}: child navigation must reserve space before history`);
    scroll.scrollTop = 500; await settle();
    expect(scroll.scrollTop > 0, `${id}: fixture child history must actually scroll`);
    expect(Math.abs(nav.getBoundingClientRect().top - scroll.getBoundingClientRect().top) < 1, `${id}: child navigation must stay at the resident scrollport top`);
  }

  mount('#appearance-settings', <AppearanceForm />);
  mount('#compression-settings', <ContextCompactionSettings api={api} scope={{ level: 'global' }} />);
  await settle(); await settle();
  const shell = element('#settings-shell');
  for (const width of [820, 543, 400]) {
    shell.style.width = `${width}px`; await settle();
    if (width === 543) {
      expect(Math.abs(element('.nexus-settings-content').getBoundingClientRect().width - 503) < 1, 'The desktop regression must exercise an actual 503px content column');
      expect(parseFloat(getComputedStyle(element('.nexus-settings-content > h2')).fontSize) <= 20, 'Settings section heading must remain compact');
    }
    for (const selector of ['[data-nexus-native-appearance-controls]', '[data-nexus-context-compaction]']) {
      const form = element(selector);
      expect(form.scrollWidth <= form.clientWidth + 1, `${width}: settings must fit their content column`);
      for (const row of form.querySelectorAll<HTMLElement>('.nexus-setting-row')) {
        if (width === 543) expect(getComputedStyle(row).gridTemplateColumns.split(/\s+/).length === 2, '503px settings content must retain separate label and control columns');
        expect(row.scrollWidth <= row.clientWidth + 1, `${width}: setting labels and controls must not overflow`);
        for (const control of row.querySelectorAll<HTMLElement>('input, select, button')) {
          const bounds = control.getBoundingClientRect(), rowBounds = row.getBoundingClientRect();
          expect(bounds.left >= rowBounds.left - 1 && bounds.right <= rowBounds.right + 1, `${width}: controls must stay inside the setting row`);
        }
      }
    }
  }
  expect(getComputedStyle(document.body).fontFamily === bodyFont, 'Brand customization must not replace the body font');
  for (const root of roots.slice(1).reverse()) flushSync(() => root.unmount());
}

void run().then(
  () => { document.documentElement.dataset.nexusFixture = btoa(JSON.stringify({ ok: true })); },
  error => { document.documentElement.dataset.nexusFixture = btoa(JSON.stringify({ ok: false, error: String(error?.stack ?? error) })); },
);
