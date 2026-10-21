/**
 * dshell-bundle: marks the bundle row that the cordis.patch.yml above
 * installs into the dsh composition. Phase 0 ships a no-op plugin; later
 * phases grow this into profile-level defaults.
 *
 * The plugin's only responsibility at this stage is to declare its
 * identity so the bundle row resolves under the dsh composition model.
 */

import type { Context } from '@deepseek-ai/cordis'

export const name = '@nexus-aethra/dshell-bundle'

export function apply(ctx: Context): void {
  ctx.set('dshell.bundle.active', { since: Date.now() })
}

export default { name, apply }
