/**
 * Mature compression implementation is vendored with the documented Nexus indexed archive extension. Nexus owns I/O,
 * lifecycle and the one coordinator; no upstream global fetch hooks are loaded.
 */
export * from '../../../../vendor/acp-kernel/src/index.js';
export const BILLION_PROVENANCE = Object.freeze({
  repository: 'https://github.com/ranxianglei/billion-context',
  commit: '7790bea9178884e70a32bdf7629fd65314b0773e',
  path: 'kernel',
  version: '0.0.147',
  license: 'MIT',
  rendererVersion: 'nexus-acp-v1',
});
