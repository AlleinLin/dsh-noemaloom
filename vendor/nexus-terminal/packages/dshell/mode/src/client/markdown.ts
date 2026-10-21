/**
 * Markdown rendering for assistant answers.
 *
 * A model answer is written to be read — README-shaped, with headings, tables,
 * lists, fenced code and inline emphasis. Rendering it as pre-wrapped plain
 * text throws all of that away, so this renders the subset answers actually
 * use into the same DOM the rest of the view is built from.
 *
 * Deliberately not a full CommonMark implementation: no HTML passthrough, no
 * reference links, no nested block structures. The inline pass handles code,
 * emphasis, strikethrough and links; the block pass handles fenced code,
 * ATX headings, GFM tables, lists, blockquotes and rules.
 */

import { createElement, type ReactElement, type ReactNode } from 'react'
import { SPAN_FONT } from './block-terminal.js'
import type { Theme } from './theme.js'

/** Inline spans: code, bold, italic, strikethrough, links. */
const INLINE = /(`[^`]+`|!\[[^\]]*\]\([^)\s]+\)|\*\*[^*]+\*\*|__[^_]+__|\*[^*\n]+\*|_[^_\n]+_|~~[^~]+~~|\[[^\]]+\]\([^)\s]+\))/u

function inline(text: string, theme: Theme, key: string): ReactNode[] {
  const nodes: ReactNode[] = []
  let rest = text
  let index = 0
  for (let match = INLINE.exec(rest); match !== null; match = INLINE.exec(rest)) {
    if (match.index > 0) nodes.push(rest.slice(0, match.index))
    const token = match[0]
    const id = `${key}:i${String(index++)}`
    const inner = token.slice(token.startsWith('**') || token.startsWith('__') ? 2 : 1, token.length - (token.startsWith('**') || token.startsWith('__') || token.startsWith('~~') ? 2 : 1))
    if (token.startsWith('`')) {
      nodes.push(createElement('code', {
        key: id,
        style: {
          fontFamily: SPAN_FONT,
          fontSize: '0.92em',
          background: theme.inputBar,
          borderRadius: '4px',
          padding: '1px 5px',
        },
      }, token.slice(1, -1)))
    } else if (token.startsWith('**') || token.startsWith('__')) {
      nodes.push(createElement('strong', { key: id }, inner))
    } else if (token.startsWith('~~')) {
      nodes.push(createElement('span', { key: id, style: { textDecoration: 'line-through', opacity: 0.7 } }, inner))
    } else if (token.startsWith('*') || token.startsWith('_')) {
      nodes.push(createElement('em', { key: id }, inner))
    } else if (token.startsWith('![')) {
      const image = /^!\[([^\]]*)\]\(([^)\s]+)\)$/u.exec(token)
      nodes.push(createElement('img', {
        key: id,
        src: image?.[2] ?? '',
        alt: image?.[1] ?? '',
        style: { maxWidth: '100%', maxHeight: '320px', borderRadius: '8px', display: 'block', margin: '6px 0' },
      }))
    } else {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/u.exec(token)
      nodes.push(createElement('a', {
        key: id,
        href: link?.[2] ?? '#',
        target: '_blank',
        rel: 'noreferrer',
        style: { color: theme.accentText, textDecoration: 'underline' },
      }, link?.[1] ?? token))
    }
    rest = rest.slice(match.index + token.length)
  }
  if (rest.length > 0) nodes.push(rest)
  return nodes
}

// Headings scale from the 13px body both views share, so a rendered answer
// sits at the same optical size as the terminal text beside it.
const HEADING_SIZE = [18, 16, 14, 13.5, 13, 13]

/** A fenced code block, recessed so it reads as source rather than prose. */
function codeBlock(lines: readonly string[], theme: Theme, key: string): ReactElement {
  return createElement('pre', {
    key,
    style: {
      fontFamily: SPAN_FONT,
      fontSize: 12.5,
      lineHeight: 1.5,
      background: theme.inputBar,
      borderRadius: '6px',
      padding: '8px 10px',
      margin: '6px 0',
      overflowX: 'auto',
      whiteSpace: 'pre',
    },
  }, lines.join('\n'))
}

/** A GFM pipe table, with the separator row's alignment applied per column. */
function table(rows: readonly string[][], aligns: readonly (string | undefined)[], theme: Theme, key: string): ReactElement {
  const [head, ...body] = rows
  const cell = (text: string, column: number, header: boolean, cellKey: string): ReactElement =>
    createElement(header ? 'th' : 'td', {
      key: cellKey,
      style: {
        textAlign: (aligns[column] ?? 'left') as 'left',
        padding: '4px 10px',
        borderBottom: `1px solid ${theme.border}`,
        fontWeight: header ? 600 : 400,
        whiteSpace: 'nowrap',
      },
    }, inline(text, theme, cellKey))
  return createElement('div', { key, style: { overflowX: 'auto', margin: '6px 0' } },
    createElement('table', { style: { borderCollapse: 'collapse', fontSize: 13 } },
      createElement('thead', null, createElement('tr', null,
        ...(head ?? []).map((text, column) => cell(text, column, true, `${key}:h${String(column)}`)))),
      createElement('tbody', null,
        ...body.map((cells, rowIndex) => createElement('tr', { key: `${key}:r${String(rowIndex)}` },
          ...cells.map((text, column) => cell(text, column, false, `${key}:r${String(rowIndex)}c${String(column)}`))))),
    ),
  )
}

