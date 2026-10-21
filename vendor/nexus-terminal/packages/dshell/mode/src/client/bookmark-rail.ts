/**
 * The right-edge turn rail.
 *
 * One mark per agent turn in the current session, drawn from the block fold
 * (the same fold the column renders). The shape follows dsh's own turn
 * navigator — ui-chat's TurnNavigator — rather than dshell's earlier panel:
 * a fixed-pitch ladder of 20x2 pills in the right gutter, right-aligned so the
 * marks share one edge, and a preview card that opens to the left of the
 * ladder while the pointer or focus is on a mark.
 *
 * Geometry, states, motion, and the tokens are the host's: the ladder is
 * vertically centred on the seat, caps at 420px and scrolls inside that frame
 * with 24px mask fades, marks are 10px apart with 6px of inset per end, and a
 * mark scales its pill in on hover (0.6 → 0.9), on the reader's own turn
 * (1.0, in `--dsw-alias-label-primary`), and while a turn is running (a 1s
 * pulse). Keyboard focus takes the brand colour, which the resting ladder
 * never uses. Copy that reaches the reader is locale-owned.
 *
 * Two things the host's rail does not carry, because they are dshell's:
 * a failed turn keeps the error colour instead of the neutral one, and a
 * running turn is the newest one, so the pulse marks live work. The rail
 * hides itself when the session has fewer than two turns: a ladder of one
 * mark navigates nowhere.
 */

