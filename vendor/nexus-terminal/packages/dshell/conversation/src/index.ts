/**
 * dshell-conversation host face — Phase 1 stub.
 *
 * The `terminal` target registration lives in src/client/index.ts (the
 * browser face) because `ctx.uiConversation` is a browser-only service.
 * This host-side entry exists only to satisfy the bundle's module-table
 * row so dsh loads the package's host face alongside the four other
 * dshell-* packages in the active profile.
 */

import type { Context } from '@deepseek-ai/cordis'

export const name = '@nexus-aethra/dshell-conversation/host'

export function apply(_ctx: Context): void {
  // Reserved for future host-side concerns; target registration is in
  // src/client/index.ts where `ctx.uiConversation` is available.
}

export default { name, apply }
