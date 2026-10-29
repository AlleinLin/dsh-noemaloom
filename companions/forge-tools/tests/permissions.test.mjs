import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { environment } from './helpers.mjs';
import { resolvePolicy } from '../src/safety.mjs';
import { PowerShellTools } from '../src/pwsh.mjs';

const newExec = (signal = new AbortController().signal) => ({
  agent: { id: 'policy-agent', session: { header: {} } }, callId: 'policy-call', signal,
});
const resultText = result => result.content.map(item => item.text ?? '').join('\n');

function policyHarness(mode, outcome = 'allowed-once') {
  const requests = [];
  const policy = { mode, workspaceRoot: 'C:\\forge-policy-test' };
  const ctx = {
    sandboxPolicy: { resolve: request => {
      assert.ok(request?.session);
      return policy;
    } },
    get: name => {
      assert.equal(name, 'approval');
      return { request: async request => { requests.push(request); return outcome; } };
    },
  };
  return { ctx, policy, requests };
}

test('permission adapter inherits the per-call policy and preserves frozen arguments', async () => {
  const { ctx, policy, requests } = policyHarness('workspace-write');
  for (const args of [Object.freeze({}), Object.freeze({ justification: '' }),
    Object.freeze({ justification: 'An orphan reason must not turn into escalation.' })]) {
    const before = JSON.stringify(args);
    assert.deepEqual(await resolvePolicy(ctx, 'write', args, newExec()), policy);
    assert.equal(JSON.stringify(args), before);
  }
  assert.equal(requests.length, 0);
});

test('valid redundant permission requests retain the actual mode without a reason or approval', async () => {
  for (const [mode, target] of [
    ['danger-full-access', 'workspace-write'],
    ['danger-full-access', 'danger-full-access'],
    ['workspace-write', 'workspace-write'],
  ]) {
    const { ctx, policy, requests } = policyHarness(mode);
    for (const reason of [undefined, '', '  ', 'Unnecessary request.']) {
      const args = Object.freeze({ sandbox_permissions: target, ...(reason === undefined ? {} : { justification: reason }) });
      assert.deepEqual(await resolvePolicy(ctx, 'write', args, newExec()), policy);
    }
    assert.equal(requests.length, 0);
  }
});

test('true widening rejects a missing, blank, or non-string justification before approval', async () => {
  const { ctx, requests } = policyHarness('read-only');
  for (const justification of [undefined, '', '  ', null, 0, false, {}]) {
    await assert.rejects(resolvePolicy(ctx, 'write', Object.freeze({
      sandbox_permissions: 'workspace-write',
      ...(justification === undefined ? {} : { justification }),
    }), newExec()), /justification/i);
  }
  assert.equal(requests.length, 0);
});

test('unknown permission targets and invalid parameter types are never normalized into access', async () => {
  const { ctx, requests } = policyHarness('danger-full-access');
  for (const sandbox_permissions of ['read-only', 'bogus', '', null, 1, false, {}, []]) {
    await assert.rejects(resolvePolicy(ctx, 'write',
      { sandbox_permissions, justification: 'A valid reason cannot rescue an invalid mode.' }, newExec()),
    /sandbox_permissions|sandbox|target|mode|permission/i);
  }
  for (const justification of [null, 0, false, {}, []]) {
    await assert.rejects(resolvePolicy(ctx, 'write', { justification }, newExec()), /justification/i);
  }
  assert.equal(requests.length, 0);
});

test('true widening uses the official approval request once and never mutates caller policy', async () => {
  const { ctx, policy, requests } = policyHarness('read-only');
  const args = Object.freeze({ sandbox_permissions: 'workspace-write', justification: 'Write the user-requested file.' });
  const exec = newExec();
  const resolved = await resolvePolicy(ctx, 'write', args, exec);
  assert.equal(resolved.mode, 'workspace-write');
  assert.equal(policy.mode, 'read-only');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].agent, exec.agent);
  assert.equal(requests[0].callId, exec.callId);
  assert.equal(requests[0].toolName, 'write');
  assert.equal(requests[0].signal, exec.signal);
  assert.match(requests[0].reason, /workspace-write.*Write the user-requested file/);
});

