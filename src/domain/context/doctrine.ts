import { COMPRESS_PHILOSOPHY, HOW_TO_COMPRESS_RULES, TIER2_DISTILL_RULES, TIER3_CONDENSE_RULES } from '../../adapters/upstream/billion/index.js';

/** The one static doctrine shared by the native host and auxiliary controller. */
export const COMPRESSION_DOCTRINE = [
  COMPRESS_PHILOSOPHY, HOW_TO_COMPRESS_RULES, TIER2_DISTILL_RULES, TIER3_CONDENSE_RULES,
  'Nexus 统一工具为 nexus_context。通过 action=status 查看 refs，通过 action=compress 提交 ranges ' +
    '[{startRef,endRef,summary,topic}]。由你根据当前任务决定何时折叠、精确的已消费范围和需要保留的细节。',
  '使用 action=search 定位精确历史，action=retrieve 按 m 引用取原文，action=decompress 按块或范围恢复。',
  '不要压缩尚未消费的结果、当前任务目标或尚待处理的工具调用。引用只使用当前 status 或消息已给出的标识。',
].join('\n\n');
