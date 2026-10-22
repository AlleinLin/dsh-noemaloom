import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import DOMPurify from 'dompurify';
import { MarkdownContent } from '../../src/client/MarkdownContent.js';
import styles from '../../src/client/companion.css';

function expect(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function element(selector: string) {
  const value = document.querySelector<HTMLElement>(selector);
  expect(value, `Missing element: ${selector}`); return value;
}
const source = [
  '## 证据范围', '', '**原始事实** 与 `inline code`', '', '- 第一项', '- 第二项', '',
  '1. 一手材料', '2. 独立检验', '', '> 引用', '', '```ts', 'const value = "<script>";',
  'x'.repeat(180), '```', '', '| 名称 | 状态 |', '| --- | --- |', '| 结果 | 完成 |', '',
  '[正常链接](https://example.com/ "说明")', '',
  '[危险链接](javascript:alert%281%29)', '',
  '<script>window.__nexusMarkdownExecuted = true</script>', '',
  '<img src=x onerror="window.__nexusMarkdownExecuted = true">', '',
  '<svg onload="window.__nexusMarkdownExecuted = true"></svg>', '',
  '<style>body{display:none}</style>', '',
  '<a id="nexus-host" onclick="alert(1)">fake</a>', '',
  '![远程图片](https://example.invalid/tracker.png)',
].join('\n');
let root: ReturnType<typeof createRoot> | undefined;
try {
  expect(DOMPurify.isSupported, 'The regression must run the real supported DOMPurify implementation');
  root = createRoot(document.getElementById('root')!);
  flushSync(() => root!.render(<section className="nexus-companion" style={{ width: 320 }}>
    <style>{styles}</style>
    <details open className="nexus-companion-reflection">
      <summary>规划前 · 更深的问题</summary><MarkdownContent source={source} />
    </details>
  </section>));
  expect(element('.nexus-markdown h2').textContent === '证据范围', 'Headings must render');
  expect(element('.nexus-markdown strong').textContent === '原始事实', 'Bold must render');
  expect(element('.nexus-markdown ul li').textContent === '第一项', 'Unordered lists must render');
  expect(element('.nexus-markdown ol li').textContent === '一手材料', 'Ordered lists must render');
  expect(getComputedStyle(element('.nexus-markdown ul')).listStyleType === 'disc', 'Native resets must not hide bullets');
  expect(getComputedStyle(element('.nexus-markdown ol')).listStyleType === 'decimal', 'Native resets must not hide numbering');
  expect(element('.nexus-markdown blockquote').textContent?.trim() === '引用', 'Blockquotes must render');
  expect(element('.nexus-markdown pre code').textContent?.includes('const value = "<script>";'), 'Code must remain literal');
  const code = element('.nexus-markdown pre');
  expect(code.scrollWidth > code.clientWidth && getComputedStyle(code).overflowX === 'auto', 'Long code must scroll in its own block');
  expect(element('.nexus-markdown th').textContent === '名称', 'GFM tables must render');
  expect(element('.nexus-markdown td').textContent === '结果', 'Table data must render');
  expect(element('.nexus-markdown a').getAttribute('href') === 'https://example.com/', 'Safe links must survive sanitization');
  const unsafe = Array.from(document.querySelectorAll('.nexus-markdown a')).find(link => link.textContent === '危险链接');
  expect(unsafe && !unsafe.hasAttribute('href'), 'Dangerous Markdown links must lose their href');
  expect(!document.querySelector('.nexus-markdown script,.nexus-markdown img,.nexus-markdown svg,.nexus-markdown style'), 'Active HTML and remote images must not enter the DOM');
  expect(!document.querySelector('.nexus-markdown [onerror],.nexus-markdown [onclick],.nexus-markdown [id]'), 'Model attributes must not affect the host DOM');
  expect(!(window as any).__nexusMarkdownExecuted, 'Model content must never execute');
  expect(element('.nexus-markdown').textContent?.includes('<script>window.'), 'Raw HTML must remain readable as text');
  const container = element('.nexus-companion');
  expect(container.scrollWidth <= container.clientWidth + 1, 'Markdown must fit a narrow native conversation column');
  flushSync(() => root!.render(<MarkdownContent source="**更新后的内容**" />));
  expect(element('.nexus-markdown strong').textContent === '更新后的内容', 'A changed reflection must update the memoized rendering');
  document.body.setAttribute('data-nexus-fixture', btoa(JSON.stringify({ ok: true })));
} catch (error) {
  document.body.setAttribute('data-nexus-fixture', btoa(JSON.stringify({
    ok: false, error: error instanceof Error ? error.stack : String(error),
  })));
} finally {
  root?.unmount();
}