test('an already cancelled permission request never prompts for approval', async () => {
  const { ctx, requests } = policyHarness('read-only');
  const controller = new AbortController();
  controller.abort(new Error('cancel-before-approval'));
  await assert.rejects(resolvePolicy(ctx, 'write', {
    sandbox_permissions: 'workspace-write', justification: 'Write the user-requested file.',
  }, newExec(controller.signal)), /cancel-before-approval/);
  assert.equal(requests.length, 0);
});

test('an approval granted after cancellation cannot authorize a late dispatch', async () => {
  const { ctx } = policyHarness('read-only');
  const controller = new AbortController();
  ctx.get = () => ({ request: async () => {
    controller.abort(new Error('cancel-during-approval'));
    return 'allowed-once';
  } });
  await assert.rejects(resolvePolicy(ctx, 'write', {
    sandbox_permissions: 'workspace-write', justification: 'Save the user-requested file.',
  }, newExec(controller.signal)), /cancel-during-approval/);
});

test('approval cannot survive a change to the active mode or workspace root', async () => {
  for (const changed of [{ mode: 'danger-full-access' }, { workspaceRoot: 'C:\\different-workspace' }]) {
    const { ctx, policy } = policyHarness('read-only');
    ctx.get = () => ({ request: async () => { Object.assign(policy, changed); return 'allowed-once'; } });
    await assert.rejects(resolvePolicy(ctx, 'write', {
      sandbox_permissions: 'workspace-write', justification: 'Save the user-requested file.',
    }, newExec()), /policy|workspace|changed|mode/i);
  }
});

for (const toolName of ['write', 'edit', 'batch_edit']) {
  test(`native ${toolName} accepts screenshot permission mistakes under full access without approval`, async t => {
    let approvals = 0;
    const { root, nativeExecute } = await environment(t, {
      sandboxFs: true, mode: 'danger-full-access',
      approval: { request: async () => { approvals++; throw new Error('redundant permission must not prompt'); } },
    });
    const target = path.join(root, 'screenshot.txt');
    const cases = [
      { sandbox_permissions: 'workspace-write', justification: '' },
      { sandbox_permissions: 'workspace-write' },
      { sandbox_permissions: 'danger-full-access', justification: '  ' },
      { justification: '' },
      {},
    ];
    for (const fields of cases) {
      await writeFile(target, 'before');
      const mutation = toolName === 'write' ? { file_path: target, content: 'after' }
        : toolName === 'edit' ? { file_path: target, old_string: 'before', new_string: 'after' }
          : { edits: [{ file_path: target, old_string: 'before', new_string: 'after' }] };
      const args = Object.freeze({ ...mutation, ...fields });
      const before = JSON.stringify(args);
      const result = await nativeExecute(toolName, args);
      assert.equal(result.isError, false, resultText(result));
      assert.equal(await readFile(target, 'utf8'), 'after', resultText(result));
      assert.equal(JSON.stringify(args), before);
    }
    assert.equal(approvals, 0);
  });
}

test('one registered schema follows session mode changes rather than composition defaults', async t => {
  let mode = 'danger-full-access', approvals = 0;
  const { root, nativeExecute } = await environment(t, {
    sandboxFs: true, mode: 'danger-full-access',
    policyResolver: (request, root) => {
      assert.ok(request?.session);
      return { mode, workspaceRoot: root };
    },
    approval: { request: async () => { approvals++; return 'allowed-once'; } },
  });
  const target = path.join(root, 'session-policy.txt');
  await writeFile(target, 'before');
  const args = Object.freeze({ file_path: target, content: 'after',
    sandbox_permissions: 'workspace-write', justification: '' });
  assert.equal((await nativeExecute('write', args)).isError, false);
  mode = 'read-only';
  await writeFile(target, 'before');
  const denied = await nativeExecute('write', args);
  assert.equal(denied.isError, true);
  assert.match(resultText(denied), /justification/i);
  assert.equal(await readFile(target, 'utf8'), 'before');
  const granted = await nativeExecute('write', { ...args, justification: 'Save the user-requested changes.' });
  assert.equal(granted.isError, false, resultText(granted));
  assert.equal(await readFile(target, 'utf8'), 'after');
  assert.equal(approvals, 1);
  const stillReadOnly = await nativeExecute('write', { file_path: target, content: 'must not write' });
  assert.equal(stillReadOnly.isError, true);
  assert.match(resultText(stillReadOnly), /sandbox.*denied/i);
  assert.equal(await readFile(target, 'utf8'), 'after');
});

