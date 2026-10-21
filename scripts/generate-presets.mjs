/**
 * Deterministic source generation only. Reads public, pinned upstream preset
 * definitions; never opens or copies a user's DSH profile.
 */
import { readFile, writeFile } from 'node:fs/promises';

const sourceRoot = new URL('../assets/presets/upstream/', import.meta.url);
const prefix = '你是协助用户完成软件工作的工程助手。遵守当前任务、工作区规范及宿主权限，先核实事实，再完成实现与验证。';
function deepseekRules(row) {
  return row.replaceAll("'@deepseek-ai/dsh-tool-subagent'", "'@local/dsh-nexus/subagent'")
    .replace(/(^[ \t]*name: '@deepseek-ai\/dsh-agent-instructions'\n[ \t]*config:\n)([ \t]*)maxBytes: 65536$/gm,
    (_, header, indent) => `${header.replace("'@deepseek-ai/dsh-agent-instructions'", "'@local/dsh-nexus/project-rules'")}${indent}maxBytes: 65536\n${indent}instructionFileCandidates: [DEEPSEEK.md, AGENT.md, AGENTS.md, CLAUDE.md]\n${indent}localInstructionFileCandidates: []`);
}
async function upstream(name) {
  const source = await readFile(new URL(`${name}.patch.yml`, sourceRoot), 'utf8');
  const lines = source.slice(source.indexOf('- insert:\n') + '- insert:\n'.length).trimEnd().split('\n');
  return lines.map(line => line.startsWith('    ') ? line.slice(4) : line).join('\n')
    .replaceAll("'@deepseek-ai/dsh-compaction-basic'", "'@local/dsh-nexus/compaction'")
    .replace(/prefix: (?:>-.*\n\s+)?You are a coding agent powered by the \{\{model\}\} model\./g, `prefix: ${prefix}`)
    .replace('prefix: You are a helpful software engineer assistant.', `prefix: ${prefix}`) + '\n';
}
function configuration(row) { return row.replace(/^- id: [^\n]+\n/, '').replace(/^  name: [^\n]+\n/, ''); }
function insertRow(row) { return row.trimEnd().split('\n').map(line => `    ${line}`).join('\n'); }

const officialNames = ['standard', 'ptc', 'minimal', 'cordis'];
const originals = Object.fromEntries(await Promise.all(officialNames.map(async name => [name, await upstream(name)])));
const standard = originals.standard;
const adaptive = standard
  .replace('- id: preset-standard', '- id: preset-suite-adaptive-standard')
  .replace('    id: standard\n', '    id: suite.adaptive-standard\n    name: 自适应标准\n    description: 六核心能力起步，按需发现完整能力目录，保持同一会话工具 schema 稳定。\n')
  .replace('    order: 1\n', '    order: 12\n')
  .replace('    plugins:\n', `    plugins:\n      - id: nexus-preset-policy\n        name: '@local/dsh-nexus/preset-runtime'\n        config:\n          presetId: suite.adaptive-standard\n          shellId: platform-default\n          registerShell: false\n`);
const coding = originals.minimal
  .replace('- id: preset-minimal', '- id: preset-suite-windows-coding')
  .replace('    id: minimal\n', '    id: suite.windows-coding\n    name: Windows 编码\n    description: PowerShell 7 持久终端与精确文本编辑；其余能力按需发现。\n')
  .replace('    order: 3\n', '    order: 10\n')
  .replace('    plugins:\n', `    plugins:\n      - id: nexus-preset-policy\n        name: '@local/dsh-nexus/preset-runtime'\n        config:\n          presetId: suite.windows-coding\n          shellId: pwsh7\n          registerShell: false\n      - id: agent-instructions\n        name: '@deepseek-ai/dsh-agent-instructions'\n        config:\n          maxBytes: 65536\n      - id: time-context\n        name: '@deepseek-ai/dsh-time-context'\n      - id: precise-editor\n        name: '@deepseek-ai/dsh-tool-str-replace-editor'\n`)
  .replace(/      - id: terminal-bash\n[\s\S]*?(?=      - id: terminal-pwsh)/, '')
  .replace(/      - id: persistent-bash\n[\s\S]*?(?=      - id: terminal-pwsh)/, '')
  .replace(/              description: \|-[\s\S]*$/, '              description: 在 PowerShell 7 持久终端执行命令。正常调用之间保留工作目录、变量、函数与环境；权限或预设代际变更后重建，不自动重跑。\n');