/** Split a table row on unescaped pipes. */
function cellsOf(line: string): string[] {
  return line.replace(/^\s*\|/u, '').replace(/\|\s*$/u, '').split(/(?<!\\)\|/u).map(cell => cell.trim().replace(/\\\|/gu, '|'))
}

/** Whether a line is a table's `|---|---|` separator, returning its alignments. */
function alignsOf(line: string): (string | undefined)[] | undefined {
  if (!/^\s*\|?[\s:-]*-[\s:|-]*\|?\s*$/u.test(line) || !line.includes('-')) return undefined
  return cellsOf(line).map(cell => (cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : 'left'))
}

const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/u
const HEADING = /^(#{1,6})\s+(.*)$/u
const RULE = /^\s*([-*_])\s*(\1\s*){2,}$/u

/**
 * Render markdown into elements.
 * @param text - the answer, with markdown syntax.
 * @param theme - the active palette.
 * @param keyPrefix - stable prefix for React keys.
 * @returns the rendered blocks, in order.
 */
export function renderMarkdown(text: string, theme: Theme, keyPrefix: string): ReactElement[] {
  const lines = text.split('\n')
  const out: ReactElement[] = []
  let paragraph: string[] = []
  let index = 0

  const flush = (): void => {
    if (paragraph.length === 0) return
    const key = `${keyPrefix}:p${String(index++)}`
    out.push(createElement('p', { key, style: { margin: '6px 0', lineHeight: 1.65 } }, inline(paragraph.join(' '), theme, key)))
    paragraph = []
  }

  for (let at = 0; at < lines.length; at += 1) {
    const line = lines[at] ?? ''
    const fence = /^\s*```(.*)$/u.exec(line)
    if (fence !== null) {
      flush()
      const body: string[] = []
      at += 1
      while (at < lines.length && !/^\s*```/u.test(lines[at] ?? '')) { body.push(lines[at] ?? ''); at += 1 }
      out.push(codeBlock(body, theme, `${keyPrefix}:c${String(index++)}`))
      continue
    }
    if (line.trim().length === 0) { flush(); continue }
    const heading = HEADING.exec(line)
    if (heading !== null) {
      flush()
      const level = (heading[1] ?? '#').length
      const key = `${keyPrefix}:h${String(index++)}`
      out.push(createElement(`h${String(Math.min(level + 1, 6))}`, {
        key,
        style: {
          fontSize: `${String(HEADING_SIZE[level - 1] ?? 14)}px`,
          fontWeight: level <= 2 ? 600 : 500,
          margin: at === 0 ? '0 0 6px' : '16px 0 6px',
          color: theme.text,
        },
      }, inline(heading[2] ?? '', theme, key)))
      continue
    }
    if (RULE.test(line)) {
      flush()
      out.push(createElement('div', { key: `${keyPrefix}:r${String(index++)}`, style: { height: 1, background: theme.border, margin: '12px 0' } }))
      continue
    }
    if (line.trimStart().startsWith('|') && at + 1 < lines.length) {
      const aligns = alignsOf(lines[at + 1] ?? '')
      if (aligns !== undefined) {
        flush()
        const rows: string[][] = [cellsOf(line)]
        at += 2
        while (at < lines.length && (lines[at] ?? '').trimStart().startsWith('|')) { rows.push(cellsOf(lines[at] ?? '')); at += 1 }
        at -= 1
        out.push(table(rows, aligns, theme, `${keyPrefix}:t${String(index++)}`))
        continue
      }
    }
    if (line.trimStart().startsWith('>')) {
      flush()
      const quote: string[] = []
      while (at < lines.length && (lines[at] ?? '').trimStart().startsWith('>')) {
        quote.push((lines[at] ?? '').replace(/^\s*>\s?/u, ''))
        at += 1
      }
      at -= 1
      const key = `${keyPrefix}:q${String(index++)}`
      out.push(createElement('blockquote', {
        key,
        style: { borderLeft: `3px solid ${theme.border}`, paddingLeft: '10px', margin: '6px 0', color: theme.muted },
      }, inline(quote.join(' '), theme, key)))
      continue
    }
    const item = LIST_ITEM.exec(line)
    if (item !== null) {
      flush()
      const ordered = /\d/u.test(item[2] ?? '')
      const items: string[] = []
      while (at < lines.length) {
        const next = LIST_ITEM.exec(lines[at] ?? '')
        if (next === null) break
        items.push(next[3] ?? '')
        at += 1
      }
      at -= 1
      const key = `${keyPrefix}:l${String(index++)}`
      out.push(createElement(ordered ? 'ol' : 'ul', {
        key,
        style: { margin: '6px 0', paddingLeft: '22px', lineHeight: 1.65 },
      }, ...items.map((entry, position) => createElement('li', { key: `${key}:${String(position)}` }, inline(entry, theme, `${key}:${String(position)}`)))))
      continue
    }
    paragraph.push(line.trim())
  }
  flush()
  return out
}
