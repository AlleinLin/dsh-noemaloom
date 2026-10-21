/**
 * What the `files` tab kind IS, as this package implements it.
 *
 * `kind: 'files'` is the shipped file tree's kind, and `priority: 'extension'`
 * is what dsh's tab registry is built for: a kind carries one `builtin` and one
 * `extension` at a time, the extension is the one in force, and the shipped
 * definition resumes the moment this package unloads. Declaring the band
 * explicitly rather than relying on the default keeps that intent readable.
 *
 * The guide entry is NOT decoration. The right pane seeds its default page from
 * the sole guide entry's kind, so a takeover that contributed none would leave
 * the pane opening the guide page instead of a file view.
 */

import { createElement } from 'react'
import { FileTypeIcon, type IconProps } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from './locales.js'

/** This implementation's identity in the tab system, and the key its body registers under. */
export const DSHELL_FILES_ID = '@nexus-aethra/dshell-files'

/** The tab kind this package takes over. */
export const FILES_KIND = 'files'

/** The type's coloured folder sheet at the guide capsule's glyph size. */
function FolderSheetGlyph({ size, className }: IconProps) {
  return createElement(FileTypeIcon, { kind: 'folder', size, className })
}

/**
 * The files type's registry definition, as this package implements it.
 * @param t - namespace-bound translate, read fresh on every label call.
 * @returns the definition to register.
 */
export function dshellFilesDefinition(t: TranslateNS<'dshellFiles'>): SidebarRightTabDefinition {
  return {
    id: DSHELL_FILES_ID,
    kind: FILES_KIND,
    // The band that may take over a builtin kind; also the registry's default.
    priority: 'extension',
    title: () => t('type.label'),
    guide: [{
      // 0.1.6 requires a stable entry identity within the provider; it is
      // validated for uniqueness only, and names the page this capsule opens.
      id: 'files',
      order: 10,
      title: () => t('guide.title'),
      description: () => t('guide.description'),
      icon: FolderSheetGlyph,
    }],
  }
}