// Keep the provider and consumer in the same terminals realm and use official
// PowerShell path resolution; no author-specific path enters the artifact.
const gitbash = `- id: preset-suite-windows-gitbash
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: suite.windows-gitbash
    name: Windows Git Bash
    description: 真正的 Git for Windows Bash，默认每次新进程，精确文本编辑与能力发现。
    order: 11
    plugins:
      - id: persona
        name: '@deepseek-ai/dsh-persona'
        config:
          prefix: ${prefix}
      - id: agent-instructions
        name: '@deepseek-ai/dsh-agent-instructions'
        config:
          maxBytes: 65536
      - id: time-context
        name: '@deepseek-ai/dsh-time-context'
      - id: nexus-preset-policy
        name: '@local/dsh-nexus/preset-runtime'
        config:
          presetId: suite.windows-gitbash
          shellId: git-bash
          registerShell: true
      - id: precise-editor
        name: '@deepseek-ai/dsh-tool-str-replace-editor'
      - id: tool-fs
        name: '@deepseek-ai/dsh-tool-fs'
      - id: tool-fs-search
        name: '@deepseek-ai/dsh-tool-fs-search'
      - id: compaction
        name: cordis:group
        group: true
        isolate:
          compaction: true
          toolResultPruner: true
        config:
          - id: compaction-basic
            name: '@local/dsh-nexus/compaction'
          - id: command-compact
            name: '@deepseek-ai/dsh-command-compact'
          - id: tool-result-pruner
            name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
            config:
              thresholdChars: 8192
              headChars: 4096
              tailChars: 1024
`;
const rows = [...officialNames.map(name => originals[name])];
const patch = `# Generated from public DeepSeek Harness commit 687f282e8625c6b8d11ff58211a90524be2e4317.
# Every matching row replaces its COMPLETE config; not a nested deep merge.
# Contains no local profile, private session, account configuration or backup.
${rows.map(deepseekRules).join('\n')}
- insert:
${[coding, gitbash, adaptive].map(deepseekRules).map(insertRow).join('\n')}
`;
await writeFile(new URL('../cordis.presets.patch.yml', import.meta.url), patch);
for (const [name, row] of [['windows-coding', coding], ['windows-gitbash', gitbash], ['adaptive-standard', adaptive]]) {
  await writeFile(new URL(`../assets/presets/${name}.declaration.yml`, import.meta.url), deepseekRules(row));
}
await writeFile(new URL('../assets/presets/PROVENANCE.md', import.meta.url), `# 预设来源\n\n完整预设基于 MIT 许可的 DeepSeek Harness 公开 commit \`687f282e8625c6b8d11ff58211a90524be2e4317\`。\n原始声明在 \`upstream/*.patch.yml\`，宿主配置合同与 provider 源文件亦保留用于继续开发。\n独立 persona 描述替代官方 persona 文案；全部 compaction provider 绑定 Nexus。\n项目规则适配官方 agent-instructions 0.2.1-rc.2，源码与 MIT 许可在 \`vendor/agent-instructions/\`。\n每目录依次查找 \`DEEPSEEK.md → AGENT.md → AGENTS.md → CLAUDE.md\`，首个命中即停止，禁用本地 overlay；保留官方预算、嵌套作用域和刷新。\n子智能体工具适配官方 tool-subagent 0.2.1-rc.2，源码与许可在 \`vendor/tool-subagent/\`；按会话授权自动提供可用模型代号，空白 effort 默认所选模型最高支持强度，保留授权与生命周期合同。\n生成脚本只读公开源码，不读取本机 profile，也不生成部署恢复备份。\n\n`);
