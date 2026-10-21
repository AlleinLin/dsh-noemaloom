# 同一个 WorkflowRuntime 中的纯编排策略

入口为 `index.ts`。本目录不启动 agent、HTTP 服务、外部 CLI，不管理第二份
Run、预算、用量、cache epoch 或并发状态。

- `selectRoute` 接收冻结模型目录、精确批准池、能力事实、预算与缓存分区参数。
  不猜 provider、模型、reasoning effort 或缺失价格。返回可审计决策和 lease
  **提案**；根 WorkflowRuntime 必须在持久事务内真正取得预算、ownership 和
  lease，随后才 dispatch。
- `resolveModelReference` 只接受精确引用。裸 model 或 provider/model 同时匹配
  多账户/endpoint 时返回歧义，不用数组第一个候选或模糊匹配。
- `classifyTaskShape` 使用宿主已规范化并验证的绝对路径、数据库、lockfile、
  端口等资源。它不会通过词语、文件数或所谓难度虚构 T3 lane。
- `createBuiltinBlueprint`、`validateBlueprint`、`compileBlueprint` 为受保护门、
  DAG、回退前驱、预算及权限编译快照。默认空 checks 永远未验证；交付合同编译器
  须填真实检查。运行中用户编辑不会修改 `structuredClone` 后的执行快照。
- `evaluateGate` 只对实际 port 生成的 receipt、hash、采样结果、独立 actor 与
  lineage 进行主机判断。来自 RPC、模型正文、旧上游 receipt 的 source 字符串
  本身不可信；调用方必须从执行器、artifact store 或 oracle 收集该参数。
  G5/G6 调用应传入所有先前作者和检查者，不能只传一个方便的 actor。
- `aggregateCompletion` 拒绝旧 snapshot、失败门、未解决高危问题、未达成目标、
  活跃或未收集后代、未知副作用。`failureFingerprint` 和
  `assessRepairProgress` 限制重复修复；`invalidateDependentEvidence` 只使受影响
  后续节点 stale。
- `createHandoffManifest` 跨 provider/protocol 只发送有版本/hash的最小语义摘要与
  artifact refs。思考、签名、加密、redacted 和任意整段历史不转成普通文本；
  同协议需原样连续时保留原 block。
- `selectAdaptations` 在 off 时直接返回，连 `load()` 都不会调用。保护用户明示
  偏好、安全规则和 active 规则不受 holdout 影响；promotion 根据 application
  去重及最新 revision，零样本保持 unknown，3 helped / 0 hurt + 回归才晋级，
  2 hurt 隔离。实际 CAS、journal 与原子写由共享 store 层完成。

`assets/` 保存锁定 Metis 完整 26 角色、16 框架和 contracts，含逐文件来源、
SHA-256、MIT 原许可和两位版权人声明。原文只是方法资产，不是新的授权或
执行入口。`assets-bundled.ts` 内嵌全部角色、框架和来源清单，运行时无
`import.meta.url` 或文件路径依赖；原始 `assets/` 仍用于源码交付及许可审查。

有针对性的 Node 测试位于 `tests/domain/orchestration/policies.test.ts`。按用户
“先写完，再统一测统一修”的要求，此实现阶段未运行测试或构建；不能把本文件
或源码阅读当成验证通过。
