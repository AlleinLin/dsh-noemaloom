/**
 * `dshellUsage` namespace dictionaries, and the namespace's declaration.
 *
 * The namespace merge lives with its key set so that any module naming
 * `TranslateNS<'dshellUsage'>` or `PropsLocale<'dshellUsage'>` needs only this
 * file. Keys are lowercase and dotted: `nav.*` (the settings navigation row),
 * `range.*` (the window selector), `chart.*` (the two charts' captions),
 * `table.*` (the route breakdown), and `state.*` (empty, busy, freshness, and
 * the load failure).
 */

import type {} from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The usage settings page: navigation label, charts, table, and states. */
    dshellUsage: DshellUsageKey
  }
}

/** Simplified Chinese dictionary and key-set source of truth. */
export const zh = {
  // The Settings navigation row this page owns.
  'nav': '用量',

  'title': '模型 token 消耗',
  'subtitle': '按模型汇总每个会话上报的用量。索引建在 dshell 自己的数据目录里，首次打开会扫一遍全部历史会话，之后只补新增的部分。',

  // The window selector. `{days}` is the day count.
  'range.7': '近 7 天',
  'range.30': '近 30 天',
  'range.all': '全部',
  'range.label': '时间范围',

  'rebuild': '重新聚合',
  'rebuild.busy': '正在聚合…',

  'chart.heatmap': '每日热力（近 26 周内）',
  'chart.heatmapDay': '{day} · {total} tok · {turns} 次调用',
  'chart.heatmapLess': '少',
  'chart.heatmapMore': '多',
  'chart.heatmapPeak': '最忙一天 {total} tok',
  'chart.heatmapTruncated': '只画最近 26 周',
  'chart.curve': '每日消耗（按模型）',
  'chart.pie': '模型占比',

  'summary.total': '合计',
  'summary.uncached': '未缓存输入',
  'summary.output': '输出',
  'summary.cacheRead': '缓存读',
  'summary.turns': '调用',
  'summary.hitRate': '缓存命中率',

  'table.title': '按模型明细',
  'table.model': '模型',
  'table.input': '输入',
  'table.output': '输出',
  'table.cacheRead': '缓存读',
  'table.cacheWrite': '缓存写',
  'table.turns': '调用',
  'table.total': '合计',

  'state.empty.title': '还没有可统计的用量',
  'state.empty.body': '索引里没有任何一条带用量上报的模型调用。跑一次 agent 会话后再点「重新聚合」。',
  'state.freshness': '索引更新于 {day}',
  'state.skipped': '有 {count} 个会话的日志读不了，未计入（详情见悬停提示）。',
  'state.scanned': '本次扫描列出 {sessions} 个会话，读取了 {read} 个，命中 {turns} 次调用。',
  'state.error': '读取用量失败：{reason}',
  'state.loading': '正在读取索引…',
} as const

/** The key set, taken from the dictionary that defines it. */
export type DshellUsageKey = keyof typeof zh

/** English dictionary, keyed by the same set. */
export const en: Record<DshellUsageKey, string> = {
  'nav': 'Usage',

  'title': 'Model token usage',
  'subtitle': 'Per-model totals folded from the usage every session reports. The index lives in dshell\'s own data directory: the first visit scans every session once, and later visits add only what is new.',

  'range.7': 'Last 7 days',
  'range.30': 'Last 30 days',
  'range.all': 'All time',
  'range.label': 'Range',

  'rebuild': 'Rebuild',
  'rebuild.busy': 'Rebuilding…',

  'chart.heatmap': 'Daily heatmap (last 26 weeks)',
  'chart.heatmapDay': '{day} · {total} tok · {turns} calls',
  'chart.heatmapLess': 'Less',
  'chart.heatmapMore': 'More',
  'chart.heatmapPeak': 'Busiest day {total} tok',
  'chart.heatmapTruncated': 'Showing the last 26 weeks',
  'chart.curve': 'Daily usage by model',
  'chart.pie': 'Share by model',

  'summary.total': 'Total',
  'summary.uncached': 'Uncached input',
  'summary.output': 'Output',
  'summary.cacheRead': 'Cache read',
  'summary.turns': 'Calls',
  'summary.hitRate': 'Cache hit rate',

  'table.title': 'By model',
  'table.model': 'Model',
  'table.input': 'Input',
  'table.output': 'Output',
  'table.cacheRead': 'Cache read',
  'table.cacheWrite': 'Cache write',
  'table.turns': 'Calls',
  'table.total': 'Total',

  'state.empty.title': 'No usage to count yet',
  'state.empty.body': 'The index holds no model call that reported usage. Run an agent session, then press Rebuild.',
  'state.freshness': 'Index updated {day}',
  'state.skipped': '{count} session logs could not be read and are not counted (hover for the reason).',
  'state.scanned': 'This scan listed {sessions} sessions, read {read}, and counted {turns} calls.',
  'state.error': 'Reading usage failed: {reason}',
  'state.loading': 'Reading the index…',
}
