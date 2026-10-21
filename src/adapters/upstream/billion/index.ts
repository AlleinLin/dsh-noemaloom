/**
 * Mature compression implementation is vendored verbatim. Nexus owns I/O,
 * lifecycle and the one coordinator; no upstream global fetch hooks are loaded.
 */
export * from '../../../../vendor/acp-kernel/src/index.js';
export const BILLION_PROVENANCE = Object.freeze({
  repository: 'https://github.com/ranxianglei/billion-context',
  commit: '6deb4547e57af6203bcedd3739fdc63b75443aec',
  path: 'kernel',
  version: '0.0.136',
  license: 'MIT',
  rendererVersion: 'nexus-acp-v1',
});
