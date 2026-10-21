/**
 * The data-directory picker: dshell's own folder dialog, because a page cannot
 * have the operating system's.
 *
 * The reader asked for a button rather than a text field, and they are right to
 * — but the browser has no access to the host's file system, and the harness is
 * not necessarily even on the machine drawing the page (a remote `dsh web`, the
 * desktop shell). What a page CAN do is ask the host to list a directory, which
 * is what `DSHELL_DIRS_PATH` is for; this dialog draws that answer as a picker:
 * a breadcrumb to walk up, a list to walk down, a field for a path typed or
 * pasted, and one button that takes the directory being shown.
 *
 * It follows the dialog shape the workspace's new-session dialog established —
 * fixed backdrop, click-outside to dismiss, Escape from anywhere inside, one
 * primary action on the right — rather than importing from it, because a client
 * plugin reaches another client plugin through slots and services, not through
 * value imports.
 *
 * What it does NOT do is decide anything durable: it hands a path back and the
 * card stores it. The dialog is usable the moment it opens because every
 * directory it shows is read on demand, and a directory it cannot read is
 * reported in the reader's language rather than as a failed request.
 */

import {
  createElement, useEffect, useState,
  type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactElement,
} from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { useDshellTheme, type Theme } from './theme.js'
// Type-only: pulls this namespace's key set (TranslateNS<'dshellMode'>).
import type {} from './locales.js'
import { DSHELL_DIRS_PATH, type DshellDirsEntry, type DshellDirsResponse } from '@nexus-aethra/dshell-std'

/** The dialog's own chrome, matching the workspace dialog's tokens. */
const backdropStyle: CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0, 0, 0, 0.55)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
}
const panelStyle: CSSProperties = {
  background: 'var(--dsw-alias-bg-layer-2)',
  border: '0.5px solid var(--dsw-alias-border-l4)', borderRadius: 10, padding: 18,
  width: 460, maxWidth: '90vw', display: 'flex', flexDirection: 'column', gap: 12,
}
const titleStyle: CSSProperties = { fontSize: 15, fontWeight: 600 }
const fieldStyle: CSSProperties = {
  background: 'var(--dsw-alias-bg-layer-1)', border: '0.5px solid var(--dsw-alias-border-l4)',
  borderRadius: 8, color: 'var(--dsw-alias-label-primary)', padding: '7px 9px',
  fontSize: 13, outline: 'none', width: '100%', boxSizing: 'border-box',
}
const crumbRowStyle: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap', fontSize: 12, minHeight: 20,
}
const crumbStyle: CSSProperties = {
  border: 'none', background: 'none', padding: '2px 4px', fontSize: 12, cursor: 'pointer',
  color: 'var(--dsw-alias-brand-primary)', borderRadius: 4,
}
const listStyle: CSSProperties = {
  maxHeight: 260, overflowY: 'auto', display: 'flex', flexDirection: 'column',
  border: '0.5px solid var(--dsw-alias-border-l4)', borderRadius: 8,
}
const entryStyle: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', border: 'none',
  background: 'none', color: 'inherit', font: 'inherit', fontSize: 13, cursor: 'pointer',
  textAlign: 'left', width: '100%',
}
const footRowStyle: CSSProperties = { display: 'flex', gap: 8, justifyContent: 'flex-end' }
/** The create row: a name field and the one button that writes it. */
const createRowStyle: CSSProperties = { display: 'flex', gap: 8, alignItems: 'center' }
const quietButtonStyle: CSSProperties = {
  border: '1px solid var(--dsw-alias-border-l4)', background: 'transparent',
  color: 'inherit', cursor: 'pointer', borderRadius: 6, padding: '6px 14px', fontSize: 13,
}
const primaryButtonStyle: CSSProperties = {
  border: 'none', background: 'var(--dsw-alias-button-primary-fill)',
  color: 'var(--dsw-alias-label-primary-foreground)', cursor: 'pointer',
  borderRadius: 6, padding: '6px 14px', fontSize: 13,
}
const noteStyle: CSSProperties = { fontSize: 12, lineHeight: '18px', opacity: 0.75 }
/** A caution is an ink, and which ink depends on the surface: see `palettes.ts`. */
const warnStyle = (theme: Theme): CSSProperties => ({ ...noteStyle, color: theme.warn })
const errorStyle = (theme: Theme): CSSProperties => ({ fontSize: 12, color: theme.danger })

/** A small folder glyph, drawn rather than imported: a client plugin has no icon set. */
function Folder(): ReactElement {
  return createElement('svg', {
    width: 14, height: 14, viewBox: '0 0 16 16', 'aria-hidden': true,
    style: { flex: '0 0 auto', opacity: 0.65 } as CSSProperties,
  },
    createElement('path', {
      d: 'M2 4.5 A1.5 1.5 0 0 1 3.5 3 H6.2 L7.6 4.7 H12.5 A1.5 1.5 0 0 1 14 6.2 V11.5 A1.5 1.5 0 0 1 12.5 13 H3.5 A1.5 1.5 0 0 1 2 11.5 Z',
      fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinejoin: 'round',
    }),
  )
}

