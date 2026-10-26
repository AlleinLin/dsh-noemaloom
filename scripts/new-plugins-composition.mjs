import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
export async function newPluginsComposition() {
  const motion = dirname(require.resolve('dsh-motion-ui/package.json'));
  const approval = dirname(require.resolve('dsh-cross-session-approval/package.json'));
  const rows = await Promise.all([
    readFile(join(motion, 'cordis.patch.yml'), 'utf8'),
    readFile(join(approval, 'cordis.patch.yml'), 'utf8'),
    readFile(new URL('../vendor/computer-use/cordis.patch.yml', import.meta.url), 'utf8'),
  ]);
  // Retain the installed loader identity across upstream's 1.40 rename.
  // Otherwise upgrading creates a second row and loses existing settings.
  if (rows[2].split('id: ljl454-computer-use').length !== 2)
    throw new Error('Computer-use native loader identity changed; review upstream composition');
  return rows[0].replace('name: dsh-motion-ui', "name: 'dsh-noemaloom/original/motion-ui'")
    + '\n' + rows[1].replace("name: 'dsh-cross-session-approval'", "name: 'dsh-noemaloom/original/cross-session-approval'")
      .replace('        - tools\n', '        - tools\n        - nexusCrossSessionMailbox\n')
    + '\n' + rows[2].replace('id: ljl454-computer-use', 'id: computer-use')
      .replace("name: '@local/dsh-computer-use'", "name: 'dsh-noemaloom/original/computer-use'");
}
