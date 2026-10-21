# DSH Nexus 工作流与编排实现

`createWorkflowModule(services)` 与 `createAgentsModule(services)` 共享一个 `WorkflowScheduler`，不会各自启动运行时。全部实际子代理经 `services.host.spawn(ModelRequest)` 执行，取消等待此次 activation 的 `dispose()`。计划、路由、节点、预算、每次 attempt、事件和证据分开持久化；同一计划可以创建多个 Run。

实现入口覆盖计划/运行/等待/取消/恢复/重试、四目标待办、参数化/连续提示词、完整双语专家与五团、外部 CLI、房间/消息/presence、文件/服务声明、旁观评审、GitHub Issue 任务板、工程生命周期转接、模型路由/蓝图/生成框架与有界学习。所有能力说明与表单 schema 来自 `index.ts` 中固定 `Capability`，公开模型工具仍是宿主的一组固定 dispatcher。

编排在 admission 时冻结蓝图、shape、ownership、角色路由、缓存 lane、交付合同与预算。T3 内置图为每个真实不相交 surface 生成独立 author/reviewer/verifier 和 G4/G5/G6，Run 级 G2/sweep/goal-check 保留整合职责。共享路径、目录父子与 service/resource claim 自动串行。全局并发与 claim lease 使用共享存储 CAS；未知清理状态保留租约，不能继续制造写冲突。

验证只接受宿主执行命令、实读文件/hash、结构化指标和独立 actor 原始证据。空 checks、固定 PASS 文本、CLI exit 0 但无 ChildResult、未知 observed model、未确认取消均不能当作成功。输入正文按引用按需读，跨 provider handoff 不传播签名 thinking。学习默认关闭，未启用时不扫描候选；trial/holdout/评价/晋升/退役/回滚具有版本历史，真实回归证据来自同一 Run 的 gate artifacts。

测试源在 `tests/workflow.test.ts`、`tests/domain/orchestration/policies.test.ts`。遵照本次用户要求，实施阶段不运行构建、测试或安装，统一验证由集成负责人在全部模块冻结后执行。

## 复用与许可

- `resources/agents/builtin.ts`：MichengAI/dsh-agency-agents 的 332 个双语 persona、23 分类；Apache-2.0。原 LICENSE/NOTICE 随目录保留。
- `resources/agents/upstream/`：原始团队 schema、五团职责与示例、中英协调/交接方法。适配层将 `expertSlug` 映射为统一 `expertId`，保持原文、版本与自定义编辑分离。
- `prompt-seed.ts`：csyangwen/dsh-memory-evolve 的提示词原文与原始来源。主项目 MIT 许可随 `LICENSE-EVOLVE` 保留；原文本各来源在 seed 内保留，不因导入自动执行。
- `orchestration/assets-bundled.ts` 及 `orchestration/assets/`：Wholiver/metis v2.0.2 / `8b1eda95afea3592e08a315e29dc7746ee57ca25` 的 16 框架、26 角色原文、MIT 许可及每文件 SHA256。运行时使用内嵌资源，不依赖构建后路径。
- Evolve 的四目标待办、CLI adapter、session/room/claim/advisor 行为合同用于适配参考；移除了旧宿主接口、假用户注入与重复 scheduler，改为本插件共享合同和真实宿主服务。

未复制个人 profile、私密会话、secret 或恢复备份。实际测试结果须由统一阶段生成，本文不能作为已通过证据。
