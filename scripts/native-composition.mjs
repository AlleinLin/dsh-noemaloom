import { readFile } from 'node:fs/promises';

export async function nativeComposition() {
  const original = await readFile(new URL('../vendor/nexus-terminal/packages/dshell/bundle/cordis.patch.yml', import.meta.url), 'utf8');
  const wsl = "    - id: dshell-wsl\n      name: '@nexus-aethra/dshell-wsl'\n";
  if (original.split(wsl).length !== 2) throw new Error('Reviewed optional WSL composition changed');
  // The new WSL provider requires a separate node-pty native addon. Keep its
  // source for provenance; do not activate an unvalidated binary backend.
  return original.replace(wsl, '').replaceAll("'@nexus-aethra/dshell-", "'dsh-noemaloom/native/dshell-")
    + "\n- insert:\n    - id: agent-procedures\n      name: 'dsh-noemaloom/native/agent-procedures'\n";
}
