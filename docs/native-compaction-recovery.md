# 原生上下文维护的失败与恢复

原生会话的自动、模型手动和溢出恢复共用同一份正式事务、租约与回执协议。辅助模型负责生成候选摘要，宿主 compactor 独占主会话表层替换。

## 自动阈值与独立压缩模型

在设置的「上下文压缩」页选择全局、工作区或会话范围。各层只保存自己的覆盖，未填写的项实时继承父级；恢复继承会清除当前层覆盖。默认开启提前维护，阈值为有效窗口的 80%，可设为 10–95 的整数。

每次冻结模型请求前，按当次已解析并准备的 provider/model 窗口重新测量。使用官方 `tokenMeter.measure(session, effectiveHeader)`，加上即将接纳的输入、已渲染系统提示和运行上下文，以及实际输出预留。工具 schema 属于请求 envelope；缓存输入也是当前请求占用，不使用累计费用或累计 token 触发压缩。换模型后按新路由重新计价。

80% 是维护目标。辅助准备失败或返回 wait 后，若正式替换被证明未开始或已经正式提交、且当前请求仍严格小于真实窗口，可记录诊断、进入辅助冷却并继续当前请求。真实超限、未知正式效果、无法证明缩减时不会据此放行或重试。

压缩模型独立于意图识别、旁路审阅和会话模型，可从准确模型目录选择，也可跟随当前会话。主阈值始终使用会话模型窗口；摘要来源预算使用所选压缩模型的真实准备窗口，输出预算同时适配主会话窗口。来源按连续完整原生消息限量，保留稳定前缀和最近完整工具配对；无法安全分段时返回原因。原始输入和最终组合后的辅助请求均在发送前检查预算，不将巨大历史直接转发给较小窗口模型。目录或路由不可用时明确诊断，不偷偷切换模型。

## 模型自己的维护工具

根智能体与子智能体可调用 `compact_context`：

```json
{"action":"status"}
{"action":"compact","requestId":"checkpoint-unique-intent-1"}
{"action":"status","requestId":"checkpoint-unique-intent-1"}
```

status 不生成摘要，只返回调用者自己的有效窗口、估计占用、策略来源结果、压缩模型、维护状态和近期操作回执。compact 只维护调用者自身；没有目标会话、父级、同级、lane、provider 或策略参数。只读子任务可执行自身维护，显式工具 deny 和激活授权仍然生效；模型无权修改用户设置。

requestId 表示稳定意图。相同 ID 返回原回执；未知结果时，相同 ID 只对账原正式操作，不重放摘要或替换。只有证明原意图终止后才能发起新的明确意图。原文用 `nexus_context` 的 `decompress` / `peek` 按正式引用只读检索。

## 真实窗口拒绝与同一步重试

嵌套 provider code、type、cause 和有界 JSON body 中的 `CONTEXT_WINDOW_EXCEEDED`、`CONTEXT_LENGTH_EXCEEDED` 等均归为 `NX_CONTEXT_WINDOW_EXCEEDED`，保留规范机器码 `CONTEXT_WINDOW_EXCEEDED`。此错误不进入普通网络重试。

真实溢出会绕过提前维护阈值，即使网关误报 1M 窗口也可以恢复。每个 turn/step 最多两次；只有同时获得正式来源提交回执、宿主 replacement generation 前进、按相同有效请求重新测量后占用下降，才允许重试同一模型步骤。已完成工具不重放。没有安全范围、摘要 wait、未知正式回执或未缩减，都持久记录精确停止原因；原始溢出身份不会被泛化网络诊断覆盖。

## 准备与正式替换的边界

`preparing`、`decision-started`、`proposal-prepared` 尚未调用正式宿主 compactor。辅助模型请求可能已经计费，模型观察结果也可能未知；这不等于宿主会话已经被替换。

准备异常将该操作写为 `preparation-failed`，释放 lane，并持久保存脱敏诊断。进程中断后，下一位持有共享文件租约的执行者通过 revision CAS 将准备操作标记为 `preparation-abandoned`。它不重发旧模型请求，不重放旧 requestId。旧 writer 后续尝试写入 `official-started` 会因 CAS 失败而停止。

普通 `pressure` 维护在确认正式替换未开始且原请求仍可容纳时允许正常会话继续。辅助失败或无安全范围有 30 秒起、至多 5 分钟的退避。此时间只控制新辅助请求的准入，不参与正式锁的释放。显式用户请求和真实 overflow 恢复可绕过辅助冷却，但仍须通过正式操作对账。

