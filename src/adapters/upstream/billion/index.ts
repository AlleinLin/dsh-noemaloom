/**
 * Mature compression implementation is vendored with the documented Nexus indexed archive extension. Nexus owns I/O,
 * lifecycle and the one coordinator; no upstream global fetch hooks are loaded.
 */
export * from '../../../../vendor/acp-kernel/src/index.js';
export const BILLION_PROVENANCE = Object.freeze({
  repository: 'https://github.com/ranxianglei/billion-context',
  commit: 'f161c51894bad4b9e0da15e29353abf5710689c9',
  path: 'kernel',
  version: '0.0.161',
  license: 'MIT',
  rendererVersion: 'nexus-acp-v1',
});
