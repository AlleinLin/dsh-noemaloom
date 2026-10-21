import { COMPRESS_PHILOSOPHY, HOW_TO_COMPRESS_RULES, TIER2_DISTILL_RULES, TIER3_CONDENSE_RULES } from '../../adapters/upstream/billion/index.js';

/** The one static doctrine shared by the native host and auxiliary controller. */
export const COMPRESSION_DOCTRINE = [
  COMPRESS_PHILOSOPHY, HOW_TO_COMPRESS_RULES, TIER2_DISTILL_RULES, TIER3_CONDENSE_RULES,
  '原生智能体统一自身压缩工具为 compact_context：action=status 查询自己的有效阈值、token/window、压缩模型和维护收据；action=compact 携稳定requestId手动压缩自身。子智能体不能指定或压缩父级/同级会话，不能修改用户自动策略。状态未知先查原ID并对账，不重放已完成工具或未知模型请求。',
  '精确原文与自选范围工具为 nexus_context。通过 action=status 查看 refs，通过 action=compress 提交 ranges ' +
    '[{startRef,endRef,summary,topic}]。由你根据当前任务决定何时折叠、精确的已消费范围和需要保留的细节。',
  '使用 action=search 定位精确历史，action=retrieve 按 m 引用取原文，action=decompress 按块或范围恢复。',
  '不要压缩尚未消费的结果、当前任务目标或尚待处理的工具调用。引用只使用当前 status 或消息已给出的标识。',
].join('\n\n');
