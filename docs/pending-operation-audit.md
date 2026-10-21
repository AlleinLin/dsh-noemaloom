# 未完成操作专项审查

审查日期：2026-10-20。范围：`src/domain/context`、`operations`、`storage`、`workflow/scheduler`、`runtime`、`orchestration`，以及宿主 compaction、session bridge、attempt policy、lifecycle。

初次审查为只读源码审查，没有运行测试、构建、桌面验收或模型请求，没有读取用户会话、profile 或凭据。下列行号指发现时的源码位置，后续修改可能使行号移动。“确认”表示源码中具有明确触发链，尚不表示已在原故障电脑复现。

按根因去重，发现 **7 类新增问题**。不包含本轮已经确认、正在修复的 `preparing / decision-started / proposal-prepared` 残留 owner 问题。前 6 类已先行报告，第 7 类为随后检查恢复租约自身时发现。它们的影响不同，不能表述成“7 个问题都会锁死整个会话”。

| 编号 | 确认问题 | 影响 | 修复状态 |
| --- | --- | --- | --- |
| 1 | 正式压缩已闭合失败，却因缺少关联 ID 一直等待收据 | compact lane 持久阻塞 | 已修：关联正式 ID，核验失败终态，未知效果保留对账 |
| 2 | 辅助上下文计划的 inFlight 没有失败后的可靠终结与恢复 | 辅助 lane 路由、所有权和删除持续被拒绝 | 已修：持久 attempt、独立收尾和恢复 |
| 3 | 工作流无句柄副作用超时、重启后被重新派发 | 未知效果可能被重放或并发写入 | 已修：稳定 requestId、attempt 栅栏、未知效果隔离 |
| 4 | 同进程租约排队不响应取消和等待超时 | 后续等待者可永久等待 | 已修：排队响应取消和统一 deadline，不越过活前驱 |
| 5 | SQLite worker 退出后没有终态熔断 | 后续存储调用永久 pending | 已修：终态熔断，拒绝未来 RPC，并发关闭去重 |
| 6 | 命令作业重启后永久保留 running | 作业状态不能终结或核验恢复 | 已修：exact owner 核验，无 owner 转 effectUnknown，禁止重跑 |
| 7 | 恢复租约的 owner 文件损坏后无法回收 guard | 后续过期写租约无法恢复 | 已修：受限回收损坏 owner，同目录恢复互斥 |

定点复审：上述 7 类均已对应修复源码，另补齐 scheduler 必须绑定原 CAS 返回的 requestId 和 attempt、同 PID 不同进程实例识别、Windows 同物理路径大小写和 junction 的恢复互斥。当前审查范围内确认尚未修复的遗漏为 0；这不代表所有未知故障均已排除。统一验证以 `本轮验收.md` 和 `evidence/verification-summary.json` 的最终源码身份为准。

## 1. 正式压缩失败闭环未被识别

发现位置：

- `src/host/compaction.ts:327`：在 `super.compactNow / compactRegion` 返回前就记录 `official-started`。
- `src/host/compaction.ts:353`：摘要失败或取消且无结果、无 summary 时，保留该 owner。
- `src/host/compaction.ts:469`：无 hostCompactionId 时只对具有 proposalId 的记录尝试寻找成功 summary。
- `src/host/compaction.ts:507`：仍没有 ID 就持续报未完成原生操作。
- `src/domain/context/index.ts:1092`：proposal abort 要求所属 hostCompactionId 对应的失败 end，然而失败前该 ID 尚未由成功返回值写入 owner。

官方 `@deepseek-ai/dsh-compaction-basic` 的 `compactSurfaceRegion` 在摘要前写 `compaction/start`，摘要失败后尝试写同 ID 的 `compaction/end(error)`，手动操作还会执行持久化检查点。Nexus 原逻辑只看成功 summary，漏掉了可证明已经终结的失败事务。因此，手动 compact 和 proposal 官方替换失败是同一个关联、终结缺陷，按一类计数。`compactNow` 在正式 start 之前被 busy 拒绝，也可能被预写的 `official-started` 误留住。

修复方向：在摘要接缝关联 exact compactionId，核验 start、end(error) 和替换记录；仅结束可证明已经终结、未替换的旧操作，保留未知计费事实，不重新执行它。重启后不能仅凭暂时没有 summary 或超时推定无效果。