/** The breadcrumb a path is cut into: every prefix of it, in order. */
export function pathCrumbs(path: string): readonly { name: string; path: string }[] {
  if (path === '/' || path.length === 0) return [{ name: '/', path: '/' }]
  const segments = path.split('/').filter(segment => segment.length > 0)
  const crumbs = [{ name: '/', path: '/' }]
  let walked = ''
  for (const segment of segments) {
    walked += `/${segment}`
    crumbs.push({ name: segment, path: walked })
  }
  return crumbs
}

/** Props the settings card hands the picker when it opens. */
export interface DataDirDialogProps {
  /** This package's bound translate seat, threaded from the card. */
  t: TranslateNS<'dshellMode'>
  /** The directory to open at: the stored choice, or empty for the host's home. */
  initial: string
  /** Called with the chosen directory; the dialog closes itself either way. */
  onPick: (path: string) => void
  /** Called when the reader dismisses the dialog. */
  onClose: () => void
}

/**
 * Render the data-directory picker.
 * @param props - the translate seat, the starting directory, and the two sinks.
 * @returns the dialog element.
 */
export function DataDirDialog(props: DataDirDialogProps): ReactElement {
  const { t } = props
  const theme = useDshellTheme()
  const [view, setView] = useState<DshellDirsResponse | null>(null)
  const [typed, setTyped] = useState(props.initial)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  /** What the last create attempt answered: a refusal the row below it explains. */
  const [createNote, setCreateNote] = useState<'exists' | 'badName' | 'noAccess' | null>(null)

  /** Ask the host for one directory; the answer replaces what is shown. */
  const load = (path: string): void => {
    setBusy(true)
    setFailure(null)
    setCreateNote(null)
    void fetch(DSHELL_DIRS_PATH, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path }),
    }).then(async (response) => {
      const body = await response.json() as DshellDirsResponse
      setView(body)
      setTyped(body.path ?? path)
    }).catch((error: unknown) => {
      setFailure(error instanceof Error ? error.message : String(error))
    }).finally(() => { setBusy(false) })
  }

  /**
   * Create the directory named in the field, then land inside it.
   *
   * The host answers with the NEW directory's listing, so success is one state
   * update: the reader is standing in what they just made, with the field
   * cleared for the next name.
   */
  const create = (): void => {
    if (view?.path === undefined || newName.trim().length === 0) return
    setBusy(true)
    setFailure(null)
    setCreateNote(null)
    void fetch(DSHELL_DIRS_PATH, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'mkdir', path: view.path, name: newName }),
    }).then(async (response) => {
      const body = await response.json() as DshellDirsResponse
      if (body.created !== undefined) {
        setNewName('')
        setView(body)
        setTyped(body.path ?? body.created)
        return
      }
      // Refused: the listing that came with it is still the truth, so it
      // replaces what is shown, and the reason is said under the field.
      setView(body)
      setTyped(body.path ?? view.path ?? '')
      if (body.note === 'exists' || body.note === 'badName' || body.note === 'noAccess') setCreateNote(body.note)
    }).catch((error: unknown) => {
      setFailure(error instanceof Error ? error.message : String(error))
    }).finally(() => { setBusy(false) })
  }

  // Open at the stored choice, or at the host's home when nothing is stored.
  // Runs once: every later move is a click the reader made.
  useEffect(() => { load(props.initial) }, [])

  const entries: readonly DshellDirsEntry[] = view?.entries ?? []
  const note = view?.note === undefined
    ? null
    : t(view.note === 'noDirectory'
      ? 'dataDialog.note.noDirectory'
      : view.note === 'notDirectory' ? 'dataDialog.note.notDirectory' : 'dataDialog.note.noAccess')
  const createMessage = createNote === null ? null : t(`dataDialog.create.${createNote}` as 'dataDialog.create.exists')
  const writable = view?.writable !== false

  return createElement('div', {
    style: backdropStyle,
    onClick: (event: ReactMouseEvent<HTMLDivElement>) => {
      if (event.target === event.currentTarget) props.onClose()
    },
  },
    createElement('div', {
      style: panelStyle,
      role: 'dialog',
      'aria-modal': true,
      'aria-label': t('dataDialog.title'),
      onClick: (event: ReactMouseEvent<HTMLDivElement>) => { event.stopPropagation() },
      onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => {
        // Escape closes the picker and stops there. The propagation stop is not
        // politeness: this dialog is mounted INSIDE the settings dialog, whose
        // own handlers would otherwise also read the key — Escape would shut
        // the settings page behind the picker, and Enter, which the path field
        // uses to go to a typed directory, would do the same.
        if (event.key !== 'Escape') return
        event.preventDefault()
        event.stopPropagation()
        props.onClose()
      },
    },
      createElement('div', { style: titleStyle }, t('dataDialog.title')),
      // The path field is the reader's own way out of a deep tree, and the one
      // way to reach a directory that is not below the current one.
      createElement('input', {
        style: fieldStyle,
        value: typed,
        spellCheck: false,
        autoFocus: true,
        'aria-label': t('dataDialog.path'),
        placeholder: t('dataDialog.path'),
        onChange: (event: { target: { value: string } }) => { setTyped(event.target.value) },
        onKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => {
          if (event.key !== 'Enter') return
          event.preventDefault()
          event.stopPropagation()
          load(typed)
        },
      }),
      createElement('div', { style: crumbRowStyle },
        createElement('button', {
          type: 'button',
          style: { ...crumbStyle, color: 'inherit', opacity: 0.75 },
          disabled: busy || view?.parent === null || view?.parent === undefined,
          onClick: () => { if (view?.parent != null) load(view.parent) },
        }, `↑ ${t('dataDialog.up')}`),
        createElement('button', {
          type: 'button',
          style: { ...crumbStyle, color: 'inherit', opacity: 0.75 },
          disabled: busy,
          onClick: () => { if (view?.home !== undefined) load(view.home) },
        }, t('dataDialog.home')),
        createElement('span', { style: { opacity: 0.4 } }, '·'),
        ...pathCrumbs(view?.path ?? typed).map((crumb, index, all) => createElement('button', {
          key: crumb.path,
          type: 'button',
          style: crumbStyle,
          disabled: busy,
          onClick: () => { load(crumb.path) },
          // The root is spelled `/` and a directory is spelled with its
          // separator, so the crumb that IS the separator is not written twice.
        }, index === all.length - 1 || crumb.name === '/' ? crumb.name : `${crumb.name}/`)),
      ),
      createElement('div', { style: listStyle },
        ...entries.map(entry => createElement('button', {
          key: entry.path,
          type: 'button',
          style: entryStyle,
          disabled: busy,
          onClick: () => { load(entry.path) },
        }, createElement(Folder, null), createElement('span', null, entry.name))),
        entries.length > 0
          ? null
          : createElement('div', { style: { ...noteStyle, padding: '10px 12px' } },
            busy ? t('dataDialog.loading') : note ?? t('dataDialog.empty')),
      ),
      failure === null
        ? null
        : createElement('div', { style: errorStyle(theme) }, t('dataDialog.error', { message: failure })),
      // Inside what they just made: the field is empty again and the note says
      // where they landed, so a reader who came to create does not have to read
      // the list to know it worked.
      view?.created === undefined
        ? null
        : createElement('div', { style: noteStyle }, t('dataDialog.created', { path: view.created })),
      // The one action here that WRITES. It is offered beside the list rather
      // than on the footer's line because it acts on the directory being SHOWN
      // (the footer's action takes that directory), and it is disabled where the
      // host said the directory cannot be written.
      createElement('div', { style: createRowStyle, 'data-dshell-dataCreate': 'row' },
        createElement('input', {
          style: { ...fieldStyle, flex: 1 },
          value: newName,
          spellCheck: false,
          disabled: busy || !writable,
          'aria-label': t('dataDialog.create.label'),
          placeholder: t('dataDialog.create.placeholder'),
          onChange: (event: { target: { value: string } }) => {
            setNewName(event.target.value)
            setCreateNote(null)
          },
          onKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => {
            if (event.key !== 'Enter') return
            event.preventDefault()
            event.stopPropagation()
            create()
          },
        }),
        createElement('button', {
          type: 'button',
          style: quietButtonStyle,
          disabled: busy || !writable || newName.trim().length === 0,
          onClick: () => { create() },
        }, t('dataDialog.create.action')),
      ),
      createMessage === null
        ? null
        : createElement('div', { style: warnStyle(theme) }, createMessage),
      view?.truncated === true
        ? createElement('div', { style: warnStyle(theme) }, t('dataDialog.truncated'))
        : null,
      view?.writable === false
        ? createElement('div', { style: warnStyle(theme) }, t('dataDialog.notWritable'))
        : null,
      createElement('div', { style: footRowStyle },
        createElement('button', {
          type: 'button', style: quietButtonStyle, disabled: busy, onClick: () => { props.onClose() },
        }, t('dataDialog.cancel')),
        createElement('button', {
          type: 'button',
          style: primaryButtonStyle,
          // A directory the host could not read is not a choice: a note means
          // the path is missing, is a file, or is unreadable, and taking it
          // would store a typo the harness would then fail to write into.
          disabled: busy || view?.path === undefined || !writable || view.note !== undefined,
          onClick: () => { if (view?.path !== undefined) props.onPick(view.path) },
        }, t('dataDialog.use')),
      ),
    ),
  )
}
