# 原生上下文维护的失败与恢复

本次会话导出能确认：第 49 轮完成，第 50 轮在 `step/start` 之前失败，第 51、52 轮被相同 lane 的遗留 owner 阻挡。主会话没有 compaction 事件，导出不足以确定第 50 轮最初异常的根因。实现不将该异常猜测成上下文溢出或正式压缩失败。

## 准备与正式替换的边界

`preparing`、`decision-started`、`proposal-prepared` 尚未调用正式宿主 compactor。辅助模型请求可能已经计费，模型观察结果也可能未知；这不等于宿主会话已经被替换。

准备异常将该操作写为 `preparation-failed`，释放 lane，并持久保存脱敏诊断。进程中断后，下一位持有共享文件租约的执行者通过 revision CAS 将准备操作标记为 `preparation-abandoned`。它不重发旧模型请求，不重放旧 requestId。旧 writer 后续尝试写入 `official-started` 会因 CAS 失败而停止。

普通 `pressure` 维护在确认正式替换未开始时允许正常会话继续。辅助重试有 30 秒起、至多 5 分钟的退避；`wait` 有 15 秒抑制窗口。此时间只控制新辅助请求的准入，不参与正式锁的释放。显式用户请求和真实 overflow 恢复可绕过辅助冷却，但仍须通过正式操作对账。

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