已经实现上述关联和失败闭环识别；其余小节的“修复方向”保留为发现时的修复约束，当前状态以上表及最终验证报告为准。

## 2. 辅助计划的 inFlight 残留

发现位置：

- `src/domain/context/index.ts:762`：prepare 将 planId 持久加入 session.inFlight。
- `src/host/host-adapter.ts:156`：模型 finally 中用独立 5 秒信号尝试 complete。
- `src/host/host-adapter.ts:157`：原模型流已有错误时，complete 失败会被吞掉。
- `src/domain/context/index.ts:1263`：只有成功的 final complete 才移除 planId。
- `src/domain/context/index.ts:1604`：recover 仅返回 inFlight 和 interruptedLeases，没有核验终结通道。
- `src/domain/context/index.ts:689 / 1421 / 1434 / 1608`：残留会阻止路由、世代、所有权切换和删除。

触发链：辅助模型已 prepare → 流失败或取消 → complete 的持久化、授权、排队或停用失败 → 进程结束后原流已不再执行，但持久 inFlight 仍在 → recover 无法终结该计划。普通 native/sync 会主动移除自己的临时 plan，不属于这条辅助调用路径。

修复方向：分离计划与实际发送占用，持久保存可对账的物理 attempt 身份；确保失败和停用时有独立终结收据。恢复时只核验旧调用，不重放模型，不用盲目清空所有 inFlight 代替核验。

## 3. 工作流未知副作用被当作可重试

发现位置：

- `src/domain/workflow/scheduler.ts:295`：perform 返回的 work 与超时、取消 Promise.race。
- `src/domain/workflow/scheduler.ts:306`：只有 active.handle 对应的模型子代理有等待清理。
- `src/domain/workflow/scheduler.ts:317`：其他未停下的 work 也可能标为 timedOut 或 cancelled。
- `src/domain/workflow/scheduler.ts:201`：结束后将此节点的资源 lease 释放。
- `src/domain/workflow/scheduler.ts:575`：retry 允许 timedOut 重新 queued。
- `src/domain/workflow/scheduler.ts:45`：初始化将运行节点变成 interrupted。
- `src/domain/workflow/scheduler.ts:561`：resume 只拦有 activationId 的 interrupted；无 ID 的已运行工具被重新 queued。
- `src/domain/workflow/scheduler.ts:590`：reconcile 只处理有 activationId 的节点。

触发链一：tool、CLI、gate 或无子代理句柄的模型工作超时 → work 尚未确认停止 → lease 被释放 → retry 可生成新物理执行，可能与旧效果并行。

触发链二：写工具已经开始 → 插件或进程重启 → 该节点无 activationId → resume 直接重排。工具调用没有显式稳定 requestId，而是继承 start、resume 各自的 Dispatcher 父意图，因此不能保证新派发会命中旧回执。

两个边界属于同一类问题：缺少持久的非子代理效果身份和未知状态处理。

修复方向：保存稳定 operation requestId 和实际派发边界；未确认终止的非纯操作转 effectUnknown 并保留资源隔离；重启先查询原操作回执。只有可证明未开始的节点可以重排。

## 4. 租约本地队列没有取消和等待预算

发现位置：

- `src/domain/storage/lease.ts:52`：localQueue 只接受 work。
- `src/domain/storage/lease.ts:58`：无期限 await prior。
- `src/domain/storage/lease.ts:174`：withLease 先进入该队列。
- `src/domain/storage/lease.ts:175 / 183`：取消检查和 lockTimeout 的起点都在本地排队结束之后。

触发链：同进程前一项 work 永不 settle → 后续相同资源请求进入 localQueue → 即使后续 signal 已取消，或 lockTimeout 已经过期，也不会返回。此问题本身不是持久 owner 错判，但会使取消和停用等待失效。

修复方向：让本地排队接受 signal 和统一 deadline；取消等待者应及时返回，并在前驱结束后完成自己的队列接续，绝不能提前释放前驱的写所有权或让取消的 work 后来执行。

## 5. SQLite worker 死亡后继续发送请求

发现时位置：`src/domain/storage/sqlite.ts:28`、`:31`、`:37`、`:41`。

触发链：ready 已成功 → worker error 或 exit 仅拒绝当时 pending → store 没有关闭或保留 terminalFailure → 后续 call 继续 postMessage 到已退出 Worker → 没有回复，也没有下一次 error 事件负责拒绝它 → 永久 pending。所有依赖该存储调用的 lane 和停用等待都会受影响。

