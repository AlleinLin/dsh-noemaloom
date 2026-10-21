/**
 * Agent task card: the step timeline of one task, in the transcript style the
 * reader is used to — a header with how long the task took, thinking rows that
 * report their own duration, terminal calls as one-line monospace previews,
 * consecutive calls folded into a counted group, and a paired result opened as
 * a `$ command` + output card.
 */

import { createElement, useEffect, useMemo, useState, type ReactElement } from 'react'
import { TextShimmer } from '@deepseek-ai/dsh-client-ui-primitives'
import { WHALE_TAIL_PATH } from './dsh-icons.js'
import runningWhaleMask from './running-whale@2x.png'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { TurnBlock } from './blocks.js'
import { SESSION_ROW_KEY, sanitizeRowText, type SessionRow } from './session-rows.js'
import { SPAN_FONT, SPAN_FONT_SIZE } from './block-terminal.js'
import { renderMarkdown } from './markdown.js'
import type { MessageImageLoader } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { DshellModeKey } from './locales.js'
import type { Theme } from './theme.js'

/** The bound translator of this package's namespace. */
type ModeTranslate = TranslateNS<'dshellMode'>

/** A foldable row: one hover target, so the whole line reads as the control. */
const FOLD_STYLE = { margin: '0 -6px', padding: '1px 6px', borderRadius: '6px', cursor: 'pointer' } as const

let foldCssInjected = false

/** The plugin ships one client bundle, so the fold stylesheet is injected once. */
function injectFoldCss(): void {
  if (foldCssInjected || typeof document === 'undefined') return
  foldCssInjected = true
  const style = document.createElement('style')
  style.textContent = [
    // Hover affordance on the fold row.
    '[data-dshell-fold]:hover{background:rgba(127,127,127,.10)}',
    // Chevron rotation.
    '[data-dshell-chevron]{opacity:.65;transition:transform 120ms ease,opacity 120ms ease}',
    '[data-dshell-fold]:hover [data-dshell-chevron]{opacity:1}',
    '[data-dshell-running-text]{color:var(--dsw-alias-label-deep-diving);--dsw-alias-label-shimmer:var(--dsw-alias-label-deep-diving-shimmer)}',
    '[data-dshell-whale-animated]{display:none;position:absolute;inset:0}',
    '[data-dshell-whale-still]{display:initial}',
    '@supports (mask-mode:alpha) and (mask-image:url("")){',
    '  @media (prefers-reduced-motion:no-preference) and (forced-colors:none){',
    '    [data-dshell-whale-tail][data-running] [data-dshell-whale-animated]{display:block;background:currentColor;mask-position:center;mask-size:100% 100%;mask-repeat:no-repeat;mask-mode:alpha;will-change:transform}',
    '    [data-dshell-whale-tail][data-running] [data-dshell-whale-still]{display:none}',
    '  }',
    '}',
  ].join('\n')
  document.head.append(style)
}

type ToolStepModel = { key: string; label: string; command: string | undefined; output: string | undefined; images: readonly unknown[] | undefined }

/**
 * Resolves an attachment ref to a displayable URL. Spelled as the conversation
 * contract's own loader, so the service's implementation assigns without a
 * cast and the attachment shape stays that package's business.
 */
export type ImageLoader = MessageImageLoader
type Step =
  | { kind: 'text'; key: string; row: SessionRow; duration: number | undefined }
  | { kind: 'tool'; key: string; label: string; callGroup?: string | undefined; command: string | undefined; output: string | undefined; images: readonly unknown[] | undefined }
  | { kind: 'group'; key: string; label: string; items: ToolStepModel[] }

/** Tool names the reader knows by their job rather than their identifier. */
const TOOL_LABEL_KEY: Record<string, DshellModeKey> = {
  bash: 'tool.terminal', shell: 'tool.terminal', terminal: 'tool.terminal', exec: 'tool.terminal',
  execute_command: 'tool.terminal', run_command: 'tool.terminal', run_terminal_cmd: 'tool.terminal',
  read_file: 'tool.read', read: 'tool.read', write_file: 'tool.write', write: 'tool.write',
  edit_file: 'tool.edit', edit: 'tool.edit', replace: 'tool.edit', grep: 'tool.search', glob: 'tool.search',
}

/** Display name of a tool call. */
function toolLabel(name: string, t: ModeTranslate): string {
  const key = name.toLowerCase().replace(/[^a-z_]/gu, '')
  const labelKey = TOOL_LABEL_KEY[key]
  return labelKey === undefined ? name : t(labelKey)
}