test('native genuine widening waits for approval and dispatches exactly one mutation', async t => {
  let grant;
  const approved = new Promise(resolve => { grant = resolve; });
  let asked;
  const prompt = new Promise(resolve => { asked = resolve; });
  let approvals = 0;
  const { root, ctx, nativeExecute } = await environment(t, {
    sandboxFs: true, mode: 'read-only',
    approval: { request: async () => { approvals++; asked(); return approved; } },
  });
  const target = path.join(root, 'approval.txt');
  await writeFile(target, 'before');
  let dispatches = 0;
  const original = ctx.fs.writeText.bind(ctx.fs);
  ctx.fs.writeText = (...args) => { dispatches++; return original(...args); };
  const call = nativeExecute('write', { file_path: target, content: 'after',
    sandbox_permissions: 'workspace-write', justification: 'Save the user-requested file.' });
  await prompt;
  assert.equal(await readFile(target, 'utf8'), 'before');
  assert.equal(dispatches, 0);
  grant('allowed-once');
  const result = await call;
  assert.equal(result.isError, false, resultText(result));
  assert.equal(await readFile(target, 'utf8'), 'after');
  assert.equal(approvals, 1);
  assert.equal(dispatches, 1);
});

for (const outcome of ['rejected', 'cancelled', 'unavailable']) {
  test(`native ${outcome} approval never dispatches or replays a mutation`, async t => {
    let approvals = 0;
    const { root, ctx, nativeExecute } = await environment(t, {
      sandboxFs: true, mode: 'read-only',
      approval: { request: async () => { approvals++; return outcome; } },
    });
    const target = path.join(root, 'denied.txt');
    await writeFile(target, 'before');
    let dispatches = 0;
    const original = ctx.fs.writeText.bind(ctx.fs);
    ctx.fs.writeText = (...args) => { dispatches++; return original(...args); };
    const result = await nativeExecute('write', { file_path: target, content: 'after',
      sandbox_permissions: 'workspace-write', justification: 'Save the user-requested file.' });
    assert.equal(result.isError, true);
    assert.match(resultText(result), outcome === 'rejected' ? /rejected/ : outcome === 'cancelled' ? /cancelled/ : /channel/);
    assert.equal(await readFile(target, 'utf8'), 'before');
    assert.equal(approvals, 1);
    assert.equal(dispatches, 0);
  });
}

test('native widening without an approval service or agent stays denied', async t => {
  const { root, nativeExecute } = await environment(t, { sandboxFs: true, mode: 'read-only' });
  const target = path.join(root, 'missing-channel.txt');
  await writeFile(target, 'before');
  const args = { file_path: target, content: 'after', sandbox_permissions: 'workspace-write',
    justification: 'Save the user-requested file.' };
  const missingService = await nativeExecute('write', args);
  assert.equal(missingService.isError, true);
  assert.match(resultText(missingService), /approval service/);
  assert.equal(await readFile(target, 'utf8'), 'before');

  let approvals = 0;
  const withService = await environment(t, { sandboxFs: true, mode: 'read-only',
    approval: { request: async () => { approvals++; return 'allowed-once'; } } });
  const second = path.join(withService.root, 'missing-agent.txt');
  await writeFile(second, 'before');
  const missingAgent = await withService.nativeExecute('write', { ...args, file_path: second }, { agent: undefined });
  assert.equal(missingAgent.isError, true);
  assert.match(resultText(missingAgent), /no agent/);
  assert.equal(await readFile(second, 'utf8'), 'before');
  assert.equal(approvals, 0);
});

test('a rejected native batch stops at the first item without dispatching any edits', async t => {
  let approvals = 0;
  const { root, ctx, nativeExecute } = await environment(t, { sandboxFs: true, mode: 'read-only',
    approval: { request: async () => { approvals++; return 'rejected'; } } });
  const targets = [path.join(root, 'first.txt'), path.join(root, 'second.txt')];
  for (const target of targets) await writeFile(target, 'before');
  let dispatches = 0;
  const original = ctx.fs.editText.bind(ctx.fs);
  ctx.fs.editText = (...args) => { dispatches++; return original(...args); };
  const result = await nativeExecute('batch_edit', {
    edits: targets.map(file_path => ({ file_path, old_string: 'before', new_string: 'after' })),
    sandbox_permissions: 'workspace-write', justification: 'Apply the user-requested edits.',
  });
  assert.equal(result.isError, false, resultText(result));
  const value = JSON.parse(resultText(result));
  assert.equal(value.completed, 0);
  assert.equal(value.failed, targets[0]);
  assert.match(value.error, /rejected/);
  assert.equal(dispatches, 0);
  assert.equal(approvals, 1);
  for (const target of targets) assert.equal(await readFile(target, 'utf8'), 'before');
});

