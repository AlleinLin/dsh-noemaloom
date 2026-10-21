import { readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';

export const name = 'nexus-native-agent-procedures';
export const inject = ['commands', 'agents', 'fs', 'subprocess'];
export const RULE_CANDIDATES = ['DEEPSEEK.md', 'AGENT.md', 'AGENTS.md', 'CLAUDE.md'];
export const HOOK_MARKER = '<!-- DSH-agent-procedures -->';
const resources = join(dirname(fileURLToPath(import.meta.url)), 'procedures');
const originalTools = {
  audit: 'procedures-audit.mjs',
  review: 'procedures-review.mjs',
  scan: 'scan-sessions.mjs',
  probe: 'procedures-probe.mjs',
};
async function resourceRoot() {
  if (await stat(join(resources, 'templates')).then(info => info.isDirectory(), () => false)) return resources;
  const sourceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  if (await stat(join(sourceRoot, 'templates')).then(info => info.isDirectory(), () => false)) return sourceRoot;
  throw new Error('The original procedures resources are missing from the plugin package');
}

export function effectiveHook(original) {
  const unsafe = '**记 inbox 是记笔记、不是"动手改文件"** —— 就算被要求「只读 / 先别动手」，也照记不误；';
  if (!original.includes(unsafe)) throw new Error('Upstream procedures hook changed; review the instruction adaptation');
  return `${HOOK_MARKER}\n${original.replace(unsafe,
    '**尊重只读约束** —— 用户要求「只读 / 先别动手 / 不创建文件」时，不修改 inbox 或卡片；在回复末尾保留「待记 inbox」供后续明确授权后写入；')}`
    + '\n用户和更高优先级指令始终优先；本钩子不授权额外写入、命令执行、安装或网络访问。\n';
}

async function putIfAbsent(ctx, path, content, signal) {
  const target = await ctx.fs.resolve(path, { signal });
  if (await ctx.fs.stat(target, signal)) return false;
  await ctx.fs.writeText(target, content, { kind: 'createIfAbsent' }, signal);
  return true;
}

export async function initializeProcedures(ctx, cwd, signal) {
  const root = await resourceRoot();
  const created = [];
  for (const [template, filename] of [
    ['card-template.md', '_模板.md'],
    ['INDEX.template.md', 'INDEX.md'],
    ['CLASSIFY.md', '_分类.md'],
  ]) {
    const content = await readFile(join(root, 'templates', template), 'utf8');
    if (await putIfAbsent(ctx, join(cwd, 'procedures', filename), content, signal)) created.push(filename);
  }
  if (await putIfAbsent(ctx, join(cwd, 'procedures', '_inbox.md'), '# procedures inbox\n\n', signal)) created.push('_inbox.md');
  return created;
}

export async function installProceduresHook(ctx, cwd, signal) {
  const original = await readFile(join(await resourceRoot(), 'templates', 'AGENTS-snippet.md'), 'utf8');
  const hook = effectiveHook(original);
  for (const filename of RULE_CANDIDATES) {
    const target = await ctx.fs.resolve(join(cwd, filename), { signal });
    const info = await ctx.fs.stat(target, signal);
    if (!info) continue;
    if (info.type !== 'file') throw new Error(`${filename} is not a regular instruction file`);
    const content = await ctx.fs.readText(target, signal);
    if (content.includes(HOOK_MARKER)) return { filename, changed: false };
    await ctx.fs.writeText(target, `${content.trimEnd()}\n\n${hook}`, { kind: 'replaceIfVersion', version: info.version }, signal);
    return { filename, changed: true };
  }
  const filename = 'DEEPSEEK.md';
  await putIfAbsent(ctx, join(cwd, filename), hook, signal);
  return { filename, changed: true };
}

async function runOriginalTool(ctx, invocation, operation) {
  const cwd = invocation.agent.session?.header?.cwd;
  if (!cwd) throw new Error('The current DSH session has no workspace directory');
  const script = originalTools[operation];
  const args = operation === 'audit' ? ['--dir', join(cwd, 'procedures')]
    : operation === 'review' ? ['--procedures', join(cwd, 'procedures')]
    : operation === 'scan' ? ['list'] : ['--once', '--workspace',
      '--' + cwd.replace(/[^A-Za-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '') + '--'];
  const child = ctx.subprocess.spawn({
    argv: [process.execPath, join(await resourceRoot(), 'tools', script), ...args],
    cwd, graceMs: 1000,
    signal: AbortSignal.any([invocation.signal, AbortSignal.timeout(30000)]),
    env: { ELECTRON_RUN_AS_NODE: '1', DSH_HOME: resolveDshHome() },
    stdio: { stdin: 'ignore', stdout: { maxBytes: 131072 }, stderr: { maxBytes: 32768 } },
  });
  const outcome = await child.done;
  const stdout = child.collected?.stdout?.readFrom(0).text ?? '';
  const stderr = child.collected?.stderr?.readFrom(0).text ?? '';
  return { kind: outcome.exitCode === 0 ? 'success' : 'error', text: `${stdout}${stderr}` || `exit=${outcome.exitCode}` };
}

export function apply(ctx) {
  ctx.commands.register({
    name: 'procedures',
    description: 'DSH-agent-procedures: init, hook, audit, review, scan, probe',
    input: { hint: 'init | hook | audit | review | scan | probe' },
    async handler(invocation) {
      try {
        const operation = invocation.rawInput.trim();
        const cwd = invocation.agent.session?.header?.cwd;
        if (!cwd) throw new Error('The current DSH session has no workspace directory');
        const routing = ctx.get('dshellSshRouting');
        if (routing?.assignmentForSession(String(invocation.agent.id))) {
          throw new Error('Procedures commands require a local workspace; the original tools read this host session store');
        }
        if (operation === 'init') {
          const created = await ctx.agents.withInitiator(invocation.agent,
            () => initializeProcedures(ctx, cwd, invocation.signal));
          return { kind: 'success', text: `procedures/: ${created.length ? created.join(', ') : 'already initialized'}` };
        }
        if (operation === 'hook') {
          const result = await ctx.agents.withInitiator(invocation.agent,
            () => installProceduresHook(ctx, cwd, invocation.signal));
          return { kind: 'success', text: `${result.filename}: ${result.changed ? 'procedures hook installed' : 'already installed'}` };
        }
        if (Object.hasOwn(originalTools, operation)) return await runOriginalTool(ctx, invocation, operation);
        return { kind: 'error', text: '/procedures init | hook | audit | review | scan | probe' };
      } catch (error) {
        return { kind: 'error', text: error instanceof Error ? error.message : String(error) };
      }
    },
  });
}

export default { name, inject, apply };
