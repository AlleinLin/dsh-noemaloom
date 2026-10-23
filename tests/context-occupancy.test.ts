import test from 'node:test';
import assert from 'node:assert/strict';
import { contextOccupancy } from '../src/shared/context-occupancy.js';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
const bundled = await build({ entryPoints: ['src/client/AgentInsights.tsx'], bundle: true, write: false,
  platform: 'node', format: 'cjs', packages: 'external', loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} as any };
new Function('require', 'module', 'exports', bundled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const { agentContextMetrics } = module.exports;

const breakdown = { systemTokens: 4700, toolsTokens: 28600, messageTokens: 244100 };
test('restored or failed-zero provider pressure falls back to the retained surface, including after compaction', () => {
  for (const pressure of [{ contextWindow: 500000 }, { projectedTokens: 0, pressureTokens: 0, contextWindow: 500000 }]) {
    const result = contextOccupancy({ contextPressure: pressure, contextBreakdown: breakdown });
    assert.equal(result.tokens, 277400);
    assert.equal(result.estimated, true);
    assert.equal(result.window, 500000);
    assert.equal(contextOccupancy({ contextPressure: pressure, contextBreakdown: { ...breakdown, messageTokens: 12000 } }).tokens, 45300);
  }
});
test('valid next-request pressure wins over both heuristics and the old pre-compaction sample', () => {
  assert.equal(contextOccupancy({ contextPressure: { projectedTokens: 90000, pressureTokens: 450000 },
    contextBreakdown: breakdown }).tokens, 90000);
  assert.equal(contextOccupancy({}).tokens, undefined);
  assert.equal(contextOccupancy({ contextBreakdown: { systemTokens: 0, toolsTokens: 0, messageTokens: 0 } }).tokens, 0);
  assert.equal(contextOccupancy({ contextPressure: { projectedTokens: NaN, pressureTokens: -2 },
    contextBreakdown: breakdown }).tokens, 277400);
});
test('agent graph metrics use the same occupancy as the composer, without requiring an optional context plugin timeline', () => {
  const result = agentContextMetrics({ contextPressure: { projectedTokens: 0, contextWindow: 500000 },
    contextBreakdown: breakdown });
  assert.equal(result?.tokens, 277400);
  assert.equal(result?.percent, 55.5);
  assert.equal(Math.round(result!.parts.reduce((sum: number, part: { value: number }) => sum + part.value, 0)), 277400);
});
