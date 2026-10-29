import { Context } from '@deepseek-ai/cordis';
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local';
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox';
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local';
import { PwshLocalExecutor } from '@deepseek-ai/dsh-pwsh-local';
import { ToolRuntime } from '@deepseek-ai/dsh-tools';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as plugin from '../src/index.mjs';

export async function environment(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-test-'));
  const ctx = new Context();
  const observations = new Map();
  ctx.provide('systemPrompt', { section: () => () => {}, tools: () => () => {}, getSectionOrder: () => 1 });
  ctx.provide('sandboxPolicy', { defaultMode: options.mode ?? 'danger-full-access', resolve: request =>
    options.policyResolver?.(request, root) ?? ({
      mode: options.mode ?? 'danger-full-access', workspaceRoot: root,
    }) });
  if (options.approval !== undefined) ctx.provide('approval', options.approval);
  ctx.provide('workingDirectory', { ensure: async () => root });
  await ctx.plugin(options.sandboxFs ? SandboxedFileSystem : LocalFileSystem, { cwd: root }).await();
  await ctx.plugin(LocalSubprocessRuntime).await();
  await ctx.plugin(PwshLocalExecutor, {}).await();
  await ctx.plugin(ToolRuntime, {}).await();
  ctx.on('fs/observed', (target, observation) => observations.set(target.targetKey, observation));
  if (options.guarded) {
    ctx.on('fs/edit-intent', async target => {
      const observed = observations.get(target.targetKey);
      if (observed?.kind !== 'present') throw new Error('FS_NOT_OBSERVED');
      return { version: observed.version };
    });
    ctx.on('fs/write-intent', async target => {
      const observed = observations.get(target.targetKey);
      return observed?.kind === 'present' ? { kind: 'replaceIfVersion', version: observed.version }
        : { kind: 'createIfAbsent' };
    });
  }
  await ctx.plugin(plugin, { watch: false, ...options.config }).await();
  const agent = { id: 'test-agent', session: { header: { cwd: root } }, ctx: ctx.extend() };
  const execute = async (name, args, signal = new AbortController().signal) => {
    const tool = ctx.tools.get(name);
    if (!tool) throw new Error(`Tool unavailable: ${name}`);
    // Real defineTool validates args; execute body is used to preserve the canonical value for assertions.
    return tool.execute(args, { agent, signal, callId: 'call-test', rootCallId: 'call-test' });
  };
  const nativeExecute = (name, args, extras = {}) => ctx.tools.execute({
    name, arguments: args, agent, callId: 'native-test', signal: new AbortController().signal, ...extras,
  });
  t.after(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }); });
  return { root, ctx, execute, nativeExecute, agent, observations };
}
