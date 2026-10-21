import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { safeExistingPath } from '../src/domain/workflow/util.js';
import { NexusError } from '../src/ports/contracts.js';

test('workflow paths accept the supplied workspace alias and its canonical identity while rejecting escapes', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'nexus-workflow-paths-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'workspace'), alias = join(directory, 'workspace-alias');
  const outside = join(directory, 'workspace-sibling');
  await Promise.all([mkdir(root), mkdir(outside)]);
  await writeFile(join(root, 'candidate.txt'), 'candidate');
  await writeFile(join(outside, 'secret.txt'), 'outside');
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  await symlink(root, alias, linkType);
  await symlink(outside, join(root, 'escape'), linkType);
  const expected = join(root, 'candidate.txt');
  for (const path of ['candidate.txt', join(alias, 'candidate.txt'), expected]) {
    assert.equal(await safeExistingPath(alias, path), expected);
  }
  for (const path of ['../workspace-sibling/secret.txt', join(outside, 'secret.txt'), 'escape/secret.txt']) {
    await assert.rejects(safeExistingPath(alias, path), (error: unknown) =>
      error instanceof NexusError && error.code === 'SCOPE_MISMATCH');
  }
});
