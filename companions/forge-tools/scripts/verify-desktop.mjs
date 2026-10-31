import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { connectTarget, until, delay, completeSyntheticOnboarding } from './desktop-cdp.mjs';

// End-to-end Desktop acceptance. The deterministic local model chooses calls;
// the installed Electron renderer, Agent loop and tools execute them for real.
const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
const install = process.env.FORGE_DSH_ROOT ?? 'D:/Program Files/DeepSeek Harness';
const executable = path.join(install, 'DeepSeek Harness.exe');
const cli = path.join(install, 'resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'forge-desktop-gui-'));
const productHome = path.join(temporary, 'home');
const userData = path.join(temporary, 'electron-user-data');
const profile = path.join(productHome, 'profiles/desktop');
const workspace = path.join(temporary, 'workspace');
const documents = path.join(temporary, 'documents');
const input = path.join(workspace, '输入 file.txt');
const output = path.join(workspace, 'output.txt');
// Evidence stays in the source workspace for development review. Packaging
// explicitly excludes these screenshots from the installable handoff.
const evidence = path.join(root, 'docs/desktop-evidence');
const transcript = [];
const advertisedTools = new Set();
const advertisedSchemas = new Map();
const observedResults = new Map();
const permissionCases = new Map();
let child, cdp, failure;
await mkdir(workspace);
await mkdir(profile, { recursive: true });
await mkdir(evidence, { recursive: true });
await writeFile(input, 'FORGE_DESKTOP_INPUT 你好\n');
const steps = [
  { name: 'read', args: { file_path: input, fresh: true }, expect: /FORGE_DESKTOP_INPUT 你好/ },
  { name: 'write', args: { file_path: output, content: 'alpha 中文\n' }, expect: /output\.txt/,
    permission: { label: 'equal target with empty reason', required: true,
      args: { sandbox_permissions: 'danger-full-access', justification: '' } } },
  { name: 'edit', args: { file_path: output, old_string: 'alpha', new_string: 'beta' }, expect: /output\.txt/,
    permission: { label: 'lower target with whitespace reason', required: true,
      args: { sandbox_permissions: 'workspace-write', justification: '   ' } } },
  { name: 'read_many', args: { files: [{ file_path: input }, { file_path: output }] }, expect: /beta 中文/ },
  { name: 'batch_edit', args: { edits: [{ file_path: output, old_string: 'beta', new_string: 'gamma' }] }, expect: /completed/,
    permission: { label: 'orphan empty reason', required: true, args: { justification: '' } } },
  { name: 'glob', args: { path: workspace, pattern: '**/*.txt', fresh: true }, expect: /output\.txt/ },
  { name: 'grep', args: { path: workspace, pattern: 'gamma 中文', fresh: true }, expect: /gamma 中文/ },
  { name: 'list_directory', args: { path: workspace }, expect: /output\.txt/ },
  { name: 'pwsh', args: { command: "$forgeDesktopValue = '桌面常驻'; Write-Output $forgeDesktopValue", workdir: workspace }, expect: /桌面常驻/,
    permission: { label: 'equal target with empty reason', required: false,
      args: { sandbox_permissions: 'danger-full-access', justification: '' } } },
  { name: 'pwsh', args: { command: 'Write-Output ($forgeDesktopValue + \':第二次\')', workdir: workspace }, expect: /桌面常驻:第二次/,
    permission: { label: 'orphan nonempty reason', required: false,
      args: { justification: '兼容旧模型附带的理由；按当前桌面会话权限执行。' } } },
  { name: 'pwsh_run', args: { file: 'pwsh', args: ['-NoProfile', '-Command', "Write-Output 'literal 中文 $x'"], workdir: workspace }, expect: /literal 中文 \$x/,
    permission: { label: 'lower target with whitespace reason', required: false,
      args: { sandbox_permissions: 'workspace-write', justification: '  ' } } },
  { name: 'forge_status', args: {}, expect: /residentCalls/ },
];

function stream(response, content, stopReason) {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const emit = (type, value = {}) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
  emit('message_start', { message: { id: `msg_forge_${transcript.length}`, type: 'message',
    role: 'assistant', model: 'forge-test', content: [], usage: { input_tokens: 10, output_tokens: 0 } } });
  emit('content_block_start', { index: 0, content_block: content });
  emit('content_block_stop', { index: 0 });
  emit('message_delta', { delta: { stop_reason: stopReason }, usage: { output_tokens: 10 } });
  emit('message_stop');
  response.end();
}

function nativeStepArguments(step, index) {
  if (!step.permission) return step.args;
  const properties = advertisedSchemas.get(step.name)?.properties ?? {};
  const exposed = Object.keys(step.permission.args).every(key => Object.hasOwn(properties, key));
  if (step.permission.required)
    assert.ok(exposed, `${step.name}: actual Desktop must expose the file permission fields for screenshot regression coverage`);
  permissionCases.set(index, { call: index + 1, name: step.name, case: step.permission.label,
    fieldsExposed: exposed, result: exposed ? 'executed through native tool pipeline'
      : 'not exercised: actual Desktop shell capability does not advertise these fields',
    ...(exposed ? { arguments: step.permission.args } : {}) });
  return exposed ? { ...step.args, ...step.permission.args } : step.args;
}

const server = createServer(async (request, response) => {
  try {
    if (!request.url?.endsWith('/messages')) throw new Error('Unexpected local model route');
    let text = '';
    for await (const data of request) text += data;
    const body = JSON.parse(text);
    for (const tool of body.tools ?? []) {
      advertisedTools.add(tool.name);
      advertisedSchemas.set(tool.name, tool.input_schema);
    }
    for (const message of body.messages ?? []) {
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (block.type === 'tool_result') observedResults.set(block.tool_use_id, block);
      }
    }
    const index = observedResults.size;
    transcript.push({ request: transcript.length + 1, completedTools: index, model: body.model });
    if (index < steps.length) {
      const step = steps[index];
      stream(response, { type: 'tool_use', id: `forge_desktop_${index}`, name: step.name,
        input: nativeStepArguments(step, index) }, 'tool_use');
    } else {
      stream(response, { type: 'text',
        text: 'DESKTOP_FORGE_ACCEPTANCE_OK：标准模式下，文件读写、批量编辑、搜索、PowerShell 常驻及字面参数均已执行；已验证实际暴露的重复权限参数兼容。此轮使用本地测试模型。' }, 'end_turn');
    }
  } catch (error) {
    failure = error;
    response.writeHead(500);
    response.end('Local Desktop acceptance model failed');
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const modelOrigin = `http://127.0.0.1:${server.address().port}`;
const env = { ...process.env, DSH_HOME: productHome, ELECTRON_RUN_AS_NODE: '1',
  DSH_AGENTS_HOME: path.join(temporary, 'agents'),
  DEEPSEEK_API_KEY: 'forge-isolated-validation-placeholder-no-external-model' };
function launch(args) {
  const result = spawnSync(executable, ['--expose-internals', cli, ...args],
    { env, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  if (result.status !== 0) throw new Error((result.stderr || result.stdout).slice(0, 1500));
}
async function screenshot(name) {
  const { data } = await cdp.call('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(evidence, name), Buffer.from(data, 'base64'));
}
async function clickButton(predicate) {
  const expression = `(()=>{const button=[...document.querySelectorAll('button')].find(${predicate});
    if(!button)throw new Error('Desktop acceptance button missing');button.click();return true})()`;
  return cdp.evaluate(expression);
}
try {
  await writeFile(path.join(profile, 'package.json'), JSON.stringify({
    name: 'dsh-profile-desktop', private: true, dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
  }, null, 2));
  await writeFile(path.join(profile, 'cordis.patch.yml'), '[]\n');
  await writeFile(path.join(profile, 'pnpm-workspace.yaml'),
    'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n');
  launch(['plugin', '--profile', 'desktop', 'add', '--offline', '--ignore-scripts', '--save-exact',
    path.join(root, 'delivery/local-dsh-forge-tools-0.1.6.tgz')]);
  await writeFile(path.join(profile, 'cordis.patch.yml'), `
- id: llm-deepseek
  config:
    baseURL: ${modelOrigin}
    thinking: disabled
    reasoningEffort: 'off'
    maxTokens: 4096
    retryPolicy:
      mode: normal
      maxRetries: 0
    models:
      - id: forge-test
        name: Forge Desktop Test
        contextWindow: 100000
- id: agent-default-model
  config:
    provider: deepseek-official
    model: forge-test
    reasoningEffort: 'off'
- id: session-title-llm
  disabled: true
- id: llm-deepseek-account
  disabled: true
- id: desktop-product-telemetry
  disabled: true
- id: product-analytics
  disabled: true
- id: workspace-controller
  config:
    documentsDirectory: ${JSON.stringify(documents.replaceAll('\\', '/'))}
`);
  const guiEnv = { ...env };
  delete guiEnv.ELECTRON_RUN_AS_NODE;
  child = spawn(executable, [`--user-data-dir=${userData}`, '--remote-debugging-port=0'],
    { env: guiEnv, windowsHide: true, detached: true, stdio: 'ignore' });
  child.unref();
  const debugging = await until(async () => {
    try { return await readFile(path.join(userData, 'DevToolsActivePort'), 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  });
  const port = Number(debugging.split('\n')[0]);
  await completeSyntheticOnboarding(port);
  // Keep only non-secret dedicated endpoint metadata for manual failure diagnosis.
  await writeFile(path.join(root, '.desktop-validation-state.json'), JSON.stringify({
    temporary, productHome, userData, workspace, pid: child.pid, port,
  }));
  const target = await until(async () => {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    return targets.find(target => target.type === 'page' && target.url.startsWith('dsh-app://app'));
  });
  cdp = await connectTarget(target);
  await until(() => cdp.evaluate(`!!document.body?.innerText.includes('Forge Desktop Test') && document.body.innerText.includes('标准模式')`));
  assert.equal(await cdp.evaluate('location.origin'), 'dsh-app://app');
  await clickButton(`x=>x.title.includes('Agent')`);
  const presetMenu = await cdp.evaluate('document.body.innerText');
  assert.ok(presetMenu.includes('标准模式') && !presetMenu.includes('Forge 高性能工具集'));
  await screenshot('desktop-standard.png');
  await clickButton(`x=>x.title.includes('Agent')`);
  // Only this disposable test session chooses full access, via the same GUI
  // control as a user, to validate the explicit resident-process code path.
  await clickButton(`x=>(x.getAttribute('aria-label')||'').startsWith('访问模式')`);
  await clickButton(`x=>x.innerText.trim()==='完全权限'`);
  await until(() => cdp.evaluate(`!!document.querySelector('[role=dialog] input[type=checkbox]')`));
  await cdp.evaluate(`document.querySelector('[role=dialog] input[type=checkbox]').click();true`);
  await clickButton(`x=>x.innerText.trim()==='启用完全权限'`);
  await until(() => cdp.evaluate(`[...document.querySelectorAll('button')].some(x=>x.getAttribute('aria-label')==='访问模式，当前：完全权限')`));
  const editors = await cdp.evaluate(`[...document.querySelectorAll('textarea,input,[contenteditable=true]')].map(x=>({tag:x.tagName,role:x.getAttribute('role'),placeholder:x.getAttribute('placeholder')}))`);
  assert.ok(editors.length > 0, 'Desktop composer must be present');
  await cdp.evaluate(`(()=>{const editor=document.querySelector('[contenteditable=true],textarea');editor.focus();return true})()`);
  await cdp.call('Input.insertText', { text: '运行此临时目录的本地工具验收；保持官方标准模式。' });
  await clickButton(`x=>x.getAttribute('aria-label')==='发送消息'`);
  console.log('Original Electron Desktop standard session submitted to the local test model.');
  await until(async () => {
    if (failure) throw failure;
    return cdp.evaluate(`document.body.innerText.includes('DESKTOP_FORGE_ACCEPTANCE_OK')`);
  }, 60000);
  for (const [index, step] of steps.entries()) {
    assert.ok(advertisedTools.has(step.name), `${step.name}: not advertised by standard`);
    const result = observedResults.get(`forge_desktop_${index}`);
    assert.ok(result, `${step.name}: no real tool result reached the model`);
    assert.ok(!result.is_error, `${step.name}: ${JSON.stringify(result.content).slice(0, 1000)}`);
    assert.match(JSON.stringify(result.content), step.expect, `${step.name}: wrong real result`);
  }
  assert.equal(await readFile(output, 'utf8'), 'gamma 中文\n');
  const jsonResult = index => JSON.parse(observedResults.get(`forge_desktop_${index}`).content
    .map(block => block.text ?? '').join(''));
  const firstPwsh = jsonResult(8);
  const warmPwsh = jsonResult(9);
  const status = jsonResult(11);
  assert.equal(status.version, '0.1.6');
  assert.equal(firstPwsh.mode, 'persistent');
  assert.equal(warmPwsh.mode, 'persistent');
  assert.equal(status.pwsh.residentStarts, 1);
  assert.equal(status.pwsh.residentCalls, 2);
  assert.equal(status.pwsh.isolatedCalls, 1);
  await delay(500);
  await screenshot('desktop-tools.png');
  await clickButton(`x=>x.innerText.trim()==='轨迹'`);
  await until(() => cdp.evaluate(`[...document.querySelectorAll('tr')].some(x=>x.innerText.includes('pwsh{'))`));
  await cdp.evaluate(`[...document.querySelectorAll('tr')].filter(x=>x.innerText.includes('pwsh{'))[1].scrollIntoView({block:'center'});true`);
  await screenshot('desktop-tools-trace.png');
  const report = {
    host: '0.2.1-rc.5', platform: 'win32-x64', surface: 'Original installed Electron Desktop',
    origin: 'dsh-app://app', profile: 'desktop', preset: 'standard', result: 'passed',
    noPresetSwitchRequired: true, isolatedProductHome: true, isolatedElectronUserData: true,
    isolatedDefaultWorkspace: true,
    model: 'Deterministic local Anthropic Messages SSE fixture; no external model requests.',
    actualExecution: 'GUI composer -> official provider/Agent loop -> real Forge tools -> real tool_result -> GUI response.',
    networkLimit: 'No assertion that Electron updater/account infrastructure performs zero non-model networking.',
    fullAccess: 'Chosen through the access-mode GUI in this disposable test session only.',
    tools: steps.map((step, index) => ({ name: step.name, call: index + 1, result: 'passed' })),
    permissionCompatibility: { version: status.version, perCallSessionMode: 'danger-full-access',
      scope: 'Normal native tools through actual Desktop Agent loop; top-level SDK run_code is not modified or covered.',
      cases: [...permissionCases.values()] },
    pwsh: { firstMs: firstPwsh.elapsedMs, warmMs: warmPwsh.elapsedMs,
      residentStarts: status.pwsh.residentStarts, residentCalls: status.pwsh.residentCalls },
    advertisedToolCount: advertisedTools.size, modelRequestCount: transcript.length,
    outputFile: 'gamma 中文\\n',
    screenshotsScope: 'Local source-workspace development evidence only; excluded from npm/ZIP/build delivery.',
    screenshots: ['desktop-evidence/desktop-standard.png', 'desktop-evidence/desktop-tools.png',
      'desktop-evidence/desktop-tools-trace.png'],
  };
  await writeFile('docs/desktop-validation.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  failure = error;
  console.error(`Desktop acceptance failed: ${error.message}`);
  if (cdp) console.error((await cdp.evaluate('document.body.innerText').catch(() => '')).slice(-5000));
  throw error;
} finally {
  cdp?.close();
  if (process.env.FORGE_KEEP_GUI !== '1') {
    if (child?.pid) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    await rm(path.join(root, '.desktop-validation-state.json'), { force: true });
    const relative = path.relative(os.tmpdir(), temporary);
    if (relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(temporary).startsWith('forge-desktop-gui-'))
      throw new Error('Unsafe isolated Desktop cleanup path');
    await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
