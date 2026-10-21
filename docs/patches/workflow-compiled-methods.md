# 编译后的学习规则与生成方法

学习规则进入公共 `workflow/plan` 和 `workflow/blueprints/compile` 的实际编译流程，默认关闭。关闭时不列出规则、不增加提示词、不改变节点、路由、工具表或顺序；显式关闭连 scoped learning settings 也不读取。`adaptations` 编译参数支持单次 `enabled`、`benchmark`、`headless`、`persistent`、`holdoutPercent` 和 `turnId`。显式设置优先；非交互或基准运行默认关闭。

开启后只选择当前用户与受信任项目的 active/trial/tentative 版本，重新执行 guard，按当前原始目标的文字触发词或 `goal:`、`role:`、`framework:`、`tier:`、`node:` 选择器和 exclusions 匹配实际 actor。trial holdout 稳定取 session/turn，明确偏好、安全/许可约束和 active 规则不进入 holdout。方法内容是受限方法上下文；它不重写授权、角色绑定、路由策略、工具权限、ownership、系统提示词、预算或质量门。已审 tool/hook 也不会被本编译步骤自动安装或执行。

规则完整内容、内容 hash、逻辑版本、存储 revision、来源证据、匹配节点、holdout 决定冻结在 TaskPlan provenance。编译证明先落盘，再公开计划。共享 scheduler 在新 Run 持久化后、派发前和幂等恢复路径生成稳定 application ID；它只读取冻结版本，不读取当前规则或学习开关。`adaptations/application` 不再接受调用者声明记录；`adaptations/applications/list|get` 是有会话 ACL 的读取入口。节点未真正尝试运行时不能提供效果评价。

三轴生成器是有类型的本地 descriptor 编译器，不发模型请求。`blueprints/generate` 以当前用户、项目、会话隔离的 `generationId` 保存服务端 attempt、输入 hash 和诊断，首次失败可按返回 ID 重生一次，第二次失败为 `OUT_OF_SCOPE`。同一 requestId 的重试不会重复消耗 attempt；attempt 不能由调用者重置。成功后 ID 的输入不可改绑，失败诊断可以用 `blueprints/leaves/generation` 读取。

`blueprints/leaves/list|get` 提供仅当前任务可读的方法归档，`blueprints/compile_leaf` 以 leafId 和可选 leafHash 进入相同 TaskPlan 编译与 Run 入口。编译再次验证方法 hash、三轴、门序列、来源、不变量、owned paths 与宿主执行器映射；方法不扩张任务 ownership，不修改原始目标。G4 仅产生一个 implementation actor，G5/G6 保持独立性；生成方法不能通过 T0 或禁止代理的请求绕过独立门。形状所需 G2/sweep 也保留。

必需 policy check 必须逐项映射真实 oracle。metric oracle 绑定相同数据集、阈值、容差和严格边界。缺少真实检查、harness、ownership 或独立执行能力均在编译时阻断，不创建空检查通过路径。生成方法仅随本任务证据归档，不自动晋升为永久技能。

新增回归材料在 `tests/workflow-adaptation-compile.test.ts` 与 `tests/domain/orchestration/generated-leaf-validation.test.ts`。本次编写期间未执行验证，等待所有实现冻结后统一检查。
