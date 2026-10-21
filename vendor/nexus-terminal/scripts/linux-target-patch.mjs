/**
 * Register the linux-x64 target widening for every Node process in the build.
 *
 * Pointed at by `NODE_OPTIONS=--import …`, so it reaches dsh's `tsx`-run prepare
 * scripts and the `node` that evaluates `electron-builder.config.mjs` alike.
 */

import { register } from 'node:module'

register('./linux-target-hooks.mjs', import.meta.url)
