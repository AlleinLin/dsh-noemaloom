/**
 * The 管理台's card seat, as dshell-wsl sees it.
 *
 * The owning page and the primary declaration live in dshell-ssh's client —
 * this is the twin declaration dshell-wsl type-checks its own contribution
 * against, because registering into the seat must not make this package
 * depend on that one's client. Interface merging accepts identical members;
 * if the copies ever drift, the compiler names the file that moved.
 */

import type {} from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * One card of the dshell 管理台 (the `dshell` settings section's page).
     * Twin of the declaration in dshell-ssh's client/admin.ts — keep the
     * copies identical.
     */
    'dshell.admin.card': {
      kind: 'list'
      scope: 'root'
      owner: { children?: never }
    }
  }
}
