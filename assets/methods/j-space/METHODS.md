# J-Space 能力的 Nexus 等效方法

来源能力：J-Space Cognition Suite，固定上游 b2023124a1fa08278e3ee82aefa8ed9faeade995。此文件为 Nexus 自写的操作规范，不转载第三方模型思维轨迹、截图片段或受排除的引文。上游 Apache 许可和来源边界附在本目录。

## 问题构造

把请求转成可检查的输入、输出、约束、不变量和未知项。分别记录已有证据与假设。缺少历史需求时保留 unknown，不从当前代码制造原意。只追问影响下一步的必要缺口。

## 有界认知模块

- capacity：依据剩余读取、模型调用、token、费用和时限决定当前窗口，保留未完成列表。
- cyber：把系统分成输入、控制器、状态、观察与反馈，依据真实输出调整下一步。
- deep-reasoning：并列备选解释，寻找可证伪差异，将最小有区分力的实验编译到统一 Run。
- directed-focus：当前阶段只加载对应方法资源和输入引用，目标变化显式换阶段。
- empirics：区分观察、测量、预测与推断；重复实验保留版本、命令和失败结果。
- epistemics：结论标证据等级与未知项，反例优先于信心；不得以模型互相同意证明正确。
- introspection：只总结可陈述的决定、假设与下一步，不要求泄露隐藏推理或伪造思考轨迹。
- markers：用稳定对象 ID、状态、证据 refs 标记当前问题与暂停点；不把标记当作权限。
- orchestration：依赖和职责交给 TaskPlan/Run，工作量相互独立时并行，写声明冲突必须串行。
- repository：把可复用结果写入项目真源或受控 artifact；优先恢复原文引用，避免重复采集。
- self-monitoring：阶段结束检查 scope、预算、证据和未完成项，遇到输入变化重新建立 snapshot。
- shorthand：保留目标、约束、证据、未知、待做和精确 refs 的紧凑摘要，按需展开原文。
- broadcast：跨角色共享经授权的事实和 artifact refs；保留发送者与来源，不冒充用户指令。

## 可执行接缝

通过 quality `method_plan` 输入 route、goal、evidenceRefs、nodes。返回统一 workflow TaskPlan；tool 节点必须指向已注册 domain/action，agent 节点走正式 Host child。模型工具面与系统前缀不因选择模块而改变。没有真实 executor 的方法只说明分析边界，不报告任务已执行或通过。
