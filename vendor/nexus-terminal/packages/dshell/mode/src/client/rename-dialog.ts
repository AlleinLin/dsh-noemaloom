/**
 * The terminal section's rename dialog.
 *
 * dsh's own rename dialog answers a request raised through a share that
 * ui-workspace keeps to itself (`shortcutControls` is a local of its apply, not
 * a service), so a row outside its tree cannot ask for it. This is the same
 * arrangement with our own share: the section raises a request into a store,
 * and one `shell.overlay` entry answers it — dsh's `Modal` and `Button` for the
 * chrome, dsh's own rename-field metrics for the input, and `SessionFace.rename`
 * for the write, which is the host's durable title and what the sidebar row, the
 * header and the tab all read. Renaming here therefore renames everywhere, and
 * pins the title against dsh's own automatic regeneration.
 */

import { createElement, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactElement } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** One rename the section asked for. */
export interface RenameTarget {
  /** The session to name. */
  readonly sessionId: SessionId
  /** The title the dialog seeds its draft from. */
  readonly currentTitle: string
}

/** The pending request; null while no dialog is showing. */
export const renameRequest = createSnapshotStore<RenameTarget | null>(null)

/**
 * Ask for the dialog.
 * @param sessionId - the session to name.
 * @param currentTitle - what the field starts out holding.
 */
export function requestRename(sessionId: SessionId, currentTitle: string): void {
  renameRequest.set({ sessionId, currentTitle })
}

/** Consume or cancel the pending request. */
export function settleRename(): void {
  renameRequest.set(null)
}

/** The field's metrics, copied from dsh's own rename input. */
const inputStyle: CSSProperties = {
  boxSizing: 'border-box',
  width: '100%',
  height: 44,
  padding: '7px 14px',
  border: '0.5px solid var(--dsw-alias-border-l4)',
  borderRadius: 'var(--dsw-radius-lg)',
  outline: 'none',
  background: 'transparent',
  fontSize: 14,
  fontWeight: 400,
  lineHeight: '22px',
  color: 'var(--dsw-alias-label-primary)',
}

/** The refusal line under the field, in dsh's own error ink. */
const errorStyle: CSSProperties = {
  marginTop: 8,
  fontSize: 12,
  lineHeight: '18px',
  color: 'var(--dsw-alias-state-error-primary)',
}

/** What the dialog needs from the rest of the composition. */
export interface DshellRenameDialogProps {
  /** Write the title; rejects with the host's own refusal. */
  rename(sessionId: SessionId, title: string): Promise<void>
}

/** One request's form; in-flight and error state die with it. */
function RenameForm(props: {
  request: RenameTarget
  rename(sessionId: SessionId, title: string): Promise<void>
  t: TranslateNS<'dshellMode'>
}): ReactElement {
  const { request, rename, t } = props
  const [draft, setDraft] = useState(request.currentTitle)
  const [renaming, setRenaming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // An Enter that commits an IME composition must not submit the dialog.
  const composing = useRef(false)
  const trimmed = draft.trim()
  const blocked = renaming || trimmed.length === 0
  const close = (): void => {
    if (renaming) return
    settleRename()
  }
  const confirm = (): void => {
    if (blocked) return
    setRenaming(true)
    setError(null)
    void rename(request.sessionId, trimmed).then(() => {
      setRenaming(false)
      settleRename()
    }, (reason: unknown) => {
      setRenaming(false)
      setError(reason instanceof Error ? reason.message : String(reason))
    })
  }
  return createElement(Modal, {
    open: true,
    onClose: close,
    closeLabel: t('rename.close'),
    title: t('rename.title'),
    footer: createElement('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
      createElement(Button, { variant: 'outline', disabled: renaming, onClick: close }, t('rename.cancel')),
      createElement(Button, { variant: 'primary', disabled: blocked, onClick: confirm }, t('rename.confirm'))),
  },
  createElement('input', {
    style: inputStyle,
    value: draft,
    'aria-label': t('rename.field'),
    // dsh's Modal moves the initial focus to the control carrying this, which
    // is what keeps the return focus where it was.
    'data-modal-autofocus': true,
    disabled: renaming,
    onFocus: (event: { target: HTMLInputElement }) => { event.target.select() },
    onChange: (event: { target: { value: string } }) => { setDraft(event.target.value); setError(null) },
    onCompositionStart: () => { composing.current = true },
    onCompositionEnd: () => { composing.current = false },
    onKeyDown: (event: { key: string; preventDefault(): void }) => {
      if (event.key !== 'Enter' || composing.current) return
      event.preventDefault()
      confirm()
    },
  }),
  error === null ? null : createElement('div', { style: errorStyle, role: 'alert' }, error))
}

/**
 * The overlay entry: nothing while no rename is asked for, otherwise one dialog
 * per request, keyed by the session so a second request starts a fresh draft.
 * @param props - the rename hop, the slot runtime and the locale seat.
 * @returns the open dialog, or null.
 */
export function DshellRenameDialog(
  props: DshellRenameDialogProps & PropsRuntime<'shell.overlay'> & PropsLocale<'dshellMode'>,
): ReactElement | null {
  const request = useSyncExternalStore(renameRequest.subscribe, renameRequest.getSnapshot)
  if (request === null) return null
  return createElement(RenameForm, {
    key: String(request.sessionId),
    request,
    rename: props.rename,
    t: props.t,
  })
}
