/**
 * Mature compression implementation is vendored with the documented Nexus indexed archive extension. Nexus owns I/O,
 * lifecycle and the one coordinator; no upstream global fetch hooks are loaded.
 */
export * from '../../../../vendor/acp-kernel/src/index.js';
export const BILLION_PROVENANCE = Object.freeze({
  repository: 'https://github.com/ranxianglei/billion-context',
  commit: '133f3525c628c4b959bb79ece82af6df82e131a3',
  path: 'kernel',
  version: '0.0.186',
  license: 'MIT',
  rendererVersion: 'nexus-acp-v1',
});