从持久 `official-started` 开始，正式效果按未知处理。不能凭时间、没有 summary 或模型请求是否计费自动释放。`official-flushed` 仍需 Nexus 来源回执完成。恢复只执行：

1. 独立核验宿主 compaction 事务身份或提案的精确指纹；
2. 宿主持久化 flush；
3. `native/commit` 或 `native/import` 的正式来源证明及内核 CAS；
4. 完成原 lane 的历史回执。

`native/commit` 继续验证完整的正式 start、summary、replacement、end 证明；仅找到一条 summary 不能激活内核。已替换事务不重新请求模型或执行第二次替换。无法证明的正式效果保留 `reconciliation-required`。

手动压缩与提案压缩的正式摘要阶段也可能失败。摘要 hook 在模型发送前记录所属 `compaction/start` 的精确 ID 和 seq。原调用已结束后，只有同一事务存在唯一 `start → end(error)`、没有 summary 或 replacement，并确认 flush，才终结为 `official-failed`、释放维护占用；辅助计费仍记为 unknown。提案先完成对应 `native/abort` 收据。重启的旧 owner 没有 ID 时，只接受水位之后唯一且闭合失败的事务；多候选、未闭合 start、已出现 replacement 均保持待对账。仅当前已拒绝的原 await 可以结合本地事件与权威快照证明根本没有进入正式 start，不将此规则用于重启后的未知 owner。

## 辅助请求的维护占用

辅助 `prepare` 保存宿主 request owner 的 PID、主机、进程实例和随机 token。宿主从 prepare 之前到 stream 和 complete 之后持有进程共享的活跃 token，并在外层 finally 无条件结束它。complete 的 usage 观察写入失败，也不阻止后续的独立 `request/release` 释放维护占用。该动作只保留 outcome unknown 的元数据并清除 inFlight，不发送模型、不创建 usage 样本、不替换正式会话。

`recover` 只恢复同一进程实例中已结束的 token，或同机已确认退出 PID 的 owner。另一活跃进程、无法核实的主机、旧版无 owner 的 plan 均不会被超时接管。旧计划返回 `unproven`，需核对对应宿主请求终态和收费记录；缺乏证据时不自动重放。已冻结的原 ContextPlan 和原文仍保留。

## 工作流外部调用

每个节点 attempt 在外部边界前持久写入 `execution.prepared → started`，工具和 CLI 使用稳定 requestId。超时或取消后，底层调用尚未结束、也没有正式 handle 的取消确认时，节点保持 effectUnknown，其写占用不会因到期而释放。重启的旧 running 节点即使没有 activationId 也不重新排队。

工具对账通过 `NexusServices.readReceipt` 只读取原作用域、原 requestId 的 dispatcher 收据；读取缺失收据不会执行原调用。缺少收据或收据仍要求副作用核验时保持 unknown。模型用量记录不能代替节点产物与 activation 的真实终态。

真实 `CONTEXT_WINDOW_EXCEEDED` 的辅助恢复失败时，保留原宿主错误，不将它替换成泛化维护错误，也不声称溢出已经解决。

## 宿主接线与诊断

`src/host/native-diagnostics.ts` 导出：

```ts
toHarnessError(error: unknown): HarnessError & { traceId: string }
readNativeCompactionDiagnostics(
  services: Pick<NexusServices, 'store'>,
  sessionId: string,
): Promise<{ schemaVersion: 1; lanes: Record<string, unknown>[] }>
```

宿主原生工具/会话边界用 `toHarnessError` 抛出正式 `@deepseek-ai/dsh-llm` 的 `HarnessError`。宿主可识别其机器码，展示文本包含实际 `code` 和 `traceId`。内部错误通过 `Symbol.for('dsh-nexus.error.v1')` 跨 bundle 识别；领域 `CTX_*` 码不再由 dispatcher 扁平化为 `INTERNAL`。

模型、桌面 UI 和导出工具可调用已注册的 `context/diagnostics`，参数为选中 `sessionId` 及可选 `purpose/lane`。该只读入口遵守全局/工作区/会话 scope 和精确 lane key，不创建 context 会话，不读取正文。纯过滤器位于 `domain/context/diagnostics.ts`，宿主导出同一实现。

诊断读取必须先授权所选会话。每 lane 保留最近 16 条失败/恢复元数据，导出仅含阶段、状态、标识、代码、时间与效果分类。准备阶段计费结果未知会明确标记为 `auxiliaryEffect: unknown`。导出不包含用户消息、模型输入输出、调用参数、栈或密钥。

正式替换效果未知时，先获取该会话原生事件及此诊断并核对事务；不要删除 owner、修改正式表层或按超时解锁。
