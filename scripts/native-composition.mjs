import { readFile } from 'node:fs/promises';

export async function nativeComposition() {
  const original = await readFile(new URL('../vendor/nexus-terminal/packages/dshell/bundle/cordis.patch.yml', import.meta.url), 'utf8');
  return original.replaceAll("'@nexus-aethra/dshell-", "'dsh-noemaloom/native/dshell-")
    + "\n- insert:\n    - id: agent-procedures\n      name: 'dsh-noemaloom/native/agent-procedures'\n";
}