import { createElement, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { TurnBlock } from './blocks.js'
import { agentItemOf } from './block-model.js'
import { sanitizeRowText } from './session-rows.js'

/** Rail width. The pill is 20px of it; the rest is the mark's hit area. */
const FRAME_WIDTH = 28
/** Distance from the seat's right edge, matching the host navigator. */
const FRAME_RIGHT = 12
/** Fixed pitch between neighbouring marks; overflow scrolls inside the frame. */
const MARK_PITCH = 10
/** Rail padding above the first mark and below the last, per end. */
const MARK_INSET = 6
/** Height of a mark's pill, and the hit band it sits in. */
const PILL_WIDTH = 20
const PILL_HEIGHT = 2
/** Fade band the mask reserves at a scrollable end. */
const FADE_PX = 24
/** The ladder's own ceiling; taller ladders scroll instead of running away. */
const LADDER_MAX = 420
/** Room the ladder leaves for the session's header and composer. */
const LADDER_RESERVE = 64
/** The preview card's height, which its clamp and centring both use. */
const PREVIEW_HEIGHT = 100
/** Text a preview body keeps before the card's own clamp takes over. */
const BODY_MAX = 220
/** Below this seat width the ladder is hidden, as the host hides its own. */
const NARROW_SEAT = 900
/**
 * Grace period between the cursor leaving a mark and the preview closing. The
 * path from one mark to the next crosses a 10px pitch, so an immediate close
 * would flicker on the way.
 */
const CLOSE_DELAY_MS = 90
/**
 * A click sets the active mark and the geometry rule must not override that
 * pick while the smooth scroll is in flight: the scroll's own events would
 * otherwise pick whichever larger neighbour takes over the viewport first.
 */
const CLICK_STICKY_MS = 1500

/**
 * One bookmark: a turn in the current session, with the request's first line
 * as its title and the first lines of the answer as its body. Both are read
 * from the durable rows, since a streaming line is, by definition, not the
 * text the bookmark would point at.
 */
export interface Bookmark {
  /** Block key: stable identity for the mark, and the jump target. */
  readonly key: string
  /** First non-empty line of the request; the preview's title row. */
  readonly prompt: string
  /** First lines of the turn's answer; empty hides the body row. */
  readonly response: string
  /** The turn's state, for the mark's colour and pulse. */
  readonly status: TurnBlock['status']
}

/** Collapse a row's display text to one line, truncated with an ellipsis. */
function oneLine(text: string, fallback: string): string {
  const line = sanitizeRowText(text).split('\n').map(part => part.trim()).find(part => part.length > 0) ?? ''
  if (line.length === 0) return fallback
  return line.length > BODY_MAX ? `${line.slice(0, BODY_MAX - 1)}…` : line
}

/** Collapse a row's display text to a short body: blank lines dropped, then capped. */
function fewLines(text: string): string {
  const kept = sanitizeRowText(text).split('\n').map(part => part.trim()).filter(part => part.length > 0)
  const joined = kept.slice(0, 3).join('\n')
  return joined.length > BODY_MAX ? `${joined.slice(0, BODY_MAX - 1)}…` : joined
}

/** Build the ladder the rail renders, oldest first; fold order is the same.
 *
 * Only blocks that render as agent cards are bookmarked. Slash-command blocks
 * (a permission switch and friends) draw one quiet marker line with no card
 * and no jump anchor, and collapsed no-op turns draw nothing at all — a mark
 * for either would read as an empty conversation.
 * @param blocks - the fold's turn blocks, oldest first.
 * @param emptyLabel - what the preview says for a request with no text.
 * @returns one bookmark per agent turn, in fold order.
 */
export function bookmarksOf(blocks: readonly TurnBlock[], emptyLabel: string): readonly Bookmark[] {
  const out: Bookmark[] = []
  for (const block of blocks) {
    const item = agentItemOf(block)
    if (item === undefined || item.kind !== 'agent') continue
    const asked = block.rows.find(row => row.role === 'user')
    const answered = block.rows.find(row => row.role === 'assistant')
    out.push({
      key: block.key,
      prompt: oneLine(asked?.text ?? block.title, emptyLabel),
      response: answered === undefined ? '' : fewLines(answered.text),
      status: block.status,
    })
  }
  return out
}

/**
 * Resolve the agent block element for a bookmark, then scroll the container
 * so the block sits near the top of the column. The block elements are tagged
 * with `data-dshell-block-key` on the column, and the container is the same
 * scroll element the column manages.
 * @param scroll - the column's scroll container, when mounted.
 * @param key - the bookmark's block key.
 * @returns whether a target was found and scrolled to.
 */
function scrollToBlock(scroll: HTMLDivElement | null, key: string): boolean {
  if (scroll === null) return false
  const target = scroll.querySelector(`[data-dshell-block-key="${CSS.escape(key)}"]`)
  if (!(target instanceof HTMLElement)) return false
  // Place the block 8px below the container's top edge — close enough that the
  // folded header is visible without the content feeling cut off. The browser
  // scrolls the nearest scrollable ancestor of `target`, which is `scroll`.
  const containerTop = scroll.getBoundingClientRect().top
  const targetTop = target.getBoundingClientRect().top
  const desired = scroll.scrollTop + (targetTop - containerTop) - 8
  scroll.scrollTo({ top: Math.max(0, desired), behavior: 'smooth' })
  return true
}

/**
 * Pick the block the reader is currently reading.
 *
 * The answer is the block whose body occupies the largest share of the
 * container's visible region — the block the reader's eyes are on, which
 * is also the block a click jump puts the user on (the click target fills
 * the viewport from just below the top down to its bottom).
 *
 * "Visible height" is the part of the block that lies inside the
 * container's visible region: `min(r.bottom, containerBottom) - max(r.top,
 * containerTop)`, clipped to zero when the block is entirely above or
 * below the viewport. The block with the greatest visible height wins. If
 * no block has any visible height, there is no answer.
 * @param scroll - the column's scroll container, when mounted.
 * @param keys - the bookmark keys to consider, oldest first.
 * @returns the dominating block's key, or undefined when none is visible.
 */
function activeBlockKey(scroll: HTMLDivElement | null, keys: readonly string[]): string | undefined {
  if (scroll === null || keys.length === 0) return undefined
  const r = scroll.getBoundingClientRect()
  const top = r.top
  const bottom = r.bottom
  let bestKey: string | undefined
  let bestVisible = 0
  for (const key of keys) {
    const el = scroll.querySelector(`[data-dshell-block-key="${CSS.escape(key)}"]`)
    if (!(el instanceof HTMLElement)) continue
    const br = el.getBoundingClientRect()
    const visible = Math.max(0, Math.min(br.bottom, bottom) - Math.max(br.top, top))
    if (visible > bestVisible) {
      bestVisible = visible
      bestKey = key
    }
  }
  return bestKey
}

/** Whether the reader asked their platform to skip decorative motion. */
function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * Inject the rail's stylesheet once per page.
 *
 * The host navigator's own styles are CSS Modules in another package, so they
 * cannot be imported; these rules restate its measurements, states, and tokens
 * under dshell's own attribute scope. Every value comes from `--dsw-*` aliases
 * that the host publishes on `<body>`, so the rail follows dsh's light and
 * dark surfaces without dshell resolving either.
 */
export function injectBookmarkCss(): void {
  if (typeof document === 'undefined' || document.getElementById('dshell-bookmark-css') !== null) return
  const style = document.createElement('style')
  style.id = 'dshell-bookmark-css'
  style.textContent = `
[data-dshell-bookmark-rail]{position:absolute;inset:0;z-index:2;pointer-events:none;container-type:inline-size;}
[data-dshell-bookmark-frame]{position:absolute;top:50%;right:${String(FRAME_RIGHT)}px;width:${String(FRAME_WIDTH)}px;
  max-height:min(max(0px,calc(100% - ${String(LADDER_RESERVE)}px)),${String(LADDER_MAX)}px);
  transform:translateY(-50%);contain:layout;cursor:pointer;pointer-events:auto;}
[data-dshell-bookmark-scroller]{position:relative;max-height:inherit;overflow-y:auto;
  overscroll-behavior:contain;scrollbar-width:none;}
[data-dshell-bookmark-scroller]::-webkit-scrollbar{display:none;}
[data-dshell-bookmark-scroller][data-fade-top]{mask-image:linear-gradient(to bottom,transparent 0,#000 ${String(FADE_PX)}px,#000 100%);}
[data-dshell-bookmark-scroller][data-fade-bottom]{mask-image:linear-gradient(to bottom,#000 0,#000 calc(100% - ${String(FADE_PX)}px),transparent 100%);}
[data-dshell-bookmark-scroller][data-fade-top][data-fade-bottom]{mask-image:linear-gradient(to bottom,transparent 0,#000 ${String(FADE_PX)}px,#000 calc(100% - ${String(FADE_PX)}px),transparent 100%);}
[data-dshell-bookmark-marks]{position:relative;}
[data-dshell-bookmark-mark]{position:absolute;left:0;right:0;height:${String(MARK_PITCH)}px;padding:0;
  border:0;border-radius:8px;background:transparent;cursor:pointer;}
[data-dshell-bookmark-mark]::before{position:absolute;top:50%;right:0;width:${String(PILL_WIDTH)}px;height:${String(PILL_HEIGHT)}px;
  border-radius:2px;background:var(--dsw-alias-border-l4);content:'';transform:translateY(-50%) scaleX(0.6);
  transform-origin:right center;transition:transform 140ms ease,background-color 140ms ease;}
[data-dshell-bookmark-mark][data-state=preview]::before{transform:translateY(-50%) scaleX(0.9);background:var(--dsw-alias-label-tertiary);}
[data-dshell-bookmark-mark][data-state=active]::before{transform:translateY(-50%) scaleX(1);background:var(--dsw-alias-label-primary);}
[data-dshell-bookmark-mark][data-failed]::before{background:var(--dsw-alias-state-error-primary);}
[data-dshell-bookmark-mark][data-busy]::before{animation:dshell-bookmark-busy 1s ease-in-out infinite;}
[data-dshell-bookmark-mark]:focus-visible{outline:none;}
[data-dshell-bookmark-mark]:focus-visible::before{transform:translateY(-50%) scaleX(1);
  background:var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));}
[data-dshell-bookmark-mark]:focus-visible::after{position:absolute;inset:0 0 0 auto;width:${String(PILL_WIDTH)}px;
  border-radius:inherit;outline:1px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));
  outline-offset:-1px;content:'';}
[data-dshell-bookmark-preview]{position:absolute;right:calc(100% + 10px);box-sizing:border-box;
  width:min(300px,calc(100cqw - 120px));max-height:${String(PREVIEW_HEIGHT)}px;overflow:hidden;padding:10px 12px;
  border:0;border-radius:var(--dsw-radius-lg);color:var(--dsw-alias-label-primary);
  background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-panel);pointer-events:none;
  animation:dshell-bookmark-preview-enter 120ms ease-out;transition:top 140ms cubic-bezier(0.2,0.8,0.2,1);}
[data-dshell-bookmark-prompt]{display:-webkit-box;overflow:hidden;-webkit-box-orient:vertical;
  -webkit-line-clamp:1;font:var(--dsw-font-xs-strong-13);}
[data-dshell-bookmark-response]{display:-webkit-box;overflow:hidden;-webkit-box-orient:vertical;
  -webkit-line-clamp:3;margin-top:4px;color:var(--dsw-alias-label-caption);font:var(--dsw-font-xxs-12);}
@keyframes dshell-bookmark-busy{0%,100%{opacity:1;}50%{opacity:0.35;}}
@keyframes dshell-bookmark-preview-enter{from{opacity:0;transform:translateX(4px);}to{opacity:1;transform:translateX(0);}}
@media (prefers-reduced-motion:reduce){
  [data-dshell-bookmark-frame],[data-dshell-bookmark-scroller],[data-dshell-bookmark-mark]::before,
  [data-dshell-bookmark-preview]{transition:none;animation:none;}
}
@container (max-width:${String(NARROW_SEAT)}px){[data-dshell-bookmark-frame]{display:none;}}`
  document.head.append(style)
}

/** Props the block view passes in. */
export interface BookmarkRailProps {
  /** The bookmarks to show, oldest first; fewer than two hides the rail. */
  bookmarks: readonly Bookmark[]
  /** The scroll container the agent blocks live in, for jump targeting. */
  scrollContainer: HTMLDivElement | null
  /** Called when the user jumps to a bookmark — unsticks the tail-pin. */
  onJump: () => void
  /** Translator for the marks' accessible names. */
  t: TranslateNS<'dshellMode'>
}

/**
 * One mark: a button in the ladder whose pill carries the turn's state.
 *
 * The button is the rail's full width and one pitch tall, so the hit area is
 * larger than the 20x2 pill drawn inside it. `onPointerMove` (not enter) is
 * what opens the preview: moving between neighbouring marks then needs no
 * leave/enter pair, which is what keeps the card from flickering as the
 * pointer travels down the ladder.
 */
function Mark(props: {
  bookmark: Bookmark
  index: number
  active: boolean
  busy: boolean
  described: boolean
  label: string
  previewId: string
  onPreview: (key: string) => void
  onNavigate: (key: string) => void
  onFocusChange: (key: string | null) => void
}): ReactElement {
  const { bookmark, index } = props
  return createElement('button', {
    type: 'button',
    'data-dshell-bookmark-mark': '',
    'data-status': bookmark.status,
    'data-state': props.active ? 'active' : props.described ? 'preview' : 'idle',
    ...bookmark.status === 'failed' ? { 'data-failed': '' } : {},
    ...props.busy ? { 'data-busy': '' } : {},
    'aria-label': props.label,
    ...props.active ? { 'aria-current': 'true' } : {},
    ...props.busy ? { 'aria-busy': 'true' } : {},
    ...props.described ? { 'aria-describedby': props.previewId } : {},
    style: { top: MARK_INSET - MARK_PITCH / 2 + index * MARK_PITCH },
    onPointerMove: () => { props.onPreview(bookmark.key) },
    onClick: () => { props.onNavigate(bookmark.key) },
    onFocus: () => { props.onFocusChange(bookmark.key) },
    onBlur: () => { props.onFocusChange(null) },
  })
}

/**
 * The right-edge turn ladder.
 *
 * State: `activeKey` is the turn the reader is on — set by a click, then kept
 * up to date from the geometry of what the column shows. `previewKey` is the
 * mark the pointer or focus is on, which is the only thing that opens the
 * preview card. The ladder centres the active mark only while the pointer is
 * elsewhere, so it never moves under the hand that is using it.
 */
export function BookmarkRail(props: BookmarkRailProps): ReactElement | null {
  const { bookmarks } = props
  const [previewKey, setPreviewKey] = useState<string | null>(null)
  const [fades, setFades] = useState({ top: false, bottom: false })
  const [previewTop, setPreviewTop] = useState(0)
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const pointerInsideRef = useRef(false)
  const closeTimer = useRef<number | undefined>(undefined)
  const clickedAt = useRef(0)
  const previewId = useId()

  const keys = useMemo(() => bookmarks.map(b => b.key), [bookmarks])
  const lastKey = keys[keys.length - 1]
  const ladderHeight = bookmarks.length * MARK_PITCH + 2 * (MARK_INSET - MARK_PITCH / 2)

  // Reset interaction state when the session changes — identified by the key
  // set, since block keys are stable per session. A fresh session's preview
  // should not leak across from the previous one.
  const identity = keys.join('|')
  useEffect(() => { setPreviewKey(null); pointerInsideRef.current = false }, [identity])

  // The key the rail treats as "you are reading this turn". Initialised to the
  // most recent turn so a brand-new session highlights what the reader just
  // watched arrive; the scroll observer below takes over once they move.
  const [activeKey, setActiveKey] = useState<string | undefined>(() => lastKey)
  useEffect(() => { setActiveKey(lastKey) }, [lastKey])
  const activeIndex = activeKey === undefined ? undefined : keys.indexOf(activeKey)
  const previewIndex = previewKey === null ? undefined : keys.indexOf(previewKey)

  useLayoutEffect(() => { injectBookmarkCss() }, [])

  // Track the block that dominates the viewport and update `activeKey` as the
  // reader scrolls. An IntersectionObserver is the right tool: it is driven by
  // the layout engine, not by a 16ms timer, and it needs no per-scroll
  // arithmetic. We observe the column's agent blocks; the callback runs when
  // any of them crosses a threshold. A single threshold at the container's top
  // is enough — the rest of the rule is in `activeBlockKey`.
  useEffect(() => {
    const scroll = props.scrollContainer
    if (scroll === null || keys.length === 0) return
    const recompute = (): void => {
      if (Date.now() - clickedAt.current < CLICK_STICKY_MS) return
      const next = activeBlockKey(scroll, keys)
      if (next !== undefined) setActiveKey(prev => prev === next ? prev : next)
    }
    recompute()
    const observer = new IntersectionObserver(() => { recompute() }, {
      root: scroll,
      // Only the very top of the container matters for "what is the reader
      // looking at"; the bottom is already covered by following the tail.
      rootMargin: '0px 0px -100% 0px',
      threshold: [0, 0.01, 0.5, 1],
    })
    for (const key of keys) {
      const el = scroll.querySelector(`[data-dshell-block-key="${CSS.escape(key)}"]`)
      if (el instanceof HTMLElement) observer.observe(el)
    }
    // The click-sticky window suppresses geometry-based recomputation while the
    // smooth scroll is in flight. A trusted `wheel` event is the natural moment
    // the user takes over, and that is when the sticky should end — earlier
    // than the timeout, when the user is already moving, so the highlight
    // follows without lag.
    const onWheel = (event: WheelEvent): void => {
      if (event.isTrusted !== true) return
      clickedAt.current = 0
      recompute()
    }
    const onScroll = (): void => { recompute() }
    scroll.addEventListener('wheel', onWheel, { passive: true })
    scroll.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      observer.disconnect()
      scroll.removeEventListener('wheel', onWheel)
      scroll.removeEventListener('scroll', onScroll)
    }
  }, [props.scrollContainer, identity, keys])

  // The mask fades mark the ends the ladder can still scroll towards.
  const syncFades = useCallback((): void => {
    const scroller = scrollerRef.current
    if (scroller === null) return
    const top = scroller.scrollTop > 1
    const bottom = scroller.scrollTop < scroller.scrollHeight - scroller.clientHeight - 1
    setFades(prev => prev.top === top && prev.bottom === bottom ? prev : { top, bottom })
  }, [])

  useEffect(() => {
    const scroller = scrollerRef.current
    if (scroller === null) return
    syncFades()
    scroller.addEventListener('scroll', syncFades, { passive: true })
    const observer = typeof ResizeObserver === 'undefined'
      ? undefined
      : new ResizeObserver(() => { syncFades() })
    observer?.observe(scroller)
    return () => {
      scroller.removeEventListener('scroll', syncFades)
      observer?.disconnect()
    }
  }, [syncFades, ladderHeight])

  // Keep the reader's own mark centred, but never while the pointer is on the
  // ladder: moving the marks under the hand that is using them is worse than
  // an off-centre active mark. Marks already inside the fade-free band stay put.
  useEffect(() => {
    const scroller = scrollerRef.current
    if (scroller === null || activeIndex === undefined || pointerInsideRef.current) return
    const center = activeIndex * MARK_PITCH + MARK_INSET
    const top = scroller.scrollTop
    const height = scroller.clientHeight
    if (height <= 0) return
    if (center >= top + FADE_PX && center <= top + height - FADE_PX) return
    const max = Math.max(0, ladderHeight - height)
    const target = Math.max(0, Math.min(max, center - height / 2))
    scroller.scrollTo({ top: target, behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
    syncFades()
  }, [activeIndex, ladderHeight, syncFades])

  // The card opens beside the mark it describes. Its offset is read once per
  // preview, not on scroll: the card follows pointer and focus, and a ladder
  // that scrolls under a stationary pointer is the auto-centring case above,
  // which is suppressed while the pointer is inside.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current
    if (scroller === null || previewIndex === undefined) return
    const height = scroller.clientHeight
    const line = previewIndex * MARK_PITCH + MARK_INSET - scroller.scrollTop
    setPreviewTop(Math.max(0, Math.min(height - PREVIEW_HEIGHT, line - PREVIEW_HEIGHT / 2)))
  }, [previewIndex, identity])

  const cancelClose = useCallback((): void => {
    if (closeTimer.current !== undefined) {
      window.clearTimeout(closeTimer.current)
      closeTimer.current = undefined
    }
  }, [])
  const scheduleClose = useCallback((): void => {
    cancelClose()
    closeTimer.current = window.setTimeout(() => { setPreviewKey(null) }, CLOSE_DELAY_MS)
  }, [cancelClose])
  useEffect(() => () => cancelClose(), [cancelClose])

  if (bookmarks.length < 2) return null

  const preview = previewIndex === undefined ? undefined : bookmarks[previewIndex]
  const described = preview !== undefined
  return createElement('div', { 'data-dshell-bookmark-rail': '' },
    createElement('nav', {
      'data-dshell-bookmark-frame': '',
      'aria-label': props.t('bookmark.rail'),
      onPointerEnter: () => {
        pointerInsideRef.current = true
        cancelClose()
      },
      onPointerLeave: () => {
        pointerInsideRef.current = false
        scheduleClose()
      },
    },
      createElement('div', {
        ref: scrollerRef,
        'data-dshell-bookmark-scroller': '',
        ...fades.top ? { 'data-fade-top': '' } : {},
        ...fades.bottom ? { 'data-fade-bottom': '' } : {},
      },
        createElement('div', {
          'data-dshell-bookmark-marks': '',
          style: { height: ladderHeight },
        },
          ...bookmarks.map((bookmark, index) => createElement(Mark, {
            key: bookmark.key,
            bookmark,
            index,
            active: bookmark.key === activeKey,
            busy: bookmark.key === lastKey && bookmark.status === 'running',
            described: described && bookmark.key === previewKey,
            label: props.t('bookmark.jump', { turn: index + 1 }),
            previewId,
            onPreview: (key: string) => { cancelClose(); setPreviewKey(key) },
            onNavigate: (key: string) => {
              if (!scrollToBlock(props.scrollContainer, key)) return
              // Optimistic: jump immediately so the highlight follows the click
              // without waiting for the observer's next tick. The observer
              // re-confirms once the smooth scroll settles and the guard expires.
              clickedAt.current = Date.now()
              setActiveKey(key)
              props.onJump()
            },
            onFocusChange: (key: string | null) => {
              setPreviewKey(key)
              if (key !== null) pointerInsideRef.current = true
            },
          })),
        ),
      ),
      preview === undefined ? null : createElement('div', {
        id: previewId,
        role: 'tooltip',
        'data-dshell-bookmark-preview': '',
        style: { top: previewTop },
      },
        createElement('div', { 'data-dshell-bookmark-prompt': '' }, preview.prompt),
        preview.response === '' ? null : createElement('div', { 'data-dshell-bookmark-response': '' }, preview.response),
      ),
    ),
  )
}