/** Human duration: `11 秒`, `2 分 5 秒`, `1 小时 2 分`. */
export function formatDuration(t: ModeTranslate, ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return t('agent.duration.seconds', { seconds })
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return t('agent.duration.minutesSeconds', { minutes, seconds: seconds % 60 })
  return t('agent.duration.hoursMinutes', { hours: Math.floor(minutes / 60), minutes: minutes % 60 })
}

/**
 * Turn a task's rows into transcript steps: tool calls paired with their
 * results, runs of consecutive calls grouped, everything else kept in order.
 * @param rows - the block's rows, oldest first.
 * @param startedAt - when the task opened, the first row's baseline.
 * @param t - the bound translator, for the tool-call labels.
 * @param resultRows - the full task's rows, including results after steering.
 * @returns the steps, in display order.
 */
export function buildSteps(rows: readonly SessionRow[], startedAt: number, t: ModeTranslate, resultRows: readonly SessionRow[] = rows): Step[] {
  const results = new Map<string, SessionRow>()
  const calls = new Set<string>()
  for (const row of resultRows) {
    if (row.role === 'tool' && row.callId !== undefined) results.set(row.callId, row)
    if (row.role === 'call' && row.callId !== undefined) calls.add(row.callId)
  }
  const steps: Step[] = []
  for (const [index, row] of rows.entries()) {
    if (row.role === 'tool') {
      if (row.callId !== undefined && calls.has(row.callId)) continue
      steps.push({ kind: 'tool', key: row.key, label: toolLabel(row.label ?? t(SESSION_ROW_KEY.tool), t), command: undefined, output: row.text, images: row.images })
      continue
    }
    // A thinking row's span is the wait *before* it: thinking and the answer
    // it produces are sections of one event and share that event's timestamp.
    const previous = rows[index - 1]?.time ?? startedAt
    if (row.role === 'call') {
      const result = row.callId === undefined ? undefined : results.get(row.callId)
      steps.push({
        kind: 'tool',
        key: row.key,
        label: toolLabel(row.label ?? t(SESSION_ROW_KEY.call), t),
        callGroup: row.callGroup,
        command: row.command,
        output: result?.text,
        images: result?.images,
      })
      continue
    }
    steps.push({
      kind: 'text',
      key: row.key,
      row,
      duration: row.role === 'reasoning' ? Math.max(0, row.time - previous) : undefined,
    })
  }
  return groupRuns(steps, t)
}

/** A run of consecutive tool calls collapses to one counted group. */
function groupRuns(steps: readonly Step[], t: ModeTranslate): Step[] {
  const out: Step[] = []
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index]
    if (step === undefined) continue
    if (step.kind !== 'tool' || step.callGroup === undefined) { out.push(step); continue }
    const run: ToolStepModel[] = []
    let cursor = index
    for (let scan = steps[cursor]; scan?.kind === 'tool' && scan.callGroup === step.callGroup && scan.label === step.label; scan = steps[cursor]) {
      run.push({ key: scan.key, label: scan.label, command: scan.command, output: scan.output, images: scan.images })
      cursor += 1
    }
    if (run.length === 1 && run[0] !== undefined) {
      out.push({ kind: 'tool', key: run[0].key, label: run[0].label, command: run[0].command, output: run[0].output, images: run[0].images })
    } else if (run.length > 1) {
      out.push({ kind: 'group', key: `group:${run[0]?.key ?? String(index)}`, label: run[0]?.label ?? t('tool.terminal'), items: run })
    }
    index = cursor - 1
  }
  return out
}

/** Lines of a result card shown before it is clipped. */
const OUTPUT_LINES = 18

function clip(text: string, limit: number): { text: string; hidden: number } {
  const lines = text.split('\n')
  if (lines.length <= limit) return { text, hidden: 0 }
  return { text: lines.slice(0, limit).join('\n'), hidden: lines.length - limit }
}

