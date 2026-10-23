interface ContextValues {
  contextPressure?: { projectedTokens?: number; pressureTokens?: number; contextWindow?: number };
  contextBreakdown?: { systemTokens?: number; toolsTokens?: number; messageTokens?: number };
  contextTimeline?: { current?: { total?: number }; contextWindow?: number };
}
const count = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/**
 * Provider pressure is calibrated only after a usage sample. Restored sessions
 * and failed attempts can have no sample (or a zero sample) while their retained
 * surface still has content. In that case display the current surface estimate,
 * never cumulative billing or the pre-compaction request's pressure.
 */
export function contextOccupancy(values: ContextValues) {
  const pressure = values.contextPressure;
  const breakdown = values.contextBreakdown;
  const parts = [breakdown?.systemTokens, breakdown?.toolsTokens, breakdown?.messageTokens];
  const estimate = parts.some(count) ? parts.reduce<number>((sum, value) => sum + (count(value) ? value : 0), 0)
    : count(values.contextTimeline?.current?.total) ? values.contextTimeline.current.total : undefined;
  const sample = count(pressure?.projectedTokens) ? pressure.projectedTokens
    : count(pressure?.pressureTokens) ? pressure.pressureTokens : undefined;
  const tokens = sample !== undefined && (sample > 0 || !estimate) ? sample : estimate;
  const window = count(pressure?.contextWindow) && pressure.contextWindow > 0 ? pressure.contextWindow
    : values.contextTimeline?.contextWindow;
  return { tokens, window, estimated: sample === undefined || sample === 0 && (estimate ?? 0) > 0 };
}
