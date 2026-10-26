import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { parseFactory } from '../scripts/original-factory.mjs';
import { adaptMotionClient, adaptComputerUseClient, adaptComputerUseHost } from '../scripts/adapt-new-originals.mjs';
import { adaptCrossSessionHost } from '../scripts/adapt-cross-session.mjs';
import { adaptComputerPolicyHost, adaptAppLaunchEntry, adaptAppLaunchRuntime, adaptCdpConnection,
  adaptCdpState, adaptComputerWorkerPolicy, adaptComputerWorkerDispatch } from '../scripts/adapt-computer-use-policy.mjs';
import { vendoredOriginal } from '../scripts/vendored-original.mjs';
import { newPluginsComposition } from '../scripts/new-plugins-composition.mjs';
import { parse } from 'yaml';

test('new native source adapters retain parseable upstream clients and reject drift', async () => {
  for (const [filename, name, adapt] of [
    ['node_modules/dsh-motion-ui/client.js', 'dsh-motion-ui', adaptMotionClient],
    ['vendor/computer-use/client.js', '@local/dsh-computer-use', adaptComputerUseClient],
  ]) {
    const source = await readFile(filename, 'utf8'), original = parseFactory(source, name);
    const adapted = adapt(original.factory);
    assert.deepEqual(ts.createSourceFile('client.js', `const factory=${adapted};`, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS).parseDiagnostics, []);
    assert.match(adapted, /prefers-reduced-motion:reduce/);
    assert.match(adapted, /#c66a4a/);
    assert.deepEqual(original.requires, name === 'dsh-motion-ui'
      ? ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime']
      : ['react']);
    if (name === 'dsh-motion-ui') {
      assert.match(adapted, /dshUiFences/); assert.match(adapted, /dshUiStream/); assert.match(adapted, /dshMotionMedia/);
      assert.doesNotMatch(adapted, /key:\s*["']assistant-step["']/);
      assert.match(adapted, /IntersectionObserver/); assert.match(adapted, /visibilitychange/);
      assert.throws(() => adapt(original.factory.replace('style.textContent = CSS2', 'style.textContent = changedCSS')), /anchor changed/);
    } else {
      assert.match(adapted, /\/api\/plugins\/dsh-noemaloom\/computer-use/);
      assert.match(adapted, /conversation.input.left/); assert.match(adapted, /style.remove/);
      assert.throws(() => adapt(original.factory.replace("const ROUTE = '/computer-use'", "const ROUTE = '/changed'")), /anchor changed/);
    }
  }
});

test('complete computer vendor source is pinned and keeps its worker/browser closure', async () => {
  const installed = await vendoredOriginal(process.cwd(), { packageName: '@local/dsh-computer-use', version: '1.40.3',
    vendor: 'vendor/computer-use', revision: 'db4c44f9a3534118dbe2138c01b0dc156c9c2f8e' });
  for (const file of ['backend/worker.ps1', 'backend/release-input.ps1', 'browser/connection.mjs',
    'browser/actions.mjs', 'internal/lease.mjs', 'internal/sessions.mjs']) assert.ok(installed.source.files[file], file);
  const original = await readFile('vendor/computer-use/index.js', 'utf8');
  const adapted = adaptComputerPolicyHost(adaptComputerUseHost(original));
  assert.match(adapted, /authenticatedComputerUseRoutes/);
  assert.doesNotMatch(adapted, /scoped\.webServer\.register/);
  assert.match(adapted, /defaultEnabled = config.defaultEnabled === true/);
  assert.doesNotMatch(adapted, /managedBrowsers\.values\(\)/);
  assert.match(adapted, /nexusComputerPolicy\.launch\(exec, args, call\)/);
  assert.deepEqual(ts.createSourceFile('host.js', adapted, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS).parseDiagnostics, []);
  assert.equal(createHash('sha256').update(original).digest('hex'), installed.source.files['index.js']);
});

test('computer adapters bind app launch and CDP to native execution and seal both worker layouts', async () => {
  for (const [path, adapt] of [
    ['internal/app-launch.mjs', adaptAppLaunchEntry], ['internal/app-launch.js', adaptAppLaunchRuntime],
    ['browser/connection.mjs', adaptCdpConnection], ['browser/state.mjs', adaptCdpState],
  ]) {
    const source = await readFile(`vendor/computer-use/${path}`, 'utf8'), adapted = adapt(source);
    assert.deepEqual(ts.createSourceFile(path, adapted, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS).parseDiagnostics, []);
    assert.throws(() => adapt('upstream changed'), /anchor changed/);
    if (path === 'internal/app-launch.js') {
      assert.ok(adapted.indexOf('await options.authorize(') < adapted.indexOf('child = spawn(resolved.file'));
      assert.match(adapted, /options\.signal\.throwIfAborted\(\)/);
    }
    if (path === 'browser/connection.mjs') {
      assert.match(adapted, /redirect: 'error'/);
      assert.match(adapted, /nexusStartupSignal\?\.throwIfAborted\(\)/);
      assert.match(adapted, /signal: options\.signal/);
    }
  }
  const parts = await adaptComputerWorkerPolicy(await readFile('vendor/computer-use/backend/parts/07-frames.ps1', 'utf8'));
  const whole = adaptComputerWorkerDispatch(await adaptComputerWorkerPolicy(await readFile('vendor/computer-use/backend/worker.ps1', 'utf8')));
  for (const text of [parts, whole]) {
    assert.match(text, /Assert-NexusLaunchPlan \$Arg/);
    assert.doesNotMatch(text, /Start-Process -FilePath \$resolved\.file/);
    assert.match(text, /-ArgumentList \$nexusPlan\.windowsArgumentLine/);
  }
  assert.match(whole, /'nexus_launch_plan'\s*=/);
});

test('cross-session keeps its ten native tools and approval audit while all messages use the mailbox', async () => {
  const original = await readFile('node_modules/dsh-cross-session-approval/lib/index.js', 'utf8');
  const adapted = adaptCrossSessionHost(original);
  assert.deepEqual(ts.createSourceFile('cross-session.js', adapted, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS).parseDiagnostics, []);
  assert.equal((adapted.match(/name: 'cross_session_/g) ?? []).length, 10);
  assert.doesNotMatch(adapted, /source:\s*\{\s*kind:\s*['"]user['"]/);
  assert.doesNotMatch(adapted, /live\.steer\(createUserMessage/);
  assert.match(adapted, /beforeResume\(caller/);
  assert.equal((adapted.match(/\.authorizeTarget\(caller/g) ?? []).length, 6);
  assert.match(adapted, /caller\.session !== entry\.ownerSession/);
  assert.match(adapted, /entry\.requesterSession/);
  assert.match(adapted, /triPartiteModeConsistent/);
  assert.match(adapted, /approval-notice:/); assert.match(adapted, /approval-withdraw:/);
  assert.match(adapted, /entry\.nexusNoticeController\.abort/);
  assert.equal((adapted.match(/\.cancelPending\(entry\.requesterAgent, receipt\.message_id\)/g) ?? []).length, 2);
  assert.match(adapted, /await Promise\.allSettled\(\[\.\.\.nexusBridgeTasks\]\)/);
  assert.doesNotMatch(adapted, /new AbortController\(\)\.signal/);
  assert.throws(() => adaptCrossSessionHost(original.replace('function deliver(', 'function changedDeliver(')), /expected one/);
});

test('native composition preserves native entries, permission clamps and the opt-in computer chip', async () => {
  const rows = parse(await newPluginsComposition()).flatMap(row => row.insert ?? []);
  const approval = rows.find(row => row.id === 'cross-session-approval');
  assert.equal(approval.config.spawnPermission, 'cap');
  assert.equal(approval.config.forkPermission, 'cap');
  assert.equal(approval.config.approvalBridge.enabled, true);
  assert.ok(approval.inject.includes('nexusCrossSessionMailbox'));
  assert.equal(rows.find(row => row.id === 'computer-use').config.defaultEnabled, false);
  assert.equal(rows.find(row => row.id === 'motion-ui').name, 'dsh-noemaloom/original/motion-ui');
});