/** A terminal call: one line folded, a `$ command` + output card expanded. */
function ToolStep(props: { step: Extract<Step, { kind: 'tool' }>; theme: Theme; loadImage: ImageLoader | undefined; t: ModeTranslate }): ReactElement {
  const { step, theme, t } = props
  const [open, setOpen] = useState(false)
  const preview = step.command ?? '…'
  const output = step.output === undefined ? undefined : sanitizeRowText(step.output)
  const clipped = output === undefined ? undefined : clip(output, OUTPUT_LINES)
  return createElement('div', { style: { margin: '2px 0' } },
    createElement('div', {
      'data-dshell-fold': '',
      onClick: () => { setOpen(value => !value) },
      style: {
        display: 'flex', alignItems: 'baseline', gap: '6px',
        fontFamily: SPAN_FONT, fontSize: SPAN_FONT_SIZE,
        ...FOLD_STYLE,
      },
    },
      createElement(ToolMark),
      createElement('span', {
        // Internal rows stay on the same tertiary label tier dsh's stock
        // command/thinking rows use. Brand colour is reserved for the fold
        // header's running shimmer — internal rows are archival regardless
        // of whether the parent block is still running; the parent's
        // sweep container is what signals "live".
        style: { color: 'var(--dsw-alias-label-tertiary)', flex: '0 0 auto' },
      }, step.label),
      createElement('span', {
        style: { color: theme.text, flex: '0 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      }, preview),
      step.output === undefined ? null : createElement(Chevron, { open, theme }),
    ),
    !open || clipped === undefined ? null : createElement('div', {
      style: {
        borderRadius: '6px',
        background: theme.inputBar,
        margin: '4px 0 4px 22px',
        padding: '6px 8px',
        fontFamily: SPAN_FONT,
        fontSize: SPAN_FONT_SIZE,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        color: theme.text,
      },
    },
      step.command === undefined ? null : createElement('div', { style: { color: theme.muted } }, `$ ${step.command}`),
      clipped.text,
      clipped.hidden > 0 ? createElement('div', { style: { color: theme.muted } }, t('agent.output.moreLines', { count: clipped.hidden })) : null,
    ),
    createElement(RowImages, { images: step.images, loadImage: props.loadImage, theme, t }),
  )
}

/**
 * The reader's own words: a right-aligned bubble, the way the transcript
 * separates who is speaking without labelling it.
 *
 * Exported because a just-sent message is rendered from the session's pending
 * submission echo — before it is durable, so the reader sees what they sent
 * while the model is still starting up — and it must look identical to the
 * durable row that replaces it.
 */
export function UserBubble(props: {
  text: string
  images?: readonly unknown[] | undefined
  /** A quiet marker above the text, for a message that answered a running turn. */
  label?: string | undefined
  loadImage: ImageLoader | undefined
  theme: Theme
  t: ModeTranslate
}): ReactElement {
  return createElement('div', {
    style: {
      borderRadius: '10px',
      background: props.theme.inputBar,
      padding: '7px 11px',
      margin: '6px 0 6px auto',
      width: 'fit-content',
      maxWidth: '78%',
      color: props.theme.text,
    },
  },
    props.label === undefined
      ? null
      : createElement('div', {
        style: { color: props.theme.muted, opacity: 0.8, marginBottom: 3 },
      }, props.label),
    createElement('div', { style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, sanitizeRowText(props.text)),
    createElement(RowImages, { images: props.images, loadImage: props.loadImage, theme: props.theme, t: props.t }),
  )
}

/**
 * Attachments carried by one row, resolved to URLs through the conversation
 * service. Rendering them is what lets the reader confirm the model was handed
 * the image at all.
 */
function RowImages(props: { images: readonly unknown[] | undefined; loadImage: ImageLoader | undefined; theme: Theme; t: ModeTranslate }): ReactElement | null {
  const { images, loadImage } = props
  const [urls, setUrls] = useState<readonly string[]>([])
  const key = JSON.stringify(images ?? [])
  useEffect(() => {
    if (images === undefined || images.length === 0 || loadImage === undefined) { setUrls([]); return }
    let live = true
    void Promise.all(images.map(image => loadImage(image as Parameters<ImageLoader>[0]).catch(() => '')))
      .then(resolved => { if (live) setUrls(resolved.filter(url => url.length > 0)) })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` stands in for the array identity
  }, [key, loadImage])
  if (urls.length === 0) return null
  return createElement('div', {
    'data-dshell-block-images': '',
    style: { display: 'flex', flexWrap: 'wrap', gap: '6px', margin: '6px 0 2px' },
  }, ...urls.map((url, index) => createElement('img', {
    key: `${url}:${String(index)}`,
    src: url,
    alt: props.t('agent.attachmentAlt'),
    onClick: () => { window.open(url, '_blank', 'noopener') },
    style: {
      maxWidth: 'min(420px, 100%)',
      maxHeight: '260px',
      borderRadius: '8px',
      border: `1px solid ${props.theme.border}`,
      cursor: 'zoom-in',
      objectFit: 'contain',
    },
  })))
}

/** A run of terminal calls: one counted line, the calls listed when opened. */
function ToolGroup(props: { step: Extract<Step, { kind: 'group' }>; theme: Theme; loadImage: ImageLoader | undefined; t: ModeTranslate }): ReactElement {
  const { step, theme, t } = props
  const [open, setOpen] = useState(false)
  return createElement('div', { style: { margin: '2px 0' } },
    createElement('div', {
      'data-dshell-fold': '',
      onClick: () => { setOpen(value => !value) },
      style: {
        display: 'flex', alignItems: 'baseline', gap: '6px',
        color: theme.muted, fontFamily: SPAN_FONT, fontSize: SPAN_FONT_SIZE,
        ...FOLD_STYLE,
      },
    },
      createElement(ToolMark),
      createElement('span', null, `${step.label} · `),
      createElement('span', {
        // The count is the only fresh fact in the row; bold pulls it
        // forward without a colour swap, so the rest of the transcript
        // doesn't gain a second accent tier.
        style: { fontWeight: 600, color: theme.muted },
      }, String(step.items.length)),
      createElement('span', null, t('agent.group.calls')),
      createElement(Chevron, { open, theme }),
    ),
    ...(open
      ? step.items.map(item => createElement('div', { key: item.key, style: { marginLeft: '20px' } },
          createElement(ToolStep, { step: { kind: 'tool', ...item }, theme, loadImage: props.loadImage, t })))
      : []),
  )
}

/** Prose and thinking steps. */
function TextStep(props: { step: Extract<Step, { kind: 'text' }>; theme: Theme; loadImage: ImageLoader | undefined; t: ModeTranslate }): ReactElement {
  const { step, theme, t } = props
  const row = step.row
  const [open, setOpen] = useState(false)
  if (row.role === 'reasoning') {
    return createElement('div', {
      'data-dshell-fold': '',
      onClick: () => { setOpen(value => !value) },
      style: { margin: '2px -6px', padding: '1px 6px', borderRadius: '6px', cursor: 'pointer' },
    },
      createElement('div', {
        style: { display: 'flex', alignItems: 'baseline', gap: '6px', color: theme.muted, fontSize: 12 },
      },
        createElement(ThinkMark),
        createElement(TextShimmer, { active: step.duration === undefined, children: t(SESSION_ROW_KEY.reasoning) }),
        step.duration === undefined ? null : createElement('span', null, t('agent.reasoning.duration', { duration: formatDuration(t, step.duration) })),
        createElement(Chevron, { open, theme }),
      ),
      open ? createElement('div', {
        style: { color: theme.muted, whiteSpace: 'pre-wrap', wordBreak: 'break-word', marginLeft: '20px', fontSize: 12 },
      }, sanitizeRowText(row.text)) : null,
    )
  }
  if (row.role === 'user') {
    return createElement('div', {
      style: {
        borderRadius: '10px',
        background: theme.inputBar,
        padding: '7px 11px',
        margin: '6px 0',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        color: theme.text,
      },
    }, sanitizeRowText(row.text))
  }
  return createElement('div', {
    style: {
      margin: '6px 0',
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
      lineHeight: 1.6,
      color: theme.text,
    },
  }, sanitizeRowText(row.text))
}

function WhaleMark(props: { running: boolean }): ReactElement {
  return createElement('span', {
    'data-dshell-whale-tail': '',
    'data-running': props.running ? '' : undefined,
    'aria-hidden': 'true',
    style: {
      position: 'relative', display: 'inline-flex', flex: '0 0 auto', alignSelf: 'center',
      width: 14, height: 14, contain: 'strict', overflow: 'hidden',
      color: props.running ? 'var(--dsw-alias-label-deep-diving)' : 'var(--dsw-alias-label-tertiary)',
    },
  },
    props.running ? createElement('span', {
      'data-dshell-whale-animated': '',
      style: { maskImage: `url("data:image/png;base64,${runningWhaleMask}")` },
    }) : null,
    createElement('svg', {
      'data-dshell-whale-still': '',
      width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none',
    }, createElement('path', { d: WHALE_TAIL_PATH, stroke: 'currentColor', strokeWidth: 1 })),
  )
}

/**
 * Internal-row mark for a thinking step: the dsh official `IconThinkOutline14`
 * glyph, inlined so this package does not have to take
 * `@deepseek-ai/dsh-client-ui-primitives` as a link dep. The path is
 * reproduced verbatim from
 * `dsh/packages/client/ui-primitives/src/icons/index.tsx`; the viewBox is
 * 14×14 and the mark fills the parent `currentColor` so it picks up the
 * row's label tier without a per-row rule.
 */
function ThinkMark(): ReactElement {
  return createElement('svg', {
    width: 14, height: 14, viewBox: '0 0 14 14', fill: 'none', 'aria-hidden': 'true',
    style: { flex: '0 0 auto', alignSelf: 'center', color: 'var(--dsw-alias-label-tertiary)' },
  },
    createElement('path', {
      d: 'M7.06431 5.93342C7.68763 5.93342 8.19307 6.43904 8.19322 7.06233C8.19322 7.68573 7.68772 8.19123 7.06431 8.19123C6.44099 8.19113 5.9354 7.68567 5.9354 7.06233C5.93555 6.43911 6.44108 5.93353 7.06431 5.93342Z',
      fill: 'currentColor',
    }),
    createElement('path', {
      fillRule: 'evenodd', clipRule: 'evenodd',
      d: 'M8.6815 0.963693C10.1169 0.447019 11.6266 0.374829 12.5633 1.31135C13.5 2.24805 13.4277 3.75776 12.911 5.19319C12.7126 5.74431 12.4386 6.31796 12.0965 6.89729C12.4969 7.54638 12.8141 8.19018 13.036 8.80647C13.5527 10.2419 13.6251 11.7516 12.6883 12.6883C11.7516 13.625 10.242 13.5527 8.8065 13.036C8.19022 12.8141 7.54641 12.4969 6.89732 12.0965C6.31797 12.4386 5.74435 12.7125 5.19322 12.911C3.75777 13.4276 2.2481 13.5 1.31138 12.5633C0.374859 11.6266 0.447049 10.1168 0.963724 8.68147C1.17185 8.10338 1.46321 7.50063 1.82896 6.8924C1.52182 6.35711 1.27235 5.82825 1.08872 5.31819C0.572068 3.88278 0.499714 2.37306 1.43638 1.43635C2.37308 0.499655 3.8828 0.572044 5.31822 1.08869C5.82828 1.27232 6.35715 1.5218 6.89243 1.82893C7.50066 1.46318 8.10341 1.17181 8.6815 0.963693ZM11.3573 8.01154C10.9083 8.62253 10.3901 9.22873 9.80943 9.8094C9.22877 10.3901 8.62255 10.9083 8.01158 11.3572C8.4257 11.5841 8.8287 11.7688 9.21275 11.9071C10.5456 12.3868 11.4246 12.2547 11.8397 11.8397C12.2548 11.4246 12.3869 10.5456 11.9071 9.21272C11.7688 8.82866 11.5841 8.42568 11.3573 8.01154ZM2.56529 8.02912C2.37344 8.39322 2.21495 8.74796 2.09263 9.08772C1.61291 10.4204 1.74512 11.2995 2.16001 11.7147C2.57505 12.1297 3.45415 12.2618 4.78697 11.7821C5.11057 11.6656 5.44786 11.5164 5.7938 11.3367C5.249 10.9223 4.70922 10.4533 4.19029 9.9344C3.57578 9.31987 3.03169 8.67633 2.56529 8.02912ZM6.90708 3.2469C6.24065 3.70479 5.5646 4.26321 4.91392 4.91389C4.26325 5.56456 3.70482 6.24063 3.24693 6.90705C3.72674 7.63325 4.32777 8.37459 5.03892 9.08576C5.64943 9.69627 6.28183 10.2265 6.90806 10.6678C7.59368 10.2025 8.2908 9.63076 8.96079 8.96076C9.6308 8.29075 10.2025 7.59366 10.6678 6.90803C10.2265 6.2818 9.69631 5.6494 9.08579 5.03889C8.37462 4.32773 7.63328 3.72672 6.90708 3.2469ZM11.7147 2.15998C11.2996 1.74509 10.4204 1.61288 9.08775 2.0926C8.74835 2.21479 8.39382 2.37271 8.03013 2.56428C8.67728 3.03065 9.31995 3.5758 9.93443 4.19026C10.4534 4.7092 10.9223 5.24896 11.3368 5.79377C11.5164 5.44785 11.6656 5.11052 11.7821 4.78694C12.2618 3.45416 12.1297 2.57502 11.7147 2.15998ZM4.91197 2.2176C3.57922 1.73788 2.70004 1.86995 2.28501 2.28498C1.87001 2.70003 1.73791 3.5792 2.21763 4.91194C2.31709 5.18822 2.44112 5.47427 2.58677 5.7674C3.01931 5.1887 3.51474 4.6158 4.06529 4.06526C4.61584 3.5147 5.18872 3.01928 5.76743 2.58674C5.47431 2.4411 5.18824 2.31706 4.91197 2.2176Z',
      fill: 'currentColor',
    }),
  )
}

/**
 * Internal-row mark for a generic tool call: the dsh official
 * `IconApiOutline14` glyph (the same `</api>`-style API plugin icon dsh's
 * stock `GenericCommandCard` uses), inlined for the same reason as
 * ThinkMark. The mark stays neutral on every row — dsh overlays a
 * `StateDot(state=error)` red dot on the rare errored tool row, but
 * dshell's fold body collapses error detail into the parent fold
 * header's left rail and "已中断" word, so the per-row mark never
 * needs an error tone here.
 */
function ToolMark(): ReactElement {
  return createElement('span', {
    style: {
      flex: '0 0 auto',
      alignSelf: 'center',
      position: 'relative',
      display: 'inline-flex',
      width: 14, height: 14,
      color: 'var(--dsw-alias-label-tertiary)',
    },
  },
    createElement('svg', {
      width: 14, height: 14, viewBox: '0 0 14 14', fill: 'none', 'aria-hidden': 'true',
      style: { position: 'absolute', inset: 0 },
    },
      createElement('path', {
        transform: 'translate(0.6689 1.073)',
        d: 'M11.4818 5.57813C11.4818 4.45301 11.4807 3.66237 11.4075 3.05908C11.3359 2.46953 11.2024 2.13852 10.9939 1.89441C10.9247 1.81341 10.8493 1.73801 10.7683 1.66882C10.5242 1.46033 10.1932 1.32686 9.60364 1.25525C9.00034 1.18198 8.20974 1.18091 7.0846 1.18091L5.57813 1.18091C4.45301 1.18091 3.66238 1.18198 3.05908 1.25525C2.46953 1.32686 2.13852 1.46033 1.89441 1.66882C1.81341 1.73801 1.73801 1.81341 1.66882 1.89441C1.46033 2.13852 1.32686 2.46953 1.25525 3.05908C1.18198 3.66238 1.18091 4.45301 1.18091 5.57813L1.18091 6.2771C1.18091 7.40218 1.18197 8.19288 1.25525 8.79614C1.32687 9.38553 1.46036 9.71674 1.66882 9.96082C1.73797 10.0417 1.81347 10.1173 1.89441 10.1864C2.13851 10.3948 2.46965 10.5275 3.05908 10.5991C3.66238 10.6724 4.45298 10.6735 5.57813 10.6735L7.0846 10.6735C8.20977 10.6735 9.00033 10.6724 9.60364 10.5991C10.1931 10.5275 10.5242 10.3948 10.7683 10.1864C10.8493 10.1173 10.9247 10.0417 10.9939 9.96082C11.2024 9.71674 11.3358 9.38553 11.4075 8.79614C11.4808 8.19288 11.4818 7.40218 11.4818 6.2771L11.4818 5.57813ZM12.6627 6.2771C12.6627 7.37222 12.6637 8.247 12.5798 8.93799C12.4942 9.64284 12.3133 10.2359 11.8928 10.7282C11.7834 10.8562 11.6637 10.9751 11.5356 11.0845C11.0434 11.5049 10.4511 11.6867 9.74634 11.7723C9.05525 11.8563 8.17999 11.8552 7.0846 11.8552L5.57813 11.8552C4.48273 11.8552 3.60747 11.8563 2.91638 11.7723C2.21157 11.6867 1.61933 11.5049 1.12708 11.0845C0.99901 10.9751 0.879281 10.8562 0.769898 10.7282C0.349454 10.2359 0.168506 9.64284 0.0828864 8.93799C-0.00101964 8.247 4.88512e-07 7.37222 6.47206e-07 6.2771L6.47206e-07 5.57813C6.47206e-07 4.48273 -0.00106163 3.60747 0.0828864 2.91638C0.168502 2.21168 0.349594 1.61928 0.769898 1.12708C0.879302 0.998981 0.998981 0.879302 1.12708 0.769898C1.61928 0.349594 2.21168 0.168502 2.91638 0.0828864C3.60747 -0.00106163 4.48273 6.47206e-07 5.57813 6.47206e-07L7.0846 6.47206e-07C8.17999 6.47206e-07 9.05525 -0.00106163 9.74634 0.0828864C10.451 0.168505 11.0434 0.349587 11.5356 0.769898C11.6637 0.879302 11.7834 0.998981 11.8928 1.12708C12.3131 1.61928 12.4942 2.21169 12.5798 2.91638C12.6638 3.60747 12.6627 4.48273 12.6627 5.57813L12.6627 6.2771Z',
        fill: 'currentColor',
      }),
      createElement('path', {
        transform: 'translate(0.6689 1.073)',
        d: 'M6.02607 5.50955L6.44306 5.9274L3.84284 8.52762L3.425 8.11063L3.00715 7.69278L4.77253 5.9274L3.00715 4.16202L3.84284 3.32633L6.02607 5.50955Z',
        fill: 'currentColor',
      }),
      createElement('path', {
        transform: 'translate(0.6689 1.073)',
        d: 'M9.23789 7.35397L9.23789 8.53488L6.96238 8.53488L6.96238 7.35397L9.23789 7.35397Z',
        fill: 'currentColor',
      }),
    ),
  )
}

/**
 * The one expand affordance. Every foldable row uses this: the same glyph, the
 * same size, rotated by CSS rather than swapped for a different character, so
 * open and closed read as one control instead of two.
 */
function Chevron(props: { open: boolean; theme: Theme }): ReactElement {
  return createElement('span', {
    'data-dshell-chevron': '',
    style: {
      display: 'inline-block',
      fontSize: 14,
      lineHeight: '14px',
      color: props.theme.muted,
      transform: props.open ? 'rotate(90deg)' : 'none',
      transition: 'transform 120ms ease',
    },
  }, '›')
}

/** Token count in the compact form the transcript uses. */
function formatTokens(tokens: number): string | undefined {
  if (tokens <= 0) return undefined
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k tok` : `${String(tokens)} tok`
}

/** One card's rows, cut into the request and the work it produced. */
interface CardSegment {
  /** Identity for the rendered nodes (React keys). */
  readonly key: string
  /** The human message that opened this segment; absent before the first one. */
  readonly ask: SessionRow | undefined
  /** Prose, thinking and tool rows in their original order. */
  readonly rows: readonly SessionRow[]
}

/**
 * Cut one card's rows into a segment per human message.
 *
 * A card is a turn, and a turn can take more than one human message: an
 * interjection steers the running turn instead of opening a card of its own
 * (see `foldEvent`). Cutting here is what lets the second request be drawn
 * after the work it interrupted — hoisting every request to the top of the card
 * would read as if it had been sent before that work. A card with one request
 * cuts into one segment and renders exactly as it always has.
 *
 * @param rows - the block's rows, in stream order.
 * @returns one segment per message, plus a single empty segment for the rows
 *   that precede the first message (a card opened by the turn itself).
 */
export function segmentsOf(rows: readonly SessionRow[]): CardSegment[] {
  const segments: CardSegment[] = []
  let ask: SessionRow | undefined
  let body: SessionRow[] = []
  const flush = (): void => {
    if (ask !== undefined || body.length > 0) {
      segments.push({
        key: ask === undefined ? `seg:${String(segments.length)}` : `seg:${ask.key}`,
        ask,
        rows: body,
      })
    }
    ask = undefined
    body = []
  }
  for (const row of rows) {
    if (row.role === 'user') { flush(); ask = row; continue }
    body.push(row)
  }
  flush()
  return segments.length > 0 ? segments : [{ key: 'seg:0', ask: undefined, rows: [] }]
}

/**
 * One agent task.
 *
 * Folding hides the *process* only. What the user asked and what the model
 * answered stay on screen either way; the thinking and the terminal calls
 * collapse behind a single summary line — `已工作 6 秒 · 1.2k tok ›` — the way
 * the transcript this is modelled on reads.
 */
export function AgentBlock(props: { block: TurnBlock; theme: Theme; loadImage: ImageLoader | undefined; t: ModeTranslate }): ReactElement {
  const { block, theme, t } = props
  const [expanded, setExpanded] = useState(false)
  const running = block.status === 'running'
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => { setNow(Date.now()) }, 1000)
    return () => { clearInterval(timer) }
  }, [running])
  useEffect(() => { injectFoldCss() }, [])
  const endedAt = block.notice?.time ?? now
  // The fold mutates `rows` in place, so the array identity stays put while a
  // step streams and its length is what says a row was appended. Cutting the
  // card into segments and rendering them here, rather than partitioning with
  // fresh filters, keeps that: one memo per streamed frame either way, and the
  // answers are parsed once.
  const segments = useMemo(() => segmentsOf(block.rows).map(segment => ({
    ...segment,
    steps: buildSteps(segment.rows, segment.ask?.time ?? block.startedAt, t, block.rows).map(step => ({
      step,
      answer: step.kind === 'text' && step.row.role === 'assistant' ? [
        ...renderMarkdown(sanitizeRowText(step.row.text), theme, step.row.key),
        createElement(RowImages, { key: `${step.key}:img`, images: step.row.images, loadImage: props.loadImage, theme, t }),
      ] : undefined,
    })),
  })), [block.rows, block.rows.length, block.startedAt, theme, props.loadImage, t])
  const tokens = formatTokens(block.tokens)
  const failed = block.status === 'failed' || block.status === 'aborted'
  // The live line the model is still writing. It renders through the same
  // paths, in the same position, as the durable rows that supersede it, so
  // settlement neither moves nor restyles the text.
  const stream = block.stream
  const liveReasoning = stream === undefined || stream.reasoning.length === 0
    ? null
    : createElement(TextStep, {
      key: 'stream:reason',
      step: {
        kind: 'text',
        key: 'stream:reason',
        row: {
          role: 'reasoning',
          key: 'stream:reason',
          text: stream.reasoning,
          collapsible: false,
          defaultCollapsed: false,
          time: stream.time,
          label: t(SESSION_ROW_KEY.reasoning),
        },
        duration: undefined,
      },
      theme,
      loadImage: props.loadImage,
      t,
    })
  const liveText = stream === undefined || stream.text.length === 0
    ? undefined
    : `${sanitizeRowText(stream.text)}${running ? '▍' : ''}`
  // The card reads request → work → answer, and a turn may take more than one
  // request (an interjection steers the running turn instead of opening a card
  // of its own), so each segment is drawn where it happened. The summary line
  // belongs to the card as a whole — it reports the whole turn's duration and
  // tokens — so it follows the first request, where it has always been.
  return createElement('div', {
    'data-dshell-block': 'agent',
    // The bookmark rail looks each block up by its stable key, so the
    // scroll-into-view can land on the right one.
    'data-dshell-block-key': block.key,
    // The same 13px the terminal regions render at, so an answer and the
    // stream it came from read at one size.
    style: { margin: '14px 0 18px', overflow: 'hidden', fontSize: SPAN_FONT_SIZE, lineHeight: 1.6 },
  },
    ...segments.flatMap((segment, index) => [
      segment.ask === undefined ? null : createElement(UserBubble, {
        key: segment.ask.key,
        text: segment.ask.text,
        images: segment.ask.images,
        label: segment.ask.label,
        loadImage: props.loadImage,
        theme,
        t,
      }),
      index > 0 ? null : createElement('div', {
        key: 'fold',
        'data-dshell-fold': '',
        onClick: () => { setExpanded(value => !value) },
        style: {
          display: 'flex', alignItems: 'baseline', gap: '6px',
          color: theme.muted, fontSize: 12,
          margin: '6px -6px 4px', padding: '1px 6px 1px 8px', borderRadius: '6px', cursor: 'pointer',
          borderLeft: failed ? '2px solid var(--dsw-alias-state-error-primary)' : '2px solid transparent',
        },
      },
        createElement(WhaleMark, { running }),
        running
          ? createElement('span', { 'data-dshell-running-text': '' },
              createElement(TextShimmer, { active: true, children: t('agent.running', { duration: formatDuration(t, endedAt - block.startedAt) }) }))
          : createElement('span', null,
              failed
                ? t('agent.interrupted', { duration: formatDuration(t, endedAt - block.startedAt) })
                : t('agent.worked', { duration: formatDuration(t, endedAt - block.startedAt) })),
        tokens === undefined ? null : createElement('span', null, `· ${tokens}`),
        createElement(Chevron, { open: expanded, theme }),
      ),
      ...segment.steps.map(({ step, answer }) => answer !== undefined
        ? createElement('div', { key: step.key, 'data-dshell-step-kind': 'answer' }, ...answer)
        : !expanded ? null : createElement('div', {
          key: step.key,
          'data-dshell-step-kind': step.kind,
        }, step.kind === 'tool'
          ? createElement(ToolStep, { step, theme, loadImage: props.loadImage, t })
          : step.kind === 'group'
            ? createElement(ToolGroup, { step, theme, loadImage: props.loadImage, t })
            : createElement(TextStep, { step, theme, loadImage: props.loadImage, t }))),
      expanded && index === segments.length - 1 ? liveReasoning : null,
    ].filter(node => node !== null)),
    liveText === undefined
      ? null
      : createElement('div', { 'data-dshell-stream': '' }, ...renderMarkdown(liveText, theme, 'stream')),
  )
}