test('workspace mode still enforces real SDK containment after redundant normalization', async t => {
  const outside = await mkdtemp(path.join(process.cwd(), '.forge-permission-boundary-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const target = path.join(outside, 'outside.txt');
  await writeFile(target, 'before');
  const { nativeExecute } = await environment(t, { sandboxFs: true, mode: 'workspace-write' });
  for (const fields of [{}, { sandbox_permissions: 'workspace-write', justification: '' }]) {
    const result = await nativeExecute('write', { file_path: target, content: 'must not write', ...fields });
    assert.equal(result.isError, true);
    assert.match(resultText(result), /sandbox.*denied/i);
    assert.equal(await readFile(target, 'utf8'), 'before');
  }
});

test('a cancelled native write never asks for approval or dispatches', async t => {
  let approvals = 0;
  const { root, ctx, nativeExecute } = await environment(t, { sandboxFs: true, mode: 'read-only',
    approval: { request: async () => { approvals++; return 'allowed-once'; } } });
  const target = path.join(root, 'cancelled.txt');
  await writeFile(target, 'before');
  let dispatches = 0;
  const original = ctx.fs.writeText.bind(ctx.fs);
  ctx.fs.writeText = (...args) => { dispatches++; return original(...args); };
  const controller = new AbortController();
  controller.abort(new Error('cancel-before-dispatch'));
  try {
    const result = await nativeExecute('write', { file_path: target, content: 'after',
      sandbox_permissions: 'workspace-write', justification: 'Save the user-requested file.' },
    { signal: controller.signal });
    assert.equal(result.isError, true);
    assert.match(resultText(result), /cancel-before-dispatch|abort|cancel/i);
  } catch (error) { assert.match(error.message, /cancel-before-dispatch|abort|cancel/i); }
  assert.equal(approvals, 0);
  assert.equal(dispatches, 0);
  assert.equal(await readFile(target, 'utf8'), 'before');
});

test('PowerShell shares permission normalization and still uses restricted execution after a mode change', async () => {
  let mode = 'danger-full-access', approvals = 0, executions = 0;
  const modes = [];
  const ctx = {
    sandboxPolicy: { resolve: () => ({ mode, workspaceRoot: '.' }) },
    get: () => ({ request: async () => { approvals++; return 'rejected'; } }),
    subprocess: { spawn() { throw new Error('must not spawn a persistent worker'); } },
    shell: { pwshPath: 'pwsh', sandboxMode: 'danger-full-access', resolve: spec => spec,
      execute: async spec => {
        executions++; modes.push(spec.sandboxPolicy.mode);
        return { result: async () => ({ exitCode: 0, timedOut: false, aborted: false,
          stdout: { text: 'executed', truncated: false }, stderr: { text: '', truncated: false } }),
        done: Promise.resolve() };
      },
    },
  };
  const service = new PowerShellTools(ctx, { clear() {}, cwd: async () => '.' }, { persistent: false });
  try {
    const args = Object.freeze({ command: "'test'", session_mode: 'isolated',
      sandbox_permissions: 'workspace-write', justification: '' });
    assert.equal((await service.execute(args, newExec())).exitCode, 0);
    assert.deepEqual(modes, ['danger-full-access']);
    mode = 'read-only';
    await assert.rejects(service.execute(args, newExec()), /justification/i);
    await assert.rejects(service.execute({ ...args, justification: 'Run the user-requested operation.' }, newExec()), /rejected/);
    const normal = await service.execute({ command: "'test'", session_mode: 'isolated' }, newExec());
    assert.equal(normal.exitCode, 0);
    assert.deepEqual(modes, ['danger-full-access', 'read-only']);
    assert.equal(executions, 2);
    assert.equal(approvals, 1);
  } finally { await service.dispose(); }
});