修复方向：保存 worker 终态错误，拒绝未来调用；清理同步发送失败；ready 前任何 exit 都必须拒绝 ready。

审查期间已经看到 root 写入 `terminalFailure / fail()` 和后续调用检查；未运行回归验证，不据此宣称通过。

## 6. 命令作业的持久 running 无恢复路径

发现位置：

- `src/domain/runtime/index.ts:153`：根据请求 ID 查询 runtimeJobs。
- `src/domain/runtime/index.ts:154`：任何已存作业均直接返回，包括旧进程的 running。
- `src/domain/runtime/index.ts:157`：取消控制器仅在当前进程内存中。
- `src/domain/runtime/index.ts:158`：持久记录 state=running。
- `src/domain/runtime/index.ts:194`：没有控制器时只能返回 not-owned-or-completed。

触发链：命令开始后进程重启，或命令已结束但最终状态无法持久化 → 旧 running 没有本代 exact handle → 查询永久显示 running → cancel 不能区分“已完成”和“旧效果未知”，也没有核验恢复入口。重新提交相同请求只返回这条旧记录。

修复方向：持久保存进程代次、启动意图和可核验句柄身份；启动或首次访问时，将没有可信当前 owner 的旧 running CAS 为 interrupted/effectUnknown，明确展示需要核验。禁止因此重新执行旧命令。区分已终态与 owner 丢失。

## 7. 恢复 guard 的损坏 owner 文件无法清理

发现位置：

- `src/domain/storage/lease.ts:68`：readOwner 对语法错误返回 undefined。
- `src/domain/storage/lease.ts:127`：过期 `.recovery` guard 进入回收。
- `src/domain/storage/lease.ts:130`：无有效 owner 时只 rmdir(guard)，吞掉 ENOTEMPTY。
- 对照 `src/domain/storage/lease.ts:140`：主 lock 的相同情况会先移除 owner.json。

触发链：创建 recovery guard 的 owner.json 时磁盘写失败，或崩溃留下空文件、半 JSON → readOwner 无有效 owner → guard 过期后 rmdir 因该文件仍在而失败 → 所有后续 recover 一直发现同一个 guard → 主 stale lock 也无法恢复。该问题与第 4 类排队取消失效不同，按独立根因计数。

修复方向：对已确认过期的无效 guard 执行受限清理，核验普通目录和唯一 owner 文件后移除损坏 owner 文件，再竞争创建恢复 guard。不能递归删除，不可用宽泛的“读取失败”覆盖权限、I/O 错误；清理过程仍须防止两个恢复者移除新 owner。

## 已检查、未计为新增缺陷

- preparing/proposal-prepared 阶段失败收据写失败：当前实现保持旧 preparing owner；下一次取得共享 lease 后，通过 revision CAS 的 finishPreparation 结束旧准备操作，没有调用旧 native/propose。该恢复通道已经存在，未重复计数。
- 正式效果尚未确认、官方 start 无匹配 end，或权威日志不可读：保持 reconciliation-required 是必要保护；“不能自动重试”本身不是缺陷。缺陷是将有确定失败终态的操作也永久当成未知。
- Dispatcher 的 durable started intent 阻止盲目重放：行为符合保留未知效果要求，不能为了消除报错直接删除回执。
- session bridge 的 create/fork/input intent 保留 exact session/message 身份，内存 inflight 有 finally 清理；没有额外确认出与上述 7 类独立的确定缺陷。
- OperationController 在 route disposer 之后 abort 的顺序：已查官方 Fetch route disposer，它只删除注册贡献，不等待当前请求排空，因此没有证据支持此前怀疑的 route-drain 自锁，未计数。
- HostAttemptTracker 的 stream finally 会尝试 settleAttempt，再写独立 usage；具体持久化故障会传播并使 owner 取消。没有把“账单事实未知”直接当作可以再发一次。

## 验证边界

本清单提供静态触发链和修复归属。用户要求先完成写入，再冻结源码、统一测试与集中修复；因此此处没有单独启动测试。交付前应按统一测试结果更新每项状态，尤其验证：失败收据写入再失败、取消发生在准入与接受之间、重启后的旧代次、官方失败闭环、Worker 退出以及损坏恢复 guard。桌面人工验收只针对 DeepSeek Harness Desktop。
