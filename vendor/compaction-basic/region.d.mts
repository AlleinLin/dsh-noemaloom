export function compactSurfaceRegion(
  dependencies: {
    meter: any;
    summarize(input: any, agent: any, signal?: AbortSignal): Promise<any>;
    recover(error: unknown, agent: any, sourceEventSeqs: readonly number[], signal?: AbortSignal): boolean;
  },
  session: any,
  start: number,
  end: number,
  agent: any,
  options: { owner: 'current-turn' | null; stability: 'whole-surface' | 'selected-span'; flush?: () => Promise<void> },
  signal?: AbortSignal,
): Promise<any>;
