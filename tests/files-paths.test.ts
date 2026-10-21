import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workspacePath } from '../src/domain/files/paths.js';
import { NexusError } from '../src/ports/contracts.js';

test('editor and debugger paths accept workspace aliases and retain canonical containment', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'nexus-files-paths-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'workspace'), alias = join(directory, 'workspace-alias');
  const outside = join(directory, 'workspace-sibling');
  await Promise.all([mkdir(root), mkdir(outside)]);
  await Promise.all([
    writeFile(join(root, 'main.py'), 'value = 21\n'),
    writeFile(join(outside, 'secret.py'), 'secret\n'),
  ]);
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  await symlink(root, alias, linkType);
  await symlink(outside, join(root, 'escape'), linkType);
  for (const workspace of [root, alias]) {
    for (const path of ['main.py', join(alias, 'main.py'), join(root, 'main.py')]) {
      assert.equal(await workspacePath(workspace, path), join(root, 'main.py'));
    }
    for (const path of ['new.py', join(alias, 'new.py'), join(root, 'new.py')]) {
      assert.equal(await workspacePath(workspace, path, true), join(root, 'new.py'));
    }
    for (const path of ['../workspace-sibling/secret.py', join(outside, 'secret.py'), 'escape/secret.py', 'escape/new.py']) {
      await assert.rejects(workspacePath(workspace, path, true), (error: unknown) =>
        error instanceof NexusError && error.code === 'SCOPE_MISMATCH');
    }
  }
  await assert.rejects(workspacePath(alias, 'new.py'), (error: unknown) =>
    error instanceof NexusError && error.code === 'NOT_FOUND');
});
