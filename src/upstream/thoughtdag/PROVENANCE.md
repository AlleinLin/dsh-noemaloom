# ThoughtDAG 复用说明

上游：`https://github.com/chenxiachan/thoughtdag`。研究与适配来源为本次用户指定的 `D:\dshplugin\plugin-sources\chenxiachan__thoughtdag`，许可 MIT，原始版权与完整许可保留于同目录 `LICENSE`。

本目录 `graph.ts` 是上游 `src/lib/graph.ts` 与 `src/lib/condense.ts` 的实质改写：保留后序祖先遍历、材料/引用/主链三层分区、selection sinks、无分叉段发现、前沿保护及 copy-tree 凝练方式；增加明确关系类型、稳定排序、索引遍历、循环路径、SHA256 固定选文、CAS 和统一宿主模型服务。`zstd.ts` 保留上游逐帧结构扫描算法，增加保留位检查和资源上限。

领域目录 `src/domain/graph/context.ts` 改接上游 `src/store/context-builder.ts` 的同一分区与角色解析规则，并使用完整字节 SHA256、可持久冻结计划及精确来源，替换原来的长度 fingerprint 与 djb2。`history-parser.ts` 改接 Claude Code、Codex、Pi 与 DSH collector 的完整行读取、工具调用/结果配对、隐藏 reasoning 排除与原生分支身份。`history.ts` 改接 Atlas 与 why 的授权来源、观察事实/候选解释分列和跨来源索引，不复用原上游隐式读取用户目录的入口。

`history-reader.ts` 对 JSONL 使用 256 KiB 流、2 MiB 解析批次和 8 MiB 单行上限；完整行 offset 与此前完整前缀 SHA256 随 canonical session 一起持久。追加前核验已消费的完整前缀，截断或重写则重建，未完成尾行留待下一次；代价是追加时重新读取旧前缀做完整摘要校验，并不宣称常数 I/O。授权 external-live-source 支持真实递归 watcher、1 秒 debounce、关闭立即取消和停用清理；DSH host-port 只通过正式 sessions port 轮询。

锁定研究文件 SHA256：

| 路径 | SHA256 |
| --- | --- |
| `src/lib/graph.ts` | `E8591A173F20969886E6E9276443C4A675F98758FD7E3128E28BCC722EE1EC4D` |
| `src/lib/condense.ts` | `C74E6E14F2B6667A02050812088D0EC6641E229BB9B9C0637226DEB5365CACB7` |

对应集中验收定义：`tests/graph.test.ts`。测试文件已写入，统一测试阶段执行；本说明不宣称测试或 Desktop 实际验证已通过。
