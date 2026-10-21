import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseDocument } from 'yaml';

test('shipped presets wire the ordered first-match project rule reader', async () => {
  const files = ['cordis.presets.patch.yml', ...['windows-coding', 'windows-gitbash', 'adaptive-standard']
    .map(name => `assets/presets/${name}.declaration.yml`)];
  for (const file of files) {
    const document = parseDocument(await readFile(new URL(`../${file}`, import.meta.url), 'utf8'), {
      customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }],
    });
    assert.deepEqual(document.errors, [], file);
    let consumers = 0;
    let delegations = 0;
    const visit = (value: unknown): void => {
      if (!value || typeof value !== 'object') return;
      if (!Array.isArray(value) && (value as Record<string, unknown>).name === '@deepseek-ai/dsh-agent-instructions') {
        assert.fail(`Unadapted all-candidates reader in ${file}`);
      }
      if (!Array.isArray(value) && (value as Record<string, unknown>).name === '@deepseek-ai/dsh-tool-subagent') {
        assert.fail(`Unadapted child model selection in ${file}`);
      }
      if (!Array.isArray(value) && (value as Record<string, unknown>).name === '@local/dsh-nexus/subagent') delegations++;
      if (!Array.isArray(value) && (value as Record<string, unknown>).name === '@local/dsh-nexus/project-rules') {
        const config = (value as { config: Record<string, unknown> }).config;
        assert.deepEqual(config.instructionFileCandidates, ['DEEPSEEK.md', 'AGENT.md', 'AGENTS.md', 'CLAUDE.md'], file);
        assert.deepEqual(config.localInstructionFileCandidates, [], file);
        assert.equal(config.maxBytes, 65536, file);
        consumers++;
      }
      for (const child of Object.values(value)) visit(child);
    };
    visit(document.toJS());
    assert(consumers > 0, `Missing official instruction consumer: ${file}`);
    if (file.includes('adaptive-standard') || file === 'cordis.presets.patch.yml') assert(delegations > 0, `Missing child selection consumer: ${file}`);
  }
});
