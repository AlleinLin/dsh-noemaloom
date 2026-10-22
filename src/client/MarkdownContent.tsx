import * as React from 'react';
import DOMPurify, { type Config } from 'dompurify';
import { marked, Renderer } from 'marked';

const MARKDOWN_SANITIZE_OPTIONS = {
  ALLOWED_TAGS: [
    'a', 'blockquote', 'br', 'code', 'del', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'hr', 'li', 'ol', 'p', 'pre', 'strong', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'ul',
  ],
  ALLOWED_ATTR: ['href', 'title', 'colspan', 'rowspan'],
  FORBID_ATTR: ['style'],
  RETURN_TRUSTED_TYPE: false,
} satisfies Config;

function escapeHtml(source: string): string {
  return source.replace(/[&<>"']/gu, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]!);
}

export function parseMarkdown(source: string): string {
  const renderer = new Renderer();
  renderer.html = ({ text }) => escapeHtml(text);
  return marked.parse(source, {
    async: false,
    breaks: true,
    gfm: true,
    renderer,
  });
}

export function sanitizeMarkdown(source: string): string {
  if (!DOMPurify.isSupported) return escapeHtml(source);
  return DOMPurify.sanitize(parseMarkdown(source), MARKDOWN_SANITIZE_OPTIONS);
}

export function MarkdownContent({ source }: { source: string }) {
  const html = React.useMemo(() => sanitizeMarkdown(source), [source]);
  return <div className="nexus-markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}
